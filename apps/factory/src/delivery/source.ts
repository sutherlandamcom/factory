import path from "node:path";
import { buildChildEnv } from "../executor/env.js";
import { FactoryError } from "../executor/errors.js";
import { runProcess, type ProcessResult } from "../executor/process.js";
import { createWorktree, removeWorktree } from "../executor/worktree.js";

const GIT_TIMEOUT_MS = 120_000;
const DEPENDENCY_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;

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

export async function resolveAcceptedSource(repoRoot: string): Promise<string> {
  await checked("git", ["fetch", "origin", "--prune"], repoRoot, GIT_TIMEOUT_MS);
  const resolved = await checked("git", ["rev-parse", "--verify", "origin/main^{commit}"], repoRoot, GIT_TIMEOUT_MS);
  const sha = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new FactoryError("accepted_source_invalid", `origin/main resolved to invalid commit '${sha}'.`);
  }
  return sha;
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
