import path from "node:path";
import { buildChildEnv } from "./executor/env.js";
import { FactoryError } from "./executor/errors.js";
import { runProcess, type ProcessResult } from "./executor/process.js";

const GIT_TIMEOUT_MS = 60_000;

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<ProcessResult>;

const defaultGitRunner: GitRunner = async (args, cwd, timeoutMs) =>
  await runProcess("git", [...args], {
    cwd,
    env: buildChildEnv(),
    timeoutMs,
  });

/**
 * Resolve the canonical Git repository top-level directory Factory operates
 * on. pnpm executes package scripts with the package directory as the working
 * directory, so process.cwd() is not a reliable repository root when the CLI
 * is launched through the documented root script. This reads the top-level
 * from Git itself (a local, read-only operation — no network, no environment
 * overrides, no pnpm-specific variables) and fails closed when no usable
 * repository root can be resolved. Establishing repository *trust* remains
 * the responsibility of resolveTrustedControlPlaneSource().
 */
export async function resolveRepositoryRoot(
  startDir: string = process.cwd(),
  runner: GitRunner = defaultGitRunner,
): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runner(["rev-parse", "--show-toplevel"], startDir, GIT_TIMEOUT_MS);
  } catch {
    throw new FactoryError(
      "repository_root_unresolved",
      "Unable to execute Git to resolve the repository root.",
    );
  }
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      "repository_root_unresolved",
      "The working directory is not inside a Git repository; Factory cannot resolve a repository root.",
    );
  }
  // Strip exactly one trailing line terminator. Git does not C-quote a path
  // that merely ends in a space or tab, so trimming more than the newline
  // could silently corrupt a genuine toplevel; any remaining surrounding
  // whitespace is refused instead of misdecoded.
  const toplevel = result.stdout.replace(/\r?\n$/u, "");
  if (
    toplevel.length === 0 ||
    toplevel !== toplevel.trim() ||
    toplevel.startsWith('"') ||
    !path.isAbsolute(toplevel)
  ) {
    throw new FactoryError(
      "repository_root_unresolved",
      "Git returned an unusable repository root path.",
    );
  }
  return toplevel;
}
