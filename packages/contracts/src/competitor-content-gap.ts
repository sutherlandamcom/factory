import { z } from "zod";

/**
 * Competitor + Content Gap contracts (Macro Run 3, v0).
 *
 * Authority model (never collapse these concepts):
 * - SerpSnapshot/SearchIntelligenceSnapshot = acquired upstream evidence.
 * - CompetitorPageSnapshot     = WHAT THE PAGE CONTAINED at observation time
 *                                (deterministic structural extraction; the
 *                                competitor page is EVIDENCE, never a copy
 *                                source and never factual authority).
 * - CompetitorPageAnalysis     = WHAT THE PAGE MEANS (bounded model
 *                                interpretation; conclusions must reference
 *                                normalized evidence segment IDs).
 * - ContentGapReport           = proposed differentiated content opportunity
 *                                (user need x SERP expectation x competitor
 *                                coverage x OUR accepted evidence).
 * - AcceptedContentGapSnapshot = immutable human-accepted gap set.
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed. No fabricated
 * numeric scores (SEO/E-E-A-T/keyword): coverage and confidence are
 * categorical, evidence-backed judgments. Unavailable values stay absent.
 */

export const COMPETITOR_SCHEMA_VERSION = "v1" as const;

export const COMPETITOR_ERROR_CODES = [
  "competitor_input_not_accepted",
  "competitor_serp_not_found",
  "competitor_no_candidates",
  "competitor_run_not_found",
  "competitor_page_failed",
  "competitor_analysis_invalid",
  "competitor_budget_blocked",
  "competitor_run_failed",
  "content_gap_report_not_found",
  "content_gap_invalid",
  "content_gap_stale",
  "content_gap_decision_invalid",
  "content_gap_accept_failed",
] as const;

export type CompetitorErrorCode = (typeof COMPETITOR_ERROR_CODES)[number];

/** Payload ceilings. Raw acquired HTML is bounded at acquisition time. */
export const MAX_PAGE_RAW_BYTES = 2 * 1024 * 1024;
export const MAX_COMPETITOR_PACKET_CHARS = 25_000;
export const MAX_CONTENT_GAP_REPORT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export const competitorClassificationSchema = z.enum([
  "INCLUDE",
  "EXCLUDE",
  "REFERENCE_ONLY",
]);
export type CompetitorClassification = z.infer<typeof competitorClassificationSchema>;

export const competitorCandidateKindSchema = z.enum([
  "service_page",
  "editorial_guide",
  "directory",
  "marketplace",
  "government",
  "forum",
  "video",
  "document",
  "other",
]);
export type CompetitorCandidateKind = z.infer<typeof competitorCandidateKindSchema>;

export const competitorAcquisitionStatusSchema = z.enum([
  "SUCCESS",
  "BLOCKED",
  "NON_HTML",
  "UNSUPPORTED",
  "FAILED",
]);
export type CompetitorAcquisitionStatus = z.infer<typeof competitorAcquisitionStatusSchema>;

/** Categorical evidence-backed judgment levels — never numeric fake scores. */
export const coverageLevelSchema = z.enum(["ABSENT", "WEAK", "PARTIAL", "STRONG"]);
export type CoverageLevel = z.infer<typeof coverageLevelSchema>;

export const levelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type Level = z.infer<typeof levelSchema>;

export const gapDispositionSchema = z.enum(["REQUIRED", "OPTIONAL", "EXCLUDE"]);
export type GapDisposition = z.infer<typeof gapDispositionSchema>;

export const gapPrioritySchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type GapPriority = z.infer<typeof gapPrioritySchema>;

export const contentGapReviewStateSchema = z.enum([
  "model_proposed",
  "operator_reviewed",
]);
export type ContentGapReviewState = z.infer<typeof contentGapReviewStateSchema>;

/** http/https URL without credentials (mirrors search contract evidenceUrlSchema). */
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

const boundedText = (max: number) => z.string().trim().max(max);

const idSchema = z.string().min(1).max(128);
const digestSchema = z.string().min(1).max(128);

export const confidenceSchema = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Competitor candidate (derived from a persisted SerpSnapshot)
// ---------------------------------------------------------------------------

export const competitorCandidateSchema = z
  .object({
    serpPosition: z.number().int().min(1),
    url: evidenceUrlSchema,
    domain: z.string().trim().min(1).max(253),
    title: boundedText(500),
    kind: competitorCandidateKindSchema,
    classification: competitorClassificationSchema,
    classificationReason: boundedText(500),
    /** Deterministic heuristics version (reasons are auditable per version). */
    classificationPolicyVersion: z.string().min(1).max(64),
  })
  .strict();
export type CompetitorCandidate = z.infer<typeof competitorCandidateSchema>;

// ---------------------------------------------------------------------------
// Competitor page snapshot (immutable acquired + extracted evidence)
// ---------------------------------------------------------------------------

