import { z } from "zod";

/**
 * Search Intelligence contracts (Live Search Intelligence v0, Macro Run 2).
 *
 * Authority model (never collapse these concepts):
 * - StructuredSerpProvider = WHAT THE SEARCH ENGINE RETURNED (measurement).
 * - GroundedSearchProvider = WHAT CURRENT WEB EVIDENCE TELLS US (model-mediated
 *   research with citations; NEVER exact SERP rankings).
 * - SearchIntelligence     = WHAT THE EVIDENCE MEANS for this project/site
 *   (derived analysis; model output is never factual authority).
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed. Absent provider
 * capabilities are represented by absent/empty arrays (UNKNOWN), never
 * invented data.
 */

export const SEARCH_SCHEMA_VERSION = "v1" as const;

/** Stable typed error codes for the Search domain (subset of OperatorErrorCode). */
export const SEARCH_ERROR_CODES = [
  "search_input_not_accepted",
  "search_query_invalid",
  "search_provider_not_configured",
  "search_provider_unavailable",
  "search_provider_auth_failed",
  "search_provider_budget_blocked",
  "search_provider_rate_limited",
  "search_response_invalid",
  "search_normalization_failed",
  "search_intelligence_invalid",
  "search_run_not_found",
  "search_run_failed",
] as const;

export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/** Payload ceilings (bytes) for persisted search artifacts. */
export const MAX_SERP_RAW_BYTES = 256 * 1024;
export const MAX_GROUNDED_RAW_BYTES = 256 * 1024;
export const MAX_SEARCH_INTELLIGENCE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const boundedText = (max: number) => z.string().trim().max(max);

/**
 * Deterministic query normalization: trim, collapse internal whitespace,
 * reject control characters. Seeds from Project Intake remain seeds — the
 * operator-facing query is validated, not rewritten semantically.
 */
export function normalizeSearchQuery(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const normalizedQuerySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => normalizeSearchQuery(v) === v, "query must be normalized (trim + collapse whitespace)");

/** http/https URL without credentials. */
const evidenceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL without credentials");

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((v) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v), "must be a registrable domain");

// ---------------------------------------------------------------------------
// Search request
// ---------------------------------------------------------------------------

export const searchDeviceSchema = z.enum(["desktop", "mobile", "tablet"]);
export type SearchDevice = z.infer<typeof searchDeviceSchema>;

/**
 * Provider identifiers. `fixture` is the deterministic test provider; it is
 * only selectable through trusted backend configuration, never by the browser.
 */
export const searchProviderIdSchema = z.enum(["dataforseo", "fixture"]);
export type SearchProviderId = z.infer<typeof searchProviderIdSchema>;

export const searchRequestSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    acceptedProjectInputSnapshotId: z.string().min(1).max(128),
    acceptedProjectInputSnapshotVersion: z.number().int().min(1),
    acceptedProjectInputDigest: z.string().min(1).max(128),
    query: normalizedQuerySchema,
    location: boundedText(200).optional(),
    language: boundedText(35).optional(),
    device: searchDeviceSchema,
    provider: searchProviderIdSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export function parseSearchRequest(input: unknown): SearchRequest {
  return searchRequestSchema.parse(input);
}

// ---------------------------------------------------------------------------
// SERP snapshot data (exact measurement — StructuredSerpProvider authority)
// ---------------------------------------------------------------------------

export const serpOrganicResultSchema = z
  .object({
    /** 1-based ranking position as returned by the provider. */
    position: z.number().int().min(1),
    url: evidenceUrlSchema,
    domain: domainSchema,
    title: boundedText(500),
    snippet: boundedText(2000),
  })
  .strict();

export type SerpOrganicResult = z.infer<typeof serpOrganicResultSchema>;

/**
 * SERP features are a closed vocabulary of well-known Google result types.
 * Only features actually exposed by the provider are recorded.
 */
export const serpFeatureSchema = z.enum([
  "featured_snippet",
  "local_pack",
  "knowledge_panel",
  "image_pack",
  "video_results",
  "shopping_results",
  "ads_top",
  "ads_bottom",
  "sitelinks",
  "top_stories",
]);
export type SerpFeature = z.infer<typeof serpFeatureSchema>;

export const peopleAlsoAskItemSchema = z
  .object({
    question: boundedText(500),
    /** Present only when the provider exposes the expanded answer. */
    answer: boundedText(2000).optional(),
  })
  .strict();

export type PeopleAlsoAskItem = z.infer<typeof peopleAlsoAskItemSchema>;

export const serpSnapshotDataSchema = z
  .object({
    /** Ordered by position ascending (organic ranking is preserved). */
    organic: z.array(serpOrganicResultSchema).max(100),
    /** Present only when the provider exposes feature data; absent = UNKNOWN. */
    features: z.array(serpFeatureSchema).max(20).optional(),
    peopleAlsoAsk: z.array(peopleAlsoAskItemSchema).max(20).optional(),
    relatedSearches: z.array(boundedText(200)).max(30).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (let i = 1; i < data.organic.length; i++) {
      if (data.organic[i]!.position <= data.organic[i - 1]!.position) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "organic results must be ordered by ascending position",
          path: ["organic", i],
        });
        break;
      }
    }
  });

export type SerpSnapshotData = z.infer<typeof serpSnapshotDataSchema>;

export function parseSerpSnapshotData(input: unknown): SerpSnapshotData {
  return serpSnapshotDataSchema.parse(input);
}

