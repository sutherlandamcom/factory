import { z } from "zod";
import {
  addSitePageInvariantIssues,
  pageTypeSchema,
  sectionTypeSchema,
  siteIdSchema,
  slugSchema,
} from "./site-task.js";

/**
 * First-Site Intelligence contracts (v0 vertical slice).
 *
 * These schemas describe the bounded planning pipeline:
 *
 *   SiteIntelligenceRequest + ResearchEvidenceBundle
 *     → deterministic normalization → digests → isolated model synthesis
 *     → SiteIntelligencePlan (strictly validated) → create_page SiteTasks
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed.
 */

/** The one methodology identifier for this vertical slice. */
export const INTELLIGENCE_METHODOLOGY_VERSION = "first-site-intelligence-v0";

/** Serialized request payload ceiling. */
export const MAX_INTELLIGENCE_REQUEST_BYTES = 64 * 1024; // 64 KB
/** Serialized research evidence bundle ceiling. */
export const MAX_RESEARCH_BUNDLE_BYTES = 512 * 1024; // 512 KB
/** Raw model output ceiling (single strict JSON document). */
export const MAX_INTELLIGENCE_MODEL_OUTPUT_BYTES = 256 * 1024; // 256 KB
/** Intelligence-specific synthesis attempt ceiling (independent of SiteTask MAX_TOTAL_ATTEMPTS). */
export const MAX_SYNTHESIS_ATTEMPTS = 3;

/** Safe stable identifier syntax shared by evidence / fact / plan element ids. */
export const stableIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message:
      'id must be 1-100 chars of [A-Za-z0-9._-] starting with an alphanumeric char (e.g. "kw-roof-repair")',
  });

/**
 * Documented deterministic scalar normalization used for duplicate detection
 * and topic comparison: trim surrounding whitespace, lowercase (Unicode
 * default), collapse internal whitespace runs to single spaces.
 */
