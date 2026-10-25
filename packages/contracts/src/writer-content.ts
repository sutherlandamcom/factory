import { z } from "zod";

/**
 * WRITER CONTENT CONTRACTS — Macro Run 4 (Content Constitution + Opus Writer).
 *
 * Versioned, digest-bound artifacts between accepted inputs and accepted page
 * content. Semantics mirror the accepted intake / accepted gap snapshot
 * patterns: approve exact revision + exact digest -> immutable version;
 * edits -> new draft -> new version; stale approval rejected with typed
 * errors; no silent semantic loss (strict schemas, bounded fields).
 */

export const WRITER_CONTENT_SCHEMA_VERSION = "writer-content-v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const idSchema = z.string().trim().min(1).max(128);
export const digestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Factory Writer Policy (project-level, immutable once approved)
// ---------------------------------------------------------------------------

/**
 * The non-negotiable writing rules for the project. DERIVED from the accepted
 * ProjectInputSnapshot's Content Constitution — the intake snapshot stays the
 * single source of truth; the writer policy is a governed projection bound to
 * its exact id/version/digest, never an independently editable second SOT.
 */
export const writerPolicyRulesSchema = z
  .object({
    brandVoice: boundedText(1000),
    tone: boundedText(500),
    audiencePrinciples: z.array(boundedText(300)).max(10),
    writingPrinciples: z.array(boundedText(300)).max(10),
    preferredTerminology: z.array(boundedText(100)).max(20),
    forbiddenTerminology: z.array(boundedText(100)).max(20),
    evidencePolicy: boundedText(1000),
    peopleFirstPrinciples: z.array(boundedText(300)).max(10),
    trustExpectations: boundedText(500),
    aiLanguageAvoidance: z.array(boundedText(200)).max(10),
    clicheAvoidance: z.array(boundedText(200)).max(10),
    localePreferences: boundedText(300),
    customWriterInstructions: z.string().max(8000),
  })
  .strict();
export type WriterPolicyRules = z.infer<typeof writerPolicyRulesSchema>;

export const writerPolicyDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    /** Exact accepted ProjectInputSnapshot lineage this policy derives from. */
    acceptedInputSnapshotId: idSchema,
    acceptedInputSnapshotVersion: z.number().int().min(1),
    acceptedInputDigest: digestSchema,
    /** The governed projection of the accepted Content Constitution. */
    rules: writerPolicyRulesSchema,
  })
  .strict();
export type WriterPolicyData = z.infer<typeof writerPolicyDataSchema>;

// ---------------------------------------------------------------------------
// Page Target (operator-supplied brief fields — NOT a pages registry/SOT)
// ---------------------------------------------------------------------------

export const pageTargetSchema = z
  .object({
    /** Versioned approved planning authority; absent only for historical briefs. */
    designBinding: z.object({
      schemaVersion: z.literal("page-design-binding-v1"),
      archetype: z.enum(["homepage", "service", "location", "editorial", "investment_advisory"]),
    }).strict().optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-/]*$/, "slug must be lowercase letters, digits, hyphens (and optional slashes)"),
    title: boundedText(200),
    objective: boundedText(1000),
    audience: boundedText(1000),
    structureGuidance: z.array(boundedText(500)).max(15),
    internalLinkIntent: z.array(boundedText(300)).max(10),
    ctaIntent: boundedText(500),
  })
  .strict();
export type PageTarget = z.infer<typeof pageTargetSchema>;

// ---------------------------------------------------------------------------
// Content Production Brief (page-level, composed deterministically)
// ---------------------------------------------------------------------------

export const contentBriefLineageSchema = z
  .object({
    acceptedInputSnapshotId: idSchema,
    acceptedInputSnapshotVersion: z.number().int().min(1),
    acceptedInputDigest: digestSchema,
    writerPolicyId: idSchema,
    writerPolicyVersion: z.number().int().min(1),
    writerPolicyDigest: digestSchema,
    /** Accepted ContentGap snapshot lineage (the search-evidence bridge). */
    gapSnapshotId: idSchema.optional(),
    gapSnapshotVersion: z.number().int().min(1).optional(),
    gapSnapshotDigest: digestSchema.optional(),
  })
  .strict();
export type ContentBriefLineage = z.infer<typeof contentBriefLineageSchema>;

export const contentBriefDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    lineage: contentBriefLineageSchema,
    pageTarget: pageTargetSchema,
    /** Claims policy materialized from the accepted intake (verbatim). */
    allowedClaims: z.array(boundedText(300)).max(20),
    prohibitedClaims: z.array(boundedText(300)).max(20),
    unknownClaims: z.array(boundedText(300)).max(20),
    operatorFacts: z.array(boundedText(1000)).max(30),
    /** Search semantics copied verbatim from the accepted gap snapshot. */
    searchSemantics: z
      .object({
        primaryIntent: boundedText(100),
        semanticCoverageRequirements: z.array(boundedText(500)).max(30),
        userNeeds: z.array(boundedText(500)).max(30),
      })
      .strict(),
    /**
     * TRANSITIONAL COMPATIBILITY (pre-vNext create_page contract): bounded
     * semantic key points. DEPRECATED — retires after AcceptedPageContent
     * pipeline acceptance. Not permission to invent additional claims.
     */
    contentBriefKeyPoints: z.array(boundedText(500)).max(20),
    /** Explicit operator acknowledgement when approving without gap lineage. */
    noGapLineageAcknowledged: z.boolean(),
  })
  .strict();
