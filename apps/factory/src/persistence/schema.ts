import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  unique,
  check,
  index,
  foreignKey,
  primaryKey,
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
    // Dev-time model override provenance (FACTORY_MODEL_OVERRIDE__*):
    // rows produced under an override record the actual model plus the
    // champion it replaced, so override artifacts never masquerade as
    // champion-produced. Nullable for all pre-override rows.
    overrideApplied: boolean("override_applied"),
    overriddenChampion: text("overridden_champion"),
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

// ---------------------------------------------------------------------------
// Search Intelligence v0: runs, SERP snapshots, grounded snapshots, intelligence
// ---------------------------------------------------------------------------

/**
 * One governed Search run: operator intent + accepted-input lineage + status.
 * Completed runs never mutate their snapshots; a refresh creates a NEW run
 * and NEW immutable observations (old history is never rewritten).
 */
export const searchRuns = pgTable(
  "search_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id")
      .notNull()
      .references(() => projectInputSnapshots.id, { onDelete: "cascade" }),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    query: text("query").notNull(),
    location: text("location"),
    language: text("language"),
    device: text("device").notNull(),
    provider: text("provider").notNull(),
    sourceRunId: text("source_run_id"),
    /** Cache/dedupe key: provider + normalized inputs + lineage + request version. */
    requestDigest: text("request_digest").notNull(),
    refreshRequested: boolean("refresh_requested").notNull().default(false),
    /** 'running' | 'succeeded' | 'failed' — failed runs never masquerade as evidence. */
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "search_runs_status_valid",
      sql`${table.status} IN ('running', 'succeeded', 'failed')`,
    ),
    check(
      "search_runs_device_valid",
      sql`${table.device} IN ('desktop', 'mobile', 'tablet')`,
    ),
    check("search_runs_duration_ms_non_negative", sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
    index("search_runs_project_created_idx").on(table.projectId, table.createdAt),
    index("search_runs_request_digest_idx").on(table.requestDigest),
  ],
);

/**
 * Immutable exact-SERP observation (StructuredSerpProvider authority).
 * Raw provider payload is retained in bounded form for auditability; the
 * rawDigest proves normalization can be reproduced from stored evidence.
 */
export const serpSnapshots = pgTable(
  "serp_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    query: text("query").notNull(),
    location: text("location"),
    language: text("language"),
    device: text("device").notNull(),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    requestDigest: text("request_digest").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    organic: jsonb("organic").notNull(),
    features: jsonb("features"),
    peopleAlsoAsk: jsonb("people_also_ask"),
    relatedSearches: jsonb("related_searches"),
    rawPayload: jsonb("raw_payload"),
    rawDigest: text("raw_digest").notNull(),
    usage: jsonb("usage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("serp_snapshots_device_valid", sql`${table.device} IN ('desktop', 'mobile', 'tablet')`),
    index("serp_snapshots_project_idx").on(table.projectId, table.observedAt),
    index("serp_snapshots_request_digest_idx").on(table.requestDigest),
  ],
);

/**
 * Immutable grounded-research observation (GroundedSearchProvider authority:
 * what current web evidence tells us — NEVER exact SERP rankings). Absent
 * provider is represented by no rows, not by invented data.
 */
export const groundedSearchSnapshots = pgTable(
  "grounded_search_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    query: text("query").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    promptVersion: text("prompt_version").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    webSearchQueries: jsonb("web_search_queries").notNull(),
    sources: jsonb("sources").notNull(),
    citations: jsonb("citations"),
    structuredOutput: jsonb("structured_output").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    usage: jsonb("usage"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("grounded_search_snapshots_project_idx").on(table.projectId, table.observedAt)],
);

/**
 * Immutable derived Search Intelligence (analyst model is NOT factual
 * authority). Every snapshot carries explicit evidence references to the
 * SERP/grounded snapshots it was derived from.
 */
export const searchIntelligenceSnapshots = pgTable(
  "search_intelligence_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    query: text("query").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    promptVersion: text("prompt_version").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    serpSnapshotId: text("serp_snapshot_id").notNull(),
    groundedSnapshotId: text("grounded_snapshot_id"),
    evidenceDigests: jsonb("evidence_digests").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    reviewState: text("review_state").notNull().default("model_proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "search_intelligence_snapshots_review_state_valid",
      sql`${table.reviewState} IN ('model_proposed', 'operator_reviewed')`,
    ),
    index("search_intelligence_snapshots_project_idx").on(table.projectId, table.createdAt),
  ],
);

export type SearchRunRecord = typeof searchRuns.$inferSelect;
export type InsertSearchRun = typeof searchRuns.$inferInsert;

export type SerpSnapshotRecord = typeof serpSnapshots.$inferSelect;
export type InsertSerpSnapshot = typeof serpSnapshots.$inferInsert;

export type GroundedSearchSnapshotRecord = typeof groundedSearchSnapshots.$inferSelect;
export type InsertGroundedSearchSnapshot = typeof groundedSearchSnapshots.$inferInsert;

export type SearchIntelligenceSnapshotRecord = typeof searchIntelligenceSnapshots.$inferSelect;
export type InsertSearchIntelligenceSnapshot = typeof searchIntelligenceSnapshots.$inferInsert;

// ---------------------------------------------------------------------------
// Competitors + Content Gap v0 (Macro Run 3): runs, page snapshots, analyses,
// gap reports, decisions, accepted gap snapshots
// ---------------------------------------------------------------------------

/**
 * One governed competitor run: resolve accepted upstreams -> select candidates
 * from a persisted SerpSnapshot -> acquire -> extract -> analyze -> propose.
 * Completed runs never mutate their snapshots; a refresh creates a NEW run
 * and NEW observations.
 */
export const competitorRuns = pgTable(
  "competitor_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id")
      .notNull()
      .references(() => projectInputSnapshots.id, { onDelete: "cascade" }),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    /** Exact SERP evidence the candidates were selected from. */
    serpSnapshotId: text("serp_snapshot_id")
      .notNull()
      .references(() => serpSnapshots.id, { onDelete: "cascade" }),
    serpSnapshotDigest: text("serp_snapshot_digest").notNull(),
    intelligenceSnapshotId: text("intelligence_snapshot_id")
      .notNull()
      .references(() => searchIntelligenceSnapshots.id, { onDelete: "cascade" }),
    intelligenceSnapshotDigest: text("intelligence_snapshot_digest").notNull(),
    /** Deterministic acquisition/analysis pipeline version (audit key). */
    pipelineVersion: text("pipeline_version").notNull(),
    /** 'running' | 'succeeded' | 'failed' — failed runs never masquerade. */
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("competitor_runs_status_valid", sql`${table.status} IN ('running', 'succeeded', 'failed')`),
    check(
      "competitor_runs_duration_ms_non_negative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    index("competitor_runs_project_created_idx").on(table.projectId, table.createdAt),
    index("competitor_runs_serp_snapshot_idx").on(table.serpSnapshotId),
  ],
);

/**
 * Immutable competitor page observation + deterministic structural extraction.
 * Raw HTML is retained only within the explicit acquisition ceiling; its
 * digest keeps lineage honest even when content is not retained. Candidate
 * selection lineage (SERP position, classification) is preserved.
 */
export const competitorPageSnapshots = pgTable(
  "competitor_page_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => competitorRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serpSnapshotId: text("serp_snapshot_id")
      .notNull()
      .references(() => serpSnapshots.id, { onDelete: "cascade" }),
    serpPosition: integer("serp_position").notNull(),
    requestedUrl: text("requested_url").notNull(),
    finalUrl: text("final_url"),
    domain: text("domain").notNull(),
    classification: text("classification").notNull(),
    classificationReason: text("classification_reason").notNull(),
    /** 'SUCCESS' | 'BLOCKED' | 'NON_HTML' | 'UNSUPPORTED' | 'FAILED' */
    acquisitionStatus: text("acquisition_status").notNull(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    rawDigest: text("raw_digest"),
    extractionDigest: text("extraction_digest"),
    extracted: jsonb("extracted"),
    snapshotDigest: text("snapshot_digest").notNull(),
    /** Content digest of the final page body (dedupe/change detection). */
    contentDigest: text("content_digest"),
    /** Content-digest dedupe: snapshot reused for an identical page. */
    dedupedFromSnapshotId: text("deduped_from_snapshot_id"),
    /** True when acquired content exceeded the retention ceiling. */
    rawTruncated: boolean("raw_truncated").notNull().default(false),
    provider: text("provider").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "competitor_page_snapshots_classification_valid",
      sql`${table.classification} IN ('INCLUDE', 'EXCLUDE', 'REFERENCE_ONLY')`,
    ),
    check(
      "competitor_page_snapshots_acquisition_status_valid",
      sql`${table.acquisitionStatus} IN ('SUCCESS', 'BLOCKED', 'NON_HTML', 'UNSUPPORTED', 'FAILED')`,
    ),
    index("competitor_page_snapshots_project_idx").on(table.projectId, table.observedAt),
    index("competitor_page_snapshots_run_idx").on(table.runId),
    index("competitor_page_snapshots_content_digest_idx").on(table.projectId, table.contentDigest),
  ],
);

/** Deterministic classification override by the operator (audit trail). */
export const competitorClassificationOverrides = pgTable(
  "competitor_classification_overrides",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageSnapshotId: text("page_snapshot_id")
      .notNull()
      .references(() => competitorPageSnapshots.id, { onDelete: "cascade" }),
    classification: text("classification").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "competitor_classification_overrides_class_valid",
      sql`${table.classification} IN ('INCLUDE', 'EXCLUDE', 'REFERENCE_ONLY')`,
    ),
    index("competitor_classification_overrides_page_idx").on(table.pageSnapshotId),
  ],
);

/**
 * Immutable bounded model interpretation of one competitor page (analyst is
 * NOT factual authority). Conclusions must reference normalized evidence
 * segment IDs; unknown references fail closed before persistence.
 */
