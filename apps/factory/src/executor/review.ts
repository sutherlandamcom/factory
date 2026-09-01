import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SiteTask } from "@factory/contracts";
import { FactoryError } from "./errors.js";
import {
  assertStrongExecutionIsolationAvailable,
  dockerClientEnv,
  CLAUDE_WORKER_IMAGE,
} from "./isolation.js";
import { FACTORY_RUNTIME_NETWORK, FACTORY_WORKER_NETWORK } from "./network.js";
import { loadOpenRouterApiKey, scrubCredentials } from "../models/gateway.js";
import { buildClaudeRuntimeEnv, CLAUDE_SENIOR_MODEL, parseClaudeJsonResult, resolveAnthropicSurface } from "./claude.js";
import { startModelRelay } from "./relay.js";
import type { TaskWritePolicy } from "./module-policy.js";
import { runProcess } from "./process.js";

/**
 * Senior read-only review (code-worker-routing-v0).
 *
 * Claude Opus 5 reviews a FROZEN Kimi-produced candidate patch against the
 * SiteTask, the Factory write policy, and recorded QA evidence. The reviewer:
 * - receives every input READ-ONLY (hard bind mounts, readonly workspace,
 *   writable tmpfs only) — it cannot mutate repository or worktree state;
 * - additionally has Edit/Write denied in its ephemeral settings;
 * - outputs structured P0/P1/P2 findings and a verdict as JSON on stdout;
 * - does NOT replace any deterministic Factory gate (tsc, astro check,
 *   build, Playwright, scope, integrity, semantic verification, replay) —
 *   LLM review is additive evidence, never the QA oracle.
 */

export interface SeniorReviewRequest {
  repoRoot: string;
  runId: string;
  task: SiteTask;
  /** Exact frozen candidate patch under review (bytes are content-addressed). */
  patch: string;
  writePolicy: TaskWritePolicy;
  /** Bounded QA evidence summary text (already secret-scrubbed). */
  qaEvidence: string;
  timeoutMs?: number;
}

export interface SeniorReviewFinding {
  severity: "P0" | "P1" | "P2";
  summary: string;
  evidence?: string;
}

export interface SeniorReviewResult {
  reviewId: string;
  runId: string;
  /** SHA-256 of the exact reviewed patch bytes. */
  reviewedPatchSha256: string;
  verdict: "no_issues" | "findings" | "unparseable";
  findings: SeniorReviewFinding[];
  respondedModel: string | null;
  runtimeVersion: string | null;
  artifactDirectory: string;
}

const REVIEW_TIMEOUT_MS = 600_000;

/** Pure prompt builder (unit-tested). The reviewer must not mutate anything. */
export function buildSeniorReviewPrompt(params: {
  task: SiteTask;
  writePolicy: TaskWritePolicy;
  qaEvidence: string;
}): string {
  return `You are the Factory SENIOR REVIEWER. You are performing a STRICTLY READ-ONLY review of one frozen candidate patch produced by an implementation worker.

You MUST NOT modify any file. Your filesystem is read-only except scratch space. Produce your findings as your ONLY output.

Review inputs (mounted read-only in your workspace):
- task.json — the validated SiteTask under review
- write-policy.json — the exact authorized write scope
- candidate.patch — the frozen diff under review
- qa-evidence.txt — deterministic Factory gate evidence (scope, integrity, QA, semantic verification, replay)

Review for:
- P0: security violations, credential exposure, write-authority widening, task-content forgery, SEO-policy violations (fabricated facts/metrics/credentials), or anything that must block merge.
- P1: task-intent deviations, QA-weakening attempts, structural defects the deterministic gates could miss, prohibited dependency/configuration changes.
- P2: maintainability, naming, duplication, minor deviations worth noting.

## SiteTask
\`\`\`json
${JSON.stringify(params.task, null, 2)}
\`\`\`

## Authorized write policy
\`\`\`json
${JSON.stringify({ taskType: params.writePolicy.taskType, writablePaths: params.writePolicy.writablePaths, writableModules: params.writePolicy.writableModules }, null, 2)}
\`\`\`

## QA evidence (deterministic gates already evaluated)
${params.qaEvidence}

## Required output format (JSON only, nothing else)
\`\`\`json
{
  "verdict": "no_issues" | "findings",
  "findings": [
    { "severity": "P0" | "P1" | "P2", "summary": "...", "evidence": "file/line or patch excerpt reference" }
  ]
}
\`\`\`

Read task.json, write-policy.json, candidate.patch, and qa-evidence.txt in your workspace, review the patch against them, and output exactly one JSON object.`;
}

/** Pure findings parser: extracts the review JSON object from model output. */
export function parseSeniorReviewOutput(stdout: string): { verdict: SeniorReviewResult["verdict"]; findings: SeniorReviewFinding[] } | null {
  const fenced = stdout.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : stdout;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      verdict?: unknown;
      findings?: unknown;
    };
    const severityOf = (value: unknown): SeniorReviewFinding["severity"] =>
      value === "P0" || value === "P1" || value === "P2" ? value : "P2";
    const findings: SeniorReviewFinding[] = Array.isArray(parsed.findings)
      ? (parsed.findings as unknown[])
          .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
          .map((f) => ({
            severity: severityOf(f.severity),
            summary: typeof f.summary === "string" ? f.summary.slice(0, 2000) : "(unparsable finding)",
            ...(typeof f.evidence === "string" ? { evidence: f.evidence.slice(0, 2000) } : {}),
          }))
          .slice(0, 50)
      : [];
    return {
      verdict: findings.length > 0 ? "findings" : "no_issues",
      findings,
    };
  } catch {
    return null;
  }
}

