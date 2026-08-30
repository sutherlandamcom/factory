import path from "node:path";
import {
  taskResultSchema,
  type TaskResult,
  type TaskStage,
  type FailureClassification,
  type AttemptKind,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import type { FactoryStore } from "./store.js";

export type RunDetails = NonNullable<Awaited<ReturnType<FactoryStore["getRunDetails"]>>>;

/**
 * Reconstructs an authoritative TaskResult purely from PostgreSQL operational state.
 * Validates the reconstructed object against taskResultSchema before returning.
 */
export function reconstructTaskResultFromPersistence(
  details: RunDetails,
  repoRoot: string,
): TaskResult {
  const { run, site, tasks, attempts } = details;

  const status: TaskResult["status"] =
    run.status === "succeeded"
      ? "succeeded"
      : run.status === "needs_review"
        ? "needs_review"
        : "failed";

  const totalAttempts = attempts.length;
  let successfulAttempt: number | null = null;
  if (status === "succeeded") {
    const successRecord = attempts.find((a) => a.status === "succeeded");
    successfulAttempt = successRecord ? successRecord.attemptNumber : (attempts[attempts.length - 1]?.attemptNumber ?? null);
  }

  const finalStage: TaskStage =
    status === "succeeded"
      ? "complete"
      : attempts.length > 0
        ? (attempts[attempts.length - 1]!.stage as TaskStage)
        : "validation";

  const runDir = run.artifactDirectory ?? path.join(".factory", "runs", run.id);
  const relRunDir = path.isAbsolute(runDir) ? path.relative(repoRoot, runDir) : runDir;

  const reconstructedAttempts = attempts.map((att, index) => {
    const expectedKind: AttemptKind = index === 0 ? "initial" : "repair";
    const attDir = att.artifactDirectory ?? path.join(runDir, "attempts", String(att.attemptNumber));
    const relAttDir = path.isAbsolute(attDir) ? path.relative(repoRoot, attDir) : attDir;

    return {
      attemptNumber: att.attemptNumber,
      kind: (att.kind as AttemptKind) || expectedKind,
      stage: (att.stage as TaskStage) || "codex",
      startedAt: att.startedAt.toISOString(),
      finishedAt: (att.finishedAt ?? att.startedAt).toISOString(),
      durationMs: Math.max(0, att.durationMs ?? 0),
      ...(att.classification ? { classification: att.classification as FailureClassification } : {}),
      ...(att.errorCode ? { error: { code: att.errorCode, message: att.errorMessage ?? "" } } : {}),
      artifacts: {
        attemptDirectory: relAttDir,
      },
    };
  });

  const reconstructed: TaskResult = {
    runId: run.id,
    status,
    finalStage,
    taskType: tasks[0]?.type ?? "create_page",
    siteId: site.key,
    baseCommit: run.baseCommit,
    startedAt: run.startedAt.toISOString(),
    finishedAt: (run.finishedAt ?? run.startedAt).toISOString(),
    durationMs: Math.max(0, run.durationMs ?? 0),
    totalAttempts,
    successfulAttempt,
    attempts: reconstructedAttempts,
    artifacts: {
      runDirectory: relRunDir,
    },
    ...(run.errorCode ? { error: { code: run.errorCode, message: run.errorMessage ?? "" } } : {}),
  };

  const parsed = taskResultSchema.safeParse(reconstructed);
  if (!parsed.success) {
    throw new FactoryError(
      "persistence_state_invalid",
      `Database state for run '${run.id}' cannot produce a valid TaskResult: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

/**
 * Resolves the terminal TaskResult for an existing run:
 * 1. If task-result.json artifact exists and is valid JSON, validate against taskResultSchema.
 * 2. Cross-check parsed artifact against durable PostgreSQL state.
 * 3. If artifact is valid and fully consistent with DB truth, return it.
 * 4. If artifact is missing, malformed, schema-invalid, or contradicts DB, reconstruct from DB.
 */
export function resolveDurableTaskResult(
  details: RunDetails,
  repoRoot: string,
  rawArtifactContent: string | null,
): TaskResult {
  const dbResult = reconstructTaskResultFromPersistence(details, repoRoot);

  if (!rawArtifactContent) {
    return dbResult;
  }

  let artifactObj: unknown;
  try {
    artifactObj = JSON.parse(rawArtifactContent);
  } catch {
    // Malformed JSON -> DB truth wins
    return dbResult;
  }

  const parsed = taskResultSchema.safeParse(artifactObj);
  if (!parsed.success) {
    // Schema-invalid artifact -> DB truth wins
    return dbResult;
  }

  const artifact = parsed.data;

  // Consistency cross-check between artifact and database truth
  const isConsistent =
    artifact.runId === dbResult.runId &&
    artifact.status === dbResult.status &&
    artifact.baseCommit === dbResult.baseCommit &&
    artifact.totalAttempts === dbResult.totalAttempts &&
    artifact.successfulAttempt === dbResult.successfulAttempt &&
    (dbResult.error ? artifact.error?.code === dbResult.error.code : true) &&
    (!artifact.attempts ||
      artifact.attempts.every((att, idx) => {
        const dbAtt = dbResult.attempts?.[idx];
        return dbAtt && att.attemptNumber === dbAtt.attemptNumber;
      }));

  if (!isConsistent) {
    // Stale or contradicting artifact -> DB truth wins
    return dbResult;
  }

  return artifact;
}
