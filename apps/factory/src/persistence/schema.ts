import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  unique,
  check,
  index,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sites = pgTable(
  "sites",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    cloudflareWorkerName: text("cloudflare_worker_name"),
    productionUrl: text("production_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("sites_project_id_key_unique").on(table.projectId, table.key),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    sourceCommit: text("source_commit").notNull(),
    artifactDigest: text("artifact_digest"),
    versionId: text("version_id"),
    previewUrl: text("preview_url"),
    previousVersionId: text("previous_version_id"),
    workerName: text("worker_name").notNull(),
    productionUrl: text("production_url").notNull(),
    status: text("status").notNull(),
    previewVerified: boolean("preview_verified").notNull().default(false),
    productionVerified: boolean("production_verified").notNull().default(false),
    rolledBack: boolean("rolled_back").notNull().default(false),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    artifactDirectory: text("artifact_directory"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    index("deployments_site_id_created_at_idx").on(table.siteId, table.createdAt),
    check(
      "deployments_status_valid",
      sql`${table.status} IN ('preparing', 'uploaded', 'preview_verified', 'promoting', 'promoted', 'verified', 'rolled_back', 'failed', 'needs_review')`,
    ),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    kind: text("kind").notNull().default("site_task"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull(), // 'running' | 'succeeded' | 'failed' | 'needs_review' | 'interrupted'
    baseCommit: text("base_commit").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    artifactDirectory: text("artifact_directory"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("runs_duration_ms_non_negative", sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
  ],
);

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(), // 'running' | 'succeeded' | 'failed' | 'needs_review' | 'interrupted'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const attempts = pgTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    attemptNumber: integer("attempt_number").notNull(),
    kind: text("kind").notNull(), // 'initial' | 'repair'
    stage: text("stage").notNull(),
    status: text("status").notNull(), // 'running' | 'succeeded' | 'failed' | 'needs_review' | 'interrupted'
    classification: text("classification"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    artifactDirectory: text("artifact_directory"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("attempts_task_id_attempt_number_unique").on(table.taskId, table.attemptNumber),
    check(
      "attempts_attempt_number_bounds",
      sql`${table.attemptNumber} >= 1 AND ${table.attemptNumber} <= 3`,
    ),
    check(
      "attempts_duration_ms_non_negative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
  ],
);

export const qualityResults = pgTable(
  "quality_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    gate: text("gate").notNull(),
    passed: boolean("passed").notNull(),
    summary: text("summary"),
    artifactRef: text("artifact_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("quality_results_attempt_id_gate_unique").on(table.attemptId, table.gate),
  ],
);

export const modelInvocations = pgTable(
  "model_invocations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    taskKind: text("task_kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    runtime: text("runtime").notNull(),
    runtimeVersion: text("runtime_version"),
    methodologyVersion: text("methodology_version"),
    // Code-worker routing provenance (code-worker-routing-v0). All nullable:
    // rows from pre-routing runs (and unknown values) stay valid.
    workerTier: text("worker_tier"),
    requestedModel: text("requested_model"),
    reasoningEffort: text("reasoning_effort"),
    escalation: boolean("escalation"),
    escalationReason: text("escalation_reason"),
    exitCode: integer("exit_code"),
    status: text("status").notNull(), // 'running' | 'succeeded' | 'failed' | 'interrupted'
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    errorCode: text("error_code"),
    artifactRef: text("artifact_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "model_invocations_duration_ms_non_negative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    check(
      "model_invocations_input_tokens_non_negative",
      sql`${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0`,
    ),
    check(
      "model_invocations_output_tokens_non_negative",
      sql`${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0`,
    ),
    check(
      "model_invocations_total_tokens_non_negative",
      sql`${table.totalTokens} IS NULL OR ${table.totalTokens} >= 0`,
    ),
    check(
      "model_invocations_cost_micros_non_negative",
      sql`${table.costMicros} IS NULL OR ${table.costMicros} >= 0`,
    ),
  ],
);

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

export type SiteRecord = typeof sites.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;

export type DeploymentRecord = typeof deployments.$inferSelect;
export type InsertDeployment = typeof deployments.$inferInsert;

export type RunRecord = typeof runs.$inferSelect;
export type InsertRun = typeof runs.$inferInsert;

export type TaskRecord = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

export type AttemptRecord = typeof attempts.$inferSelect;
export type InsertAttempt = typeof attempts.$inferInsert;

export type QualityResultRecord = typeof qualityResults.$inferSelect;
export type InsertQualityResult = typeof qualityResults.$inferInsert;

export type ModelInvocationRecord = typeof modelInvocations.$inferSelect;
export type InsertModelInvocation = typeof modelInvocations.$inferInsert;

// ---------------------------------------------------------------------------
// Operator Kernel: Project Intake drafts + accepted input snapshots (v0)
// ---------------------------------------------------------------------------

/**
 * The single editable Project Intake draft per project. One row per project
 * (PK = project_id). `revision` starts at 0 (empty draft); every save
 * increments it and binds the payload to its canonical digest.
 */
export const projectInputDrafts = pgTable(
  "project_input_drafts",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    payload: jsonb("payload"),
    digest: text("digest"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("project_input_drafts_revision_non_negative", sql`${table.revision} >= 0`),
  ],
);

/**
 * Immutable accepted ProjectInputSnapshot versions. Once accepted, a row is
 * never mutated; re-acceptance after edits creates the next version.
 * `unique(project_id, version)` enforces monotonic per-project versions.
 */
export const projectInputSnapshots = pgTable(
  "project_input_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    payload: jsonb("payload").notNull(),
    digest: text("digest").notNull(),
    acceptedBy: text("accepted_by").notNull().default("operator"),
    acceptanceState: text("acceptance_state").notNull().default("human_accepted"),
    provenance: jsonb("provenance").notNull().default({}),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("project_input_snapshots_project_version_unique").on(table.projectId, table.version),
    check("project_input_snapshots_version_positive", sql`${table.version} >= 1`),
    check("project_input_snapshots_source_revision_positive", sql`${table.sourceRevision} >= 1`),
    check(
      "project_input_snapshots_acceptance_state_valid",
      sql`${table.acceptanceState} IN ('human_accepted')`,
    ),
    index("project_input_snapshots_project_idx").on(table.projectId, table.version),
  ],
);

export type ProjectInputDraftRecord = typeof projectInputDrafts.$inferSelect;
export type InsertProjectInputDraft = typeof projectInputDrafts.$inferInsert;

export type ProjectInputSnapshotRecord = typeof projectInputSnapshots.$inferSelect;
export type InsertProjectInputSnapshot = typeof projectInputSnapshots.$inferInsert;
