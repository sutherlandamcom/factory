import { FactoryError } from "./errors.js";
import { runProcess } from "./process.js";
import { buildChildEnv } from "./env.js";

export interface PreflightResult {
  /** Resolved absolute path of the repository top level. */
  repoRoot: string;
  /** HEAD SHA — the unambiguous base commit for the run. */
  baseCommit: string;
}

const GIT_TIMEOUT_MS = 30_000;

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", repoRoot, ...args], {
    cwd: repoRoot,
    env: buildChildEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Clean-repo preflight. Fails before any worktree/Codex work when the repo
 * is missing, HEAD is unresolvable, or the working tree has any tracked or
 * untracked (non-ignored) modifications. No stashing, no silent inclusion.
 */
export async function preflight(candidateRoot: string): Promise<PreflightResult> {
  let repoRoot: string;
  try {
    repoRoot = await git(candidateRoot, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    throw new FactoryError(
      "repo_not_found",
      `not a git repository: ${candidateRoot} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  let baseCommit: string;
  try {
    baseCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
  } catch (err) {
    if (err instanceof FactoryError) {
      throw new FactoryError("head_unresolvable", `cannot resolve HEAD: ${err.message}`);
    }
    throw err;
  }

  // --porcelain lists tracked modifications AND untracked non-ignored files.
  const status = await git(repoRoot, ["status", "--porcelain"]);
  if (status.length > 0) {
    throw new FactoryError(
      "dirty_working_tree",
      `working tree is not clean; refusing to run:\n${status}`,
    );
  }

  return { repoRoot, baseCommit };
}
