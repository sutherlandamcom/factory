import { z } from "zod";

/**
 * Macro Run 11 — Unified Operator Workflow read-model contract.
 *
 * The workflow read model is DERIVED, never persisted. It projects the
 * existing immutable/current authorities (intake snapshots, search
 * intelligence, writer pipeline, assets, design, visual sets, derivatives,
 * production inputs/candidates and QA evidence) into one deterministic
 * operator view. No workflow-stage row exists anywhere in storage; the
 * backend derives state on every read and the Dashboard only renders it.
 */

/** Fixed product workflow areas (Run 11 information architecture). */
export const workflowAreaIdSchema = z.enum([
  "intake",
  "research",
  "content",
  "assets",
  "design",
  "production",
  "qa",
  "versions",
  "costs",
  "deployment",
]);
export type WorkflowAreaId = z.infer<typeof workflowAreaIdSchema>;

/**
 * Derived workflow state vocabulary. These values are never stored; they are
 * recomputed from authoritative data on every read.
 */
export const workflowStateSchema = z.enum([
  "NOT_STARTED",
  "READY",
  "IN_PROGRESS",
  "REVIEW_REQUIRED",
  "ACCEPTED",
  "STALE",
  "BLOCKED",
  "NOT_APPLICABLE",
]);
export type WorkflowState = z.infer<typeof workflowStateSchema>;

/** Relation of a versioned artifact to the current authority chain. */
export const authorityRelationSchema = z.enum(["CURRENT", "HISTORICAL"]);
export type AuthorityRelation = z.infer<typeof authorityRelationSchema>;

/** Freshness of the CURRENT authority version against its dependencies. */
export const authorityFreshnessSchema = z.enum(["CURRENT", "STALE"]);
export type AuthorityFreshness = z.infer<typeof authorityFreshnessSchema>;

/** Reference to an exact authority artifact (id + version + digest). */
export const authorityRefSchema = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  version: z.number().int().min(0).optional(),
  digest: z.string().min(1).max(256).optional(),
  acceptedAt: z.string().datetime({ offset: true }).optional(),
  pageIdentity: z.string().min(1).max(256).optional(),
});
export type AuthorityRef = z.infer<typeof authorityRefSchema>;

/** Structured, machine-readable reason why something is stale. */
export const workflowReasonSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(500),
  authorityRef: authorityRefSchema.optional(),
});
export type WorkflowReason = z.infer<typeof workflowReasonSchema>;

/**
 * Structured blocker. Every blocker carries a machine-readable code, the
 * area it belongs to, a human-readable message and — where applicable — the
 * affected page/authority and a safe navigation route.
 */
export const workflowBlockerSchema = z.object({
  code: z.string().min(1).max(128),
  area: workflowAreaIdSchema,
  message: z.string().min(1).max(500),
  pageIdentity: z.string().min(1).max(256).optional(),
  authorityRef: authorityRefSchema.optional(),
  resolutionRoute: z.string().min(1).max(256).optional(),
});
export type WorkflowBlocker = z.infer<typeof workflowBlockerSchema>;

/** Deterministic backend-derived next action (no AI, no persisted state). */
export const workflowNextActionSchema = z.object({
  actionId: z.string().min(1).max(128),
  area: workflowAreaIdSchema,
  label: z.string().min(1).max(200),
  /** Fixed Dashboard route path (allow-list; never arbitrary stored URLs). */
  route: z.string().min(1).max(256),
  reasonCode: z.string().min(1).max(128),
  reasonMessage: z.string().min(1).max(500),
  pageIdentity: z.string().min(1).max(256).optional(),
});
export type WorkflowNextAction = z.infer<typeof workflowNextActionSchema>;

/** Per-page counts inside an area summary. */
export const workflowPageCountsSchema = z.object({
  total: z.number().int().min(0),
  current: z.number().int().min(0),
  stale: z.number().int().min(0),
  blocked: z.number().int().min(0),
});
export type WorkflowPageCounts = z.infer<typeof workflowPageCountsSchema>;

/** Derived summary of one workflow area. */
export const workflowAreaSummarySchema = z.object({
  area: workflowAreaIdSchema,
  state: workflowStateSchema,
  blockers: z.array(workflowBlockerSchema),
  staleReasons: z.array(workflowReasonSchema),
  currentAuthorities: z.array(authorityRefSchema),
  historicalCount: z.number().int().min(0).optional(),
  pageCounts: workflowPageCountsSchema.optional(),
});
export type WorkflowAreaSummary = z.infer<typeof workflowAreaSummarySchema>;

