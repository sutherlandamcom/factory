import { mkdir } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "./errors.js";
import { runProcess } from "./process.js";
import { buildChildEnv } from "./env.js";

const GIT_TIMEOUT_MS = 60_000;

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

export function worktreePathFor(repoRoot: string, runId: string): string {
  return path.join(repoRoot, ".factory", "worktrees", runId);
}

/**
 * Create a detached worktree at exactly baseCommit, inside the repo's
 * gitignored `.factory/worktrees/` directory. The site is never recursively
 * copied — a worktree shares .git and costs one checkout.
 */
export async function createWorktree(
  repoRoot: string,
  baseCommit: string,
  runId: string,
): Promise<string> {
  const worktreePath = worktreePathFor(repoRoot, runId);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  try {
    await git(repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  } catch (err) {
    if (err instanceof FactoryError) {
      throw new FactoryError("worktree_failed", err.message);
    }
    throw err;
  }
  return worktreePath;
}

/** Remove a worktree. Best-effort idempotent: safe to call twice. */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Already gone or never registered — prune below reconciles either way.
  }
  await git(repoRoot, ["worktree", "prune"]);
}
