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
    const succeededAttempts = attempts.filter((a) => a.status === "succeeded");
    if (succeededAttempts.length === 0) {
      throw new FactoryError(
        "persistence_state_invalid",
        `Run '${run.id}' has status 'succeeded' but contains no succeeded attempt in the database.`,
      );
    }
    if (succeededAttempts.length > 1) {
      throw new FactoryError(
        "persistence_state_invalid",
        `Run '${run.id}' has status 'succeeded' but contains multiple succeeded attempts (${succeededAttempts.length}) in the database.`,
      );
    }
    successfulAttempt = succeededAttempts[0]!.attemptNumber;
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
 * 2. Cross-check parsed artifact against durable PostgreSQL state (run-level and attempt-level semantics).
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

  // Run-level semantic consistency cross-check
  const runLevelConsistent =
    artifact.runId === dbResult.runId &&
    artifact.status === dbResult.status &&
    artifact.siteId === dbResult.siteId &&
    artifact.taskType === dbResult.taskType &&
    artifact.baseCommit === dbResult.baseCommit &&
    artifact.totalAttempts === dbResult.totalAttempts &&
    artifact.successfulAttempt === dbResult.successfulAttempt &&
    (dbResult.error?.code === artifact.error?.code);

  if (!runLevelConsistent) {
    return dbResult;
  }

  // Attempt-level semantic consistency cross-check
  if (dbResult.totalAttempts > 0) {
    if (!artifact.attempts || artifact.attempts.length !== dbResult.totalAttempts) {
      return dbResult;
    }

    const attemptsConsistent = artifact.attempts.every((artAtt, idx) => {
      const dbAtt = dbResult.attempts?.[idx];
      if (!dbAtt) return false;
      return (
        artAtt.attemptNumber === dbAtt.attemptNumber &&
        artAtt.kind === dbAtt.kind &&
        artAtt.stage === dbAtt.stage &&
        (artAtt.classification ?? undefined) === (dbAtt.classification ?? undefined) &&
        (artAtt.error?.code ?? undefined) === (dbAtt.error?.code ?? undefined)
      );
    });

    if (!attemptsConsistent) {
      return dbResult;
    }
  }

  return artifact;
}
