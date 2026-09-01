/**
 * Factory CodeWorkerRuntime seam (code-worker-routing-v0).
 *
 * One small structural seam between the Factory attempt loop and the coding
 * agent runtimes. Implementations exist for exactly three runtimes
 * (`codex-cli`, `kimi-code-cli`, `claude-code`); there is no dynamic runtime
 * loader, no plugin marketplace, and no generic agent framework.
 *
 * Factory owns everything above this seam (worktree, write policy, timeout,
 * diff inspection, QA, replay, cleanup); the runtime implementations own
 * only the containerized invocation of their CLI, including their own
 * credential materialization, ephemeral runtime home, and provenance
 * extraction.
 */

import type { WorkerRuntime } from "@factory/contracts";

export type CodeWorkerRuntimeId = WorkerRuntime;

export interface CodeWorkerRunRequest {
  worktreePath: string;
  prompt: string;
  /** Run artifact directory; raw stdout/stderr land here. */
  runDir: string;
  timeoutMs: number;
  /** Exact logical write authority derived from the validated SiteTask. */
  writablePaths: readonly string[];
  /**
   * Mount the ENTIRE workspace read-write instead of the strict readonly
   * root + per-path writable-parent layout. Only the Intelligence planner
   * uses this (Factory-built throwaway workspace); SiteTask execution never
   * sets it.
   */
  workspaceWritable?: boolean;
}

export interface CodeWorkerRunResult {
  /** Runtime-reported version string (e.g. "kimi-code-cli 0.39.1"); null when genuinely unavailable. */
  runtimeVersion: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Exact model id Factory pinned for this invocation; null for runtimes that own model selection (legacy codex). */
  requestedModel: string | null;
  /** Model identity reported by the runtime/gateway; null when unavailable — never invented. */
  respondedModel: string | null;
  /** Gateway/provider attribution ("openrouter", "openai", ...). */
  provider: string | null;
  /** Configured reasoning effort for this invocation; null when not applicable. */
  reasoningEffort: string | null;
  stdout: string;
  stderr: string;
}

export type CodeWorkerRuntime = (request: CodeWorkerRunRequest) => Promise<CodeWorkerRunResult>;

/** Registry of runtime implementations keyed by runtime id. */
export type CodeWorkerRuntimeRegistry = Partial<Record<CodeWorkerRuntimeId, CodeWorkerRuntime>>;

/**
 * Extract a model identifier from runtime output without inventing one.
 * Scans JSON-shaped lines for a "model" string field and returns the LAST
 * such value (final events describe the actual completion). Returns null
 * when nothing model-shaped is found.
 */
export function extractRespondedModel(stdout: string): string | null {
  const lines = stdout.split("\n");
  let found: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const model = findModelField(parsed, 0);
      if (typeof model === "string" && model.length > 0 && model.length <= 200) {
        found = model;
      }
    } catch {
      // Non-JSON line — ignore.
    }
  }
  return found;
}

function findModelField(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.model === "string") return record.model;
  for (const nested of Object.values(record)) {
    const found = findModelField(nested, depth + 1);
    if (typeof found === "string") return found;
  }
  return undefined;
}