/** One normalized, addressable evidence segment of the page. */
export const evidenceSegmentSchema = z
  .object({
    id: z
      .string()
      .regex(/^seg-\d{3,}$/, "segment id must be seg-<number> (stable, ordered)"),
    kind: z.enum(["heading", "paragraph", "list", "table", "question", "faq", "citation", "cta", "metadata"]),
    /** Bounded normalized text content of the segment. */
    text: boundedText(2000),
    /** Heading level when kind === "heading" (2 = H2, 3 = H3). */
    level: z.number().int().min(1).max(6).optional(),
  })
  .strict();
export type EvidenceSegment = z.infer<typeof evidenceSegmentSchema>;

export const competitorPageExtractedSchema = z
  .object({
    pageTitle: boundedText(500).optional(),
    metaDescription: boundedText(1000).optional(),
    canonicalUrl: evidenceUrlSchema.optional(),
    h1: boundedText(500).optional(),
    headings: z.array(evidenceSegmentSchema).max(200),
    segments: z.array(evidenceSegmentSchema).max(400),
    questions: z.array(boundedText(500)).max(100),
    /** JSON-LD @type signals actually present (e.g. FAQPage, Article, Product). */
    jsonLdTypes: z.array(boundedText(100)).max(20),
    hasFaqSchema: z.boolean(),
    outboundLinks: z
      .array(
        z
          .object({
            url: evidenceUrlSchema,
            text: boundedText(300).optional(),
          })
          .strict(),
      )
      .max(50),
    publicationDate: boundedText(40).optional(),
    updatedDate: boundedText(40).optional(),
    /** Deterministic CTA/commercial signal candidates. */
    ctaSignals: z.array(boundedText(200)).max(30),
    wordCount: z.number().int().min(0),
    /** Extraction metadata — honest about noise removal. */
    extractionVersion: z.string().min(1).max(64),
  })
  .strict();
export type CompetitorPageExtracted = z.infer<typeof competitorPageExtractedSchema>;

export const competitorPageSnapshotDataSchema = z
  .object({
    requestedUrl: evidenceUrlSchema,
    finalUrl: evidenceUrlSchema,
    domain: z.string().trim().min(1).max(253),
    httpStatus: z.number().int().min(200).max(599),
    contentType: boundedText(200),
    observedAt: z.string().datetime(),
    rawDigest: digestSchema,
    /** Retained bounded raw HTML digest of the extraction input. */
    extractionDigest: digestSchema,
    extracted: competitorPageExtractedSchema,
    /** Trusted acquisition provider id (direct HTTP or fixture for CI). */
    provider: z.enum(["direct_http", "fixture_page"]),
    acquisitionMethodVersion: z.string().min(1).max(64),
  })
  .strict();
export type CompetitorPageSnapshotData = z.infer<typeof competitorPageSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// Evidence packet (deterministic reduction for the analyst)
// ---------------------------------------------------------------------------

export const competitorEvidencePacketSchema = z
  .object({
    selectionPolicyVersion: z.literal("selection-policy-v1"),
    /** Characters of normalized extracted evidence available. */
    sourceChars: z.number().int().min(0),
    /** Characters actually selected into the packet. */
    selectedChars: z.number().int().min(0),
    /** True when the selection policy dropped available evidence. */
    selectionTruncated: z.boolean(),
    pageSnapshotId: idSchema,
    pageSnapshotDigest: digestSchema,
    url: evidenceUrlSchema,
    domain: z.string().trim().min(1).max(253),
    observedAt: z.string().datetime(),
    extracted: competitorPageExtractedSchema,
  })
  .strict();
export type CompetitorEvidencePacket = z.infer<typeof competitorEvidencePacketSchema>;

// ---------------------------------------------------------------------------
// Competitor page analysis (bounded model interpretation — NOT authority)
// ---------------------------------------------------------------------------

export const analysisEvidenceRefSchema = z
  .object({
    pageSnapshotId: idSchema,
    segmentId: z.string().regex(/^seg-\d{3,}$/),
  })
  .strict();
export type AnalysisEvidenceRef = z.infer<typeof analysisEvidenceRefSchema>;