/** Provider usage/cost telemetry; UNKNOWN cost stays null (never fabricated). */
export const searchUsageSchema = z
  .object({
    costMicros: z.number().int().min(0).nullable().optional(),
    currency: boundedText(8).optional(),
    /** Provider-native cost fields we could not interpret remain unknown. */
    costUnknown: z.boolean().optional(),
    inputTokens: z.number().int().min(0).nullable().optional(),
    outputTokens: z.number().int().min(0).nullable().optional(),
    totalTokens: z.number().int().min(0).nullable().optional(),
    searchQueriesCount: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export type SearchUsage = z.infer<typeof searchUsageSchema>;

// ---------------------------------------------------------------------------
// Grounded search snapshot data (model-mediated web research — NEVER rankings)
// ---------------------------------------------------------------------------

export const groundedSourceSchema = z
  .object({
    title: boundedText(500).optional(),
    uri: evidenceUrlSchema,
  })
  .strict();

export type GroundedSource = z.infer<typeof groundedSourceSchema>;

/**
 * Citation/support relationships: which grounded output span is supported by
 * which source. `outputSegment` is a bounded verbatim excerpt of the model's
 * structured output; provenance only — never treated as authority.
 */
export const groundedCitationSchema = z
  .object({
    outputSegment: boundedText(1000),
    sourceIndex: z.number().int().min(0),
  })
  .strict();

export type GroundedCitation = z.infer<typeof groundedCitationSchema>;

export const groundedSearchDataSchema = z
  .object({
    /** The actual Google search queries the model executed while grounding. */
    webSearchQueries: z.array(boundedText(200)).max(20),
    sources: z.array(groundedSourceSchema).max(50),
    citations: z.array(groundedCitationSchema).max(100).optional(),
    structuredOutput: z.record(z.string(), z.unknown()),
  })
  .strict();

export type GroundedSearchData = z.infer<typeof groundedSearchDataSchema>;

export function parseGroundedSearchData(input: unknown): GroundedSearchData {
  return groundedSearchDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Search Intelligence data (derived meaning — analyst model is NOT authority)
// ---------------------------------------------------------------------------

export const searchIntentSchema = z.enum([
  "informational",
  "commercial",
  "transactional",
  "local",
  "navigational",
]);
export type SearchIntent = z.infer<typeof searchIntentSchema>;

export const reviewStateSchema = z.enum(["model_proposed", "operator_reviewed"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

const confidenceSchema = z.number().min(0).max(1);

export const queryClusterSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: boundedText(200),
    queries: z.array(normalizedQuerySchema).max(30).min(1),
    intent: searchIntentSchema,
    primaryQuery: normalizedQuerySchema,
    secondaryQueries: z.array(normalizedQuerySchema).max(30),
    rationale: boundedText(1000).optional(),
    confidence: confidenceSchema,
  })
  .strict()
  .refine(
    (c) => c.queries.includes(c.primaryQuery) && c.secondaryQueries.every((q) => c.queries.includes(q)),
    "primary and secondary queries must belong to the cluster's query list",
  );

export type QueryCluster = z.infer<typeof queryClusterSchema>;

export const searchTopicSchema = z
  .object({
    topic: boundedText(200),
    subtopics: z.array(boundedText(200)).max(20),
  })
  .strict();

export type SearchTopic = z.infer<typeof searchTopicSchema>;

export const searchEntitySchema = z
  .object({
    name: boundedText(200),
    kind: boundedText(100).optional(),
    notes: boundedText(500).optional(),
  })
  .strict();

export type SearchEntity = z.infer<typeof searchEntitySchema>;

/**
 * Evidence provenance: every intelligence snapshot references the exact
 * acquired evidence it was derived from (snapshot ids + digests).
 */
export const searchEvidenceRefSchema = z
  .object({
    kind: z.enum(["serp_snapshot", "grounded_snapshot"]),
    id: z.string().min(1).max(128),
    digest: z.string().min(1).max(128),
  })
  .strict();

export type SearchEvidenceRef = z.infer<typeof searchEvidenceRefSchema>;

export const searchIntelligenceDataSchema = z
  .object({
    primaryIntent: searchIntentSchema,
    intentRationale: boundedText(2000),
    secondaryIntents: z.array(searchIntentSchema).max(5),
    queryClusters: z.array(queryClusterSchema).max(15),
    longTailOpportunities: z
      .array(
        z
          .object({
            query: normalizedQuerySchema,
            rationale: boundedText(500).optional(),
            confidence: confidenceSchema,
          })
          .strict(),
      )
      .max(30),
    entities: z.array(searchEntitySchema).max(50),
    topics: z.array(searchTopicSchema).max(30),
    questions: z.array(boundedText(500)).max(50),
    modifiers: z.array(boundedText(100)).max(50),
    searchVocabulary: z.array(boundedText(100)).max(100),
    relatedConcepts: z.array(boundedText(200)).max(50),
    semanticCoverageRequirements: z.array(boundedText(500)).max(30),
    userNeeds: z.array(boundedText(500)).max(30),
    evidenceRefs: z.array(searchEvidenceRefSchema).max(10).min(1),
    reviewState: reviewStateSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const clusterIds = new Set<string>();
    for (const [i, cluster] of data.queryClusters.entries()) {
      if (clusterIds.has(cluster.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate query cluster id "${cluster.id}"`,
          path: ["queryClusters", i],
        });
      }
      clusterIds.add(cluster.id);
    }
  });

export type SearchIntelligenceData = z.infer<typeof searchIntelligenceDataSchema>;

export function parseSearchIntelligenceData(input: unknown): SearchIntelligenceData {
  return searchIntelligenceDataSchema.parse(input);
}