function safeReviewDirName(runId: string): string {
  const base = runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return `review-${base}-${randomBytes(4).toString("hex")}`;
}

/** Strong production review runner: Colima VM → hardened Docker worker → Claude Code (read-only). */
export async function runSeniorReview(request: SeniorReviewRequest): Promise<SeniorReviewResult> {
  const timeoutMs = request.timeoutMs ?? REVIEW_TIMEOUT_MS;
  await assertStrongExecutionIsolationAvailable(request.repoRoot);

  const apiKey = loadOpenRouterApiKey();
  if (apiKey === null) {
    throw new FactoryError(
      "claude_credentials_unavailable",
      "OPENROUTER_API_KEY is not configured; the senior reviewer fails closed without credentials",
    );
  }
  const reviewId = safeReviewDirName(request.runId);
  const relay = await startModelRelay({
    tier: "senior",
    apiKey,
    repoRoot: request.repoRoot,
    containerName: `review-${reviewId}`,
  });

  const reviewsRoot = path.join(request.repoRoot, ".factory", "reviews");
  const reviewDir = path.join(reviewsRoot, reviewId);
  const configDir = path.join(reviewDir, "config");
  await mkdir(configDir, { recursive: true });

  const patchSha256 = createHash("sha256").update(request.patch).digest("hex");
  const prompt = buildSeniorReviewPrompt({
    task: request.task,
    writePolicy: request.writePolicy,
    qaEvidence: scrubCredentials(request.qaEvidence),
  });

  try {
    // Every input is written by Factory (never the reviewer) and mounted
    // read-only; the only writable space is container-ephemeral tmpfs.
    await writeFile(path.join(reviewDir, "task.json"), JSON.stringify(request.task, null, 2), { mode: 0o644 });
    await writeFile(
      path.join(reviewDir, "write-policy.json"),
      JSON.stringify(
        { taskType: request.writePolicy.taskType, readableModules: request.writePolicy.readableModules, writableModules: request.writePolicy.writableModules, writablePaths: request.writePolicy.writablePaths },
        null,
        2,
      ),
      { mode: 0o644 },
    );
    await writeFile(path.join(reviewDir, "candidate.patch"), request.patch, { mode: 0o644 });
    await writeFile(path.join(reviewDir, "qa-evidence.txt"), scrubCredentials(request.qaEvidence), { mode: 0o644 });
    const settingsPath = path.join(configDir, "settings.json");
    await writeFile(settingsPath, buildReviewerSettingsJson(), { mode: 0o600 });
    await chmod(settingsPath, 0o600);

    const runtimeEnv = buildClaudeRuntimeEnv(relay.relayToken, relay.baseUrl);
    const containerUid = process.getuid?.() ?? 1000;
    const containerGid = process.getgid?.() ?? 1000;
    const args = [
      "run",
      "--rm",
      "--interactive",
      "--name",
      `factory-review-${reviewId}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2",
      "--network",
      FACTORY_WORKER_NETWORK,
      "--user",
      `${containerUid}:${containerGid}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      // The review WORKSPACE is read-only: the reviewer cannot mutate any
      // repository, worktree, or artifact state.
      "--mount",
      `type=bind,src=${reviewDir},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      CLAUDE_WORKER_IMAGE,
    ];
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (value === undefined) continue;
      args.push("--env", `${key}=${value}`);
    }

    const result = await runProcess("docker", args, {
      cwd: request.repoRoot,
      env: dockerClientEnv(request.repoRoot),
      timeoutMs,
      input: prompt,
    });

    const parsedJson = parseClaudeJsonResult(result.stdout);
    const parsed = parseSeniorReviewOutput(result.stdout);
    if (!parsed) {
      return {
        reviewId,
        runId: request.runId,
        reviewedPatchSha256: patchSha256,
        verdict: "unparseable",
        findings: [],
        respondedModel: parsedJson?.model ?? null,
        runtimeVersion: `claude-code ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`}`,
        artifactDirectory: path.relative(request.repoRoot, reviewDir),
      };
    }
    return {
      reviewId,
      runId: request.runId,
      reviewedPatchSha256: patchSha256,
      verdict: parsed.verdict,
      findings: parsed.findings,
      respondedModel: parsedJson?.model ?? null,
      runtimeVersion: "claude-code (review)",
      artifactDirectory: path.relative(request.repoRoot, reviewDir),
    };
  } finally {
    await relay.close().catch(() => undefined);
    // Config contains no credentials (auth is env-only), but the review
    // inputs stay for evidence; only the ephemeral config is removed.
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reviewer settings: writes/edits denied in addition to the read-only mounts. */
export function buildReviewerSettingsJson(): string {
  return JSON.stringify(
    {
      permissions: {
        defaultMode: "plan",
        deny: [
          "Edit",
          "Write",
          "NotebookEdit",
          "WebFetch",
          "WebSearch",
          "Task",
          "Agent",
        ],
      },
      env: {
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    null,
    2,
  );
}

export { CLAUDE_SENIOR_MODEL };
