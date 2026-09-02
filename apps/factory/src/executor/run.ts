import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_TOTAL_ATTEMPTS,
  parseSiteTask,
  validateMaxAttempts,
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
import { adaptCodexRunner, createCodexRunner, type CodexRunner } from "./codex.js";
import { createKimiCodeRunner } from "./kimi.js";
import { createClaudeCodeRunner } from "./claude.js";
import { assertStrongExecutionIsolationAvailable } from "./isolation.js";
import { buildWorkerPrompt, buildWorkerRepairPrompt } from "./prompt.js";
import {
  acceptanceRuntimeOverride,
  classifyProviderFailure,
  classifyTask,
  isEscalationEligible,
  runtimeFailureCodes,
  selectWorkerForAttempt,
  type PreviousFailure,
  type WorkerSelection,
} from "./router.js";
import type { CodeWorkerRuntime, CodeWorkerRuntimeId, CodeWorkerRuntimeRegistry } from "./runtime.js";
import { CODE_WORKER_POLICY, codeWorkerBinding, type CodeWorkerBinding } from "../models/policy.js";
import { buildFailureReport, classifyFailure, type FailureReport } from "./classify.js";
import { collectChanges } from "./scope.js";
import { runQa } from "./qa.js";
import { verifyCreatePage } from "./verify.js";
import { verifyPatchReplay, type ReplayVerificationResult, type VerifyPatchReplayOptions } from "./replay.js";
import { captureIntegritySnapshot, compareIntegritySnapshots } from "./integrity.js";
import { deriveTaskWritePolicy } from "./module-policy.js";

export { DEFAULT_MAX_ATTEMPTS, MAX_TOTAL_ATTEMPTS };

export interface ExecutorTimeouts {
  depsMs: number;
  /** Coding-worker invocation timeout (env FACTORY_CODEX_TIMEOUT_MS, legacy name kept). */
  codexMs: number;
  qaMs: number;
}

export interface ExecutorLifecycleObserver {
  onAttemptStarted?: (info: {
    attemptNumber: number;
    kind: "initial" | "repair";
    stage: TaskStage;
    startedAt: Date;
    attemptDir: string;
  }) => Promise<void>;
  onModelInvocation?: (info: {
    attemptNumber: number;
    provider: string;
    model?: string | null;
    runtime: string;
    runtimeVersion?: string | null;
    methodologyVersion?: string | null;
    /** Trusted Factory tier of the selected worker. */
    workerTier?: "primary" | "senior" | null;
    /** Exact model id Factory pinned for this invocation. */
    requestedModel?: string | null;
    /** Model identity reported by the runtime/gateway (null when unavailable). */
    respondedModel?: string | null;
    /** Configured reasoning effort (null when not applicable). */
    reasoningEffort?: string | null;
    /** True when this attempt escalated to the senior runtime. */
    escalation?: boolean;
    escalationReason?: string | null;
    exitCode?: number | null;
    status: "running" | "succeeded" | "failed" | "interrupted";
    startedAt: Date;
    finishedAt?: Date | null;
    durationMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    costMicros?: number | null;
    errorCode?: string | null;
    artifactRef?: string | null;
  }) => Promise<void>;
  onQualityGateEvaluated?: (info: {
    attemptNumber: number;
    gate: string;
    passed: boolean;
    summary?: string | null;
    artifactRef?: string | null;
  }) => Promise<void>;
  onAttemptCompleted?: (info: {
    attemptNumber: number;
    attemptResult: AttemptResult;
  }) => Promise<void>;
}

