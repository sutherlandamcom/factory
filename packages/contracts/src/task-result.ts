import { z } from "zod";

/**
 * TaskResult — the structured outcome the executor reports back to the
 * control plane for one SiteTask run. Written to
 * `.factory/runs/<runId>/task-result.json` on every run, success or failure.
 */

export const MAX_TOTAL_ATTEMPTS = 3;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Validates an attempt count against the hard ceiling [1, MAX_TOTAL_ATTEMPTS].
 * Throws an Error if invalid.
 */
export function validateMaxAttempts(value: unknown): number {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(`FACTORY_MAX_ATTEMPTS must be an integer between 1 and ${MAX_TOTAL_ATTEMPTS} (got "${value}")`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed < 1 || parsed > MAX_TOTAL_ATTEMPTS) {
      throw new Error(`FACTORY_MAX_ATTEMPTS cannot exceed hard ceiling of ${MAX_TOTAL_ATTEMPTS} (got ${parsed})`);
    }
    return parsed;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_ATTEMPTS) {
      throw new Error(`maxAttempts must be an integer between 1 and ${MAX_TOTAL_ATTEMPTS} (got ${value})`);
    }
    return value;
  }

  throw new Error(`Invalid maxAttempts configuration: expected integer between 1 and ${MAX_TOTAL_ATTEMPTS}`);
}

export const taskStatusSchema = z.enum(["succeeded", "failed", "needs_review"]);

export const attemptKindSchema = z.enum(["initial", "repair"]);

export const failureClassificationSchema = z.enum([
  "repairable",
  "non_repairable",
  "exhausted",
  "no_progress",
]);

/** Pipeline stage the run reached (and, on failure, died in). */
export const taskStageSchema = z.enum([
  "validation",
  "preflight",
  "worktree",
  "dependencies",
  "isolation",
  /** Legacy stage name written by pre-routing runs (read for old artifacts). */
  "codex",
  /** Coding-worker execution stage used by routed (multi-runtime) runs. */
  "worker",
  "scope",
  "integrity",
  "qa",
  "verify",
  "replay",
  "complete",
]);

/** Coding runtimes the Factory code-worker router may select. */
export const workerRuntimeSchema = z.enum(["codex-cli", "kimi-code-cli", "claude-code"]);

/** Trusted Factory tier of the selected worker (never an untrusted field). */
export const workerTierSchema = z.enum(["primary", "senior"]);

/**
 * Generalized coding-worker execution outcome. `codex` below is the legacy
 * shape kept for backward-compatible reading of pre-routing artifacts; all
 * new runs record `worker` regardless of runtime.
 */
export const workerOutcomeSchema = z.object({
  runtime: workerRuntimeSchema,
  /** Runtime-reported version string, or null when genuinely unavailable. */
  runtimeVersion: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  /** Exact model id Factory pinned for this invocation, or null for runtimes that own model selection. */
  requestedModel: z.string().nullable(),
  /** Model identity reported by the runtime/gateway, or null when unavailable. */
  respondedModel: z.string().nullable(),
  /** Configured reasoning effort for the invocation, or null when not applicable. */
  reasoningEffort: z.string().nullable(),
  workerTier: workerTierSchema,
  /** True when this attempt escalated to the senior runtime after an eligible failure. */
  escalation: z.boolean(),
  escalationReason: z.string().nullable(),
});

export const codexOutcomeSchema = z.object({
  exitCode: z.number().int().nullable(),
  /** Codex CLI version string, when it could be determined. */
  version: z.string().nullable(),
  timedOut: z.boolean(),
});

export const qaOutcomeSchema = z.object({
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  foundationPassed: z.boolean().optional(),
  dynamicPassed: z.boolean().optional(),
  failureGate: z.enum(["foundation", "dynamic"]).optional(),
  foundationArtifact: z.string().optional(),
  dynamicArtifact: z.string().optional(),
});

export const taskVerificationSchema = z.object({
  passed: z.boolean(),
  details: z.string(),
});

export const replayOutcomeSchema = z.object({
  passed: z.boolean(),
  details: z.string(),
  error: z.string().optional(),
});

export const changeSetSchema = z.object({
  changedFiles: z.array(z.string()),
  /** Path to the diff.patch artifact, relative to the repository root. */
  patchPath: z.string().nullable(),
});

export const taskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const attemptScopeOutcomeSchema = z.object({
  passed: z.boolean(),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()),
});