export const competitorPageAnalyses = pgTable(
  "competitor_page_analyses",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => competitorRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageSnapshotId: text("page_snapshot_id")
      .notNull()
      .references(() => competitorPageSnapshots.id, { onDelete: "cascade" }),
    reusedFromAnalysisId: text("reused_from_analysis_id"),
    semanticInputDigest: text("semantic_input_digest"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    promptVersion: text("prompt_version").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    packetDigest: text("packet_digest").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    usage: jsonb("usage"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reusedFromAnalysisId],
      foreignColumns: [table.id],
      name: "competitor_page_analyses_reused_from_analysis_id_competitor_page_analyses_id_fk",
    }).onDelete("set null"),
    index("competitor_page_analyses_project_idx").on(table.projectId, table.createdAt),
    index("competitor_page_analyses_page_idx").on(table.pageSnapshotId),
    index("competitor_page_analyses_reused_from_idx").on(table.reusedFromAnalysisId),
    index("competitor_page_analyses_semantic_digest_idx").on(table.semanticInputDigest),
  ],
);

/**
 * Content gap proposal (model_proposed) + reviewed state. Immutable once the
 * reviewed gap set is accepted; a post-acceptance edit flow creates a new
 * proposal/acceptance cycle with a new version.
 */
export const contentGapReports = pgTable(
  "content_gap_reports",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => competitorRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id")
      .notNull()
      .references(() => projectInputSnapshots.id, { onDelete: "cascade" }),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    serpSnapshotId: text("serp_snapshot_id")
      .notNull()
      .references(() => serpSnapshots.id, { onDelete: "cascade" }),
    serpSnapshotDigest: text("serp_snapshot_digest").notNull(),
    intelligenceSnapshotId: text("intelligence_snapshot_id")
      .notNull()
      .references(() => searchIntelligenceSnapshots.id, { onDelete: "cascade" }),
    intelligenceSnapshotDigest: text("intelligence_snapshot_digest").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    promptVersion: text("prompt_version").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    /** 'model_proposed' | 'operator_reviewed' | 'accepted' */
    reviewState: text("review_state").notNull().default("model_proposed"),
    reviewRevision: integer("review_revision").notNull().default(0),
    decisionsDigest: text("decisions_digest"),
    usage: jsonb("usage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "content_gap_reports_review_state_valid",
      sql`${table.reviewState} IN ('model_proposed', 'operator_reviewed', 'accepted')`,
    ),
    index("content_gap_reports_project_idx").on(table.projectId, table.createdAt),
  ],
);

/** Operator per-gap review decisions for one report (audit trail). */
export const contentGapDecisions = pgTable(
  "content_gap_decisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    reportId: text("report_id")
      .notNull()
      .references(() => contentGapReports.id, { onDelete: "cascade" }),
    gapId: text("gap_id").notNull(),
    disposition: text("disposition").notNull(),
    priority: text("priority"),
    note: text("note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "content_gap_decisions_disposition_valid",
      sql`${table.disposition} IN ('REQUIRED', 'OPTIONAL', 'EXCLUDE')`,
    ),
    check(
      "content_gap_decisions_priority_valid",
      sql`${table.priority} IS NULL OR ${table.priority} IN ('HIGH', 'MEDIUM', 'LOW')`,
    ),
    unique("content_gap_decisions_report_gap_unique").on(table.reportId, table.gapId),
    index("content_gap_decisions_report_idx").on(table.reportId),
  ],
);

/**
 * Immutable accepted gap set (human acceptance binds exact report + decision
 * digests). Old versions remain inspectable; staleness is computed by
 * comparing stored upstream refs to current upstream digests.
 */
export const acceptedContentGapSnapshots = pgTable(
  "accepted_content_gap_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    reportId: text("report_id")
      .notNull()
      .references(() => contentGapReports.id, { onDelete: "cascade" }),
    reportDigest: text("report_digest").notNull(),
    decisionsDigest: text("decisions_digest").notNull(),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    serpSnapshotId: text("serp_snapshot_id").notNull(),
    serpSnapshotDigest: text("serp_snapshot_digest").notNull(),
    intelligenceSnapshotId: text("intelligence_snapshot_id").notNull(),
    intelligenceSnapshotDigest: text("intelligence_snapshot_digest").notNull(),
    pageSnapshotRefs: jsonb("page_snapshot_refs").notNull(),
    analysisRefs: jsonb("analysis_refs").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("accepted_content_gap_snapshots_project_version_unique").on(table.projectId, table.version),
    unique("accepted_content_gap_snapshots_report_id_unique").on(table.reportId),
    index("accepted_content_gap_snapshots_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * Durable budget reservation ledger for paid model invocations.
 *
 * A row in state 'ACTIVE' represents authorized-but-not-yet-accounted spend:
 * money that MAY already have been spent. Budget authorization always sums
 * accounted spend + active reservations before permitting a new reservation,
 * so there is never a window where possible spend is invisible to the gate.
 */
export const competitorBudgetReservations = pgTable(
  "competitor_budget_reservations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Conservative worst-case cost authorized for this invocation (micros). */
    authorizedMicros: integer("authorized_micros").notNull(),
    /** Durably accounted spend once terminal; NULL while ACTIVE/RELEASED. */
    accountedMicros: integer("accounted_micros"),
    /** 'ACTIVE' | 'ACCOUNTED' | 'RELEASED' */
    state: text("state").notNull(),
    /** Digest of the exact compiled invocation this reservation authorizes. */
    invocationDigest: text("invocation_digest").notNull(),
    /** Invocation lineage (kind, runId, projectId) for audit. */
    lineage: jsonb("lineage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accountedAt: timestamp("accounted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "competitor_budget_reservations_state_valid",
      sql`${table.state} IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')`,
    ),
    index("competitor_budget_reservations_state_created_idx").on(table.state, table.createdAt),
    index("competitor_budget_reservations_created_idx").on(table.createdAt),
  ],
);

export type CompetitorRunRecord = typeof competitorRuns.$inferSelect;
export type InsertCompetitorRun = typeof competitorRuns.$inferInsert;

export type CompetitorPageSnapshotRecord = typeof competitorPageSnapshots.$inferSelect;
export type InsertCompetitorPageSnapshot = typeof competitorPageSnapshots.$inferInsert;

export type CompetitorPageAnalysisRecord = typeof competitorPageAnalyses.$inferSelect;
export type InsertCompetitorPageAnalysis = typeof competitorPageAnalyses.$inferInsert;

export type ContentGapReportRecord = typeof contentGapReports.$inferSelect;
export type InsertContentGapReport = typeof contentGapReports.$inferInsert;

export type ContentGapDecisionRecord = typeof contentGapDecisions.$inferSelect;
export type InsertContentGapDecision = typeof contentGapDecisions.$inferInsert;

export type AcceptedContentGapSnapshotRecord = typeof acceptedContentGapSnapshots.$inferSelect;
export type InsertAcceptedContentGapSnapshot = typeof acceptedContentGapSnapshots.$inferInsert;

export type CompetitorBudgetReservationRecord = typeof competitorBudgetReservations.$inferSelect;
export type InsertCompetitorBudgetReservation = typeof competitorBudgetReservations.$inferInsert;

/**
 * Durable budget reservation ledger for paid WRITER model invocations.
 * Reuses the exact lifecycle mechanism of competitor_budget_reservations
 * (ACTIVE -> ACCOUNTED | RELEASED under an advisory xact lock) with its own
 * daily limit (FACTORY_WRITER_DAILY_LIMIT_USD).
 */
export const writerBudgetReservations = pgTable(
  "writer_budget_reservations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    authorizedMicros: integer("authorized_micros").notNull(),
    accountedMicros: integer("accounted_micros"),
    state: text("state").notNull(),
    invocationDigest: text("invocation_digest").notNull(),
    lineage: jsonb("lineage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accountedAt: timestamp("accounted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "writer_budget_reservations_state_valid",
      sql`${table.state} IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')`,
    ),
    check(
      "writer_budget_reservations_accounted_valid",
      sql`(${table.state} = 'ACTIVE' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NULL) OR (${table.state} = 'ACCOUNTED' AND ${table.accountedMicros} IS NOT NULL AND ${table.accountedAt} IS NOT NULL) OR (${table.state} = 'RELEASED' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NOT NULL)`,
    ),
    index("writer_budget_reservations_state_created_idx").on(table.state, table.createdAt),
    index("writer_budget_reservations_created_idx").on(table.createdAt),
  ],
);

export type WriterBudgetReservationRecord = typeof writerBudgetReservations.$inferSelect;
export type InsertWriterBudgetReservation = typeof writerBudgetReservations.$inferInsert;

// ---- Writer pipeline (Macro Run 4) -----------------------------------------

/**
 * Factory Writer Policy: versioned, digest-bound, immutable-once-approved
 * projection of the accepted Content Constitution (never a second editable
 * SOT). Approve exact revision + digest -> immutable approved version;
 * edits -> new draft version.
 */