export function normalizeScalarText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDuplicateNormalized(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeScalarText(value);
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

/**
 * Conservative absolute http/https URL acceptance used by contracts (this
 * package has no Node runtime types). Requires a hostname of [A-Za-z0-9.-]
 * with optional port; userinfo and IPv6 literals are rejected. The
 * Intelligence module performs deeper semantic URL handling with the
 * WHATWG URL parser at normalization time.
 */
const ABSOLUTE_HTTP_URL_PATTERN = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[^\s]*)?(?:\?[^\s]*)?(?:#[^\s]*)?$/;

function isHttpOrHttpsUrl(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  return ABSOLUTE_HTTP_URL_PATTERN.test(value);
}

const finiteMetricRefine = {
  predicate: (value: number) => Number.isFinite(value),
  message: "metrics must be finite numbers (NaN/Infinity are rejected)",
} as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// SiteIntelligenceRequest
// ---------------------------------------------------------------------------

/**
 * Operator-supplied facts about the business.
 *
 * Trust semantics: FACT-AUTHORITATIVE but INSTRUCTION-UNTRUSTED. The text is
 * data about the business; it must never be treated as instructions, rules,
 * tool requests, or authority modifications by the synthesis model.
 */
export const operatorFactSchema = z
  .object({
    id: stableIdSchema,
    text: boundedText(1000),
  })
  .strict();

export const businessSchema = z
  .object({
    name: boundedText(200),
    category: boundedText(200),
    country: boundedText(100),
    language: boundedText(64),
    primaryMarket: boundedText(200),
    serviceSeeds: z.array(boundedText(150)).min(1).max(20),
    audienceNotes: z.array(boundedText(500)).max(10).optional(),
    operatorFacts: z.array(operatorFactSchema).max(30).optional(),
    constraints: z.array(boundedText(500)).max(20).optional(),
  })
  .strict();

export const planningSchema = z
  .object({
    maxInitialPages: z.number().int().min(3).max(20),
    mustCoverServices: z.array(boundedText(150)).max(20).optional(),
    excludedTopics: z.array(boundedText(150)).max(30).optional(),
  })
  .strict();

export const siteIntelligenceRequestSchema = z
  .object({
    version: z.literal("v0"),
    siteId: siteIdSchema,
    business: businessSchema,
    planning: planningSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const duplicate = (values: string[], label: string) => {
      if (hasDuplicateNormalized(values)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} contains duplicate values after deterministic normalization`,
        });
      }
    };
    duplicate(request.business.serviceSeeds, "business.serviceSeeds");
    duplicate(request.planning.mustCoverServices ?? [], "planning.mustCoverServices");
    duplicate(request.planning.excludedTopics ?? [], "planning.excludedTopics");

    const factIds = (request.business.operatorFacts ?? []).map((fact) => fact.id);
    if (new Set(factIds).size !== factIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "business.operatorFacts contains duplicate fact ids",
      });
    }
  });

export type OperatorFact = z.infer<typeof operatorFactSchema>;
export type SiteIntelligenceRequest = z.infer<typeof siteIntelligenceRequestSchema>;

// ---------------------------------------------------------------------------
// ResearchEvidenceBundle
// ---------------------------------------------------------------------------

/**
 * Bounded evidence kinds. `operator_fact` is deliberately NOT an evidence
 * kind: operator facts live in the request where their trust semantics are
 * explicit and separately namespaced.
 */
export const evidenceKindSchema = z.enum([
  "keyword_observation",
  "serp_observation",
  "competitor_page",
  "market_observation",
]);

/**
 * Metrics may carry only observed values supplied by evidence. No defaults,
 * no fabrication: absent metrics stay absent. All values must be finite
 * (NaN/Infinity are rejected).
 */
export const evidenceMetricsSchema = z
  .object({
    searchVolume: z.number().int().min(0).refine(finiteMetricRefine.predicate, finiteMetricRefine.message).optional(),
    cpc: z.number().min(0).refine(finiteMetricRefine.predicate, finiteMetricRefine.message).optional(),
    difficulty: z.number().min(0).max(100).refine(finiteMetricRefine.predicate, finiteMetricRefine.message).optional(),
    position: z.number().int().min(1).refine(finiteMetricRefine.predicate, finiteMetricRefine.message).optional(),
  })
  .strict();

/** UTC ISO-8601 timestamp (e.g. "2026-08-31T10:15:00Z"). */
export const isoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, {
    message: "timestamp must be a UTC ISO-8601 string like 2026-08-31T10:15:00Z",
  })
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "timestamp must parse as a real date",
  });

const researchEvidenceItemFields = {
  id: stableIdSchema,
  kind: evidenceKindSchema,
  provider: boundedText(100).optional(),
  query: boundedText(300).optional(),
  /** Runtime evidence URLs: http/https only; never fetched automatically. */
  sourceUrl: z.string().min(1).max(2048).optional(),
  title: boundedText(500).optional(),
  text: z.string().min(1).max(4000).optional(),
  metrics: evidenceMetricsSchema.optional(),
  collectedAt: isoDateTimeSchema.optional(),
} as const;

/**
 * Substantive-evidence rule: every record must carry at least ONE actual
 * observation payload (query, sourceUrl, title, text, or at least one
 * observed metric value). id/kind/provider/collectedAt metadata alone — and
 * an empty metrics object — are NOT substantive evidence.
 */
function hasSubstantiveEvidencePayload(item: {
  query?: unknown;
  sourceUrl?: unknown;
  title?: unknown;
  text?: unknown;
  metrics?: unknown;
}): boolean {
  if (
    item.query !== undefined ||
    item.sourceUrl !== undefined ||
    item.title !== undefined ||
    item.text !== undefined
  ) {
    return true;
  }
  if (item.metrics === undefined || typeof item.metrics !== "object" || item.metrics === null) {
    return false;
  }
  return Object.values(item.metrics as Record<string, unknown>).some((value) => value !== undefined);
}

export const researchEvidenceItemSchema = z
  .object({ ...researchEvidenceItemFields })
  .strict()
  .superRefine((item, ctx) => {
    if (item.sourceUrl !== undefined && !isHttpOrHttpsUrl(item.sourceUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceUrl must be an absolute http:// or https:// URL",
        path: ["sourceUrl"],
      });
    }
    if (!hasSubstantiveEvidencePayload(item)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "evidence item must contain at least one substantive payload (query, sourceUrl, title, text, or at least one observed metric value); id/kind/provider/collectedAt metadata alone is not evidence",
      });
    }
  });

export const researchEvidenceBundleSchema = z
  .object({
    version: z.literal("v0"),
    collectedAt: isoDateTimeSchema,
    items: z.array(researchEvidenceItemSchema).min(1).max(200),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const ids = bundle.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "research bundle contains duplicate evidence ids",
      });
    }
  });

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceMetrics = z.infer<typeof evidenceMetricsSchema>;
export type ResearchEvidenceItem = z.infer<typeof researchEvidenceItemSchema>;
export type ResearchEvidenceBundle = z.infer<typeof researchEvidenceBundleSchema>;

// ---------------------------------------------------------------------------
// Normalized research (non-destructive)
// ---------------------------------------------------------------------------

/**
 * A normalized evidence record preserves the original validated record
 * verbatim (id, sourceUrl, text, metrics, …) and may only ADD provenance
 * helpers: `normalizedUrl` (deterministic comparison form) and `duplicateOf`
 * (likely-duplicate marker referencing an existing original id). Evidence is
 * never deleted, merged away, or rewritten.
 */
export const normalizedResearchEvidenceItemSchema = z
  .object({
    ...researchEvidenceItemFields,
    normalizedUrl: z.string().min(1).max(2048).optional(),
    duplicateOf: stableIdSchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    for (const [field, value] of [
      ["sourceUrl", item.sourceUrl],
      ["normalizedUrl", item.normalizedUrl],
    ] as const) {
      if (value !== undefined && !isHttpOrHttpsUrl(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be an absolute http:// or https:// URL`,
          path: [field],
        });
      }
    }
    if (item.duplicateOf !== undefined && item.duplicateOf === item.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicateOf must reference a different evidence id",
        path: ["duplicateOf"],
      });
    }
  });