export type ContentBriefData = z.infer<typeof contentBriefDataSchema>;

// ---------------------------------------------------------------------------
// WriterPromptSnapshot (exact compiled prompt packet)
// ---------------------------------------------------------------------------

export const writerPromptSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    briefId: idSchema,
    briefVersion: z.number().int().min(1),
    briefDigest: digestSchema,
    /** The exact compiled prompt packet sent to the writer. */
    systemPrompt: z.string().min(1).max(32_000),
    userPrompt: z.string().min(1).max(64_000),
    /** Bounded output ceiling (tokens) — required for budget ceilings. */
    maxOutputTokens: z.number().int().min(1).max(64_000),
  })
  .strict();
export type WriterPromptSnapshotData = z.infer<typeof writerPromptSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// PageContentProposal (structured writer output)
// ---------------------------------------------------------------------------

export const proposalSectionSchema = z
  .object({
    heading: boundedText(300),
    body: z.string().min(1).max(20_000),
  })
  .strict();
export type ProposalSection = z.infer<typeof proposalSectionSchema>;

export const pageContentProposalDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    snapshotId: idSchema,
    snapshotVersion: z.number().int().min(1),
    snapshotDigest: digestSchema,
    title: boundedText(200),
    metaDescription: boundedText(400),
    introduction: z.string().min(1).max(20_000),
    sections: z.array(proposalSectionSchema).max(30),
    conclusion: z.string().min(1).max(20_000),
    cta: boundedText(1000),
    internalLinks: z.array(boundedText(300)).max(10),
  })
  .strict();
export type PageContentProposalData = z.infer<typeof pageContentProposalDataSchema>;

// ---------------------------------------------------------------------------
// P1-03 — deterministic JSON Schema generator for the WRITER RESPONSE subset.
//
// The model must return a single strict JSON document. Rather than
// describing the response in loose prose (which GLM-5.3-flash violated by
// returning `internalLinks` as objects), the compiled prompt carries the
// exact JSON Schema generated from the Factory contract. The Factory
// contract is NEVER loosened to admit a malformed model response; this
// generator exists only to express the SAME constraints in JSON Schema form
// for prompt guidance (and, after verified wire-capability probing, for
// schema-constrained output requests).
// ---------------------------------------------------------------------------

export interface WriterProposalJsonSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

const WRITER_RESPONSE_FIELD_BOUNDS = {
  title: { min: 1, max: 200 },
  metaDescription: { min: 1, max: 400 },
  introduction: { min: 1, max: 20_000 },
  sectionHeading: { max: 300 },
  sectionBody: { min: 1, max: 20_000 },
  conclusion: { min: 1, max: 20_000 },
  cta: { min: 1, max: 1000 },
  internalLink: { max: 300 },
  maxSections: 30,
  maxInternalLinks: 10,
} as const;

/**
 * Build the JSON Schema for the writer RESPONSE subset of
 * PageContentProposalData. `snapshotId`/`snapshotVersion`/`snapshotDigest`
 * and `schemaVersion` are NOT part of the requested response: the
 * persistence layer binds them from the EXACT approved snapshot AFTER the
 * response is validated (no model-authored lineage fields).
 */
export function writerProposalResponseJsonSchema(): WriterProposalJsonSchema {
  const b = WRITER_RESPONSE_FIELD_BOUNDS;
  return {
    name: "page_content_proposal",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "metaDescription", "introduction", "sections", "conclusion", "cta", "internalLinks"],
      properties: {
        title: { type: "string", minLength: b.title.min, maxLength: b.title.max },
        metaDescription: { type: "string", minLength: b.metaDescription.min, maxLength: b.metaDescription.max },
        introduction: { type: "string", minLength: b.introduction.min, maxLength: b.introduction.max },
        sections: {
          type: "array",
          maxItems: b.maxSections,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "body"],
            properties: {
              heading: { type: "string", minLength: 1, maxLength: b.sectionHeading.max },
              body: { type: "string", minLength: b.sectionBody.min, maxLength: b.sectionBody.max },
            },
          },
        },
        conclusion: { type: "string", minLength: b.conclusion.min, maxLength: b.conclusion.max },
        cta: { type: "string", minLength: b.cta.min, maxLength: b.cta.max },
        // THE exact field the flash model previously violated: internalLinks
        // is an ARRAY OF STRING SLUG PATHS — never objects, never missing.
        internalLinks: {
          type: "array",
          maxItems: b.maxInternalLinks,
          items: { type: "string", maxLength: b.internalLink.max },
        },
      },
    },
  };
}

