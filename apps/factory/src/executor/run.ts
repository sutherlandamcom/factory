import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseSiteTask, type SiteTask, type TaskResult, type TaskStage } from "@factory/contracts";
import { FactoryError } from "./errors.js";
import { preflight } from "./preflight.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { prepareDependencies } from "./deps.js";
import { createCodexRunner, type CodexRunner } from "./codex.js";
import { buildCodexPrompt } from "./prompt.js";
import { collectChanges } from "./scope.js";
import { runQa } from "./qa.js";
import { verifyCreatePage } from "./verify.js";

export interface ExecutorTimeouts {
  depsMs: number;
  codexMs: number;
  qaMs: number;
}

/** Injectable boundaries — tests substitute deterministic fakes. */
export interface ExecutorDeps {
  codexRunner?: CodexRunner;
  prepareDependenciesFn?: (worktreePath: string, timeoutMs: number) => Promise<void>;
  runQaFn?: (worktreePath: string, runDir: string, timeoutMs: number) => Promise<{
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
  }>;
  verifyFn?: (worktreePath: string, task: SiteTask) => Promise<{ passed: boolean; details: string }>;
  timeouts?: Partial<ExecutorTimeouts>;
  /** Fixed runId for tests; a timestamped id is generated otherwise. */
  runId?: string;
}

export interface RunSiteTaskOptions extends ExecutorDeps {
  /** Any path inside the repository; the top level is resolved via git. */
  repoRoot: string;
}

