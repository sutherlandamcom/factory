import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { FactoryError } from "./errors.js";
import {
  CLAUDE_VERSION,
  CLAUDE_WORKER_IMAGE,
  assertStrongExecutionIsolationAvailable,
  dockerClientEnv,
} from "./isolation.js";
import { FACTORY_RUNTIME_NETWORK, OPENROUTER_EGRESS_HOST } from "./network.js";
import { loadOpenRouterApiKey, scrubCredentials } from "../models/gateway.js";
import { codeWorkerBinding } from "../models/policy.js";
import { runProcess } from "./process.js";
import { startModelRelay } from "./relay.js";
import type { CodeWorkerRuntime } from "./runtime.js";

/**
 * Claude Code runtime adapter (Factory senior code worker: implementation
 * escalation, senior_required work, and read-only senior review).
 *
 * Trust and security properties (must never be weakened):
 * - Strong outer isolation is asserted before first use (dedicated Colima
 *   QEMU VM + hardened ephemeral Docker worker under the DEFAULT hardened
 *   seccomp profile). Claude Code's own sandbox features are NOT relied on;
 *   the outer boundary is authoritative (Factory rule: never trust inner
 *   sandbox claims).
 * - The container runs non-root, read-only-rootfs, capability-free,
 *   no-new-privileges, resource-bounded, worktree read-only except the
 *   exact writable parent paths.
 * - Credentials: The worker container has NO real OPENROUTER_API_KEY. All
 *   model requests route through the trusted local Factory model relay, which
 *   owns the real API key and enforces model binding (anthropic/claude-opus-5).
 *   The container receives only an ephemeral dummy authorization token.
 *   No host HOME, no host Claude configuration (CLAUDE_CONFIG_DIR is a
 *   per-run ephemeral tmpfs), no other credentials.
 * - Model pinning: ANTHROPIC_MODEL plus every model-alias env var are pinned
 *   to exact OpenRouter slugs (anthropic/claude-opus-5) so neither main nor
 *   auxiliary/background calls can silently select another model. The Factory
 *   settings.json denies WebFetch/WebSearch and subagent tools; MCP connectors
 *   are disabled.
 * - Provenance: requestedModel comes from the Factory policy; respondedModel
 *   and usage are read from the runtime's JSON result when genuinely
 *   present, otherwise null — never invented.
 */

const CLAUDE_CONFIG_DIR = "/tmp/home/.claude";

/** Exact OpenRouter slugs pinned for Claude Code main + auxiliary calls. */
export const CLAUDE_SENIOR_MODEL = "anthropic/claude-opus-5";
export const CLAUDE_SMALL_FAST_MODEL = "anthropic/claude-opus-5";

/**
 * Candidate (base URL, endpoint path) pairs for OpenRouter's
 * Anthropic-compatible Messages surface. The probe resolves the exact
 * working combination before any run depends on it; an unresolvable surface
 * fails closed (`claude_runtime_unavailable`).
 */
export const ANTHROPIC_SURFACE_CANDIDATES: ReadonlyArray<{ baseUrl: string; messagesPath: string }> = [
  { baseUrl: "https://openrouter.ai/api", messagesPath: "/v1/messages" },
  { baseUrl: "https://openrouter.ai/api/v1", messagesPath: "/messages" },
];