export const normalizedResearchEvidenceBundleSchema = z
  .object({
    version: z.literal("v0"),
    collectedAt: isoDateTimeSchema,
    items: z.array(normalizedResearchEvidenceItemSchema).min(1).max(200),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const ids = new Set(bundle.items.map((item) => item.id));
    if (ids.size !== bundle.items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "normalized research bundle contains duplicate evidence ids",
      });
    }
    for (const item of bundle.items) {
      if (item.duplicateOf !== undefined) {
        if (!ids.has(item.duplicateOf)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicateOf references unknown evidence id "${item.duplicateOf}"`,
            path: ["items"],
          });
        } else {
          const target = bundle.items.find((candidate) => candidate.id === item.duplicateOf);
          if (target?.duplicateOf !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicateOf chains are forbidden ("${item.id}" → "${item.duplicateOf}" is itself a duplicate)`,
              path: ["items"],
            });
          }
        }
      }
    }
  });

export type NormalizedResearchEvidenceItem = z.infer<typeof normalizedResearchEvidenceItemSchema>;
export type NormalizedResearchEvidenceBundle = z.infer<typeof normalizedResearchEvidenceBundleSchema>;

// ---------------------------------------------------------------------------
// SiteIntelligencePlan
// ---------------------------------------------------------------------------

export const intelligenceIntentSchema = z.enum([
  "transactional",
  "commercial_investigation",
  "informational",
]);

export const intelligencePrioritySchema = z.enum(["high", "medium", "low"]);

export const marketSummarySchema = z
  .object({
    niche: boundedText(500),
    demandObservations: z.array(boundedText(500)).max(10),
    planningImplications: z.array(boundedText(500)).max(10),
    uncertainty: z.array(boundedText(500)).max(10),
  })
  .strict();

export const audienceSchema = z
  .object({
    name: boundedText(200),
    intent: intelligenceIntentSchema,
    evidenceIds: z.array(stableIdSchema).max(50).optional(),
  })
  .strict();

export const competitorInsightCategorySchema = z.enum([
  "service_coverage",
  "page_structure",
  "trust_signals",
  "content_themes",
  "gap",
]);