export const writerPolicies = pgTable(
  "writer_policies",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** 'draft' | 'approved' */
    state: text("state").notNull(),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    data: jsonb("data").notNull(),
    policyDigest: text("policy_digest").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("writer_policies_state_valid", sql`${table.state} IN ('draft', 'approved')`),
    unique("writer_policies_project_version_unique").on(table.projectId, table.version),
    check(
      "writer_policies_approved_state_valid",
      sql`(${table.state} = 'draft' AND ${table.approvedAt} IS NULL) OR (${table.state} = 'approved' AND ${table.approvedAt} IS NOT NULL)`,
    ),
    index("writer_policies_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * Content Production Brief: page-level brief composed deterministically from
 * accepted inputs + approved writer policy + operator Page Target fields +
 * accepted gap snapshot lineage. Page Target fields are brief draft fields,
 * not a pages registry.
 */
export const contentBriefs = pgTable(
  "content_briefs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** 'draft' | 'approved' */
    state: text("state").notNull(),
    acceptedInputSnapshotId: text("accepted_input_snapshot_id").notNull(),
    acceptedInputVersion: integer("accepted_input_version").notNull(),
    acceptedInputDigest: text("accepted_input_digest").notNull(),
    writerPolicyId: text("writer_policy_id").notNull(),
    writerPolicyVersion: integer("writer_policy_version").notNull(),
    writerPolicyDigest: text("writer_policy_digest").notNull(),
    gapSnapshotId: text("gap_snapshot_id"),
    gapSnapshotVersion: integer("gap_snapshot_version"),
    gapSnapshotDigest: text("gap_snapshot_digest"),
    /** Explicit, digest-bound operator acknowledgement for missing gap lineage. */
    noGapLineageAcknowledged: boolean("no_gap_lineage_acknowledged").notNull().default(false),
    slug: text("slug").notNull(),
    data: jsonb("data").notNull(),
    briefDigest: text("brief_digest").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("content_briefs_state_valid", sql`${table.state} IN ('draft', 'approved')`),
    unique("content_briefs_project_version_unique").on(table.projectId, table.version),
    check(
      "content_briefs_approved_state_valid",
      sql`(${table.state} = 'draft' AND ${table.approvedAt} IS NULL) OR (${table.state} = 'approved' AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "content_briefs_gap_lineage_valid",
      sql`(${table.gapSnapshotId} IS NOT NULL AND ${table.gapSnapshotVersion} IS NOT NULL AND ${table.gapSnapshotDigest} IS NOT NULL) OR (${table.noGapLineageAcknowledged} = true)`,
    ),
    check(
      "content_briefs_no_gap_flag_consistent",
      sql`(${table.noGapLineageAcknowledged} = false) OR (${table.gapSnapshotId} IS NULL)`,
    ),
    index("content_briefs_project_slug_idx").on(table.projectId, table.slug),
  ],
);

/** WriterPromptSnapshot: exact compiled prompt packet, human-reviewable. */
export const writerPromptSnapshots = pgTable(
  "writer_prompt_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** 'draft' | 'approved' */
    state: text("state").notNull(),
    briefId: text("brief_id").notNull(),
    briefVersion: integer("brief_version").notNull(),
    briefDigest: text("brief_digest").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    userPrompt: text("user_prompt").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("writer_prompt_snapshots_state_valid", sql`${table.state} IN ('draft', 'approved')`),
    unique("writer_prompt_snapshots_project_version_unique").on(table.projectId, table.version),
    check(
      "writer_prompt_snapshots_approved_state_valid",
      sql`(${table.state} = 'draft' AND ${table.approvedAt} IS NULL) OR (${table.state} = 'approved' AND ${table.approvedAt} IS NOT NULL)`,
    ),
    index("writer_prompt_snapshots_project_idx").on(table.projectId, table.version),
  ],
);

/** PageContentProposal: structured writer output bound to the exact snapshot digest. */
export const pageContentProposals = pgTable(
  "page_content_proposals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    slug: text("slug").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    overrideApplied: boolean("override_applied").notNull().default(false),
    overriddenChampion: text("overridden_champion"),
    data: jsonb("data").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("page_content_proposals_project_version_unique").on(table.projectId, table.version),
    index("page_content_proposals_project_idx").on(table.projectId, table.version),
  ],
);

/** Deterministic QA report (factual + search + editorial) for a proposal. */
export const contentQaReports = pgTable(
  "content_qa_reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    data: jsonb("data").notNull(),
    reportDigest: text("report_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("content_qa_reports_proposal_unique").on(table.proposalId),
  ],
);

/** AcceptedPageContent: final human-approved, immutable, digested content. */
export const acceptedPageContent = pgTable(
  "accepted_page_content",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    slug: text("slug").notNull(),
    proposalId: text("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    qaReportDigest: text("qa_report_digest").notNull(),
    data: jsonb("data").notNull(),
    contentDigest: text("content_digest").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("accepted_page_content_project_version_unique").on(table.projectId, table.version),
    unique("accepted_page_content_project_proposal_unique").on(table.projectId, table.proposalId),
    index("accepted_page_content_project_idx").on(table.projectId, table.version),
  ],
);

export type WriterPolicyRecord = typeof writerPolicies.$inferSelect;
export type InsertWriterPolicy = typeof writerPolicies.$inferInsert;
export type ContentBriefRecord = typeof contentBriefs.$inferSelect;
export type InsertContentBrief = typeof contentBriefs.$inferInsert;
export type WriterPromptSnapshotRecord = typeof writerPromptSnapshots.$inferSelect;
export type InsertWriterPromptSnapshot = typeof writerPromptSnapshots.$inferInsert;
export type PageContentProposalRecord = typeof pageContentProposals.$inferSelect;
export type InsertPageContentProposal = typeof pageContentProposals.$inferInsert;
export type ContentQaReportRecord = typeof contentQaReports.$inferSelect;
export type InsertContentQaReport = typeof contentQaReports.$inferInsert;
export type AcceptedPageContentRecord = typeof acceptedPageContent.$inferSelect;
export type InsertAcceptedPageContent = typeof acceptedPageContent.$inferInsert;

// ---------------------------------------------------------------------------
// Assets: Asset Foundation + Operator Photography (Macro Run 5)
// ---------------------------------------------------------------------------

/**
 * Stable logical asset identity within a project (e.g. "Chamonix homepage
 * hero photograph"). An Asset is NOT the mutable latest bytes: versions
 * carry the actual immutable bytes records.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "assets_kind_valid",
      sql`${table.kind} IN ('logo', 'photo', 'illustration', 'chart', 'icon')`,
    ),
    index("assets_project_idx").on(table.projectId, table.createdAt),
  ],
);

/**
 * Immutable representation of exact uploaded bytes. Once created a row is
 * never mutated except the two terminal state transitions
 * pending -> approved | rejected (approval binds the exact binary digest).
 * Assignments bind version_id + digests, so newer versions can never move
 * an existing assignment silently.
 */
export const assetVersions = pgTable(
  "asset_versions",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    provenance: jsonb("provenance").notNull(),
    rightsStatus: text("rights_status").notNull(),
    rightsNote: text("rights_note"),
    altIntent: text("alt_intent"),
    approvalState: text("approval_state").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    governanceDigest: text("governance_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("asset_versions_asset_version_unique").on(table.assetId, table.version),
    unique("asset_versions_project_binary_digest_unique").on(table.projectId, table.binaryDigest),
    check("asset_versions_version_positive", sql`${table.version} >= 1`),
    check("asset_versions_byte_size_positive", sql`${table.byteSize} >= 1`),
    check(
      "asset_versions_media_type_valid",
      sql`${table.mediaType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check(
      "asset_versions_rights_status_valid",
      sql`${table.rightsStatus} IN ('operator_owned', 'licensed', 'public_domain', 'unknown')`,
    ),
    check(
      "asset_versions_approval_state_valid",
      sql`${table.approvalState} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      "asset_versions_state_timestamps_valid",
      sql`(
        (${table.approvalState} = 'pending' AND ${table.approvedAt} IS NULL AND ${table.rejectedAt} IS NULL)
        OR (${table.approvalState} = 'approved' AND ${table.approvedAt} IS NOT NULL AND ${table.rejectedAt} IS NULL)
        OR (${table.approvalState} = 'rejected' AND ${table.approvedAt} IS NULL AND ${table.rejectedAt} IS NOT NULL)
      )`,
    ),
    check(
      "asset_versions_provenance_category_valid",
      sql`${table.provenance} ->> 'category' IN ('operator_upload', 'generated', 'imported')`,
    ),
    // Governance invariant: an approved version ALWAYS carries its
    // governance digest (binary and governance digests are distinct
    // authorities; substitution is forbidden at the store layer too).
    check(
      "asset_versions_approved_governance_digest_required",
      sql`${table.approvalState} <> 'approved' OR ${table.governanceDigest} IS NOT NULL`,
    ),
    index("asset_versions_asset_idx").on(table.assetId, table.version),
    index("asset_versions_project_idx").on(table.projectId),
  ],
);

/**
 * Deterministic responsive derivatives (web/thumb) of an exact version.
 * Identity is content-addressed; rows are immutable.
 */
export const assetDerivatives = pgTable(
  "asset_derivatives",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mediaType: text("media_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("asset_derivatives_version_kind_unique").on(table.versionId, table.kind),
    check("asset_derivatives_kind_valid", sql`${table.kind} IN ('web', 'thumb')`),
    check("asset_derivatives_width_positive", sql`${table.width} >= 1`),
    check("asset_derivatives_height_positive", sql`${table.height} >= 1`),
    check("asset_derivatives_byte_size_positive", sql`${table.byteSize} >= 1`),
    check(
      "asset_derivatives_media_type_valid",
      sql`${table.mediaType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    index("asset_derivatives_version_idx").on(table.versionId),
  ],
);

/**
 * Page/slot assignment binding the EXACT approved version (id + digests
 * copied at bind time). One assignment per (project, page, role); moving to
 * a newer version is always an explicit operator action.
 */
export const assetPageAssignments = pgTable(
  "asset_page_assignments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "restrict" }),
    versionDigest: text("version_digest").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    acceptedPageContentId: text("accepted_page_content_id").references(() => acceptedPageContent.id),
    acceptedPageContentVersion: integer("accepted_page_content_version"),
    acceptedPageContentDigest: text("accepted_page_content_digest"),
    pageSlug: text("page_slug").notNull(),
    role: text("role").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("assignment_page_lineage_complete", sql`(
      (${table.acceptedPageContentId} IS NULL AND ${table.acceptedPageContentVersion} IS NULL AND ${table.acceptedPageContentDigest} IS NULL) OR
      (${table.acceptedPageContentId} IS NOT NULL AND ${table.acceptedPageContentVersion} IS NOT NULL AND ${table.acceptedPageContentDigest} IS NOT NULL AND ${table.acceptedPageContentVersion} > 0 AND ${table.acceptedPageContentDigest} ~ '^[0-9a-f]{64}$')
    )`),
    unique("asset_page_assignments_slot_unique").on(table.projectId, table.pageSlug, table.role),
    check(
      "asset_page_assignments_role_valid",
      sql`${table.role} IN ('hero', 'background', 'inline', 'chart', 'illustration', 'logo', 'supporting')`,
    ),
    check("asset_page_assignments_slug_shape", sql`${table.pageSlug} ~ '^[a-z0-9][a-z0-9/-]*$'`),
    index("asset_page_assignments_project_idx").on(table.projectId),
  ],
);

/**
 * Project-level imagery strategy (Constitution vocabulary). Declaring
 * 'generated'/'mixed' does NOT activate any provider — Run 5 has no
 * generated-imagery path.
 */
export const projectAssetSettings = pgTable(
  "project_asset_settings",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    imageryStrategy: text("imagery_strategy").notNull().default("none"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "project_asset_settings_imagery_strategy_valid",
      sql`${table.imageryStrategy} IN ('none', 'operator', 'generated', 'mixed')`,
    ),
  ],
);

export type AssetRecord = typeof assets.$inferSelect;
export type InsertAsset = typeof assets.$inferInsert;
export type AssetVersionRecord = typeof assetVersions.$inferSelect;
export type InsertAssetVersion = typeof assetVersions.$inferInsert;
export type AssetDerivativeRecord = typeof assetDerivatives.$inferSelect;
export type InsertAssetDerivative = typeof assetDerivatives.$inferInsert;
export type AssetPageAssignmentRecord = typeof assetPageAssignments.$inferSelect;
export type InsertAssetPageAssignment = typeof assetPageAssignments.$inferInsert;
export type ProjectAssetSettingsRecord = typeof projectAssetSettings.$inferSelect;
export type InsertProjectAssetSettings = typeof projectAssetSettings.$inferInsert;

// ---------------------------------------------------------------------------
// Design: Google Stitch Design Provider (Macro Run 6)
// ---------------------------------------------------------------------------

/**
 * Immutable, authority-bound design generation input. Every material
 * upstream dependency (accepted project inputs, accepted page content,
 * approved asset versions) is bound by id + version + exact digest at
 * snapshot time so any design artifact can answer "which exact content,
 * facts, and assets produced this design?" and so upstream mutation makes
 * dependent artifacts stale.
 */
export const designInputSnapshots = pgTable(
  "design_input_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    inputDigest: text("input_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("design_input_snapshots_project_version_unique").on(table.projectId, table.version),
    check("design_input_snapshots_version_positive", sql`${table.version} >= 1`),
    check("design_input_snapshots_digest_shape", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    index("design_input_snapshots_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * A provider generation result (candidate). Candidates are immutable
 * evidence: acceptance never mutates them; a rejected candidate stays
 * inspectable. Approval state transitions pending -> accepted | rejected
 * bind the exact candidate digest.
 */
export const designCandidates = pgTable(
  "design_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    inputSnapshotId: text("input_snapshot_id")
      .notNull()
      .references(() => designInputSnapshots.id, { onDelete: "cascade" }),
    inputSnapshotVersion: integer("input_snapshot_version").notNull(),
    inputDigest: text("input_digest").notNull(),
    provider: text("provider").notNull(),
    /** Durable evidence mode: live provider execution vs deterministic fixture. */
    providerMode: text("provider_mode").notNull(),
    providerProjectName: text("provider_project_name").notNull(),
    data: jsonb("data").notNull(),
    candidateDigest: text("candidate_digest").notNull(),
    approvalState: text("approval_state").notNull().default("pending"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "design_candidates_approval_state_valid",
      sql`${table.approvalState} IN ('pending', 'accepted', 'rejected')`,
    ),
    check("design_candidates_digest_shape", sql`${table.candidateDigest} ~ '^[0-9a-f]{64}$'`),
    check("design_candidates_input_digest_shape", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "design_candidates_state_timestamps_valid",
      sql`(
        (${table.approvalState} = 'pending' AND ${table.acceptedAt} IS NULL AND ${table.rejectedAt} IS NULL)
        OR (${table.approvalState} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.rejectedAt} IS NULL)
        OR (${table.approvalState} = 'rejected' AND ${table.acceptedAt} IS NULL AND ${table.rejectedAt} IS NOT NULL)
      )`,
    ),
    check(
      "design_candidates_provider_valid",
      sql`${table.provider} IN ('google-stitch')`,
    ),
    check(
      "design_candidates_provider_mode_valid",
      sql`${table.providerMode} IN ('live', 'fixture')`,
    ),
    index("design_candidates_project_idx").on(table.projectId, table.createdAt),
    index("design_candidates_input_idx").on(table.inputSnapshotId),
  ],
);

/**
 * The immutable accepted design artifact. Created ONLY by explicit human
 * acceptance of an exact candidate (id + digest). Bind-time digests are
 * copied from the candidate so downstream staleness never silently tracks
 * mutable "latest" state.
 */
export const acceptedDesignArtifacts = pgTable(
  "accepted_design_artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => designCandidates.id, { onDelete: "restrict" }),
    candidateDigest: text("candidate_digest").notNull(),
    inputSnapshotId: text("input_snapshot_id").notNull(),
    inputSnapshotVersion: integer("input_snapshot_version").notNull(),
    inputDigest: text("input_digest").notNull(),
    provider: text("provider").notNull(),
    /** Durable evidence mode carried from the accepted candidate. */
    providerMode: text("provider_mode").notNull(),
    providerProjectName: text("provider_project_name").notNull(),
    designMdDigest: text("design_md_digest").notNull(),
    data: jsonb("data").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("accepted_design_artifacts_project_version_unique").on(table.projectId, table.version),
    check("accepted_design_artifacts_version_positive", sql`${table.version} >= 1`),
    check("accepted_design_artifacts_candidate_digest_shape", sql`${table.candidateDigest} ~ '^[0-9a-f]{64}$'`),
    check("accepted_design_artifacts_input_digest_shape", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check("accepted_design_artifacts_design_md_digest_shape", sql`${table.designMdDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "accepted_design_artifacts_provider_valid",
      sql`${table.provider} IN ('google-stitch')`,
    ),
    check(
      "accepted_design_artifacts_provider_mode_valid",
      sql`${table.providerMode} IN ('live', 'fixture')`,
    ),
    index("accepted_design_artifacts_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * Durable artifact-reference manifest: proves which project/candidate owns
 * or references which raw artifact digest. Content-addressed storage stays
 * globally deduplicated; AUTHORIZATION is project-scoped through this table
 * (a digest alone is never an authorization mechanism).
 */
export const designArtifactRefs = pgTable(
  "design_artifact_refs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => designCandidates.id, { onDelete: "cascade" }),
    artifactKind: text("artifact_kind").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("design_artifact_refs_candidate_digest_unique").on(table.candidateId, table.artifactKind, table.artifactDigest),
    check("design_artifact_refs_digest_shape", sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "design_artifact_refs_kind_valid",
      sql`${table.artifactKind} IN ('design_md', 'screen_html', 'screen_screenshot', 'provider_response')`,
    ),
    index("design_artifact_refs_project_digest_idx").on(table.projectId, table.artifactDigest),
  ],
);

export type DesignInputSnapshotRecord = typeof designInputSnapshots.$inferSelect;
export type InsertDesignInputSnapshot = typeof designInputSnapshots.$inferInsert;
export type DesignCandidateRecord = typeof designCandidates.$inferSelect;
export type InsertDesignCandidate = typeof designCandidates.$inferInsert;
export type AcceptedDesignArtifactRecord = typeof acceptedDesignArtifacts.$inferSelect;
export type InsertAcceptedDesignArtifact = typeof acceptedDesignArtifacts.$inferInsert;

// ---------------------------------------------------------------------------
// Visual Assets: Final Asset Resolution (Macro Run 7)
// ---------------------------------------------------------------------------

/**
 * Versioned VisualAssetPlan derived from an exact accepted design artifact.
 * Immutable once written; re-derivation with changed upstream creates the
 * next version. Slots carry truth-class PROPOSALS — the operator's
 * confirmation lives in visual_slot_classifications.
 */
export const visualAssetPlans = pgTable(
  "visual_asset_plans",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    designArtifactId: text("design_artifact_id").notNull(),
    designArtifactVersion: integer("design_artifact_version").notNull(),
    designCandidateDigest: text("design_candidate_digest").notNull(),
    designInputDigest: text("design_input_digest").notNull(),
    designProviderMode: text("design_provider_mode").notNull(),
    slots: jsonb("slots").notNull(),
    planDigest: text("plan_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("visual_asset_plans_project_version_unique").on(table.projectId, table.version),
    check("visual_asset_plans_version_positive", sql`${table.version} >= 1`),
    check("visual_asset_plans_digest_shape", sql`${table.planDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "visual_asset_plans_provider_mode_valid",
      sql`${table.designProviderMode} IN ('live', 'fixture')`,
    ),
    index("visual_asset_plans_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * Operator-confirmed truth classification per (plan, slot). This is the
 * classification AUTHORITY: the plan's proposal is advisory until a row
 * exists here. Re-confirmation overwrites the slot's classification
 * (pre-provider-execution only; accepted slots are immutable).
 */
export const visualSlotClassifications = pgTable(
  "visual_slot_classifications",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => visualAssetPlans.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    truthClass: text("truth_class").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("visual_slot_classifications_plan_slot_unique").on(table.planId, table.slot),
    check(
      "visual_slot_classifications_truth_class_valid",
      sql`${table.truthClass} IN ('documentary', 'documentary_edited', 'illustrative', 'decorative', 'data_visualization')`,
    ),
  ],
);

/**
 * Immutable prompt snapshot (human-approved before any spend). The digest is
 * computed over the exact snapshot payload; approval binds it. Never mutated.
 */
export const visualPromptSnapshots = pgTable(
  "visual_prompt_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => visualAssetPlans.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    operation: text("operation").notNull(),
    truthClass: text("truth_class").notNull(),
    data: jsonb("data").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    approvalState: text("approval_state").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("visual_prompt_snapshots_digest_shape", sql`${table.promptDigest} ~ '^[0-9a-f]{64}$'`),
    check("visual_prompt_snapshots_operation_valid", sql`${table.operation} IN ('edit', 'generate')`),
    check(
      "visual_prompt_snapshots_approval_state_valid",
      sql`${table.approvalState} IN ('pending', 'approved')`,
    ),
    check(
      "visual_prompt_snapshots_approved_at_valid",
      sql`(${table.approvalState} = 'pending' AND ${table.approvedAt} IS NULL)
          OR (${table.approvalState} = 'approved' AND ${table.approvedAt} IS NOT NULL)`,
    ),
    index("visual_prompt_snapshots_project_idx").on(table.projectId, table.promptDigest),
  ],
);

/**
 * Provider generation request with request-digest dedup: the same exact
 * (slot, design digest, prompt digest, source digests, provider, model,
 * params) maps to the same request_digest, and a repeat never re-spends.
 */
export const visualGenerationRequests = pgTable(
  "visual_generation_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    requestDigest: text("request_digest").notNull(),
    promptSnapshotId: text("prompt_snapshot_id")
      .notNull()
      .references(() => visualPromptSnapshots.id, { onDelete: "cascade" }),
    promptDigest: text("prompt_digest").notNull(),
    provider: text("provider").notNull(),
    providerMode: text("provider_mode").notNull(),
    model: text("model").notNull(),
    modelPolicyVersion: text("model_policy_version").notNull(),
    operation: text("operation").notNull(),
    escalationReason: text("escalation_reason"),
    providerRequestRef: text("provider_request_ref"),
    resultState: text("result_state").notNull(),
    leaseHolder: text("lease_holder"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    costMicros: integer("cost_micros"),
    rawMetadata: jsonb("raw_metadata"),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("visual_generation_requests_project_digest_unique").on(table.projectId, table.requestDigest),
    check("visual_generation_requests_digest_shape", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
    check("visual_generation_requests_prompt_digest_shape", sql`${table.promptDigest} ~ '^[0-9a-f]{64}$'`),
    check("visual_generation_requests_provider_valid", sql`${table.provider} IN ('google-genai')`),
    check("visual_generation_requests_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    check("visual_generation_requests_operation_valid", sql`${table.operation} IN ('edit', 'generate')`),
    check("visual_generation_requests_result_state_valid", sql`${table.resultState} IN ('pending', 'running', 'succeeded', 'failed')`),
    check(
      "visual_generation_requests_cost_non_negative",
      sql`${table.costMicros} IS NULL OR ${table.costMicros} >= 0`,
    ),
    check(
      "visual_generation_requests_escalation_reason_valid",
      sql`${table.escalationReason} IS NULL OR ${table.escalationReason} IN (
        'composition_complexity', 'brand_consistency', 'text_rendering', 'reference_composition', 'quality_floor_failure'
      )`,
    ),
    index("visual_generation_requests_project_idx").on(table.projectId, table.slot),
  ],
);

/**
 * Immutable provider-output candidate: byte-validated, content-addressed
 * (`.factory/visual/candidates/`), with exact parent lineage, C2PA read
 * result and QA evidence. Provider output is NEVER an AssetVersion until
 * human acceptance routes it through the Run 5 authority.
 */
export const visualAssetCandidates = pgTable(
  "visual_asset_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requestId: text("request_id")
      .notNull()
      .references(() => visualGenerationRequests.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    candidateIndex: integer("candidate_index").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    mediaType: text("media_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull(),
    parentLineage: jsonb("parent_lineage").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    c2pa: jsonb("c2pa").notNull(),
    providerMetadata: jsonb("provider_metadata"),
    qa: jsonb("qa").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("visual_asset_candidates_request_index_unique").on(table.requestId, table.candidateIndex),
    check("visual_asset_candidates_digest_shape", sql`${table.binaryDigest} ~ '^[0-9a-f]{64}$'`),
    check("visual_asset_candidates_prompt_digest_shape", sql`${table.promptDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "visual_asset_candidates_media_type_valid",
      sql`${table.mediaType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check(
      "visual_asset_candidates_dimensions_positive",
      sql`${table.width} >= 1 AND ${table.height} >= 1 AND ${table.byteSize} >= 1`,
    ),
    check("visual_asset_candidates_state_valid", sql`${table.state} IN ('pending', 'selected', 'rejected')`),
    index("visual_asset_candidates_project_idx").on(table.projectId, table.slot),
  ],
);

/**
 * The immutable AcceptedVisualAssetSet: version/digest-bound final visual
 * authority for one plan (one accepted design lineage). Slots bind the
 * EXACT resolved AssetVersion (id + both digests copied at accept time).
 */
export const acceptedVisualAssetSets = pgTable(
  "accepted_visual_asset_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    planId: text("plan_id")
      .notNull()
      .references(() => visualAssetPlans.id, { onDelete: "cascade" }),
    providerMode: text("provider_mode").notNull().default("fixture"),
    designArtifactId: text("design_artifact_id").notNull(),
    designArtifactVersion: integer("design_artifact_version").notNull(),
    designCandidateDigest: text("design_candidate_digest").notNull(),
    designInputDigest: text("design_input_digest").notNull(),
    setDigest: text("set_digest").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("accepted_visual_asset_sets_project_version_unique").on(table.projectId, table.version),
    check("accepted_visual_asset_sets_version_positive", sql`${table.version} >= 1`),
    check("accepted_visual_asset_sets_digest_shape", sql`${table.setDigest} ~ '^[0-9a-f]{64}$'`),
    check("accepted_visual_asset_sets_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    index("accepted_visual_asset_sets_project_idx").on(table.projectId, table.version),
  ],
);

/**
 * Per-slot final resolution inside an accepted set. The documentary
 * CHECK enforces the hard truth policy at the DB layer: ai_generate can
 * never carry documentary/documentary_edited/data_visualization truth.
 */
export const acceptedVisualAssetSlots = pgTable(
  "accepted_visual_asset_slots",
  {
    id: text("id").primaryKey(),
    setId: text("set_id")
      .notNull()
      .references(() => acceptedVisualAssetSets.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    pageSlug: text("page_slug").notNull(),
    role: text("role").notNull(),
    resolvedVersionId: text("resolved_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "restrict" }),
    binaryDigest: text("binary_digest").notNull(),
    governanceDigest: text("governance_digest").notNull(),
    resolutionMode: text("resolution_mode").notNull(),
    truthClass: text("truth_class").notNull(),
    promptSnapshotId: text("prompt_snapshot_id").references(() => visualPromptSnapshots.id, {
      onDelete: "set null",
    }),
    generationRequestId: text("generation_request_id").references(() => visualGenerationRequests.id, {
      onDelete: "set null",
    }),
    candidateId: text("candidate_id").references(() => visualAssetCandidates.id, { onDelete: "set null" }),
    visualProviderConsumedSourceAsset: boolean("visual_provider_consumed_source_asset")
      .notNull()
      .default(false),
    visualProviderProducedAsset: boolean("visual_provider_produced_asset")
      .notNull()
      .default(false),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("accepted_visual_asset_slots_set_slot_unique").on(table.setId, table.slot),
    check(
      "accepted_visual_asset_slots_digest_shape",
      sql`${table.binaryDigest} ~ '^[0-9a-f]{64}$' AND ${table.governanceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "accepted_visual_asset_slots_resolution_mode_valid",
      sql`${table.resolutionMode} IN ('reuse_real', 'deterministic_transform', 'ai_edit', 'ai_generate')`,
    ),
    check(
      "accepted_visual_asset_slots_truth_class_valid",
      sql`${table.truthClass} IN ('documentary', 'documentary_edited', 'illustrative', 'decorative', 'data_visualization')`,
    ),
    check(
      "accepted_visual_asset_slots_documentary_forbids_generated",
      sql`NOT (${table.resolutionMode} = 'ai_generate' AND ${table.truthClass} IN ('documentary', 'documentary_edited', 'data_visualization'))`,
    ),
    index("accepted_visual_asset_slots_project_idx").on(table.projectId),
  ],
);

/**
 * Durable, plan-specific, slot-specific resolution authority (P1-01 / P1-02).
 * Records exact resolution evidence for all 4 modes: reuse_real,
 * deterministic_transform, ai_edit, ai_generate.
 * Unique on (plan_id, slot).
 */
export const visualSlotResolutions = pgTable(
  "visual_slot_resolutions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => visualAssetPlans.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    pageSlug: text("page_slug").notNull(),
    role: text("role").notNull(),

    fromAssetId: text("from_asset_id"),
    fromVersionId: text("from_version_id"),
    fromBinaryDigest: text("from_binary_digest"),
    fromGovernanceDigest: text("from_governance_digest"),

    toAssetId: text("to_asset_id").notNull(),
    toVersionId: text("to_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "restrict" }),
    toBinaryDigest: text("to_binary_digest").notNull(),
    toGovernanceDigest: text("to_governance_digest").notNull(),

    resolutionMode: text("resolution_mode").notNull(),

    visualProviderConsumedSourceAsset: boolean("visual_provider_consumed_source_asset")
      .notNull()
      .default(false),
    visualProviderProducedAsset: boolean("visual_provider_produced_asset")
      .notNull()
      .default(false),

    promptSnapshotId: text("prompt_snapshot_id").references(() => visualPromptSnapshots.id, {
      onDelete: "set null",
    }),
    generationRequestId: text("generation_request_id").references(() => visualGenerationRequests.id, {
      onDelete: "set null",
    }),
    candidateId: text("candidate_id").references(() => visualAssetCandidates.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("visual_slot_resolutions_plan_slot_unique").on(table.planId, table.slot),
    check(
      "visual_slot_resolutions_to_digests_shape",
      sql`${table.toBinaryDigest} ~ '^[0-9a-f]{64}$' AND ${table.toGovernanceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "visual_slot_resolutions_from_digests_shape",
      sql`(${table.fromBinaryDigest} IS NULL OR ${table.fromBinaryDigest} ~ '^[0-9a-f]{64}$')
          AND (${table.fromGovernanceDigest} IS NULL OR ${table.fromGovernanceDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "visual_slot_resolutions_resolution_mode_valid",
      sql`${table.resolutionMode} IN ('reuse_real', 'deterministic_transform', 'ai_edit', 'ai_generate')`,
    ),
    index("visual_slot_resolutions_project_idx").on(table.projectId, table.planId),
  ],
);

/**
 * Visual budget reservation ledger: exact lifecycle clone of
 * writer_budget_reservations (ceiling-check + INSERT in one tx under the
 * shared budget advisory xact lock; ACTIVE -> ACCOUNTED | RELEASED).
 */
export const visualBudgetReservations = pgTable(
  "visual_budget_reservations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    authorizedMicros: integer("authorized_micros").notNull(),
    accountedMicros: integer("accounted_micros"),
    state: text("state").notNull(),
    invocationDigest: text("invocation_digest").notNull(),
    lineage: jsonb("lineage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accountedAt: timestamp("accounted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "visual_budget_reservations_state_valid",
      sql`${table.state} IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')`,
    ),
    check(
      "visual_budget_reservations_accounted_valid",
      sql`(
        (${table.state} = 'ACTIVE' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NULL)
        OR (${table.state} = 'ACCOUNTED' AND ${table.accountedMicros} IS NOT NULL AND ${table.accountedAt} IS NOT NULL)
        OR (${table.state} = 'RELEASED' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NOT NULL)
      )`,
    ),
    index("visual_budget_reservations_state_created_idx").on(table.state, table.createdAt),
    index("visual_budget_reservations_created_idx").on(table.createdAt),
  ],
);

export type VisualAssetPlanRecord = typeof visualAssetPlans.$inferSelect;
export type InsertVisualAssetPlan = typeof visualAssetPlans.$inferInsert;
export type VisualSlotClassificationRecord = typeof visualSlotClassifications.$inferSelect;
export type VisualPromptSnapshotRecord = typeof visualPromptSnapshots.$inferSelect;
export type VisualGenerationRequestRecord = typeof visualGenerationRequests.$inferSelect;
export type VisualAssetCandidateRecord = typeof visualAssetCandidates.$inferSelect;
export type AcceptedVisualAssetSetRecord = typeof acceptedVisualAssetSets.$inferSelect;
export type AcceptedVisualAssetSlotRecord = typeof acceptedVisualAssetSlots.$inferSelect;
export type VisualSlotResolutionRecord = typeof visualSlotResolutions.$inferSelect;
export type InsertVisualSlotResolution = typeof visualSlotResolutions.$inferInsert;
export type VisualBudgetReservationRecord = typeof visualBudgetReservations.$inferSelect;

export const searchBudgetReservations = pgTable(
  "search_budget_reservations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    authorizedMicros: integer("authorized_micros").notNull(),
    accountedMicros: integer("accounted_micros"),
    state: text("state").notNull(),
    invocationDigest: text("invocation_digest").notNull(),
    lineage: jsonb("lineage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accountedAt: timestamp("accounted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "search_budget_reservations_state_valid",
      sql`${table.state} IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')`,
    ),
    check(
      "search_budget_reservations_accounted_valid",
      sql`(${table.state} = 'ACTIVE' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NULL) OR (${table.state} = 'ACCOUNTED' AND ${table.accountedMicros} IS NOT NULL AND ${table.accountedAt} IS NOT NULL) OR (${table.state} = 'RELEASED' AND ${table.accountedMicros} IS NULL AND ${table.accountedAt} IS NOT NULL)`,
    ),
    index("search_budget_reservations_state_created_idx").on(table.state, table.createdAt),
    index("search_budget_reservations_created_idx").on(table.createdAt),
  ],
);


export const assetAssignmentHistory = pgTable("asset_assignment_history", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  assignmentId: text("assignment_id").notNull().references(() => assetPageAssignments.id),
  binding: jsonb("binding").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Production authority: ProductionPageInput + ProductionCandidate + QA
// (Macro Run 9 — Production + SEO + Performance Engine)
// ---------------------------------------------------------------------------

/**
 * Immutable, versioned, digest-bound manifest of the exact accepted
 * authorities (content + design + visual set + route/site identity +
 * renderer identity) that a production build consumes. NOT a copy of
 * editable page data — the renderer reads authority artifacts by exact
 * id/version/digest lineage.
 */
export const productionPageInputs = pgTable(
  "production_page_inputs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Accepted page identity: the bound AcceptedPageContent slug. */
    pageIdentity: text("page_identity").notNull(),
    pageType: text("page_type").notNull(),
    route: text("route").notNull(),
    canonicalOrigin: text("canonical_origin").notNull(),
    siteId: text("site_id"),
    siteName: text("site_name"),
    siteLanguage: text("site_language"),
    siteProfileDigest: text("site_profile_digest"),
    acceptedContentId: text("accepted_content_id").notNull(),
    acceptedContentVersion: integer("accepted_content_version").notNull(),
    acceptedContentDigest: text("accepted_content_digest").notNull(),
    acceptedDesignId: text("accepted_design_id").notNull(),
    acceptedDesignVersion: integer("accepted_design_version").notNull(),
    acceptedDesignDigest: text("accepted_design_digest").notNull(),
    acceptedVisualSetId: text("accepted_visual_set_id").notNull(),
    acceptedVisualSetVersion: integer("accepted_visual_set_version").notNull(),
    acceptedVisualSetDigest: text("accepted_visual_set_digest").notNull(),
    rendererId: text("renderer_id").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    rendererPolicyVersion: text("renderer_policy_version").notNull(),
    data: jsonb("data").notNull(),
    inputDigest: text("input_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("production_page_inputs_project_version_unique").on(table.projectId, table.version),
    unique("production_page_inputs_project_page_version_unique").on(table.projectId, table.pageIdentity, table.version),
    check("production_page_inputs_version_positive", sql`${table.version} >= 1`),
    check("production_page_inputs_digest_shape", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "production_page_inputs_authority_digests_shape",
      sql`${table.acceptedContentDigest} ~ '^[0-9a-f]{64}$' AND ${table.acceptedDesignDigest} ~ '^[0-9a-f]{64}$' AND ${table.acceptedVisualSetDigest} ~ '^[0-9a-f]{64}$' AND (${table.siteProfileDigest} IS NULL OR ${table.siteProfileDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "production_page_inputs_renderer_valid",
      sql`${table.rendererId} = 'astro-static'`,
    ),
    check(
      "production_page_inputs_page_type_valid",
      sql`${table.pageType} IN ('homepage', 'service', 'location', 'editorial', 'investment_advisory')`,
    ),
    index("production_page_inputs_project_idx").on(table.projectId, table.version),
  ],
);

/** Stable route owner; immutable input versions may reuse their page's route. */
export const productionRouteAuthorities = pgTable(
  "production_route_authorities",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    pageIdentity: text("page_identity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.route] }),
    unique("production_route_authorities_project_page_unique").on(table.projectId, table.pageIdentity),
  ],
);

/**
 * Immutable production build result. A candidate proves exactly which
 * authority versions/digests it was built from, the rendered artifact
 * digest, and its QA state. Upstream mutation never mutates a historical
 * candidate — it becomes STALE and a new candidate is required.
 */
export const productionCandidates = pgTable(
  "production_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    productionInputId: text("production_input_id")
      .notNull()
      .references(() => productionPageInputs.id, { onDelete: "restrict" }),
    productionInputVersion: integer("production_input_version").notNull(),
    productionInputDigest: text("production_input_digest").notNull(),
    pageIdentity: text("page_identity").notNull(),
    route: text("route").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    /** Digest over the rendered production artifacts (normalized surface). */
    artifactDigest: text("artifact_digest"),
    /** Build output directory/manifest reference (runtime evidence). */
    artifactRef: text("artifact_ref"),
    assetReferences: jsonb("asset_references"),
    manifestSetDigest: text("manifest_set_digest"),
    redirectSnapshotDigest: text("redirect_snapshot_digest"),
    siteProfileDigest: text("site_profile_digest"),
    rendererVersion: text("renderer_version"),
    repositorySha: text("repository_sha"),
    lockfileDigest: text("lockfile_digest"),
    /** pending | built | qa_passed | qa_failed | stale */
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("production_candidates_state_valid", sql`${table.state} IN ('pending', 'built', 'qa_passed', 'qa_failed', 'stale')`),
    check("production_candidates_input_digest_shape", sql`${table.productionInputDigest} ~ '^[0-9a-f]{64}$'`),
    check("production_candidates_artifact_digest_shape", sql`${table.artifactDigest} IS NULL OR ${table.artifactDigest} ~ '^[0-9a-f]{64}$'`),
    check("production_candidates_snapshot_digests_shape", sql`(${table.manifestSetDigest} IS NULL OR ${table.manifestSetDigest} ~ '^[0-9a-f]{64}$') AND (${table.redirectSnapshotDigest} IS NULL OR ${table.redirectSnapshotDigest} ~ '^[0-9a-f]{64}$') AND (${table.siteProfileDigest} IS NULL OR ${table.siteProfileDigest} ~ '^[0-9a-f]{64}$') AND (${table.lockfileDigest} IS NULL OR ${table.lockfileDigest} ~ '^[0-9a-f]{64}$')`),
    check("production_candidates_repository_sha_shape", sql`${table.repositorySha} IS NULL OR ${table.repositorySha} ~ '^[0-9a-f]{40}$'`),
    check("production_candidates_canonical_shape", sql`${table.canonicalUrl} LIKE 'http%'`),
    index("production_candidates_project_idx").on(table.projectId, table.createdAt),
    index("production_candidates_input_idx").on(table.productionInputId),
  ],
);

/** Exact site input set compiled for a candidate. Rows are insert-once. */
export const productionCandidateInputs = pgTable(
  "production_candidate_inputs",
  {
    candidateId: text("candidate_id").notNull().references(() => productionCandidates.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    productionInputId: text("production_input_id").notNull().references(() => productionPageInputs.id, { onDelete: "restrict" }),
    productionInputVersion: integer("production_input_version").notNull(),
    productionInputDigest: text("production_input_digest").notNull(),
    pageIdentity: text("page_identity").notNull(),
    route: text("route").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.productionInputId] }),
    unique("production_candidate_inputs_route_unique").on(table.candidateId, table.route),
    check("production_candidate_inputs_digests_shape", sql`${table.productionInputDigest} ~ '^[0-9a-f]{64}$' AND ${table.manifestDigest} ~ '^[0-9a-f]{64}$'`),
    index("production_candidate_inputs_project_idx").on(table.projectId, table.candidateId),
  ],
);

/** Explicit candidate-bound redirect snapshot; zero rows plus digest means none. */
export const productionCandidateRedirects = pgTable(
  "production_candidate_redirects",
  {
    candidateId: text("candidate_id").notNull().references(() => productionCandidates.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    destination: text("destination").notNull(),
    kind: text("kind").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.source] }),
    check("production_candidate_redirects_kind_valid", sql`${table.kind} IN ('permanent', 'temporary')`),
  ],
);

/**
 * One deterministic QA execution against one exact candidate. Reports are
 * immutable evidence: re-running QA creates a new qa_run row.
 */
export const productionQaRuns = pgTable(
  "production_qa_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => productionCandidates.id, { onDelete: "cascade" }),
    candidateArtifactDigest: text("candidate_artifact_digest"),
    data: jsonb("data").notNull(),
    overall: text("overall").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "production_qa_runs_overall_valid",
      sql`${table.overall} IN ('PASS', 'REVIEW', 'FAIL')`,
    ),
    index("production_qa_runs_candidate_idx").on(table.candidateId, table.createdAt),
  ],
);

/** Tool evidence accepted only from the trusted server/CLI runner. */
export const productionQaEvidence = pgTable(
  "production_qa_evidence",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id").notNull().references(() => productionCandidates.id, { onDelete: "cascade" }),
    checkId: text("check_id").notNull(),
    scope: text("scope").notNull(),
    subject: text("subject").notNull(),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull(),
    executionDigest: text("execution_digest").notNull(),
    artifactDigest: text("artifact_digest"),
    repositorySha: text("repository_sha"),
    lockfileDigest: text("lockfile_digest"),
    verdict: text("verdict").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("production_qa_evidence_candidate_check_subject_unique").on(table.candidateId, table.checkId, table.subject),
    check("production_qa_evidence_scope_valid", sql`${table.scope} IN ('page', 'site', 'repository')`),
    check("production_qa_evidence_verdict_valid", sql`${table.verdict} IN ('PASS', 'REVIEW', 'FAIL')`),
    check("production_qa_evidence_digest_shape", sql`${table.executionDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Relational immutable check rows avoid truncating complete 100-page QA. */
export const productionQaRunChecks = pgTable(
  "production_qa_run_checks",
  {
    qaRunId: text("qa_run_id").notNull().references(() => productionQaRuns.id, { onDelete: "cascade" }),
    checkId: text("check_id").notNull(),
    scope: text("scope").notNull(),
    subject: text("subject").notNull(),
    verdict: text("verdict").notNull(),
    data: jsonb("data").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.qaRunId, table.checkId, table.subject] }),
  ],
);

export type ProductionPageInputRecord = typeof productionPageInputs.$inferSelect;
export type InsertProductionPageInput = typeof productionPageInputs.$inferInsert;
export type ProductionCandidateRecord = typeof productionCandidates.$inferSelect;
export type InsertProductionCandidate = typeof productionCandidates.$inferInsert;
export type ProductionQaRunRecord = typeof productionQaRuns.$inferSelect;
export type ProductionCandidateInputRecord = typeof productionCandidateInputs.$inferSelect;
export type ProductionQaEvidenceRecord = typeof productionQaEvidence.$inferSelect;
export type InsertProductionQaRun = typeof productionQaRuns.$inferInsert;

// ---------------------------------------------------------------------------
// Macro Run 10 — Page derivatives (summary + narration/audio authority)
// ---------------------------------------------------------------------------

export const projectDerivativePolicies = pgTable(
  "project_derivative_policies",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    summaryEnabled: boolean("summary_enabled").notNull(),
    summaryLanguage: text("summary_language").notNull(),
    summaryPolicyVersion: text("summary_policy_version").notNull(),
    audioEnabled: boolean("audio_enabled").notNull(),
    audioLanguage: text("audio_language").notNull(),
    audioVoiceId: text("audio_voice_id"),
    audioPolicyVersion: text("audio_policy_version").notNull(),
    data: jsonb("data").notNull(),
    policyDigest: text("policy_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("project_derivative_policies_version_positive", sql`${table.version} >= 1`),
    check("project_derivative_policies_digest_shape", sql`${table.policyDigest} ~ '^[0-9a-f]{64}$'`),
    unique("project_derivative_policies_project_version_unique").on(table.projectId, table.version),
    index("project_derivative_policies_project_idx").on(table.projectId, table.version),
  ],
);

export const pageDerivativeOverrides = pgTable(
  "page_derivative_overrides",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    version: integer("version").notNull(),
    summaryMode: text("summary_mode").notNull(),
    summaryLanguage: text("summary_language"),
    audioMode: text("audio_mode").notNull(),
    audioLanguage: text("audio_language"),
    audioVoiceId: text("audio_voice_id"),
    data: jsonb("data").notNull(),
    overrideDigest: text("override_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("page_derivative_overrides_version_positive", sql`${table.version} >= 1`),
    check("page_derivative_overrides_digest_shape", sql`${table.overrideDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "page_derivative_overrides_mode_valid",
      sql`${table.summaryMode} IN ('inherit', 'enabled', 'disabled') AND ${table.audioMode} IN ('inherit', 'enabled', 'disabled')`,
    ),
    unique("page_derivative_overrides_project_page_version_unique").on(
      table.projectId,
      table.pageIdentity,
      table.version,
    ),
    index("page_derivative_overrides_project_page_idx").on(table.projectId, table.pageIdentity, table.version),
  ],
);

export const pageDerivativeIntentSnapshots = pgTable(
  "page_derivative_intent_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    acceptedContentId: text("accepted_content_id").notNull(),
    acceptedContentVersion: integer("accepted_content_version").notNull(),
    acceptedContentDigest: text("accepted_content_digest").notNull(),
    projectPolicyId: text("project_policy_id"),
    projectPolicyVersion: integer("project_policy_version"),
    projectPolicyDigest: text("project_policy_digest"),
    pageOverrideId: text("page_override_id"),
    pageOverrideVersion: integer("page_override_version"),
    pageOverrideDigest: text("page_override_digest"),
    effectiveSummaryState: text("effective_summary_state").notNull(),
    effectiveSummaryLanguage: text("effective_summary_language").notNull(),
    effectiveSummaryPolicyVersion: text("effective_summary_policy_version").notNull(),
    effectiveAudioState: text("effective_audio_state").notNull(),
    effectiveAudioLanguage: text("effective_audio_language").notNull(),
    effectiveAudioVoiceId: text("effective_audio_voice_id"),
    effectiveAudioPolicyVersion: text("effective_audio_policy_version").notNull(),
    data: jsonb("data").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("page_derivative_intent_snapshots_digest_shape", sql`${table.snapshotDigest} ~ '^[0-9a-f]{64}$'`),
    check("page_derivative_intent_snapshots_content_digest_shape", sql`${table.acceptedContentDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "page_derivative_intent_snapshots_effective_state_valid",
      sql`${table.effectiveSummaryState} IN ('enabled', 'disabled') AND ${table.effectiveAudioState} IN ('enabled', 'disabled')`,
    ),
    unique(
      "page_derivative_intent_snapshots_identity_unique",
    ).on(
      table.projectId,
      table.pageIdentity,
      table.acceptedContentId,
      table.acceptedContentVersion,
      table.projectPolicyId,
      table.projectPolicyVersion,
      table.pageOverrideId,
      table.pageOverrideVersion,
      table.effectiveSummaryState,
      table.effectiveAudioState,
      table.effectiveSummaryLanguage,
      table.effectiveAudioLanguage,
      table.effectiveAudioVoiceId,
    ),
    index("page_derivative_intent_snapshots_project_page_idx").on(table.projectId, table.pageIdentity),
  ],
);

export const summaryPromptSnapshots = pgTable(
  "summary_prompt_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    intentSnapshotId: text("intent_snapshot_id")
      .notNull()
      .references(() => pageDerivativeIntentSnapshots.id, { onDelete: "restrict" }),
    intentSnapshotDigest: text("intent_snapshot_digest").notNull(),
    acceptedContentId: text("accepted_content_id").notNull(),
    acceptedContentVersion: integer("accepted_content_version").notNull(),
    acceptedContentDigest: text("accepted_content_digest").notNull(),
    summaryPolicyVersion: text("summary_policy_version").notNull(),
    language: text("language").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    userPrompt: text("user_prompt").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("summary_prompt_snapshots_digest_shape", sql`${table.promptDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_prompt_snapshots_intent_digest_shape", sql`${table.intentSnapshotDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_prompt_snapshots_content_digest_shape", sql`${table.acceptedContentDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_prompt_snapshots_max_tokens_positive", sql`${table.maxOutputTokens} >= 1`),
    unique("summary_prompt_snapshots_intent_unique").on(table.intentSnapshotId),
  ],
);

export const summaryProposals = pgTable(
  "summary_proposals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    promptSnapshotId: text("prompt_snapshot_id")
      .notNull()
      .references(() => summaryPromptSnapshots.id, { onDelete: "restrict" }),
    promptSnapshotDigest: text("prompt_snapshot_digest").notNull(),
    acceptedContentId: text("accepted_content_id").notNull(),
    acceptedContentVersion: integer("accepted_content_version").notNull(),
    acceptedContentDigest: text("accepted_content_digest").notNull(),
    providerMode: text("provider_mode").notNull(),
    isTestDouble: boolean("is_test_double").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    summaryText: text("summary_text").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    usagePromptTokens: integer("usage_prompt_tokens"),
    usageCompletionTokens: integer("usage_completion_tokens"),
    usageTotalTokens: integer("usage_total_tokens"),
    usageCostMicros: integer("usage_cost_micros"),
    usageCurrency: text("usage_currency").notNull().default("UNKNOWN"),
    proposalDigest: text("proposal_digest").notNull(),
    qaReport: jsonb("qa_report"),
    qaReportDigest: text("qa_report_digest"),
    qaOverall: text("qa_overall"),
    state: text("state").notNull().default("generated"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("summary_proposals_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    check("summary_proposals_state_valid", sql`${table.state} IN ('generated', 'review', 'accepted', 'superseded')`),
    check("summary_proposals_digest_shape", sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_proposals_content_digest_shape", sql`${table.acceptedContentDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_proposals_prompt_digest_shape", sql`${table.promptSnapshotDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_proposals_qa_digest_shape", sql`${table.qaReportDigest} IS NULL OR ${table.qaReportDigest} ~ '^[0-9a-f]{64}$'`),
    check("summary_proposals_qa_overall_valid", sql`${table.qaOverall} IS NULL OR ${table.qaOverall} IN ('PASS', 'REVIEW', 'FAIL')`),
    check("summary_proposals_currency_valid", sql`${table.usageCurrency} IN ('USD', 'UNKNOWN')`),
    check("summary_proposals_cost_non_negative", sql`${table.usageCostMicros} IS NULL OR ${table.usageCostMicros} >= 0`),
    index("summary_proposals_project_page_idx").on(table.projectId, table.pageIdentity),
  ],
);

export const acceptedSummaryArtifacts = pgTable(
  "accepted_summary_artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    version: integer("version").notNull(),
    sourceContentId: text("source_content_id").notNull(),
    sourceContentVersion: integer("source_content_version").notNull(),
    sourceContentDigest: text("source_content_digest").notNull(),
    intentSnapshotId: text("intent_snapshot_id")
      .notNull()
      .references(() => pageDerivativeIntentSnapshots.id, { onDelete: "restrict" }),
    intentSnapshotDigest: text("intent_snapshot_digest").notNull(),
    promptSnapshotId: text("prompt_snapshot_id")
      .notNull()
      .references(() => summaryPromptSnapshots.id, { onDelete: "restrict" }),
    promptSnapshotDigest: text("prompt_snapshot_digest").notNull(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => summaryProposals.id, { onDelete: "restrict" }),
    proposalDigest: text("proposal_digest").notNull(),
    providerMode: text("provider_mode").notNull(),
    isTestDouble: boolean("is_test_double").notNull().default(false),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    language: text("language").notNull(),
    summaryText: text("summary_text").notNull(),
    qaReportDigest: text("qa_report_digest").notNull(),
    qaOverall: text("qa_overall").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("accepted_summary_artifacts_version_positive", sql`${table.version} >= 1`),
    check("accepted_summary_artifacts_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    check(
      "accepted_summary_artifacts_digests_shape",
      sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$' AND ${table.sourceContentDigest} ~ '^[0-9a-f]{64}$' AND ${table.intentSnapshotDigest} ~ '^[0-9a-f]{64}$' AND ${table.promptSnapshotDigest} ~ '^[0-9a-f]{64}$' AND ${table.proposalDigest} ~ '^[0-9a-f]{64}$' AND ${table.qaReportDigest} ~ '^[0-9a-f]{64}$`,
    ),
    check("accepted_summary_artifacts_qa_overall_valid", sql`${table.qaOverall} IN ('PASS', 'REVIEW')`),
    unique("accepted_summary_artifacts_project_version_unique").on(table.projectId, table.version),
    index("accepted_summary_artifacts_project_page_idx").on(table.projectId, table.pageIdentity, table.version),
  ],
);

export const narrationTextSnapshots = pgTable(
  "narration_text_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    sourceContentId: text("source_content_id").notNull(),
    sourceContentVersion: integer("source_content_version").notNull(),
    sourceContentDigest: text("source_content_digest").notNull(),
    narrationPolicyVersion: text("narration_policy_version").notNull(),
    language: text("language").notNull(),
    narrationText: text("narration_text").notNull(),
    narrationDigest: text("narration_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("narration_text_snapshots_digest_shape", sql`${table.narrationDigest} ~ '^[0-9a-f]{64}$'`),
    check("narration_text_snapshots_content_digest_shape", sql`${table.sourceContentDigest} ~ '^[0-9a-f]{64}$'`),
    unique("narration_text_snapshots_identity_unique").on(
      table.projectId,
      table.pageIdentity,
      table.sourceContentId,
      table.sourceContentVersion,
      table.narrationPolicyVersion,
      table.language,
    ),
    index("narration_text_snapshots_project_page_idx").on(table.projectId, table.pageIdentity),
  ],
);

export const audioCandidates = pgTable(
  "audio_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    narrationSnapshotId: text("narration_snapshot_id")
      .notNull()
      .references(() => narrationTextSnapshots.id, { onDelete: "restrict" }),
    narrationSnapshotDigest: text("narration_snapshot_digest").notNull(),
    providerMode: text("provider_mode").notNull(),
    isTestDouble: boolean("is_test_double").notNull(),
    provider: text("provider").notNull(),
    engine: text("engine").notNull(),
    voiceId: text("voice_id").notNull(),
    language: text("language").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    durationSeconds: doublePrecision("duration_seconds"),
    usageCharacters: integer("usage_characters"),
    usageCostMicros: integer("usage_cost_micros"),
    usageCurrency: text("usage_currency").notNull().default("UNKNOWN"),
    candidateDigest: text("candidate_digest").notNull(),
    state: text("state").notNull().default("generated"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("audio_candidates_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    check("audio_candidates_state_valid", sql`${table.state} IN ('generated', 'review', 'accepted', 'superseded')`),
    check(
      "audio_candidates_digests_shape",
      sql`${table.binaryDigest} ~ '^[0-9a-f]{64}$' AND ${table.candidateDigest} ~ '^[0-9a-f]{64}$' AND ${table.narrationSnapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("audio_candidates_mime_type_valid", sql`${table.mimeType} IN ('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4')`),
    check("audio_candidates_size_positive", sql`${table.sizeBytes} >= 1`),
    check("audio_candidates_currency_valid", sql`${table.usageCurrency} IN ('USD', 'UNKNOWN')`),
    check("audio_candidates_cost_non_negative", sql`${table.usageCostMicros} IS NULL OR ${table.usageCostMicros} >= 0`),
    index("audio_candidates_project_page_idx").on(table.projectId, table.pageIdentity),
  ],
);

export const acceptedAudioArtifacts = pgTable(
  "accepted_audio_artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    version: integer("version").notNull(),
    sourceContentId: text("source_content_id").notNull(),
    sourceContentVersion: integer("source_content_version").notNull(),
    sourceContentDigest: text("source_content_digest").notNull(),
    narrationSnapshotId: text("narration_snapshot_id")
      .notNull()
      .references(() => narrationTextSnapshots.id, { onDelete: "restrict" }),
    narrationSnapshotDigest: text("narration_snapshot_digest").notNull(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => audioCandidates.id, { onDelete: "restrict" }),
    candidateDigest: text("candidate_digest").notNull(),
    providerMode: text("provider_mode").notNull(),
    isTestDouble: boolean("is_test_double").notNull().default(false),
    provider: text("provider").notNull(),
    engine: text("engine").notNull(),
    voiceId: text("voice_id").notNull(),
    language: text("language").notNull(),
    binaryDigest: text("binary_digest").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    durationSeconds: doublePrecision("duration_seconds"),
    artifactDigest: text("artifact_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("accepted_audio_artifacts_version_positive", sql`${table.version} >= 1`),
    check("accepted_audio_artifacts_provider_mode_valid", sql`${table.providerMode} IN ('live', 'fixture')`),
    check(
      "accepted_audio_artifacts_digests_shape",
      sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$' AND ${table.sourceContentDigest} ~ '^[0-9a-f]{64}$' AND ${table.narrationSnapshotDigest} ~ '^[0-9a-f]{64}$' AND ${table.candidateDigest} ~ '^[0-9a-f]{64}$' AND ${table.binaryDigest} ~ '^[0-9a-f]{64}$`,
    ),
    check("accepted_audio_artifacts_mime_type_valid", sql`${table.mimeType} IN ('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4')`),
    unique("accepted_audio_artifacts_project_version_unique").on(table.projectId, table.version),
    index("accepted_audio_artifacts_project_page_idx").on(table.projectId, table.pageIdentity, table.version),
  ],
);

export const acceptedDerivativeSets = pgTable(
  "accepted_derivative_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageIdentity: text("page_identity").notNull(),
    version: integer("version").notNull(),
    sourceContentId: text("source_content_id").notNull(),
    sourceContentVersion: integer("source_content_version").notNull(),
    sourceContentDigest: text("source_content_digest").notNull(),
    intentSnapshotId: text("intent_snapshot_id")
      .notNull()
      .references(() => pageDerivativeIntentSnapshots.id, { onDelete: "restrict" }),
    intentSnapshotDigest: text("intent_snapshot_digest").notNull(),
    summaryState: text("summary_state").notNull(),
    summaryArtifactId: text("summary_artifact_id"),
    summaryVersion: integer("summary_version"),
    summaryDigest: text("summary_digest"),
    audioState: text("audio_state").notNull(),
    audioArtifactId: text("audio_artifact_id"),
    audioVersion: integer("audio_version"),
    audioDigest: text("audio_digest"),
    audioBinaryDigest: text("audio_binary_digest"),
    data: jsonb("data").notNull(),
    setDigest: text("set_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "accepted_derivative_sets_version_positive",
      sql`${table.version} >= 1`,
    ),
    check(
      "accepted_derivative_sets_state_valid",
      sql`${table.summaryState} IN ('disabled', 'accepted') AND ${table.audioState} IN ('disabled', 'accepted')`,
    ),
    check(
      "accepted_derivative_sets_digests_shape",
      sql`${table.setDigest} ~ '^[0-9a-f]{64}$' AND ${table.sourceContentDigest} ~ '^[0-9a-f]{64}$' AND ${table.intentSnapshotDigest} ~ '^[0-9a-f]{64}$' AND (${table.summaryDigest} IS NULL OR ${table.summaryDigest} ~ '^[0-9a-f]{64}$') AND (${table.audioDigest} IS NULL OR ${table.audioDigest} ~ '^[0-9a-f]{64}$') AND (${table.audioBinaryDigest} IS NULL OR ${table.audioBinaryDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "accepted_derivative_sets_summary_identity",
      sql`(${table.summaryState} = 'disabled' AND ${table.summaryArtifactId} IS NULL AND ${table.summaryDigest} IS NULL) OR (${table.summaryState} = 'accepted' AND ${table.summaryArtifactId} IS NOT NULL AND ${table.summaryDigest} IS NOT NULL AND ${table.summaryVersion} IS NOT NULL)`,
    ),
    check(
      "accepted_derivative_sets_audio_identity",
      sql`(${table.audioState} = 'disabled' AND ${table.audioArtifactId} IS NULL AND ${table.audioDigest} IS NULL AND ${table.audioBinaryDigest} IS NULL) OR (${table.audioState} = 'accepted' AND ${table.audioArtifactId} IS NOT NULL AND ${table.audioDigest} IS NOT NULL AND ${table.audioVersion} IS NOT NULL AND ${table.audioBinaryDigest} IS NOT NULL)`,
    ),
    unique("accepted_derivative_sets_project_version_unique").on(table.projectId, table.version),
    unique("accepted_derivative_sets_project_page_version_unique").on(
      table.projectId,
      table.pageIdentity,
      table.version,
    ),
    index("accepted_derivative_sets_project_page_idx").on(table.projectId, table.pageIdentity, table.version),
  ],
);

export type ProjectDerivativePolicyRecord = typeof projectDerivativePolicies.$inferSelect;
export type PageDerivativeOverrideRecord = typeof pageDerivativeOverrides.$inferSelect;
export type PageDerivativeIntentSnapshotRecord = typeof pageDerivativeIntentSnapshots.$inferSelect;
export type SummaryPromptSnapshotRecord = typeof summaryPromptSnapshots.$inferSelect;
export type SummaryProposalRecord = typeof summaryProposals.$inferSelect;
export type AcceptedSummaryArtifactRecord = typeof acceptedSummaryArtifacts.$inferSelect;
export type NarrationTextSnapshotRecord = typeof narrationTextSnapshots.$inferSelect;
export type AudioCandidateRecord = typeof audioCandidates.$inferSelect;
export type AcceptedAudioArtifactRecord = typeof acceptedAudioArtifacts.$inferSelect;
export type AcceptedDerivativeSetRecord = typeof acceptedDerivativeSets.$inferSelect;
