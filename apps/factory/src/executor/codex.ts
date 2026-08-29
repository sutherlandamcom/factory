import { existsSync } from "node:fs";
import path from "node:path";
import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

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

/**
 * The one and only Codex execution adapter.
 *
 * Effective policy (codex-cli 0.150.1, verified against `codex exec --help`
 * and live probes on this host):
 * - non-interactive `codex exec`
 * - `--ephemeral`: no session files persisted
 * - `--json`: machine-readable JSONL events on stdout
 * - `--color never`: keep artifacts plain
 * - cwd pinned to the temp worktree via `-C`
 * - sandbox = workspace-write (`-s workspace-write`)
 * - approval policy = never (`-c approval_policy="never"`)
 * - shell network disabled (`-c sandbox_workspace_write.network_access=false`)
 * - web search tool disabled (`-c tools.web_search=false`)
 *
 * There is deliberately no fallback to weaker sandboxing: if the binary or
 * policy is unavailable, the caller must fail closed with
 * codex_environment_failed.
 */
export function createCodexRunner(opts: CodexRunnerOptions): CodexRunner {
  return async (request) => {
    if (!existsSync(opts.codexPath)) {
      throw new FactoryError(
        "codex_environment_failed",
        `codex CLI not found at ${opts.codexPath} — install @openai/codex at the workspace root`,
      );
    }

    const versionResult = await runProcess(opts.codexPath, ["--version"], {
      cwd: request.worktreePath,
      env: buildChildEnv(),
      timeoutMs: opts.versionTimeoutMs ?? 30_000,
    });
    if (versionResult.timedOut || versionResult.exitCode !== 0) {
      throw new FactoryError(
        "codex_environment_failed",
        `codex --version failed: ${versionResult.stderr.trim() || `exit ${versionResult.exitCode}`}`,
      );
    }
    const version = versionResult.stdout.trim() || null;

    const result = await runProcess(
      opts.codexPath,
      [
        "exec",
        "--ephemeral",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "tools.web_search=false",
        "-C",
        request.worktreePath,
        "-o",
        path.join(request.runDir, "codex-last-message.txt"),
        request.prompt,
      ],
      {
        cwd: request.worktreePath,
        env: buildChildEnv(),
        timeoutMs: request.timeoutMs,
      },
    );

    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      version,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
