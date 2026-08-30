import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createWorktree, removeWorktree } from "./worktree.js";
import { prepareDependencies } from "./deps.js";
import { runProcess } from "./process.js";
import { buildChildEnv } from "./env.js";

export interface VerifyPatchReplayOptions {
  repoRoot: string;
  baseCommit: string;
  patch: string;
  runId: string;
  timeoutMs?: number;
  prepareDependenciesFn?: (worktreePath: string, timeoutMs: number) => Promise<void>;
  runReplayCheckBuildFn?: (worktreePath: string, timeoutMs: number) => Promise<{ passed: boolean; details: string }>;
}

export interface ReplayVerificationResult {
  passed: boolean;
  details: string;
  error?: string;
}

const DEFAULT_REPLAY_TIMEOUT_MS = 300_000;

/**
 * Replay and verify that the cumulative diff.patch is self-contained:
 * 1. Creates a separate disposable worktree from immutable baseCommit.
 * 2. Applies the binary-safe diff.patch.
 * 3. Prepares dependencies offline.
 * 4. Runs typecheck and build in the pristine worktree.
 * 5. Cleans up the worktree in all cases.
 */
export async function verifyPatchReplay(
  opts: VerifyPatchReplayOptions,
): Promise<ReplayVerificationResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  const replayRunId = `${opts.runId}-replay`;
  const worktreePath = await createWorktree(opts.repoRoot, opts.baseCommit, replayRunId);

  try {
    // 1. If patch is empty, it means no source changes were made.
    if (!opts.patch || opts.patch.trim().length === 0) {
      return {
        passed: false,
        details: "diff.patch is empty; cannot replay",
        error: "empty_patch",
      };
    }

    // 2. Apply the binary-safe patch to the pristine worktree.
    const tempPatchFile = path.join(worktreePath, ".factory-replay.patch");
    await writeFile(tempPatchFile, opts.patch, "utf8");

    const applyResult = await runProcess(
      "git",
      ["-C", worktreePath, "apply", "--binary", "--whitespace=nowarn", tempPatchFile],
      {
        cwd: worktreePath,
        env: buildChildEnv(),
        timeoutMs: 60_000,
      },
    );

    await unlink(tempPatchFile).catch(() => {});

    if (applyResult.timedOut || applyResult.exitCode !== 0) {
      return {
        passed: false,
        details: `git apply failed: ${applyResult.stderr.trim() || `exit ${applyResult.exitCode}`}`,
        error: "patch_apply_failed",
      };
    }

    // 3. Prepare dependencies offline in the replay worktree.
    const prepFn = opts.prepareDependenciesFn ?? prepareDependencies;
    await prepFn(worktreePath, timeoutMs);

    // 4. Run typecheck and build in the replay worktree.
    if (opts.runReplayCheckBuildFn) {
      return await opts.runReplayCheckBuildFn(worktreePath, timeoutMs);
    }

    const checkResult = await runProcess("pnpm", ["run", "check"], {
      cwd: worktreePath,
      env: buildChildEnv(),
      timeoutMs,
    });

    if (checkResult.timedOut || checkResult.exitCode !== 0) {
      return {
        passed: false,
        details: `pnpm check failed during replay: ${checkResult.stderr.trim() || checkResult.stdout.trim()}`,
        error: "replay_check_failed",
      };
    }

    const buildResult = await runProcess("pnpm", ["run", "build"], {
      cwd: worktreePath,
      env: buildChildEnv(),
      timeoutMs,
    });

    if (buildResult.timedOut || buildResult.exitCode !== 0) {
      return {
        passed: false,
        details: `pnpm build failed during replay: ${buildResult.stderr.trim() || buildResult.stdout.trim()}`,
        error: "replay_build_failed",
      };
    }

    return {
      passed: true,
      details: "diff.patch applied cleanly to baseCommit; pnpm check and pnpm build succeeded in pristine worktree",
    };
  } catch (err) {
    return {
      passed: false,
      details: `replay verification encountered an error: ${err instanceof Error ? err.message : String(err)}`,
      error: "replay_exception",
    };
  } finally {
    await removeWorktree(opts.repoRoot, worktreePath);
  }
}