export const attemptIntegrityOutcomeSchema = z.object({
  passed: z.boolean(),
  violations: z.array(z.string()),
  baselineArtifact: z.string(),
  currentArtifact: z.string(),
});

export const attemptResultSchema = z.object({
  attemptNumber: z.number().int().min(1).max(MAX_TOTAL_ATTEMPTS),
  kind: attemptKindSchema,
  stage: taskStageSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** Generalized coding-worker outcome (all routed runs). */
  worker: workerOutcomeSchema.optional(),
  /** Legacy Codex-specific outcome (pre-routing artifacts; not written by new runs). */
  codex: codexOutcomeSchema.optional(),
  scope: attemptScopeOutcomeSchema.optional(),
  integrity: attemptIntegrityOutcomeSchema.optional(),
  qa: qaOutcomeSchema.optional(),
  taskVerification: taskVerificationSchema.optional(),
  changes: changeSetSchema.optional(),
  classification: failureClassificationSchema.optional(),
  error: taskErrorSchema.optional(),
  artifacts: z.object({
    attemptDirectory: z.string(),
  }),
});

export const taskResultSchema = z
  .object({
    runId: z.string(),
    status: taskStatusSchema,
    finalStage: taskStageSchema,
    taskType: z.string(),
    siteId: z.string(),
    /** Resolved HEAD SHA the run was based on; "" if preflight never ran. */
    baseCommit: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    totalAttempts: z.number().int().min(0).max(MAX_TOTAL_ATTEMPTS),
    successfulAttempt: z.number().int().min(1).max(MAX_TOTAL_ATTEMPTS).nullable().optional(),
    attempts: z.array(attemptResultSchema).max(MAX_TOTAL_ATTEMPTS).optional(),
    /** Last recorded generalized worker outcome (routed runs). */
    worker: workerOutcomeSchema.optional(),
    /** Legacy last Codex outcome (pre-routing artifacts; not written by new runs). */
    codex: codexOutcomeSchema.optional(),
    qa: qaOutcomeSchema.optional(),
    taskVerification: taskVerificationSchema.optional(),
    replay: replayOutcomeSchema.optional(),
    changes: changeSetSchema.optional(),
    artifacts: z.object({
      /** Run artifact directory, relative to the repository root. */
      runDirectory: z.string(),
    }),
    error: taskErrorSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.successfulAttempt != null && data.successfulAttempt > data.totalAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `successfulAttempt (${data.successfulAttempt}) cannot exceed totalAttempts (${data.totalAttempts})`,
        path: ["successfulAttempt"],
      });
    }
    if (data.attempts) {
      if (data.attempts.length !== data.totalAttempts) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `attempts count (${data.attempts.length}) must match totalAttempts (${data.totalAttempts})`,
          path: ["attempts"],
        });
      }
      for (let i = 0; i < data.attempts.length; i++) {
        const attempt = data.attempts[i]!;
        const expectedNumber = i + 1;
        if (attempt.attemptNumber !== expectedNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `attempt index ${i} has attemptNumber ${attempt.attemptNumber}, expected ${expectedNumber}`,
            path: ["attempts", i, "attemptNumber"],
          });
        }
        const expectedKind = i === 0 ? "initial" : "repair";
        if (attempt.kind !== expectedKind) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `attempt ${expectedNumber} must have kind "${expectedKind}" (got "${attempt.kind}")`,
            path: ["attempts", i, "kind"],
          });
        }
      }
    }
  });

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type AttemptKind = z.infer<typeof attemptKindSchema>;
export type FailureClassification = z.infer<typeof failureClassificationSchema>;
export type TaskStage = z.infer<typeof taskStageSchema>;
export type WorkerRuntime = z.infer<typeof workerRuntimeSchema>;
export type WorkerTier = z.infer<typeof workerTierSchema>;
export type WorkerOutcome = z.infer<typeof workerOutcomeSchema>;
export type CodexOutcome = z.infer<typeof codexOutcomeSchema>;
export type QaOutcome = z.infer<typeof qaOutcomeSchema>;
export type TaskVerification = z.infer<typeof taskVerificationSchema>;
export type ReplayOutcome = z.infer<typeof replayOutcomeSchema>;
export type ChangeSet = z.infer<typeof changeSetSchema>;
export type TaskError = z.infer<typeof taskErrorSchema>;
export type AttemptScopeOutcome = z.infer<typeof attemptScopeOutcomeSchema>;
export type AttemptIntegrityOutcome = z.infer<typeof attemptIntegrityOutcomeSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
