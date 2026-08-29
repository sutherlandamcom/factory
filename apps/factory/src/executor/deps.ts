import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

/**
 * Deterministic dependency preparation. Factory — never Codex — runs the
 * install, offline from the host's content-addressable pnpm store, against
 * the committed lockfile. Any package missing from the store fails the run.
 */
export async function prepareDependencies(
  worktreePath: string,
  timeoutMs: number,
): Promise<void> {
  const result = await runProcess("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: worktreePath,
    env: buildChildEnv(),
    timeoutMs,
  });
  if (result.timedOut) {
    throw new FactoryError(
      "dependency_prepare_timeout",
      `pnpm install --offline --frozen-lockfile timed out after ${timeoutMs}ms`,
    );
  }
  if (result.exitCode !== 0) {
    throw new FactoryError(
      "dependency_prepare_failed",
      `pnpm install --offline --frozen-lockfile exited ${result.exitCode}:\n${result.stderr.trim()}`,
    );
  }
}
