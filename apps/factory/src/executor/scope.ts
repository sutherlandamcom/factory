import { lstat } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";
import { policyAllowsWrite, type TaskWritePolicy } from "./module-policy.js";

export interface GitChange {
  status: string;
  oldMode: string;
  newMode: string;
  path: string;
}

export interface ChangeScopeResult {
  changedFiles: string[];
  violations: string[];
  patch: string;
  /** Human-readable, JSON-escaped evidence; safe for unusual filenames. */
  nameStatus: string;
  /** Authoritative NUL-delimited raw Git evidence. */
  rawEvidence: string;
  changes: GitChange[];
}

const GIT_TIMEOUT_MS = 60_000;
const REGULAR_FILE_MODE = "100644";

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

/** Parse `git diff --raw -z` output. Rename detection is disabled by the caller. */
export function parseRawDiffZ(raw: string): GitChange[] {
  if (raw.length === 0) return [];
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: GitChange[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const header = tokens[i];
    const file = tokens[i + 1];
    if (!header || file === undefined) {
      throw new FactoryError("git_evidence_invalid", "malformed NUL-delimited Git diff evidence");
    }
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(header);
    if (!match) {
      throw new FactoryError("git_evidence_invalid", `unexpected Git raw record ${JSON.stringify(header)}`);
    }
    changes.push({ oldMode: match[1]!, newMode: match[2]!, status: match[3]!, path: file });
  }
  return changes;
}

function modeViolation(change: GitChange): string | undefined {
  if (change.status === "D") {
    return change.oldMode === REGULAR_FILE_MODE && change.newMode === "000000"
      ? undefined
      : `${change.path}: unsupported deletion mode ${change.oldMode}->${change.newMode}`;
  }
  if (change.newMode !== REGULAR_FILE_MODE) {
    return `${change.path}: unsafe Git mode ${change.oldMode}->${change.newMode}`;
  }
  if (change.oldMode !== "000000" && change.oldMode !== REGULAR_FILE_MODE) {
    return `${change.path}: unsafe prior Git mode ${change.oldMode}`;
  }
  return undefined;
}

/** Stages and evaluates every affected path using NUL-delimited evidence. */
export async function collectChanges(
  worktreePath: string,
  policyOrAllowedPaths: TaskWritePolicy | readonly string[],
): Promise<ChangeScopeResult> {
  const policy = Array.isArray(policyOrAllowedPaths) ? undefined : policyOrAllowedPaths as TaskWritePolicy;
  const allowedPaths = Array.isArray(policyOrAllowedPaths) ? new Set(policyOrAllowedPaths) : undefined;

  await git(worktreePath, ["add", "-A"]);
  const rawEvidence = await git(worktreePath, [
    "diff", "--cached", "--raw", "-z", "--no-renames", "--abbrev=40",
  ]);
  const changes = parseRawDiffZ(rawEvidence);
  const changedFiles = changes.map((change) => change.path);
  const violations: string[] = [];

  for (const change of changes) {
    if (!(policy ? policyAllowsWrite(policy, change.path) : allowedPaths!.has(change.path))) {
      violations.push(`${change.path}: path not authorized by TaskWritePolicy`);
    }
    const invalidMode = modeViolation(change);
    if (invalidMode) violations.push(invalidMode);
    if (change.status !== "D") {
      try {
        const stat = await lstat(path.join(worktreePath, change.path));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          violations.push(`${change.path}: filesystem entry is not a regular file`);
        }
        if ((stat.mode & 0o111) !== 0) {
          violations.push(`${change.path}: executable filesystem mode is forbidden`);
        }
      } catch (error) {
        violations.push(`${change.path}: cannot validate filesystem type (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  const patch = await git(worktreePath, [
    "diff", "--cached", "--binary", "--full-index", "--no-renames",
  ]);
  const nameStatus = `${changes.map((change) => JSON.stringify(change)).join("\n")}${changes.length ? "\n" : ""}`;
  return { changedFiles, violations: [...new Set(violations)], patch, nameStatus, rawEvidence, changes };
}
