import path from "node:path";
import { buildChildEnv } from "../executor/env.js";
import { FactoryError } from "../executor/errors.js";
import { runProcess, type ProcessResult } from "../executor/process.js";
import { createWorktree, removeWorktree } from "../executor/worktree.js";

const GIT_TIMEOUT_MS = 120_000;
const DEPENDENCY_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;
export const ACCEPTED_MAIN_FETCH_ARGS = [
  "fetch",
  "--no-tags",
  "--prune",
  "origin",
  "+refs/heads/main:refs/remotes/origin/main",
] as const;

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

async function checked(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const result = await runProcess(command, args, {
    cwd,
    env: buildChildEnv(),
    timeoutMs,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      "accepted_source_unavailable",
      `${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}

async function checkedGit(
  runner: GitRunner,
  args: readonly string[],
  repoRoot: string,
  failureCode = "accepted_source_unavailable",
): Promise<ProcessResult> {
  const result = await runner(args, repoRoot, GIT_TIMEOUT_MS);
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(failureCode, "Trusted Git source operation failed.");
  }
  return result;
}

export function assertAuthoritativeOrigin(remoteOutput: string): void {
  const urls = remoteOutput.split(/\r?\n/u).map((url) => url.trim()).filter(Boolean);
  const authoritative = /^(?:https:\/\/github\.com\/sutherlandamcom\/factory(?:\.git)?|git@github\.com:sutherlandamcom\/factory(?:\.git)?|ssh:\/\/git@github\.com\/sutherlandamcom\/factory(?:\.git)?)$/u;
  if (urls.length !== 1 || !authoritative.test(urls[0]!)) {
    throw new FactoryError(
      "accepted_source_remote_mismatch",
      "The effective origin fetch URL is not the single authoritative Factory repository.",
    );
  }
}

export function assertTrustedControlPlaneState(
  acceptedCommit: string,
  headCommit: string,
  porcelainStatus: string,
): void {
  if (headCommit.trim() !== acceptedCommit || porcelainStatus.length !== 0) {
    throw new FactoryError(
      "control_plane_unaccepted",
      "Production delivery requires a clean control-plane checkout at authoritative origin/main.",
    );
  }
}

export async function resolveAcceptedSource(
  repoRoot: string,
  runner: GitRunner = defaultGitRunner,
): Promise<string> {
  const remote = await checkedGit(runner, ["remote", "get-url", "--all", "origin"], repoRoot);
  assertAuthoritativeOrigin(remote.stdout);
  await checkedGit(runner, ACCEPTED_MAIN_FETCH_ARGS, repoRoot);
  const resolved = await checkedGit(runner, ["rev-parse", "--verify", "origin/main^{commit}"], repoRoot);
  const sha = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new FactoryError("accepted_source_invalid", `origin/main resolved to invalid commit '${sha}'.`);
  }
  return sha;
}

export async function resolveTrustedControlPlaneSource(
  repoRoot: string,
  runner: GitRunner = defaultGitRunner,
): Promise<string> {
  const acceptedCommit = await resolveAcceptedSource(repoRoot, runner);
  const head = await checkedGit(runner, ["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  const status = await checkedGit(
    runner,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
    "control_plane_unaccepted",
  );
  assertTrustedControlPlaneState(acceptedCommit, head.stdout.trim(), status.stdout);
  return acceptedCommit;
}

export async function assertAcceptedSourceUnchanged(
  repoRoot: string,
  expectedCommit: string,
): Promise<void> {
  const current = await resolveAcceptedSource(repoRoot);
  if (current !== expectedCommit) {
    throw new FactoryError(
      "accepted_source_changed",
      `origin/main moved from ${expectedCommit} to ${current}; the built candidate will not be promoted.`,
    );
  }
}

export async function prepareAcceptedWorktree(repoRoot: string, sourceCommit: string, deploymentId: string): Promise<string> {
  const worktree = await createWorktree(repoRoot, sourceCommit, `delivery-${deploymentId}`);
  const install = await runProcess("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: worktree,
    env: buildChildEnv(),
    timeoutMs: DEPENDENCY_TIMEOUT_MS,
  });
  if (install.timedOut || install.exitCode !== 0) {
    await removeWorktree(repoRoot, worktree);
    throw new FactoryError(
      install.timedOut ? "dependency_prepare_timeout" : "dependency_prepare_failed",
      `Trusted delivery dependency preparation failed: ${install.stderr.trim() || `exit ${install.exitCode}`}`,
    );
  }
  return worktree;
}

export async function buildAcceptedSite(worktree: string, productionUrl: string): Promise<string> {
  const result = await runProcess(
    "pnpm",
    ["--filter", "@factory/site-starter", "run", "build"],
    {
      cwd: worktree,
      env: buildChildEnv(process.env, { PUBLIC_SITE_URL: productionUrl, CI: "1" }),
      timeoutMs: BUILD_TIMEOUT_MS,
    },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      result.timedOut ? "delivery_build_timeout" : "delivery_build_failed",
      `Accepted site build failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return path.join(worktree, "sites", "starter", "dist");
}

export { removeWorktree };
