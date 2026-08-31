import path from "node:path";
import {
  INTELLIGENCE_ERROR_CODES,
  INTELLIGENCE_METHODOLOGY_VERSION,
  MAX_SYNTHESIS_ATTEMPTS,
  parseIntelligenceResult,
  parseResearchEvidenceBundle,
  parseSiteIntelligenceRequest,
  type IntelligenceArtifacts,
  type IntelligenceError,
  type IntelligenceErrorCode,
  type IntelligenceResult,
  type ModelRuntime,
  type NormalizedResearchEvidenceBundle,
  type ResearchEvidenceBundle,
  type SiteIntelligencePlan,
  type SiteIntelligenceRequest,
} from "@factory/contracts";
import { createCodexRunner, type CodexRunner } from "../executor/codex.js";
import { buildChildEnv } from "../executor/env.js";
import { FactoryError } from "../executor/errors.js";
import { runProcess } from "../executor/process.js";
import {
  buildArtifactDigests,
  generateRunId,
  prepareRunDirectory,
  publishJsonAtomically,
  randomRunIdSuffix,
  verifyArtifactIntegrity,
  writeArtifact,
} from "./artifacts.js";
import { compilePlanToTasks, type CompiledIntelligenceTask } from "./compile.js";
import { canonicalJsonStringify, deterministicDigest } from "./digest.js";
import { buildSynthesisPrompt, buildSynthesisRepairPrompt } from "./prompt.js";
import { validateSiteIntelligencePlan } from "./plan-validation.js";
import { countDuplicateEvidenceRecords, normalizeResearchBundle } from "./normalize.js";
import {
  parseModelPlanOutput,
  parseModelRuntimeFromStdout,
  prepareSynthesisWorkspace,
  removeSynthesisWorkspace,
  runSynthesisAttempt,
  writeWorkspacePrompt,
} from "./synthesis.js";

/** Per-attempt synthesis timeout (Intelligence-specific; SiteTask ceilings untouched). */
export const SYNTHESIS_TIMEOUT_MS = 900_000;

export interface FactorySourceCommitInfo {
  commit: string | null;
  dirty: boolean;
}

export type SourceCommitResolver = (repoRoot: string) => Promise<FactorySourceCommitInfo>;

export async function resolveFactorySourceCommit(repoRoot: string): Promise<FactorySourceCommitInfo> {
  const headResult = await runProcess("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    cwd: repoRoot,
    env: buildChildEnv(),
    timeoutMs: 30_000,
  }).catch(() => null);
  const candidate =
    headResult && !headResult.timedOut && headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const commit = candidate !== null && /^[0-9a-f]{40}$/.test(candidate) ? candidate : null;

  const statusResult = await runProcess("git", ["-C", repoRoot, "status", "--porcelain"], {
    cwd: repoRoot,
    env: buildChildEnv(),
    timeoutMs: 30_000,
  }).catch(() => null);
  const dirty =
    statusResult !== null && !statusResult.timedOut && statusResult.exitCode === 0
      ? statusResult.stdout.trim().length > 0
      : false;

  return { commit, dirty };
}

export interface RunIntelligenceInput {
  repoRoot: string;
  requestInput: unknown;
  researchInput: unknown;
}

export interface RunIntelligenceDeps {
  /** Injectable Codex runner (defaults to the accepted strong-isolation runner). */
  codexRunner?: CodexRunner;
  now?: () => Date;
  runIdSuffix?: () => string;
  sourceCommitResolver?: SourceCommitResolver;
  synthesisTimeoutMs?: number;
  /** Progress diagnostics (stderr for the CLI; never evidence dumps). */
  onProgress?: (message: string) => void;
}

function boundedMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Defensive credential scrubbing without importing persistence modules —
  // the Intelligence pipeline has no database dependency by design.
  const sanitized = raw.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+@\S+/g, "[redacted-url]");
  return sanitized.slice(0, 500);
}