/** Injectable boundaries — tests substitute deterministic fakes. */
export interface ExecutorDeps {
  /**
   * Routed runtime registry (production seam). When provided, worker
   * selection comes from the deterministic router and the registry supplies
   * implementations; ids absent from the registry resolve to production
   * adapters on demand.
   */
  workerRuntimes?: CodeWorkerRuntimeRegistry;
  /**
   * Convenience single-implementation injection for attempt-loop mechanics
   * tests and legacy callers: bound to BOTH routed runtime slots so the
   * deterministic router still decides per-attempt selection (and
   * escalation records the senior slot) while every invocation runs the
   * same supplied implementation. Routing-specific tests inject an explicit
   * workerRuntimes registry instead.
   */
  primaryRunner?: CodexRunner;
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
  verifyReplayFn?: (opts: VerifyPatchReplayOptions) => Promise<ReplayVerificationResult>;
  timeouts?: Partial<ExecutorTimeouts>;
  maxAttempts?: number;
  /** Fixed runId for tests; a timestamped id is generated otherwise. */
  runId?: string;
  lifecycle?: ExecutorLifecycleObserver;
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

function generateRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Run one SiteTask end to end with bounded automatic repair:
 * validation → clean-repo preflight → detached worktree → offline dependency
 * prep → [attempt loop: routed coding worker → scope → Factory QA → task verification → replay] →
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

  let error: { code: string; message: string } | undefined;
  const fail = (code: string, message: string): void => {
    error = { code, message };
  };

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  try {
    if (opts.maxAttempts !== undefined) {
      maxAttempts = validateMaxAttempts(opts.maxAttempts);
    } else if (process.env.FACTORY_MAX_ATTEMPTS !== undefined) {
      maxAttempts = validateMaxAttempts(process.env.FACTORY_MAX_ATTEMPTS);
    }
  } catch (err) {
    fail("invalid_configuration", err instanceof Error ? err.message : String(err));
  }

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
  let writePolicy: ReturnType<typeof deriveTaskWritePolicy> | undefined;
  let worktreePath: string | undefined;
  let status: TaskStatus = "failed";
  let successfulAttempt: number | null = null;
  const attempts: AttemptResult[] = [];
  let previousPatch = "";
  let lastScopeResult: Awaited<ReturnType<typeof collectChanges>> | undefined;
  let acceptanceOverride: WorkerSelection | null = null;
  let lastWorkerOutcome: TaskResult["worker"];
  let lastQaOutcome: TaskResult["qa"];
  let lastVerificationOutcome: TaskResult["taskVerification"];
  let lastReplayOutcome: TaskResult["replay"];

