import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  parseSiteTask,
  type AttemptResult,
  type FailureClassification,
  type SiteTask,
  type TaskResult,
  type TaskStage,
  type TaskStatus,
} from "@factory/contracts";
import { FactoryError } from "./errors.js";
import { preflight } from "./preflight.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { prepareDependencies } from "./deps.js";
import { assertStrongExecutionIsolationAvailable, createCodexRunner, type CodexRunner } from "./codex.js";
import { buildCodexPrompt, buildRepairPrompt } from "./prompt.js";
import { buildFailureReport, classifyFailure, type FailureReport } from "./classify.js";
import { collectChanges, createPageTargetPath } from "./scope.js";
import { runQa } from "./qa.js";
import { verifyCreatePage } from "./verify.js";
import { captureIntegritySnapshot, compareIntegritySnapshots } from "./integrity.js";

export interface ExecutorTimeouts {
  depsMs: number;
  codexMs: number;
  qaMs: number;
}

/** Injectable boundaries — tests substitute deterministic fakes. */
export interface ExecutorDeps {
  codexRunner?: CodexRunner;
  prepareDependenciesFn?: (worktreePath: string, timeoutMs: number) => Promise<void>;
  runQaFn?: (worktreePath: string, runDir: string, timeoutMs: number, task: SiteTask) => Promise<{
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    foundationPassed?: boolean;
    dynamicPassed?: boolean;
    failureGate?: "foundation" | "dynamic";
    foundationArtifact?: string;
    dynamicArtifact?: string;
  }>;
  verifyFn?: (worktreePath: string, task: SiteTask) => Promise<{ passed: boolean; details: string }>;
  timeouts?: Partial<ExecutorTimeouts>;
  maxAttempts?: number;
  /** Fixed runId for tests; a timestamped id is generated otherwise. */
  runId?: string;
}

