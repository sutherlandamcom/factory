import { z } from "zod";

/**
 * TaskResult — the structured outcome the executor reports back to the
 * control plane for one SiteTask run. Written to
 * `.factory/runs/<runId>/task-result.json` on every run, success or failure.
 */

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
  "codex",
  "scope",
  "qa",
  "verify",
  "complete",
]);

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
});

export const taskVerificationSchema = z.object({
  passed: z.boolean(),
  details: z.string(),
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

export const attemptResultSchema = z.object({
  attemptNumber: z.number().int().positive(),
  kind: attemptKindSchema,
  stage: taskStageSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  codex: codexOutcomeSchema.optional(),
  scope: attemptScopeOutcomeSchema.optional(),
  qa: qaOutcomeSchema.optional(),
  taskVerification: taskVerificationSchema.optional(),
  changes: changeSetSchema.optional(),
  classification: failureClassificationSchema.optional(),
  error: taskErrorSchema.optional(),
  artifacts: z.object({
    attemptDirectory: z.string(),
  }),
});

export const taskResultSchema = z.object({
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
  totalAttempts: z.number().int().nonnegative(),
  successfulAttempt: z.number().int().positive().nullable().optional(),
  attempts: z.array(attemptResultSchema).optional(),
  codex: codexOutcomeSchema.optional(),
  qa: qaOutcomeSchema.optional(),
  taskVerification: taskVerificationSchema.optional(),
  changes: changeSetSchema.optional(),
  artifacts: z.object({
    /** Run artifact directory, relative to the repository root. */
    runDirectory: z.string(),
  }),
  error: taskErrorSchema.optional(),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type AttemptKind = z.infer<typeof attemptKindSchema>;
export type FailureClassification = z.infer<typeof failureClassificationSchema>;
export type TaskStage = z.infer<typeof taskStageSchema>;
export type CodexOutcome = z.infer<typeof codexOutcomeSchema>;
export type QaOutcome = z.infer<typeof qaOutcomeSchema>;
export type TaskVerification = z.infer<typeof taskVerificationSchema>;
export type ChangeSet = z.infer<typeof changeSetSchema>;
export type TaskError = z.infer<typeof taskErrorSchema>;
export type AttemptScopeOutcome = z.infer<typeof attemptScopeOutcomeSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