/** Pure builder for the ephemeral Claude Code settings.json (unit-tested). */
export function buildClaudeSettingsJson(): string {
  return JSON.stringify(
    {
      // Factory-supplied trusted configuration only: no MCP servers, no
      // plugins, no hooks, no inherited user state.
      permissions: {
        defaultMode: "acceptEdits",
        deny: [
          "WebFetch",
          "WebSearch",
          "Task",
          "Agent",
          "EnterPlanMode",
          "ExitPlanMode",
          "NotebookEdit",
        ],
      },
      env: {
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    null,
    2,
  );
}

/**
 * Pure builder for the pinned Claude Code container environment
 * (unit-tested with a placeholder token; the real token never appears in
 * pure-builder outputs or artifacts).
 */
export function buildClaudeRuntimeEnv(authToken: string, anthropicBaseUrl: string): NodeJS.ProcessEnv {
  return {
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    CLAUDE_CONFIG_DIR,
    // OpenRouter Anthropic-compatible surface (probe-resolved).
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    // Exact model pinning: main calls AND auxiliary/small-fast calls.
    ANTHROPIC_MODEL: CLAUDE_SENIOR_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_SMALL_FAST_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_SENIOR_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_SENIOR_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_SMALL_FAST_MODEL,
    // No MCP, no claude.ai connectors, no telemetry/auto-update traffic.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function safeContainerName(runDir: string): string {
  const base = path.basename(path.dirname(runDir)).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 38);
  return `factory-claude-${base}-${randomBytes(4).toString("hex")}`;
}

/** Pure docker-args builder. Env values are passed verbatim (tests use placeholders). */
export function buildClaudeContainerArgs(
  request: Parameters<CodeWorkerRuntime>[0],
  containerName: string,
  runtimeDir: string,
  runtimeEnv: NodeJS.ProcessEnv,
): string[] {
  const containerUid = process.getuid?.() ?? 1000;
  const containerGid = process.getgid?.() ?? 1000;
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    // Dedicated allowlist-only network (outer DOCKER-USER egress rules).
    "--network",
    FACTORY_RUNTIME_NETWORK,
    "--user",
    `${containerUid}:${containerGid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--mount",
    `type=bind,src=${request.worktreePath},dst=/workspace${request.workspaceWritable ? "" : ",readonly"}`,
  ];
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value === undefined) continue;
    args.push("--env", `${key}=${value}`);
  }
  if (!request.workspaceWritable) {
    const writableParents = [...new Set(request.writablePaths.map((relativePath) => path.dirname(relativePath)))];
    for (const relativeParent of writableParents) {
      args.push(
        "--mount",
        `type=bind,src=${path.join(request.worktreePath, relativeParent)},dst=${path.posix.join("/workspace", relativeParent)}`,
      );
    }
  }
  args.push(
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "config")},dst=/claude-config,readonly`,
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "output")},dst=/output`,
    "--workdir",
    "/workspace",
    CLAUDE_WORKER_IMAGE,
  );
  return args;
}

export interface ClaudeRuntimeOptions {
  repoRoot: string;
  /** Credential loader override (tests); defaults to the OpenRouter loader. */
  loadApiKey?: () => string | null;
  /** Surface probe override (tests). */
  resolveSurface?: () => Promise<{ baseUrl: string }>;
}

/** Probe OpenRouter's Anthropic-compatible surface; fail closed when absent. */
export async function resolveAnthropicSurface(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ baseUrl: string }> {
  const errors: string[] = [];
  for (const candidate of ANTHROPIC_SURFACE_CANDIDATES) {
    const url = `${candidate.baseUrl}${candidate.messagesPath}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLAUDE_SENIOR_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      // 404/405 mean "surface not present at this path"; anything else
      // (200/400/401/403/429) proves the endpoint exists and is routable.
      if (response.status !== 404 && response.status !== 405) {
        return { baseUrl: candidate.baseUrl };
      }
      errors.push(`${url}: HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${url}: ${scrubCredentials(error instanceof Error ? error.message : String(error), apiKey)}`);
    }
  }
  throw new FactoryError(
    "claude_runtime_unavailable",
    `OpenRouter Anthropic-compatible surface could not be verified (fail closed): ${errors.join("; ")}`.slice(0, 500),
  );
}

/** Strong production runner: Colima VM → hardened Docker worker → Claude Code. */
export function createClaudeCodeRunner(opts: ClaudeRuntimeOptions): CodeWorkerRuntime {
  let isolationReady: Promise<void> | undefined;
  let surfaceReady: Promise<{ baseUrl: string }> | undefined;

  return async (request) => {
    isolationReady ??= assertStrongExecutionIsolationAvailable(opts.repoRoot);
    await isolationReady;

    const binding = codeWorkerBinding("senior");
    if (binding.runtime !== "claude-code") {
      throw new FactoryError(
        "routing_violation",
        `claude runtime adapter selected but policy senior runtime is ${binding.runtime}`,
      );
    }

    const apiKey = (opts.loadApiKey ?? loadOpenRouterApiKey)();
    if (apiKey === null) {
      throw new FactoryError(
        "claude_credentials_unavailable",
        "OPENROUTER_API_KEY is not configured; the claude-code runtime fails closed without credentials",
      );
    }

    const containerName = safeContainerName(request.runDir);
    const relay = await startModelRelay({
      tier: "senior",
      apiKey,
      repoRoot: opts.repoRoot,
      containerName,
    });

    const runtimeRoot = path.join(opts.repoRoot, ".factory", "claude-runtime");
    const runtimeDir = path.join(runtimeRoot, containerName);
    const configDir = path.join(runtimeDir, "config");
    const outputDir = path.join(runtimeDir, "output");

    for (const relativePath of request.writablePaths) {
      const absolute = path.resolve(request.worktreePath, relativePath);
      const relative = path.relative(request.worktreePath, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new FactoryError("scope_violation", `${relativePath}: writable path escapes worktree`);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
    }

    try {
      await mkdir(configDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });
      const settingsPath = path.join(configDir, "settings.json");
      await writeFile(settingsPath, buildClaudeSettingsJson(), { mode: 0o600 });
      await chmod(settingsPath, 0o600);

      const runtimeEnv = buildClaudeRuntimeEnv(relay.relayToken, relay.baseUrl);
      const args = buildClaudeContainerArgs(request, containerName, runtimeDir, runtimeEnv);
      const result = await runProcess("docker", args, {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: request.timeoutMs,
        input: request.prompt,
      });

      const parsed = parseClaudeJsonResult(result.stdout);

      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        runtimeVersion: `claude-code ${CLAUDE_VERSION}`,
        requestedModel: binding.model,
        respondedModel: parsed?.model ?? null,
        provider: "openrouter",
        reasoningEffort: binding.reasoningEffort,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await relay.close().catch(() => undefined);
      await runProcess("docker", ["rm", "--force", containerName], {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: 30_000,
      }).catch(() => undefined);
      // Removes the ephemeral config; guaranteed for every outcome.
      await rm(runtimeDir, { recursive: true, force: true });
    }
  };
}

export interface ClaudeJsonResult {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsd: number | null;
}

/** Best-effort parse of `claude -p --output-format json` output; nulls when absent. */
export function parseClaudeJsonResult(stdout: string): ClaudeJsonResult | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    return {
      model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model.slice(0, 200) : null,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    };
  } catch {
    return null;
  }
}