/** One cell of the per-page readiness matrix. */
export const pageWorkflowCellSchema = z.object({
  state: workflowStateSchema,
  relation: authorityRelationSchema.optional(),
  freshness: authorityFreshnessSchema.optional(),
  version: z.number().int().min(0).optional(),
  digest: z.string().max(256).optional(),
});
export type PageWorkflowCell = z.infer<typeof pageWorkflowCellSchema>;

/** One row of the per-page readiness matrix (Run 12 multi-page ready). */
export const pageWorkflowRowSchema = z.object({
  pageIdentity: z.string().min(1).max(256),
  content: pageWorkflowCellSchema,
  assets: pageWorkflowCellSchema,
  design: pageWorkflowCellSchema,
  derivatives: pageWorkflowCellSchema,
  production: pageWorkflowCellSchema,
  qa: pageWorkflowCellSchema,
});
export type PageWorkflowRow = z.infer<typeof pageWorkflowRowSchema>;

/** Overall project readiness (derived; never persisted). */
export const projectOverallStateSchema = z.enum([
  "IN_PROGRESS",
  "BLOCKED",
  "READY_FOR_DEPLOYMENT",
]);
export type ProjectOverallState = z.infer<typeof projectOverallStateSchema>;

/**
 * Deployment readiness. Run 11 ends at READY_FOR_DEPLOYMENT; publish /
 * rollback / preview lifecycle belongs to Macro Run 13. PUBLISHED is never
 * derived here — it is a real deployment fact, not a QA outcome.
 */
export const deploymentReadinessSchema = z.object({
  state: z.enum(["BLOCKED", "READY_FOR_DEPLOYMENT"]),
  candidate: authorityRefSchema.optional(),
  blockers: z.array(workflowBlockerSchema),
  qaCurrent: z.boolean(),
});
export type DeploymentReadiness = z.infer<typeof deploymentReadinessSchema>;

/** The canonical derived workflow read model for one project. */
export const projectWorkflowReadModelSchema = z.object({
  projectId: z.string().min(1).max(128),
  overall: projectOverallStateSchema,
  areas: z.array(workflowAreaSummarySchema),
  nextAction: workflowNextActionSchema.nullable(),
  secondaryActionCount: z.number().int().min(0),
  pages: z.array(pageWorkflowRowSchema),
  deployment: deploymentReadinessSchema,
});
export type ProjectWorkflowReadModel = z.infer<typeof projectWorkflowReadModelSchema>;

/** Version/history projection of one artifact version. */
export const artifactVersionSummarySchema = z.object({
  artifactKind: z.string().min(1).max(64),
  pageIdentity: z.string().min(1).max(256).optional(),
  id: z.string().min(1).max(128),
  version: z.number().int().min(0),
  digest: z.string().min(1).max(256),
  acceptedAt: z.string().datetime({ offset: true }).optional(),
  relation: authorityRelationSchema,
  freshness: authorityFreshnessSchema.optional(),
  sourceAuthorities: z.array(authorityRefSchema).optional(),
});
export type ArtifactVersionSummary = z.infer<typeof artifactVersionSummarySchema>;

export const projectVersionsReadModelSchema = z.object({
  projectId: z.string().min(1).max(128),
  artifacts: z.array(artifactVersionSummarySchema),
});
export type ProjectVersionsReadModel = z.infer<typeof projectVersionsReadModelSchema>;

/** Cost of one provider call: KNOWN amount or truthfully UNKNOWN. */
export const costValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("KNOWN"), amountUsd: z.number().min(0) }),
  z.object({ kind: z.literal("UNKNOWN") }),
]);
export type CostValue = z.infer<typeof costValueSchema>;

/** One aggregated cost row (grouped by provider/model/operation/page). */
export const costAggregateRowSchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().max(256).nullable(),
  operation: z.string().min(1).max(128),
  pageIdentity: z.string().max(256).nullable(),
  calls: z.number().int().min(0),
  knownCost: costValueSchema,
  unknownCostCalls: z.number().int().min(0),
});
export type CostAggregateRow = z.infer<typeof costAggregateRowSchema>;

/**
 * Cost read model. Providers that record no cost telemetry are reported as
 * `available: false` — never guessed and never treated as zero.
 */
export const projectCostsReadModelSchema = z.object({
  projectId: z.string().min(1).max(128),
  rows: z.array(costAggregateRowSchema),
  unattributedCalls: z.number().int().min(0),
  unavailableSources: z.array(
    z.object({ source: z.string().min(1).max(128), reason: z.string().min(1).max(200) }),
  ),
});
export type ProjectCostsReadModel = z.infer<typeof projectCostsReadModelSchema>;
