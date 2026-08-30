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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("sites_project_id_key_unique").on(table.projectId, table.key),
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