function envTimeout(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultTimeouts(): ExecutorTimeouts {
  return {
    depsMs: envTimeout("FACTORY_DEPS_TIMEOUT_MS", 300_000),
    codexMs: envTimeout("FACTORY_CODEX_TIMEOUT_MS", 1_200_000),
    qaMs: envTimeout("FACTORY_QA_TIMEOUT_MS", 900_000),
  };
}

function generateRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Run one SiteTask end to end:
 * validation → clean-repo preflight → detached worktree → offline dependency
 * prep → constrained Codex → mechanical scope enforcement → Factory QA →
 * task verification → patch artifact → structured TaskResult → cleanup.
 *
 * Always returns a TaskResult (also on failure) and always attempts cleanup.
 */
export async function runSiteTask(
  taskInput: unknown,
  opts: RunSiteTaskOptions,
): Promise<TaskResult> {
  const startedAt = new Date();
  const runId = opts.runId ?? generateRunId();
  const timeouts: ExecutorTimeouts = { ...defaultTimeouts(), ...opts.timeouts };

  // Resolved after preflight; until then artifacts anchor at opts.repoRoot.
  let repoRoot = opts.repoRoot;
  let runDir = path.join(repoRoot, ".factory", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "task.json"),
    typeof taskInput === "string" ? taskInput : JSON.stringify(taskInput, null, 2),
    "utf8",
  );

  let stage: TaskStage = "validation";
  let baseCommit = "";
  let task: SiteTask | undefined;
  let worktreePath: string | undefined;
  let error: { code: string; message: string } | undefined;
  let codex: TaskResult["codex"];
  let qa: TaskResult["qa"];
  let taskVerification: TaskResult["taskVerification"];
  let changes: TaskResult["changes"];

  const fail = (code: string, message: string): void => {
    error = { code, message };
  };

  try {
    // 1. Validation — before any worktree/Codex/modification.
    try {
      task = parseSiteTask(taskInput);
    } catch (err) {
      fail("invalid_task", err instanceof Error ? err.message : String(err));
      throw new FactoryError("invalid_task", error!.message);
    }

    // 2. Clean-repo preflight.
    stage = "preflight";
    const pre = await preflight(repoRoot);
    repoRoot = pre.repoRoot;
    baseCommit = pre.baseCommit;
    // Re-anchor the run dir at the resolved top level if it moved.
    const resolvedRunDir = path.join(repoRoot, ".factory", "runs", runId);
    if (resolvedRunDir !== runDir) {
      await mkdir(resolvedRunDir, { recursive: true });
      await writeFile(
        path.join(resolvedRunDir, "task.json"),
        typeof taskInput === "string" ? taskInput : JSON.stringify(taskInput, null, 2),
        "utf8",
      );
      runDir = resolvedRunDir;
    }
    await writeFile(path.join(runDir, "base-commit.txt"), `${baseCommit}\n`, "utf8");

    // 3. Detached temp worktree at exactly baseCommit.
    stage = "worktree";
    worktreePath = await createWorktree(repoRoot, baseCommit, runId);

    // 4. Deterministic dependency preparation (Factory, never Codex).
    stage = "dependencies";
    const prepare = opts.prepareDependenciesFn ?? prepareDependencies;
    await prepare(worktreePath, timeouts.depsMs);

    // 5. Constrained Codex execution.
    stage = "codex";
    const codexRunner =
      opts.codexRunner ??
      createCodexRunner({ codexPath: path.join(repoRoot, "node_modules", ".bin", "codex") });
    const codexResult = await codexRunner({
      worktreePath,
      prompt: buildCodexPrompt(task),
      runDir,
      timeoutMs: timeouts.codexMs,
    });
    codex = {
      exitCode: codexResult.exitCode,
      version: codexResult.version,
      timedOut: codexResult.timedOut,
    };
    await writeFile(path.join(runDir, "codex-output.jsonl"), codexResult.stdout, "utf8");
    await writeFile(path.join(runDir, "codex-stderr.txt"), codexResult.stderr, "utf8");
    if (codexResult.version) {
      await writeFile(path.join(runDir, "codex-version.txt"), `${codexResult.version}\n`, "utf8");
    }
    if (codexResult.timedOut) {
      fail("codex_timeout", `codex exec timed out after ${timeouts.codexMs}ms`);
      throw new FactoryError(error!.code, error!.message);
    }
    if (codexResult.exitCode !== 0) {
      fail("codex_failed", `codex exec exited ${codexResult.exitCode}`);
      throw new FactoryError(error!.code, error!.message);
    }

    // 6. Mechanical change discovery + write-scope enforcement.
    stage = "scope";
    const scopeResult = await collectChanges(worktreePath);
    await writeFile(path.join(runDir, "changed-files.txt"), scopeResult.nameStatus, "utf8");
    const patchPath = path.join(runDir, "diff.patch");
    await writeFile(patchPath, scopeResult.patch, "utf8");
    changes = {
      changedFiles: scopeResult.changedFiles,
      patchPath: path.relative(repoRoot, patchPath),
    };
    if (scopeResult.violations.length > 0) {
      // Evidence is already persisted above; no silent revert.
      fail(
        "scope_violation",
        `changes outside allowed scope (sites/starter/src/): ${scopeResult.violations.join(", ")}`,
      );
      throw new FactoryError(error!.code, error!.message);
    }

    // 7. Independent Factory QA in the worktree.
    stage = "qa";
    const qaRunner = opts.runQaFn ?? runQa;
    const qaResult = await qaRunner(worktreePath, runDir, timeouts.qaMs);
    qa = { passed: qaResult.passed, exitCode: qaResult.exitCode, timedOut: qaResult.timedOut };
    if (qaResult.timedOut) {
      fail("qa_timeout", `Factory QA timed out after ${timeouts.qaMs}ms`);
      throw new FactoryError(error!.code, error!.message);
    }
    if (!qaResult.passed) {
      fail("qa_failed", `Factory QA exited ${qaResult.exitCode} in the worktree`);
      throw new FactoryError(error!.code, error!.message);
    }

    // 8. Task-specific verification against the worktree build output.
    stage = "verify";
    const verifier = opts.verifyFn ?? verifyCreatePage;
    const verification = await verifier(worktreePath, task);
    taskVerification = verification;
    await writeFile(
      path.join(runDir, "task-verification.json"),
      JSON.stringify(verification, null, 2),
      "utf8",
    );
    if (!verification.passed) {
      fail("verification_failed", verification.details);
      throw new FactoryError(error!.code, error!.message);
    }

    stage = "complete";
  } catch (err) {
    if (!error) {
      if (err instanceof FactoryError) {
        fail(err.code, err.message);
      } else {
        fail("internal_error", err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    // Always cleanup — success, codex failure, timeout, scope violation, QA
    // failure, verification failure. The main tree is never modified.
    if (worktreePath) {
      try {
        await removeWorktree(repoRoot, worktreePath);
      } catch (err) {
        if (!error) {
          fail(
            "cleanup_failed",
            `failed to remove worktree ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const finishedAt = new Date();
  const result: TaskResult = {
    runId,
    status: error ? "failed" : "succeeded",
    finalStage: error ? stage : "complete",
    taskType: task?.type ?? "unknown",
    siteId: task?.siteId ?? "unknown",
    baseCommit,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(codex ? { codex } : {}),
    ...(qa ? { qa } : {}),
    ...(taskVerification ? { taskVerification } : {}),
    ...(changes ? { changes } : {}),
    artifacts: { runDirectory: path.relative(repoRoot, runDir) },
    ...(error ? { error } : {}),
  };

  await writeFile(path.join(runDir, "task-result.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}