export const competitorPageAnalysisDataSchema = z
  .object({
    pageType: boundedText(100),
    primaryIntent: boundedText(100),
    topics: z.array(boundedText(200)).max(30),
    subtopics: z.array(boundedText(200)).max(30),
    entities: z.array(boundedText(200)).max(30),
    questionsAnswered: z.array(boundedText(500)).max(30),
    questionsUnanswered: z.array(boundedText(500)).max(30),
    /** Coverage areas with categorical, evidence-backed levels. */
    coverageAreas: z
      .array(
        z
          .object({
            area: boundedText(200),
            level: coverageLevelSchema,
            rationale: boundedText(500),
          })
          .strict(),
      )
      .max(20),
    dataFactsUsed: z.array(boundedText(500)).max(30),
    sourceSignals: z.array(boundedText(500)).max(20),
    trustSignals: z.array(boundedText(500)).max(20),
    experienceSignals: z.array(boundedText(500)).max(20),
    commercialPositioning: boundedText(1000),
    ctaTreatment: boundedText(500),
    freshnessAssessment: boundedText(500),
    strengths: z.array(boundedText(500)).max(20),
    weaknesses: z.array(boundedText(500)).max(20),
    uniqueTreatment: z.array(boundedText(500)).max(20),
    missingTreatment: z.array(boundedText(500)).max(20),
    /** Every conclusion-anchoring reference must resolve to a real segment. */
    evidenceSegmentRefs: z.array(analysisEvidenceRefSchema).max(60).min(1),
    confidence: confidenceSchema,
  })
  .strict();
export type CompetitorPageAnalysisData = z.infer<typeof competitorPageAnalysisDataSchema>;

// ---------------------------------------------------------------------------
// Coverage matrix (deterministically computed from analyses)
// ---------------------------------------------------------------------------