export const competitorInsightSchema = z
  .object({
    id: stableIdSchema,
    category: competitorInsightCategorySchema,
    summary: boundedText(1000),
    evidenceIds: z.array(stableIdSchema).min(1).max(50),
  })
  .strict();

export const keywordClusterSchema = z
  .object({
    id: stableIdSchema,
    primaryTopic: boundedText(200),
    supportingTerms: z.array(boundedText(150)).max(20),
    intent: intelligenceIntentSchema,
    priority: intelligencePrioritySchema,
    evidenceIds: z.array(stableIdSchema).min(1).max(50),
    /** Only values actually observed in referenced evidence may appear here. */
    metrics: evidenceMetricsSchema.optional(),
  })
  .strict();

/**
 * A planned launch page. Reuses the CURRENT SiteTask page invariants
 * (page types, slug rules, unique sections) via the shared refinement helper.
 * Provenance: at least one evidence reference OR explicit operator-fact
 * reference is mandatory (enforced deterministically by plan validation).
 */
export const plannedPageSchema = z
  .object({
    type: pageTypeSchema,
    slug: slugSchema,
    title: z.string().trim().min(1, "title cannot be empty").max(200, "title cannot exceed 200 characters"),
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .max(500, "description cannot exceed 500 characters"),
    sections: z
      .array(sectionTypeSchema)
      .min(1, "at least one section is required")
      .max(20, "maximum 20 sections allowed"),
    primaryTopic: boundedText(200),
    intent: intelligenceIntentSchema,
    priority: intelligencePrioritySchema,
    rationale: boundedText(2000),
    evidenceIds: z.array(stableIdSchema).max(50),
    operatorFactIds: z.array(stableIdSchema).max(30).optional(),
  })
  .strict()
  .superRefine(addSitePageInvariantIssues);

export const siteIntelligencePlanSchema = z
  .object({
    version: z.literal("v0"),
    methodologyVersion: z.literal(INTELLIGENCE_METHODOLOGY_VERSION),
    siteId: siteIdSchema,
    marketSummary: marketSummarySchema,
    audiences: z.array(audienceSchema).max(8),
    competitorInsights: z.array(competitorInsightSchema).max(20),
    keywordClusters: z.array(keywordClusterSchema).max(30),
    pages: z.array(plannedPageSchema).min(1).max(20),
    warnings: z.array(boundedText(1000)).max(20),
  })
  .strict();

export type IntelligenceIntent = z.infer<typeof intelligenceIntentSchema>;
export type IntelligencePriority = z.infer<typeof intelligencePrioritySchema>;
export type MarketSummary = z.infer<typeof marketSummarySchema>;
export type Audience = z.infer<typeof audienceSchema>;
export type CompetitorInsight = z.infer<typeof competitorInsightSchema>;
export type KeywordCluster = z.infer<typeof keywordClusterSchema>;
export type PlannedPage = z.infer<typeof plannedPageSchema>;
export type SiteIntelligencePlan = z.infer<typeof siteIntelligencePlanSchema>;

// ---------------------------------------------------------------------------
// IntelligenceResult
// ---------------------------------------------------------------------------

export const INTELLIGENCE_ERROR_CODES = [
  "intelligence_input_invalid",
  "research_input_invalid",
  "intelligence_source_unverified",
  "intelligence_isolation_unavailable",
  "intelligence_model_failed",
  "intelligence_model_timeout",
  "intelligence_output_invalid",
  "intelligence_no_progress",
  "intelligence_attempts_exhausted",
  "intelligence_plan_invalid",
  "intelligence_task_compilation_failed",
  "intelligence_artifact_failed",
] as const;

export const intelligenceErrorCodeSchema = z.enum(INTELLIGENCE_ERROR_CODES);

export type IntelligenceErrorCode = (typeof INTELLIGENCE_ERROR_CODES)[number];

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "digest must be a lowercase hex SHA-256 string",
});