  const recordAttempt = async (attemptDir: string, result: AttemptResult): Promise<void> => {
    attempts.push(result);
    await writeFile(
      path.join(attemptDir, "attempt-result.json"),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    if (opts.lifecycle?.onAttemptCompleted) {
      await opts.lifecycle.onAttemptCompleted({
        attemptNumber: result.attemptNumber,
        attemptResult: result,
      });
    }
  };

  try {
    // 1. Validation — before any worktree/worker/modification.
    if (error) {
      throw new FactoryError(error.code, error.message);
    }

    try {
      task = parseSiteTask(taskInput);
      writePolicy = deriveTaskWritePolicy(task);
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

    // Acceptance-only runtime override is trusted Factory process
    // configuration; an invalid value fails closed at validation with zero
    // worker invocations.
    acceptanceOverride = acceptanceRuntimeOverride();

    // Unsafe host-shared coding execution is never an implicit fallback.
    if (!opts.primaryRunner && !opts.workerRuntimes) {
      stage = "isolation";
      await assertStrongExecutionIsolationAvailable(repoRoot);
    }

    // 3. Detached temp worktree at exactly baseCommit.
    stage = "worktree";
    worktreePath = await createWorktree(repoRoot, baseCommit, runId);

    // 4. Deterministic dependency preparation (Factory, never Codex).
    stage = "dependencies";
    const prepare = opts.prepareDependenciesFn ?? prepareDependencies;
    await prepare(worktreePath, timeouts.depsMs);

    // 5. Bounded routed execution and repair loop (code-worker-routing-v0):
    // routine → primary worker attempts 1–2, senior escalation on attempt 3
    // when eligible; senior_required → senior worker from attempt 1; terminal
    // security failures never escalate.
    let failureReport: FailureReport | undefined;
    const routingClass = classifyTask(task);

    const runtimeRegistry: CodeWorkerRuntimeRegistry = { ...(opts.workerRuntimes ?? {}) };
    if (opts.primaryRunner) {
      const shared = adaptCodexRunner(opts.primaryRunner);
      runtimeRegistry[codeWorkerBinding("primary").runtime] = shared;
      runtimeRegistry[codeWorkerBinding("senior").runtime] = shared;
    }
    const resolveRuntime = (runtimeId: CodeWorkerRuntimeId): CodeWorkerRuntime => {
      const existing = runtimeRegistry[runtimeId];
      if (existing) return existing;
      const created: CodeWorkerRuntime =
        runtimeId === "codex-cli"
          ? adaptCodexRunner(createCodexRunner({ repoRoot }))
          : runtimeId === "kimi-code-cli"
            ? createKimiCodeRunner({ repoRoot })
            : createClaudeCodeRunner({ repoRoot });
      runtimeRegistry[runtimeId] = created;
      return created;
    };

    let previousFailure: PreviousFailure | undefined;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      const attemptStartedAt = new Date();
      const attemptDir = path.join(runDir, "attempts", String(attemptNumber));
      await mkdir(attemptDir, { recursive: true });

      const kind: "initial" | "repair" = attemptNumber === 1 ? "initial" : "repair";
      let attemptWorker: AttemptResult["worker"];
      let attemptScope: AttemptResult["scope"];
      let attemptIntegrity: AttemptResult["integrity"];
      let attemptQa: AttemptResult["qa"];
      let attemptVerification: AttemptResult["taskVerification"];
      let attemptChanges: AttemptResult["changes"];
      let attemptClassification: FailureClassification | undefined;
      let attemptError: { code: string; message: string } | undefined;

      if (opts.lifecycle?.onAttemptStarted) {
        await opts.lifecycle.onAttemptStarted({
          attemptNumber,
          kind,
          stage: "worker",
          startedAt: attemptStartedAt,
          attemptDir,
        });
      }

      // Deterministic, Factory-owned worker selection. Untrusted SiteTask
      // content cannot influence it; the acceptance override (trusted
      // process env) takes precedence for REAL isolated runtime acceptance.
      let selection: WorkerSelection;
      if (acceptanceOverride) {
        selection = {
          ...acceptanceOverride,
          requestedModel:
            acceptanceOverride.runtime === "kimi-code-cli"
              ? CODE_WORKER_POLICY.primary.model
              : CODE_WORKER_POLICY.senior.model,
          reasoningEffort:
            acceptanceOverride.runtime === "kimi-code-cli"
              ? CODE_WORKER_POLICY.primary.reasoningEffort
              : CODE_WORKER_POLICY.senior.reasoningEffort,
        };
      } else if (!CODE_WORKER_POLICY.migrationActivated) {
        selection = {
          runtime: CODE_WORKER_POLICY.legacyRuntime,
          tier: "primary",
          requestedModel: null,
          reasoningEffort: null,
          escalation: false,
          escalationReason: null,
        };
      } else {
        selection = selectWorkerForAttempt(routingClass, attemptNumber, previousFailure, {
          primary: codeWorkerBinding("primary"),
          senior: codeWorkerBinding("senior"),
        });
      }

      const integrityBaseline = await captureIntegritySnapshot(worktreePath);
      const integrityBaselinePath = path.join(attemptDir, "integrity-baseline.json");
      await writeFile(integrityBaselinePath, JSON.stringify(integrityBaseline, null, 2), "utf8");

      stage = "worker";
      const runtimeImpl = resolveRuntime(selection.runtime);

      const prompt =
        attemptNumber === 1
          ? buildWorkerPrompt(task, writePolicy)
          : buildWorkerRepairPrompt(task, failureReport!, writePolicy);

      const workerResult = await runtimeImpl({
        worktreePath,
        prompt,
        runDir: attemptDir,
        timeoutMs: timeouts.codexMs,
        writablePaths: writePolicy.writablePaths,
      });
      stage = "worker";

      attemptWorker = {
        runtime: selection.runtime,
        runtimeVersion: workerResult.runtimeVersion,
        exitCode: workerResult.exitCode,
        timedOut: workerResult.timedOut,
        // What Factory PINNED for this attempt (router bindings) is the
        // authoritative requested-model provenance.
        requestedModel: selection.requestedModel ?? workerResult.requestedModel,
        respondedModel: workerResult.respondedModel,
        reasoningEffort: workerResult.reasoningEffort,
        workerTier: selection.tier,
        escalation: selection.escalation,
        escalationReason: selection.escalationReason,
      };
      lastWorkerOutcome = attemptWorker;

      await writeFile(path.join(attemptDir, "worker-output.jsonl"), workerResult.stdout, "utf8");
      await writeFile(path.join(attemptDir, "worker-stderr.txt"), workerResult.stderr, "utf8");
      if (workerResult.runtimeVersion) {
        await writeFile(path.join(attemptDir, "worker-version.txt"), `${workerResult.runtimeVersion}\n`, "utf8");
      }

      const runtimeFailed = workerResult.timedOut || workerResult.exitCode !== 0;
      if (opts.lifecycle?.onModelInvocation) {
        await opts.lifecycle.onModelInvocation({
          attemptNumber,
          provider: workerResult.provider ?? "unknown",
          model: workerResult.respondedModel ?? workerResult.requestedModel ?? null,
          runtime: workerResult.runtimeVersion?.split(" ")[0] ?? selection.runtime,
          runtimeVersion: workerResult.runtimeVersion ?? null,
          workerTier: selection.tier,
          requestedModel: workerResult.requestedModel,
          respondedModel: workerResult.respondedModel,
          reasoningEffort: workerResult.reasoningEffort,
          escalation: selection.escalation,
          escalationReason: selection.escalationReason,
          exitCode: workerResult.exitCode,
          status: runtimeFailed ? "failed" : "succeeded",
          startedAt: attemptStartedAt,
          finishedAt: new Date(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          errorCode: runtimeFailed
            ? (workerResult.timedOut ? runtimeFailureCodes(selection.runtime).timeout : runtimeFailureCodes(selection.runtime).executionFailed)
            : null,
          artifactRef: path.relative(repoRoot, path.join(attemptDir, "worker-output.jsonl")),
        });
      }

      // Runtime/model failures and bounded runtime timeouts are
      // escalation-eligible (Factory Model Policy v0.1); legacy codex codes
      // stay terminal. Terminal failures stop immediately and are NEVER
      // routed to the senior runtime.
      if (runtimeFailed) {
        const combinedOutput = `${workerResult.stdout || ""}\n${workerResult.stderr || ""}`;
        const providerCode = classifyProviderFailure(combinedOutput);
        const codes = runtimeFailureCodes(selection.runtime);
        const failureCode = providerCode ?? (workerResult.timedOut ? codes.timeout : codes.executionFailed);
        const failureMessage = providerCode
          ? `${selection.runtime} provider failure (${failureCode}): ${combinedOutput.trim().slice(0, 300)}`
          : workerResult.timedOut
            ? `${selection.runtime} invocation timed out after ${timeouts.codexMs}ms`
            : `${selection.runtime} invocation exited ${workerResult.exitCode}`;
        attemptError = { code: failureCode, message: failureMessage };
        attemptClassification = "non_repairable";
        fail(failureCode, failureMessage);
        if (attemptNumber >= maxAttempts || !isEscalationEligible(failureCode, attemptClassification)) {
          status = "failed";
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "worker",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            worker: attemptWorker,
            classification: attemptClassification,
            error: attemptError,
            artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
          });
          break;
        }
        failureReport = buildFailureReport({
          runId,
          attemptNumber,
          failingStage: "worker",
          failureCode,
          message: failureMessage,
          stdout: workerResult.stdout,
          stderr: workerResult.stderr,
          targetSlug: task.page.slug,
          authorizedScope: writePolicy.writablePaths.join(", "),
        });
        await writeFile(
          path.join(attemptDir, "failure-report.json"),
          JSON.stringify(failureReport, null, 2),
          "utf8",
        );
        previousFailure = { code: failureCode, classification: attemptClassification };
        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "worker",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          worker: attemptWorker,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        continue;
      }

      // 6. Mechanical change discovery + write-scope enforcement.
      stage = "scope";
      const scopeResult = await collectChanges(worktreePath, writePolicy);
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

      if (opts.lifecycle?.onQualityGateEvaluated) {
        await opts.lifecycle.onQualityGateEvaluated({
          attemptNumber,
          gate: "scope",
          passed: scopeResult.violations.length === 0,
          summary:
            scopeResult.violations.length === 0
              ? `Changed files: ${scopeResult.changedFiles.join(", ") || "(none)"}`
              : `Unauthorized paths: ${scopeResult.violations.join(", ")}`,
          artifactRef: path.relative(repoRoot, attemptPatchPath),
        });
      }

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
          worker: attemptWorker,
          scope: attemptScope,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        // Stop immediately on scope violation. No retry, no escalation:
        // a security violation is reported, never laundered through the
        // senior runtime.
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

      if (opts.lifecycle?.onQualityGateEvaluated) {
        await opts.lifecycle.onQualityGateEvaluated({
          attemptNumber,
          gate: "integrity",
          passed: integrity.passed,
          summary: integrity.passed
            ? "Ignored/build-input state unmodified"
            : `Integrity violations: ${integrity.violations.join(", ")}`,
          artifactRef: path.relative(repoRoot, integrityCurrentPath),
        });
      }
      if (!integrity.passed) {
        attemptError = {
          code: "integrity_violation",
          message: `ignored/build-input state changed during worker execution: ${integrity.violations.join(", ")}`,
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
          worker: attemptWorker,
          scope: attemptScope,
          integrity: attemptIntegrity,
          changes: attemptChanges,
          classification: attemptClassification,
          error: attemptError,
          artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
        });
        break;
      }

      // Progress check: on repair attempts, verify changes were made. A
      // no-progress failure is escalation-eligible: the senior runtime takes
      // the next attempt; on the final attempt it ends as needs_review.
      if (attemptNumber > 1) {
        if (scopeResult.patch === previousPatch || scopeResult.changedFiles.length === 0) {
          attemptError = {
            code: "no_progress",
            message: "repair attempt made no new source modifications",
          };
          attemptClassification = "no_progress";
          fail(attemptError.code, attemptError.message);
          previousFailure = { code: "no_progress", classification: attemptClassification };
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "scope",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            worker: attemptWorker,
            scope: attemptScope,
            integrity: attemptIntegrity,
            changes: attemptChanges,
            classification: attemptClassification,
            error: attemptError,
            artifacts: { attemptDirectory: path.relative(repoRoot, attemptDir) },
          });
          if (attemptNumber >= maxAttempts) {
            status = "needs_review";
            break;
          }
          continue;
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

      if (opts.lifecycle?.onQualityGateEvaluated) {
        await opts.lifecycle.onQualityGateEvaluated({
          attemptNumber,
          gate: qaResult.failureGate === "dynamic" ? "dynamic_qa" : "foundation_qa",
          passed: qaResult.passed,
          summary: qaResult.passed
            ? "QA checks passed"
            : `QA exited ${qaResult.exitCode}${qaResult.failureGate ? ` on ${qaResult.failureGate}` : ""}`,
          artifactRef: qaResult.dynamicArtifact ?? qaResult.foundationArtifact ?? null,
        });
      }

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
          worker: attemptWorker,
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
            worker: attemptWorker,
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
          authorizedScope: writePolicy.writablePaths.join(", "),
        });
        previousFailure = { code: "qa_failed", classification: "repairable" };

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
          worker: attemptWorker,
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

      if (opts.lifecycle?.onQualityGateEvaluated) {
        await opts.lifecycle.onQualityGateEvaluated({
          attemptNumber,
          gate: "semantic_verification",
          passed: verification.passed,
          summary: verification.details,
          artifactRef: path.relative(repoRoot, path.join(attemptDir, "task-verification.json")),
        });
      }

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
            worker: attemptWorker,
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
          authorizedScope: writePolicy.writablePaths.join(", "),
        });
        previousFailure = { code: "verification_failed", classification: "repairable" };

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
          worker: attemptWorker,
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

      // 10. Patch self-containment verification (pristine replay from baseCommit)
      stage = "replay";
      const replayVerifier = opts.verifyReplayFn ?? verifyPatchReplay;
      const replayResult = await replayVerifier({
        repoRoot,
        baseCommit,
        patch: scopeResult.patch,
        runId: `${runId}-attempt-${attemptNumber}`,
        timeoutMs: timeouts.qaMs,
        prepareDependenciesFn: opts.prepareDependenciesFn,
      });
      lastReplayOutcome = replayResult;

      await writeFile(
        path.join(attemptDir, "replay-verification.json"),
        JSON.stringify(replayResult, null, 2),
        "utf8",
      );

      if (opts.lifecycle?.onQualityGateEvaluated) {
        await opts.lifecycle.onQualityGateEvaluated({
          attemptNumber,
          gate: "patch_replay",
          passed: replayResult.passed,
          summary: replayResult.details,
          artifactRef: path.relative(repoRoot, path.join(attemptDir, "replay-verification.json")),
        });
      }

      if (!replayResult.passed) {
        if (attemptNumber >= maxAttempts) {
          attemptError = {
            code: "replay_failed",
            message: `${replayResult.details} (attempts exhausted)`,
          };
          attemptClassification = "exhausted";
          fail(attemptError.code, attemptError.message);
          status = "needs_review";
          await recordAttempt(attemptDir, {
            attemptNumber,
            kind,
            stage: "replay",
            startedAt: attemptStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: new Date().getTime() - attemptStartedAt.getTime(),
            worker: attemptWorker,
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
          code: "replay_failed",
          message: replayResult.details,
        };
        attemptClassification = "repairable";
        failureReport = buildFailureReport({
          runId,
          attemptNumber,
          failingStage: "replay",
          failureCode: "replay_failed",
          message: replayResult.details,
          targetSlug: task.page.slug,
          changedFiles: scopeResult.changedFiles,
          authorizedScope: writePolicy.writablePaths.join(", "),
        });
        previousFailure = { code: "replay_failed", classification: "repairable" };

        await writeFile(
          path.join(attemptDir, "failure-report.json"),
          JSON.stringify(failureReport, null, 2),
          "utf8",
        );

        await recordAttempt(attemptDir, {
          attemptNumber,
          kind,
          stage: "replay",
          startedAt: attemptStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: new Date().getTime() - attemptStartedAt.getTime(),
          worker: attemptWorker,
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
        worker: attemptWorker,
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
        fail(err.code, `${err.message} [at ${(err.stack ?? "").split("\n")[1]?.trim().slice(0, 160) ?? "unknown"}]`);
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
    ...(lastWorkerOutcome ? { worker: lastWorkerOutcome } : {}),
    ...(lastQaOutcome ? { qa: lastQaOutcome } : {}),
    ...(lastVerificationOutcome ? { taskVerification: lastVerificationOutcome } : {}),
    ...(lastReplayOutcome ? { replay: lastReplayOutcome } : {}),
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
