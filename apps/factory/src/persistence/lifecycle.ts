import path from "node:path";
import type { AttemptResult, TaskStage } from "@factory/contracts";
import type { FactoryStore } from "./store.js";
import type { AttemptRecord } from "./schema.js";

export interface ModelInvocationEvent {
  attemptNumber: number;
  provider: string;
  model?: string | null;
  runtime: string;
  runtimeVersion?: string | null;
  methodologyVersion?: string | null;
  /** Trusted Factory tier of the selected worker (code-worker-routing-v0). */
  workerTier?: string | null;
  requestedModel?: string | null;
  respondedModel?: string | null;
  reasoningEffort?: string | null;
  escalation?: boolean | null;
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
}

export interface QualityGateEvent {
  attemptNumber: number;
  gate: string;
  passed: boolean;
  summary?: string | null;
  artifactRef?: string | null;
}

export interface AttemptStartedEvent {
  attemptNumber: number;
  kind: "initial" | "repair";
  stage: TaskStage;
  startedAt: Date;
  attemptDir: string;
}

export interface AttemptCompletedEvent {
  attemptNumber: number;
  attemptResult: AttemptResult;
}

export interface ExecutorLifecycleObserver {
  onAttemptStarted?: (event: AttemptStartedEvent) => Promise<void>;
  onModelInvocation?: (event: ModelInvocationEvent) => Promise<void>;
  onQualityGateEvaluated?: (event: QualityGateEvent) => Promise<void>;
  onAttemptCompleted?: (event: AttemptCompletedEvent) => Promise<void>;
}

export class DatabaseLifecycleObserver implements ExecutorLifecycleObserver {
  private readonly attemptsMap = new Map<number, AttemptRecord>();

  constructor(
    private readonly store: FactoryStore,
    private readonly runId: string,
    private readonly taskId: string,
    private readonly taskType: string,
    private readonly repoRoot: string,
  ) {}

  async onAttemptStarted(event: AttemptStartedEvent): Promise<void> {
    const relArtifactDir = path.relative(this.repoRoot, event.attemptDir);
    const record = await this.store.beginAttempt({
      runId: this.runId,
      taskId: this.taskId,
      attemptNumber: event.attemptNumber,
      kind: event.kind,
      stage: event.stage,
      startedAt: event.startedAt,
      artifactDirectory: relArtifactDir,
    });
    this.attemptsMap.set(event.attemptNumber, record);
  }

  async onModelInvocation(event: ModelInvocationEvent): Promise<void> {
    const attempt = this.attemptsMap.get(event.attemptNumber);
    if (!attempt) return;

    await this.store.recordModelInvocation({
      runId: this.runId,
      taskId: this.taskId,
      attemptId: attempt.id,
      taskKind: this.taskType,
      provider: event.provider,
      model: event.model,
      runtime: event.runtime,
      runtimeVersion: event.runtimeVersion,
      methodologyVersion: event.methodologyVersion,
      workerTier: event.workerTier ?? null,
      requestedModel: event.requestedModel ?? null,
      reasoningEffort: event.reasoningEffort ?? null,
      escalation: event.escalation ?? null,
      escalationReason: event.escalationReason ?? null,
      exitCode: event.exitCode ?? null,
      status: event.status,
      startedAt: event.startedAt,
      finishedAt: event.finishedAt,
      durationMs: event.durationMs,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      costMicros: event.costMicros,
      errorCode: event.errorCode,
      artifactRef: event.artifactRef,
    });
  }

  async onQualityGateEvaluated(event: QualityGateEvent): Promise<void> {
    const attempt = this.attemptsMap.get(event.attemptNumber);
    if (!attempt) return;

    await this.store.recordQualityResult({
      runId: this.runId,
      taskId: this.taskId,
      attemptId: attempt.id,
      gate: event.gate,
      passed: event.passed,
      summary: event.summary,
      artifactRef: event.artifactRef,
    });
  }

  async onAttemptCompleted(event: AttemptCompletedEvent): Promise<void> {
    const attempt = this.attemptsMap.get(event.attemptNumber);
    if (!attempt) return;

    const res = event.attemptResult;
    const status: "succeeded" | "failed" | "needs_review" | "interrupted" =
      res.stage === "complete"
        ? "succeeded"
        : res.classification === "exhausted" || res.classification === "no_progress"
          ? "needs_review"
          : "failed";

    await this.store.completeAttempt({
      attemptId: attempt.id,
      stage: res.stage,
      status,
      classification: res.classification ?? null,
      finishedAt: new Date(res.finishedAt),
      durationMs: res.durationMs,
      errorCode: res.error?.code ?? null,
      errorMessage: res.error?.message ?? null,
      artifactDirectory: res.artifacts?.attemptDirectory ?? null,
    });
  }
}