/** Verbatim JSON text of the response schema (embedded into the prompt). */
export function writerProposalResponseJsonSchemaText(): string {
  return JSON.stringify(writerProposalResponseJsonSchema(), null, 2);
}

// ---------------------------------------------------------------------------
// QA verdicts (deterministic triad; no fake numeric scores)
// ---------------------------------------------------------------------------

export const qaVerdictSchema = z.enum(["PASS", "REVIEW", "FAIL"]);
export type QaVerdict = z.infer<typeof qaVerdictSchema>;

export const qaEvidenceRefSchema = z
  .object({
    kind: z.enum(["claim", "requirement", "userNeed", "section", "policyRule", "briefField"]),
    ref: z.string().min(1).max(300),
    note: z.string().max(500).optional(),
  })
  .strict();
export type QaEvidenceRef = z.infer<typeof qaEvidenceRefSchema>;

export const qaCheckResultSchema = z
  .object({
    checkId: z.string().min(1).max(100),
    verdict: qaVerdictSchema,
    detail: z.string().min(1).max(2000),
    evidence: z.array(qaEvidenceRefSchema).max(50),
  })
  .strict();
export type QaCheckResult = z.infer<typeof qaCheckResultSchema>;

export const contentQaReportDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    proposalId: idSchema,
    proposalVersion: z.number().int().min(1),
    proposalDigest: digestSchema,
    factual: z.array(qaCheckResultSchema).max(50),
    search: z.array(qaCheckResultSchema).max(50),
    editorial: z.array(qaCheckResultSchema).max(50),
    /** Overall verdict: FAIL if any FAIL; REVIEW if any REVIEW; else PASS. */
    overall: qaVerdictSchema,
  })
  .strict();
export type ContentQaReportData = z.infer<typeof contentQaReportDataSchema>;

// ---------------------------------------------------------------------------
// AcceptedPageContent (final human-approved, immutable, digested)
// ---------------------------------------------------------------------------

export const acceptedPageContentDataSchema = z
  .object({
    schemaVersion: z.literal(WRITER_CONTENT_SCHEMA_VERSION),
    proposalId: idSchema,
    proposalVersion: z.number().int().min(1),
    proposalDigest: digestSchema,
    qaReportDigest: digestSchema,
    slug: pageTargetSchema.shape.slug,
    title: boundedText(200),
    content: pageContentProposalDataSchema,
  })
  .strict();
export type AcceptedPageContentData = z.infer<typeof acceptedPageContentDataSchema>;

// ---------------------------------------------------------------------------
// Typed failure codes (domain-level; operator contract maps them to HTTP)
// ---------------------------------------------------------------------------

export const WRITER_ERROR_CODES = [
  "writer_input_not_accepted",
  "content_gap_lineage_missing",
  "writer_policy_not_approved",
  "writer_approval_failed",
  "writer_artifact_stale",
  "writer_artifact_not_found",
  "writer_content_invalid",
  "writer_budget_blocked",
  "writer_provider_not_configured",
  "writer_provider_unavailable",
  "writer_proposal_invalid",
  "content_accept_failed",
  "accepted_content_not_found",
  "writer_qa_conflict",
  "budget_invariant_violation",
] as const;
export type WriterErrorCode = (typeof WRITER_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Parsers (fail closed on drift, mirroring the other contract parsers)
// ---------------------------------------------------------------------------

export function parseWriterPolicyData(input: unknown): WriterPolicyData {
  return writerPolicyDataSchema.parse(input);
}

export function parsePageTarget(input: unknown): PageTarget {
  return pageTargetSchema.parse(input);
}

export function parseContentBriefData(input: unknown): ContentBriefData {
  return contentBriefDataSchema.parse(input);
}

export function parseWriterPromptSnapshotData(input: unknown): WriterPromptSnapshotData {
  return writerPromptSnapshotDataSchema.parse(input);
}

export function parsePageContentProposalData(input: unknown): PageContentProposalData {
  return pageContentProposalDataSchema.parse(input);
}

export function parseContentQaReportData(input: unknown): ContentQaReportData {
  return contentQaReportDataSchema.parse(input);
}

export function parseAcceptedPageContentData(input: unknown): AcceptedPageContentData {
  if (input !== null && typeof input === "object" && !("content" in input) && "sections" in input) {
    const proposal = pageContentProposalDataSchema.parse(input);
    return {
      schemaVersion: WRITER_CONTENT_SCHEMA_VERSION,
      proposalId: "wprp-implicit",
      proposalVersion: 1,
      proposalDigest: proposal.snapshotDigest,
      qaReportDigest: "0".repeat(64),
      slug: "",
      title: proposal.title,
      content: proposal,
    };
  }
  return acceptedPageContentDataSchema.parse(input);
}