export const coverageMatrixSchema = z
  .object({
    policyVersion: z.string().min(1).max(64),
    /** Rows = user needs / semantic requirements. */
    rows: z
      .array(
        z
          .object({
            requirement: boundedText(300),
            /** Per INCLUDED analyzed competitor, in run order. */
            cells: z.array(
              z
                .object({
                  pageSnapshotId: idSchema,
                  domain: z.string().trim().min(1).max(253),
                  level: coverageLevelSchema,
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type CoverageMatrix = z.infer<typeof coverageMatrixSchema>;

// ---------------------------------------------------------------------------
// Content gap report (model-proposed, operator-reviewed, versioned)
// ---------------------------------------------------------------------------

export const firstPartyEvidenceRefSchema = z
  .object({
    /** Which accepted intake evidence item supports this (operatorFacts index). */
    intakeField: z.enum(["operatorFacts", "allowedClaims"]),
    itemIndex: z.number().int().min(0),
    excerpt: boundedText(300),
  })
  .strict();
export type FirstPartyEvidenceRef = z.infer<typeof firstPartyEvidenceRefSchema>;

export const contentGapSchema = z
  .object({
    id: z.string().min(1).max(64),
    userNeed: boundedText(500),
    topicQuestion: boundedText(500),
    searchEvidenceRefs: z
      .array(
        z
          .object({
            kind: z.enum(["serp_snapshot", "search_intelligence_snapshot"]),
            id: idSchema,
            digest: digestSchema,
          })
          .strict(),
      )
      .max(10),
    competitorCoverage: coverageLevelSchema,
    competitorsCoveringIt: z.array(idSchema).max(20),
    treatmentPattern: boundedText(1000),
    baselineExpectation: boundedText(1000),
    ourEvidenceAvailable: z.array(firstPartyEvidenceRefSchema).max(20),
    ourEvidenceMissing: z.array(boundedText(500)).max(20),
    claimConstraints: z.array(boundedText(300)).max(20),
    differentiationOpportunity: boundedText(1000),
    recommendedDisposition: gapDispositionSchema,
    priority: gapPrioritySchema,
    rationale: boundedText(1500),
    evidenceRefs: z.array(analysisEvidenceRefSchema).max(60),
  })
  .strict();
export type ContentGap = z.infer<typeof contentGapSchema>;

export const differentiationRequirementsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            requirement: boundedText(300),
            basis: z.enum(["accepted_evidence", "editorial_opportunity"]),
            rationale: boundedText(500),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type DifferentiationRequirements = z.infer<typeof differentiationRequirementsSchema>;

export const contentGapReportDataSchema = z
  .object({
    serpSnapshotId: idSchema,
    serpSnapshotDigest: digestSchema,
    intelligenceSnapshotId: idSchema,
    intelligenceSnapshotDigest: digestSchema,
    pageSnapshotRefs: z
      .array(z.object({ id: idSchema, digest: digestSchema }).strict())
      .max(10),
    analysisRefs: z
      .array(z.object({ id: idSchema, digest: digestSchema }).strict())
      .max(10),
    acceptedInputSnapshotId: idSchema,
    acceptedInputSnapshotVersion: z.number().int().min(1),
    acceptedInputDigest: digestSchema,
    coverageMatrix: coverageMatrixSchema,
    gaps: z.array(contentGapSchema).max(30),
    differentiationRequirements: differentiationRequirementsSchema,
    model: boundedText(200),
    provider: boundedText(100),
    promptVersion: z.string().min(1).max(64),
    reviewState: contentGapReviewStateSchema,
  })
  .strict();
export type ContentGapReportData = z.infer<typeof contentGapReportDataSchema>;

// ---------------------------------------------------------------------------
// Operator review decisions
// ---------------------------------------------------------------------------

export const gapDecisionSchema = z
  .object({
    gapId: z.string().min(1).max(64),
    disposition: gapDispositionSchema,
    priority: gapPrioritySchema.optional(),
    note: boundedText(500).optional(),
  })
  .strict();
export type GapDecision = z.infer<typeof gapDecisionSchema>;

export const gapDecisionRecordSchema = gapDecisionSchema
  .extend({
    priority: gapPrioritySchema.nullable(),
    note: boundedText(500).nullable(),
  })
  .strict();
export type GapDecisionRecord = z.infer<typeof gapDecisionRecordSchema>;

/**
 * Report digest + all-gap decisions digest bind the accepted snapshot.
 * Every gap of the report must have exactly one decision to accept.
 */
export const contentGapDecisionsDataSchema = z
  .object({
    reportId: idSchema,
    reportDigest: digestSchema,
    decisions: z.array(gapDecisionSchema).max(30),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [i, d] of data.decisions.entries()) {
      if (seen.has(d.gapId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate decision for gap "${d.gapId}"`,
          path: ["decisions", i],
        });
      }
      seen.add(d.gapId);
    }
  });
export type ContentGapDecisionsData = z.infer<typeof contentGapDecisionsDataSchema>;

// ---------------------------------------------------------------------------
// Accepted Content Gap Snapshot data (immutable human-accepted truth)
// ---------------------------------------------------------------------------

export const acceptedContentGapItemSchema = contentGapSchema
  .extend({
    /** Human-reviewed disposition is authoritative after acceptance. */
    disposition: gapDispositionSchema,
    /** Operator-decided priority (preserves operator decision or model recommendation). */
    priority: gapPrioritySchema,
    /** Operator review note (preserved exactly; null when omitted). */
    note: boundedText(500).nullable(),
    /** Model-proposed disposition preserved for provenance. */
    recommendedDisposition: gapDispositionSchema,
    /** Model-proposed priority preserved for provenance. */
    recommendedPriority: gapPrioritySchema,
  })
  .strict();
export type AcceptedContentGapItem = z.infer<typeof acceptedContentGapItemSchema>;

export const acceptedContentGapSnapshotDataSchema = z
  .object({
    serpSnapshotId: idSchema,
    serpSnapshotDigest: digestSchema,
    intelligenceSnapshotId: idSchema,
    intelligenceSnapshotDigest: digestSchema,
    pageSnapshotRefs: z
      .array(z.object({ id: idSchema, digest: digestSchema }).strict())
      .max(10),
    analysisRefs: z
      .array(z.object({ id: idSchema, digest: digestSchema }).strict())
      .max(10),
    acceptedInputSnapshotId: idSchema,
    acceptedInputSnapshotVersion: z.number().int().min(1),
    acceptedInputDigest: digestSchema,
    coverageMatrix: coverageMatrixSchema,
    /** Gaps with human-reviewed decisions materialized as authoritative. */
    gaps: z.array(acceptedContentGapItemSchema).max(30),
    differentiationRequirements: differentiationRequirementsSchema,
    model: boundedText(200),
    provider: boundedText(100),
    promptVersion: z.string().min(1).max(64),
    /** Review state of the accepted snapshot (always accepted). */
    reviewState: z.literal("accepted").optional(),
    /** Exact operator review decisions preserved inside the immutable snapshot. */
    decisions: z.array(gapDecisionRecordSchema).max(30),
  })
  .strict();
export type AcceptedContentGapSnapshotData = z.infer<typeof acceptedContentGapSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// Parsers (fail closed on drift, mirroring search contract exports)
// ---------------------------------------------------------------------------

export function parseCompetitorPageSnapshotData(input: unknown): CompetitorPageSnapshotData {
  return competitorPageSnapshotDataSchema.parse(input);
}

export function parseCompetitorPageAnalysisData(
  input: unknown,
  validSegmentIds?: ReadonlySet<string>,
): CompetitorPageAnalysisData {
  const data = competitorPageAnalysisDataSchema.parse(input);
  if (validSegmentIds) {
    for (const ref of data.evidenceSegmentRefs) {
      if (!validSegmentIds.has(ref.segmentId)) {
        throw new Error(`unknown evidence segment ref "${ref.segmentId}"`);
      }
    }
  }
  return data;
}

export function parseContentGapReportData(input: unknown): ContentGapReportData {
  return contentGapReportDataSchema.parse(input);
}

export function parseContentGapDecisionsData(input: unknown): ContentGapDecisionsData {
  return contentGapDecisionsDataSchema.parse(input);
}

export function parseAcceptedContentGapSnapshotData(input: unknown): AcceptedContentGapSnapshotData {
  return acceptedContentGapSnapshotDataSchema.parse(input);
}
