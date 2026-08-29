import { FactoryError } from "./errors.js";

export interface CodexRunRequest {
  worktreePath: string;
  prompt: string;
  /** Run artifact directory; raw JSONL/stdout/stderr land here. */
  runDir: string;
  timeoutMs: number;
}

export interface CodexRunResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Codex CLI version string, e.g. "codex-cli 0.150.1"; null if unavailable. */
  version: string | null;
  /** Raw stdout (JSONL events when --json is active). */
  stdout: string;
  stderr: string;
}

export type CodexRunner = (request: CodexRunRequest) => Promise<CodexRunResult>;

export interface CodexRunnerOptions {
  /** Path to the codex executable (host install, never the worktree's). */
  codexPath: string;
  versionTimeoutMs?: number;
}

export const STRONG_EXECUTION_ISOLATION_UNAVAILABLE =
  "STRONG_EXECUTION_ISOLATION_UNAVAILABLE";

export function assertStrongExecutionIsolationAvailable(): never {
  throw new FactoryError(
    "strong_execution_isolation_unavailable",
    `${STRONG_EXECUTION_ISOLATION_UNAVAILABLE}: no verified OCI/container execution backend is installed; unsafe host-shared Codex execution is disabled`,
  );
}

/**
 * Default production boundary. The previous host runner is intentionally
 * disabled because workspace-write permits arbitrary host reads. Tests may
 * inject a deterministic CodexRunner, but the CLI never falls back to a
 * host-shared process. A verified OCI adapter can replace this gate later.
 */
export function createCodexRunner(opts: CodexRunnerOptions): CodexRunner {
  void opts;
  return async () => {
    assertStrongExecutionIsolationAvailable();
  };
}
