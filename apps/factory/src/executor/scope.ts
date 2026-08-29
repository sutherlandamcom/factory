import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

/** Allowed change scope for create_page: site source only. */
export const CREATE_PAGE_ALLOWED_PREFIX = "sites/starter/src/";

export interface ChangeScopeResult {
  /** Paths from `git diff --cached --name-only` (post `git add -A`). */
  changedFiles: string[];
  /** Changed paths outside the allowed prefix. */
  violations: string[];
  /** Full binary patch of the staged change set. */
  patch: string;
  /** Raw `git diff --cached --name-status` output, for evidence. */
  nameStatus: string;
}

const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], {
    cwd,
    env: buildChildEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

/**
 * Mechanical write-scope enforcement. Stages everything in the disposable
 * worktree (evidence only — never committed), then takes the authoritative
 * change set from the staged diff: plain `git diff` would miss untracked
 * files Codex created.
 */
export async function collectChanges(
  worktreePath: string,
  allowedPrefix: string = CREATE_PAGE_ALLOWED_PREFIX,
): Promise<ChangeScopeResult> {
  await git(worktreePath, ["add", "-A"]);

  const nameStatus = await git(worktreePath, ["diff", "--cached", "--name-status"]);
  const changedFiles = nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // name-status format: "M\tpath", "A\tpath", "R100\told\tnew", ...
      const parts = line.split("\t");
      return parts[parts.length - 1]!;
    });

  const violations = changedFiles.filter((file) => !file.startsWith(allowedPrefix));
  const patch = await git(worktreePath, ["diff", "--cached", "--binary", "--full-index"]);

  return { changedFiles, violations, patch, nameStatus };
}