export const modelRuntimeSchema = z
  .object({
    provider: z.string().min(1).max(100),
    runtime: z.string().min(1).max(100),
    codexVersion: z.string().min(1).max(100),
    /** Actual resolved model identifier, or null when truthfully unavailable. */
    model: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const intelligenceArtifactsSchema = z
  .object({
    /** Repo-relative run directory, e.g. ".factory/intelligence/<runId>". */
    runDirectory: z.string().min(1).max(500),
    manifest: z.string().max(500).nullable(),
    plan: z.string().max(500).nullable(),
    tasks: z.array(z.string().max(500)).max(20),
    result: z.string().max(500).nullable(),
  })
  .strict();

export const intelligenceErrorSchema = z
  .object({
    code: intelligenceErrorCodeSchema,
    message: z.string().min(1).max(2000),
  })
  .strict();

export const intelligenceResultSchema = z
  .object({
    version: z.literal("v0"),
    status: z.enum(["succeeded", "failed", "needs_review"]),
    runId: z.string().min(1).max(100),
    siteId: siteIdSchema.nullable(),
    factorySourceCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    methodologyVersion: z.string().min(1).max(100),
    requestDigest: sha256HexSchema.nullable(),
    researchDigest: sha256HexSchema.nullable(),
    planDigest: sha256HexSchema.nullable(),
    attemptCount: z.number().int().min(0).max(MAX_SYNTHESIS_ATTEMPTS),
    modelRuntime: modelRuntimeSchema.nullable(),
    artifacts: intelligenceArtifactsSchema.nullable(),
    taskCount: z.number().int().min(0).max(20),
    warnings: z.array(z.string().min(1).max(1000)).max(50),
    error: intelligenceErrorSchema.nullable(),
  })
  .strict();

export type ModelRuntime = z.infer<typeof modelRuntimeSchema>;
export type IntelligenceArtifacts = z.infer<typeof intelligenceArtifactsSchema>;
export type IntelligenceError = z.infer<typeof intelligenceErrorSchema>;
export type IntelligenceResult = z.infer<typeof intelligenceResultSchema>;

// ---------------------------------------------------------------------------
// Bounded parse helpers (mirror parseSiteTask semantics)
// ---------------------------------------------------------------------------

function parseJsonWithinLimit(input: unknown, maxBytes: number, label: string): unknown {
  if (input === null || input === undefined) {
    throw new Error(`${label} input cannot be null or undefined`);
  }
  let parsedObj: unknown;
  if (typeof input === "string") {
    if (input.length > maxBytes) {
      throw new Error(`${label} payload size (${input.length}) exceeds maximum allowed ${maxBytes}`);
    }
    parsedObj = JSON.parse(input);
  } else {
    const serialized = JSON.stringify(input);
    if (serialized.length > maxBytes) {
      throw new Error(`${label} payload size (${serialized.length}) exceeds maximum allowed ${maxBytes}`);
    }
    parsedObj = input;
  }
  return parsedObj;
}

/** Parse bounded input into a validated SiteIntelligenceRequest. */
export function parseSiteIntelligenceRequest(input: unknown): SiteIntelligenceRequest {
  return siteIntelligenceRequestSchema.parse(
    parseJsonWithinLimit(input, MAX_INTELLIGENCE_REQUEST_BYTES, "SiteIntelligenceRequest"),
  );
}

/** Parse bounded input into a validated ResearchEvidenceBundle. */
export function parseResearchEvidenceBundle(input: unknown): ResearchEvidenceBundle {
  return researchEvidenceBundleSchema.parse(
    parseJsonWithinLimit(input, MAX_RESEARCH_BUNDLE_BYTES, "ResearchEvidenceBundle"),
  );
}

/** Parse bounded model output into a structurally valid SiteIntelligencePlan. */
export function parseSiteIntelligencePlan(input: unknown): SiteIntelligencePlan {
  return siteIntelligencePlanSchema.parse(
    parseJsonWithinLimit(input, MAX_INTELLIGENCE_MODEL_OUTPUT_BYTES, "SiteIntelligencePlan"),
  );
}

/** Parse an IntelligenceResult (used for artifact verification and tests). */
export function parseIntelligenceResult(input: unknown): IntelligenceResult {
  return intelligenceResultSchema.parse(input);
}