export interface RunSiteTaskOptions extends ExecutorDeps {
  /** Any path inside the repository; the top level is resolved via git. */
  repoRoot: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultTimeouts(): ExecutorTimeouts {
  return {
    depsMs: envInt("FACTORY_DEPS_TIMEOUT_MS", 300_000),
    codexMs: envInt("FACTORY_CODEX_TIMEOUT_MS", 1_200_000),
    qaMs: envInt("FACTORY_QA_TIMEOUT_MS", 900_000),
  };
}

export const DEFAULT_MAX_ATTEMPTS = 3;

function generateRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Run one SiteTask end to end with bounded automatic repair:
 * validation → clean-repo preflight → detached worktree → offline dependency
 * prep → [attempt loop: Codex → scope → Factory QA → task verification] →
 * patch artifact → structured TaskResult → cleanup.
 *
 * Always returns a TaskResult (also on failure or needs_review) and always attempts cleanup.
 */
export async function runSiteTask(
  taskInput: unknown,
  opts: RunSiteTaskOptions,
): Promise<TaskResult> {
  const startedAt = new Date();
  const runId = opts.runId ?? generateRunId();
  const timeouts: ExecutorTimeouts = { ...defaultTimeouts(), ...opts.timeouts };
  const maxAttempts = opts.maxAttempts ?? envInt("FACTORY_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);

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
  let status: TaskStatus = "failed";
  let successfulAttempt: number | null = null;
  const attempts: AttemptResult[] = [];
  let previousPatch = "";
  let lastScopeResult: Awaited<ReturnType<typeof collectChanges>> | undefined;
  let lastCodexOutcome: TaskResult["codex"];
  let lastQaOutcome: TaskResult["qa"];
  let lastVerificationOutcome: TaskResult["taskVerification"];

  const fail = (code: string, message: string): void => {
    error = { code, message };
  };

  const recordAttempt = async (attemptDir: string, result: AttemptResult): Promise<void> => {
    attempts.push(result);
    await writeFile(
      path.join(attemptDir, "attempt-result.json"),
      JSON.stringify(result, null, 2),
      "utf8",
    );
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

    // Unsafe host-shared Codex execution is never an implicit fallback.
    if (!opts.codexRunner) {
      stage = "isolation";
      assertStrongExecutionIsolationAvailable();
    }

    // 3. Detached temp worktree at exactly baseCommit.
    stage = "worktree";
    worktreePath = await createWorktree(repoRoot, baseCommit, runId);

    // 4. Deterministic dependency preparation (Factory, never Codex).
    stage = "dependencies";
    const prepare = opts.prepareDependenciesFn ?? prepareDependencies;
    await prepare(worktreePath, timeouts.depsMs);

    // 5. Bounded execution and repair loop.
    let failureReport: FailureReport | undefined;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      const attemptStartedAt = new Date();
      const attemptDir = path.join(runDir, "attempts", String(attemptNumber));
      await mkdir(attemptDir, { recursive: true });

      const kind: "initial" | "repair" = attemptNumber === 1 ? "initial" : "repair";
      let attemptCodex: AttemptResult["codex"];
      let attemptScope: AttemptResult["scope"];
      let attemptIntegrity: AttemptResult["integrity"];
      let attemptQa: AttemptResult["qa"];
      let attemptVerification: AttemptResult["taskVerification"];
      let attemptChanges: AttemptResult["changes"];
      let attemptClassification: FailureClassification | undefined;
      let attemptError: { code: string; message: string } | undefined;

      const integrityBaseline = await captureIntegritySnapshot(worktreePath);
      const integrityBaselinePath = path.join(attemptDir, "integrity-baseline.json");
      await writeFile(integrityBaselinePath, JSON.stringify(integrityBaseline, null, 2), "utf8");

      stage = "codex";
      const codexRunner =
        opts.codexRunner ??
        createCodexRunner({ codexPath: path.join(repoRoot, "node_modules", ".bin", "codex") });

      const prompt =
        attemptNumber === 1
          ? buildCodexPrompt(task)
          : buildRepairPrompt(task, failureReport!);

      const codexResult = await codexRunner({
        worktreePath,
        prompt,
        runDir: attemptDir,
        timeoutMs: timeouts.codexMs,
      });
      stage = "codex";

      attemptCodex = {
        exitCode: codexResult.exitCode,
        version: codexResult.version,
        timedOut: codexResult.timedOut,
      };
      lastCodexOutcome = attemptCodex;

      await writeFile(path.join(attemptDir, "codex-output.jsonl"), codexResult.stdout, "utf8");
      await writeFile(path.join(attemptDir, "codex-stderr.txt"), codexResult.stderr, "utf8");
      if (codexResult.version) {
        await writeFile(path.join(attemptDir, "codex-version.txt"), `${codexResult.version}\n`, "utf8");
      }

      if (codexResult.timedOut) {
        attemptError = { code: "codex_timeout", message: `codex exec timed out after ${timeouts.codexMs}ms` };
        attemptClassification = "non_repairable";
        fail(attemptError.code, attemptError.message);
        status = "failed";
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "codex",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        break;
      }

      if (codexResult.exitCode !== 0) {
        attemptError = { code: "codex_failed", message: `codex exec exited ${codexResult.exitCode}` };
        attemptClassification = "non_repairable";
        fail(attemptError.code, attemptError.message);
        status = "failed";
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "codex",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        break;
      }

      // 6. Mechanical change discovery + write-scope enforcement.
      stage = "scope";
      const scopeResult = await collectChanges(worktreePath, task);
      lastScopeResult = scopeResult;
      await writeFile(path.join(attemptDir, "changed-files.txt"), scopeResult.nameStatus, "utf8");
      await writeFile(path.join(attemptDir, "git-evidence.raw.z"), scopeResult.rawEvidence, "utf8");
      const attemptPatchPath = path.join(attemptDir, "diff.patch");
      await writeFile(attemptPatchPath, scopeResult.patch, "utf8");

      attemptScope = {
        passed: scopeResult.violations.length === 0,
        changedFiles: scopeResult.changedFiles,
        violations: scopeResult.violations,
      };
      attemptChanges = {
        changedFiles: scopeResult.changedFiles,
        patchPath: path.relative(repoRoot, attemptPatchPath),
      };

      if (scopeResult.violations.length > 0) {
        attemptError = {
          code: "scope_violation",
          message: `unauthorized path or file type: ${scopeResult.violations.join(", ")}`,
        };
        attemptClassification = "non_repairable";
        fail(attemptError.code, attemptError.message);
        status = "failed";
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "scope",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          scope: attemptScope,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        // Stop immediately on scope violation. No retry.
        break;
      }

      // 7. Ignored/build-input integrity — defense in depth before any QA runs.
      stage = "integrity";
      const integrityCurrent = await captureIntegritySnapshot(worktreePath);
      const integrityCurrentPath = path.join(attemptDir, "integrity-current.json");
      await writeFile(integrityCurrentPath, JSON.stringify(integrityCurrent, null, 2), "utf8");
      const integrity = compareIntegritySnapshots(integrityBaseline, integrityCurrent);
      attemptIntegrity = {
        passed: integrity.passed,
        violations: integrity.violations,
        baselineArtifact: path.relative(repoRoot, integrityBaselinePath),
        currentArtifact: path.relative(repoRoot, integrityCurrentPath),
      };
      if (!integrity.passed) {
        attemptError = {
          code: "integrity_violation",
          message: `ignored/build-input state changed during Codex execution: ${integrity.violations.join(", ")}`,
        };
        attemptClassification = "non_repairable";
        fail(attemptError.code, attemptError.message);
        status = "failed";
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "integrity",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          scope: attemptScope,
          integrity: attemptIntegrity,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        break;
      }

      // Progress check: on repair attempts, verify changes were made.
      if (attemptNumber > 1) {
        if (scopeResult.patch === previousPatch || scopeResult.changedFiles.length === 0) {
          attemptError = {
            code: "no_progress",
            message: "repair attempt made no new source modifications",
          };
          attemptClassification = "no_progress";
          fail(attemptError.code, attemptError.message);
          status = "needs_review";
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "scope",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            codex: attemptCodex,
            scope: attemptScope,
            integrity: attemptIntegrity,
            changes: attemptChanges,
            classification: attemptClassification,
            error: attemptError,
            artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
          });
          break;
        }
      }
      previousPatch = scopeResult.patch;

      // 8. Foundation regression QA plus dynamic task-page QA.
      stage = "qa";
      const qaRunner = opts.runQaFn ?? runQa;
      const qaResult = await qaRunner(worktreePath, attemptDir, timeouts.qaMs, task);
      attemptQa = {
        passed: qaResult.passed,
        exitCode: qaResult.exitCode,
        timedOut: qaResult.timedOut,
        ...(qaResult.foundationPassed !== undefined ? { foundationPassed: qaResult.foundationPassed } : {}),
        ...(qaResult.dynamicPassed !== undefined ? { dynamicPassed: qaResult.dynamicPassed } : {}),
        ...(qaResult.failureGate ? { failureGate: qaResult.failureGate } : {}),
        ...(qaResult.foundationArtifact ? { foundationArtifact: qaResult.foundationArtifact } : {}),
        ...(qaResult.dynamicArtifact ? { dynamicArtifact: qaResult.dynamicArtifact } : {}),
      };
      lastQaOutcome = attemptQa;

      if (qaResult.timedOut) {
        attemptError = { code: "qa_timeout", message: `Factory QA timed out after ${timeouts.qaMs}ms` };
        attemptClassification = "non_repairable";
        fail(attemptError.code, attemptError.message);
        status = "failed";
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "qa",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          scope: attemptScope,
          integrity: attemptIntegrity,
          qa: attemptQa,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        break;
      }

      if (!qaResult.passed) {
        const qaStdout = await readFile(path.join(attemptDir, "qa-stdout.txt"), "utf8").catch(() => "");
        const qaStderr = await readFile(path.join(attemptDir, "qa-stderr.txt"), "utf8").catch(() => "");

        if (attemptNumber >= maxAttempts) {
          attemptError = {
            code: "qa_failed",
            message: `${qaResult.failureGate ?? "Factory"} QA exited ${qaResult.exitCode} in worktree (attempts exhausted)`,
          };
          attemptClassification = "exhausted";
          fail(attemptError.code, attemptError.message);
          status = "needs_review";
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "qa",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            codex: attemptCodex,
            scope: attemptScope,
            integrity: attemptIntegrity,
            qa: attemptQa,
            changes: attemptChanges,
            classification: attemptClassification,
            error: attemptError,
            artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
          });
          break;
        }