function tryCanonicalJson(raw: string): string | null {
  try {
    return canonicalJsonStringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Intelligence vertical-slice driver.
 *
 * SiteIntelligenceRequest + ResearchEvidenceBundle
 *   → strict validation → deterministic normalization → digests
 *   → isolated model synthesis (bounded repair, max 3 attempts)
 *   → strict plan validation + deterministic quality gates
 *   → deterministic compilation to current create_page SiteTasks
 *   → canonical parseSiteTask validation for every compiled task
 *   → atomic sanitized artifact publication (definitive result LAST)
 *   → structured IntelligenceResult
 *
 * Never throws for run-level failures: every terminal outcome is a
 * structured IntelligenceResult. Never reports success unless every gate
 * passed and artifacts were published and verified.
 */
export async function runIntelligence(
  input: RunIntelligenceInput,
  deps: RunIntelligenceDeps = {},
): Promise<IntelligenceResult> {
  const onProgress = deps.onProgress ?? (() => undefined);
  const runId = generateRunId(deps.now?.() ?? new Date(), deps.runIdSuffix?.() ?? randomRunIdSuffix());
  const runDirectoryRelative = `.factory/intelligence/${runId}`;

  let attemptCount = 0;
  let modelRuntime: ModelRuntime | null = null;
  let siteId: string | null = null;
  let requestDigest: string | null = null;
  let researchDigest: string | null = null;
  let planDigest: string | null = null;
  let factorySourceCommit: string | null = null;
  let artifacts: IntelligenceArtifacts | null = null;
  const warnings: string[] = [];

  const finish = (status: IntelligenceResult["status"], error: IntelligenceError | null): IntelligenceResult => {
    return parseIntelligenceResult({
      version: "v0",
      status,
      runId,
      siteId,
      factorySourceCommit,
      methodologyVersion: INTELLIGENCE_METHODOLOGY_VERSION,
      requestDigest,
      researchDigest,
      planDigest,
      attemptCount,
      modelRuntime,
      artifacts,
      taskCount: artifacts?.tasks.length ?? 0,
      warnings: warnings.slice(0, 50),
      error,
    });
  };

  try {
    // --- 1. Request validation (one source of site identity) ---
    let request: SiteIntelligenceRequest;
    try {
      request = parseSiteIntelligenceRequest(input.requestInput);
    } catch (error) {
      return finish("failed", { code: "intelligence_input_invalid", message: boundedMessage(error) });
    }
    siteId = request.siteId;
    onProgress(`request validated: siteId=${request.siteId}`);

    // --- 2. Research validation ---
    let bundle: ResearchEvidenceBundle;
    try {
      bundle = parseResearchEvidenceBundle(input.researchInput);
    } catch (error) {
      return finish("failed", { code: "research_input_invalid", message: boundedMessage(error) });
    }
    onProgress(`research validated: ${bundle.items.length} evidence record(s)`);

    // --- 3. Non-destructive normalization + deterministic digests ---
    const normalized: NormalizedResearchEvidenceBundle = normalizeResearchBundle(bundle);
    const duplicateCount = countDuplicateEvidenceRecords(normalized);
    if (duplicateCount > 0) {
      warnings.push(
        `${duplicateCount} evidence record(s) marked as likely duplicates via duplicateOf; all records preserved`,
      );
    }
    requestDigest = deterministicDigest(request);
    researchDigest = deterministicDigest(normalized);

    // --- 4. Factory source provenance ---
    const source = await (deps.sourceCommitResolver ?? resolveFactorySourceCommit)(input.repoRoot);
    if (source.commit === null) {
      return finish("failed", {
        code: "intelligence_artifact_failed",
        message: "factory source commit could not be resolved via git; provenance is mandatory",
      });
    }
    factorySourceCommit = source.commit;
    if (source.dirty) {
      warnings.push("factory working tree contained uncommitted changes during the run");
    }
    onProgress(`factorySourceCommit=${factorySourceCommit}`);

    // --- 5. Fresh artifact root (never reuse previous runs) ---
    let runDir: string;
    try {
      runDir = await prepareRunDirectory(input.repoRoot, runId);
    } catch (error) {
      return finish("failed", { code: "intelligence_artifact_failed", message: boundedMessage(error) });
    }
    artifacts = { runDirectory: runDirectoryRelative, manifest: null, plan: null, tasks: [], result: null };

    // --- 6. Intermediate artifacts (safe to exist before success) ---
    await writeArtifact(runDir, "request.json", `${JSON.stringify(request, null, 2)}\n`);
    await writeArtifact(runDir, "normalized-research.json", `${JSON.stringify(normalized, null, 2)}\n`);
    await writeArtifact(runDir, "request-digest.txt", `${requestDigest}\n`);
    await writeArtifact(runDir, "research-digest.txt", `${researchDigest}\n`);

    // --- 7. Isolated synthesis with bounded repair ---
    const codexRunner = deps.codexRunner ?? createCodexRunner({ repoRoot: input.repoRoot });
    const timeoutMs = deps.synthesisTimeoutMs ?? SYNTHESIS_TIMEOUT_MS;
    onProgress("starting isolated synthesis");
    const workspace = await prepareSynthesisWorkspace(input.repoRoot, runId, {
      prompt: buildSynthesisPrompt(request, normalized),
      requestJson: canonicalJsonStringify(request),
      researchJson: canonicalJsonStringify(normalized),
    });

    try {
      let previousRaw: string | null = null;
      let previousCanonical: string | null = null;
      let repairIssues: string[] | null = null;
      let plan: SiteIntelligencePlan | null = null;

      for (let attemptNumber = 1; attemptNumber <= MAX_SYNTHESIS_ATTEMPTS; attemptNumber++) {
        attemptCount = attemptNumber;
        const prompt =
          repairIssues !== null && previousRaw !== null
            ? buildSynthesisRepairPrompt(request, normalized, previousRaw, repairIssues)
            : buildSynthesisPrompt(request, normalized);
        await writeArtifact(runDir, `attempts/${attemptNumber}/prompt.txt`, prompt);
        await writeWorkspacePrompt(workspace, prompt);

        let attempt: Awaited<ReturnType<typeof runSynthesisAttempt>>;
        try {
          attempt = await runSynthesisAttempt(codexRunner, {
            workspace,
            prompt,
            runArtifactDir: path.join(runDir, "attempts", String(attemptNumber)),
            timeoutMs,
          });
        } catch (error) {
          const code: IntelligenceErrorCode =
            error instanceof FactoryError && error.code === "strong_execution_isolation_unavailable"
              ? "intelligence_isolation_unavailable"
              : "intelligence_model_failed";
          return finish("failed", { code, message: boundedMessage(error) });
        }
        modelRuntime = parseModelRuntimeFromStdout(attempt.codex.stdout, attempt.codex.version);
        await writeArtifact(
          runDir,
          `attempts/${attemptNumber}/raw-output.txt`,
          attempt.rawOutput ?? `<<no output file: ${attempt.outputError ?? "unknown"}>>\n`,
        );
        // Runtime evidence (bounded): raw event stream and stderr for audits.
        await writeArtifact(runDir, `attempts/${attemptNumber}/codex-stdout.txt`, attempt.codex.stdout.slice(0, 65_536));
        await writeArtifact(runDir, `attempts/${attemptNumber}/codex-stderr.txt`, attempt.codex.stderr.slice(0, 65_536));
        onProgress(`synthesis attempt ${attemptNumber} finished (exit=${attempt.codex.exitCode})`);

        if (attempt.codex.timedOut) {
          return finish("failed", {
            code: "intelligence_model_timeout",
            message: `synthesis attempt ${attemptNumber} timed out after ${timeoutMs}ms`,
          });
        }
        if (attempt.codex.exitCode !== 0) {
          return finish("failed", {
            code: "intelligence_model_failed",
            message: `synthesis attempt ${attemptNumber} failed with exit code ${attempt.codex.exitCode ?? "signal"}`,
          });
        }

        // No-progress detection: identical raw output or identical canonical
        // content over an already-invalid attempt stops the loop early.
        const currentCanonical = attempt.rawOutput !== null ? tryCanonicalJson(attempt.rawOutput) : null;
        if (previousRaw !== null) {
          const rawIdentical = attempt.rawOutput !== null && attempt.rawOutput === previousRaw;
          const canonicalIdentical =
            currentCanonical !== null && previousCanonical !== null && currentCanonical === previousCanonical;
          if (rawIdentical || canonicalIdentical) {
            return finish("needs_review", {
              code: "intelligence_no_progress",
              message: `synthesis attempt ${attemptNumber} repeated the previous invalid output without progress`,
            });
          }
        }

        const parsed = parseModelPlanOutput(attempt.rawOutput, attempt.outputError);
        if (!parsed.ok) {
          if (attemptNumber === MAX_SYNTHESIS_ATTEMPTS) {
            return finish("needs_review", {
              code: "intelligence_attempts_exhausted",
              message: `all ${MAX_SYNTHESIS_ATTEMPTS} synthesis attempts produced invalid output: ${parsed.error}`,
            });
          }
          previousRaw = attempt.rawOutput;
          previousCanonical = currentCanonical;
          repairIssues = [parsed.error];
          continue;
        }

        const validation = validateSiteIntelligencePlan(parsed.value, { request, research: normalized });
        if (!validation.ok) {
          if (attemptNumber === MAX_SYNTHESIS_ATTEMPTS) {
            return finish("needs_review", {
              code: "intelligence_attempts_exhausted",
              message: `all ${MAX_SYNTHESIS_ATTEMPTS} synthesis attempts produced invalid plans (${validation.issues.length} issue(s); first: ${validation.issues[0] ?? "unknown"})`,
            });
          }
          previousRaw = attempt.rawOutput;
          previousCanonical = currentCanonical;
          repairIssues = validation.issues;
          continue;
        }

        plan = validation.plan;
        break;
      }

      if (plan === null) {
        return finish("needs_review", {
          code: "intelligence_attempts_exhausted",
          message: "synthesis produced no valid plan",
        });
      }
      const resolvedPlanDigest = deterministicDigest(plan);
      planDigest = resolvedPlanDigest;
      onProgress("plan validated by deterministic quality gates");

      // --- 8. Deterministic compilation to current SiteTasks ---
      let compiled: CompiledIntelligenceTask[];
      try {
        compiled = compilePlanToTasks(plan, request);
      } catch (error) {
        return finish("failed", {
          code: "intelligence_task_compilation_failed",
          message: boundedMessage(error),
        });
      }

      // --- 9. Publication: intermediates, then manifest, then result LAST ---
      await writeArtifact(runDir, "site-intelligence.json", `${JSON.stringify(plan, null, 2)}\n`);
      const taskRelativePaths: string[] = [];
      for (const compiledTask of compiled) {
        const relativePath = `tasks/${compiledTask.fileName}`;
        await writeArtifact(runDir, relativePath, `${JSON.stringify(compiledTask.task, null, 2)}\n`);
        taskRelativePaths.push(relativePath);
      }

      const manifestFiles = [
        "request.json",
        "normalized-research.json",
        "request-digest.txt",
        "research-digest.txt",
        "site-intelligence.json",
        ...taskRelativePaths,
      ];
      const digests = await buildArtifactDigests(runDir, manifestFiles);
      const manifest = {
        runId,
        siteId: request.siteId,
        status: "succeeded",
        factorySourceCommit,
        methodologyVersion: INTELLIGENCE_METHODOLOGY_VERSION,
        requestDigest,
        researchDigest,
        planDigest,
        attemptCount,
        modelRuntime,
        artifacts: ["manifest.json", "intelligence-result.json", ...manifestFiles],
        compiledTaskCount: taskRelativePaths.length,
        digests,
      };
      await publishJsonAtomically(runDir, "manifest.json", manifest);
      // Manifest integrity + stale-artifact proof BEFORE any success report.
      await verifyArtifactIntegrity(runDir, digests, resolvedPlanDigest);

      artifacts = {
        runDirectory: runDirectoryRelative,
        manifest: "manifest.json",
        plan: "site-intelligence.json",
        tasks: taskRelativePaths,
        result: "intelligence-result.json",
      };
      warnings.push(...plan.warnings);

      const result = finish("succeeded", null);
      // The definitive successful result is published LAST, atomically.
      await publishJsonAtomically(runDir, "intelligence-result.json", result);
      onProgress(`run complete: ${taskRelativePaths.length} compiled task(s)`);
      return result;
    } finally {
      // Temporary model workspace is always cleaned: success, validation
      // failure, model failure, and timeout included.
      await removeSynthesisWorkspace(workspace);
    }
  } catch (error) {
    const code: IntelligenceErrorCode =
      error instanceof FactoryError && (INTELLIGENCE_ERROR_CODES as readonly string[]).includes(error.code)
        ? (error.code as IntelligenceErrorCode)
        : "intelligence_artifact_failed";
    return finish("failed", { code, message: boundedMessage(error) });
  }
}