        attemptError = {
          code: "qa_failed",
          message: `${qaResult.failureGate ?? "Factory"} QA exited ${qaResult.exitCode} in worktree for ${task.page.slug}`,
        };
        attemptClassification = "repairable";
        failureReport = buildFailureReport({
          runId,
          attemptNumber,
          failingStage: "qa",
          failureCode: "qa_failed",
          message: attemptError.message,
          stdout: qaStdout,
          stderr: qaStderr,
          targetSlug: task.page.slug,
          changedFiles: scopeResult.changedFiles,
          authorizedScope: createPageTargetPath(task),
        });

        await writeFile(
          path.join(attemptDir, "failure-report.json"),
          JSON.stringify(failureReport, null, 2),
          "utf8",
        );

        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "qa",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          scope: attemptScope,
          integrity: attemptIntegrity,
          qa: attemptQa,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        continue;
      }

      // 9. Task-specific semantic verification against fresh build output.
      stage = "verify";
      const verifier = opts.verifyFn ?? verifyCreatePage;
      const verification = await verifier(worktreePath, task);
      attemptVerification = verification;
      lastVerificationOutcome = verification;
      await writeFile(
        path.join(attemptDir, "task-verification.json"),
        JSON.stringify(verification, null, 2),
        "utf8",
      );

      if (!verification.passed) {
        if (attemptNumber >= maxAttempts) {
          attemptError = {
            code: "verification_failed",
            message: `${verification.details} (attempts exhausted)`,
          };
          attemptClassification = "exhausted";
          fail(attemptError.code, attemptError.message);
          status = "needs_review";
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "verify",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            codex: attemptCodex,
            scope: attemptScope,
            integrity: attemptIntegrity,
            qa: attemptQa,
            taskVerification: attemptVerification,
            changes: attemptChanges,
            classification: attemptClassification,
            error: attemptError,
            artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
          });
          break;
        }

        attemptError = {
          code: "verification_failed",
          message: verification.details,
        };
        attemptClassification = "repairable";
        failureReport = buildFailureReport({
          runId,
          attemptNumber,
          failingStage: "verify",
          failureCode: "verification_failed",
          message: verification.details,
          targetSlug: task.page.slug,
          changedFiles: scopeResult.changedFiles,
          authorizedScope: createPageTargetPath(task),
        });

        await writeFile(
          path.join(attemptDir, "failure-report.json"),
          JSON.stringify(failureReport, null, 2),
          "utf8",
        );

        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "verify",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          codex: attemptCodex,
          scope: attemptScope,
          integrity: attemptIntegrity,
          qa: attemptQa,
          taskVerification: attemptVerification,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        continue;
      }

      // All quality gates passed!
      successfulAttempt = attemptNumber;
      status = "succeeded";
      stage = "complete";
      await recordAttempt(attemptDir, {
        attemptNumber,
        kind,
        stage: "complete",
        startedAt: attemptStartedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: new Date().getTime() - attemptStartedAt.getTime(),
        codex: attemptCodex,
        scope: attemptScope,
        integrity: attemptIntegrity,
        qa: attemptQa,
        taskVerification: attemptVerification,
        changes: attemptChanges,
        artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
      });
      break;
    }
  } catch (err) {
    if (!error) {
      if (err instanceof FactoryError) {
        fail(err.code, err.message);
      } else {
        fail("internal_error", err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
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

  // Persist top-level aggregated artifacts
  if (lastScopeResult) {
    await writeFile(path.join(runDir, "changed-files.txt"), lastScopeResult.nameStatus, "utf8");
    await writeFile(path.join(runDir, "git-evidence.raw.z"), lastScopeResult.rawEvidence, "utf8");
    await writeFile(path.join(runDir, "diff.patch"), lastScopeResult.patch, "utf8");
  }

  const finishedAt = new Date();
  const patchPath = lastScopeResult ? path.join(runDir, "diff.patch") : null;

  const result: TaskResult = {
    runId,
    status,
    finalStage: status === "succeeded" ? "complete" : stage,
    taskType: task?.type ?? "unknown",
    siteId: task?.siteId ?? "unknown",
    baseCommit,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalAttempts: attempts.length,
    successfulAttempt,
    attempts,
    ...(lastCodexOutcome ? { codex: lastCodexOutcome } : {}),
    ...(lastQaOutcome ? { qa: lastQaOutcome } : {}),
    ...(lastVerificationOutcome ? { taskVerification: lastVerificationOutcome } : {}),
    ...(lastScopeResult
      ? {
          changes: {
            changedFiles: lastScopeResult.changedFiles,
            patchPath: patchPath ? path.relative(repoRoot, patchPath) : null,
          },
        }
      : {}),
    artifacts: { runDirectory: path.relative(repoRoot, runDir) },
    ...(error ? { error } : {}),
  };

  await writeFile(path.join(runDir, "task-result.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}
