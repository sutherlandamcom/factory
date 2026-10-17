import { z } from "zod";
import { digestSchema, idSchema, qaVerdictSchema } from "./writer-content.js";

/**
 * YMYL / TRUST GOVERNANCE CONTRACTS — Macro Run 12
 * (High-Quality Multi-Page Proof).
 *
 * Additive, versioned, digest-bound governance records that make
 * financial/trust semantics INSPECTABLE and TESTABLE without inventing a
 * second content authority:
 *
 *   page intent (strategy)      -> PageIntentAuthority (planning-time, durable)
 *   YMYL classification         -> per-page enum, bound with the intent
 *   claim classification        -> ClaimRecord (FACT..OPINION, never mixed)
 *   claim <-> evidence lineage  -> ClaimLineageRecord (source refs, dates)
 *   source authority            -> sourceTierSchema (A..E hierarchy)
 *   source freshness            -> claim-type-specific (FreshnessPolicy)
 *   calculation provenance      -> CalculationRecord (reproducibility)
 *   review authority            -> ReviewAuthority (real review events)
 *   cannibalization control     -> deterministic pair check over intents
 *
 * HARD RULES (Run 12 master prompt):
 *  - No numeric E-E-A-T / SEO / cannibalization scores. Verdicts only.
 *  - Assumptions/forecasts/scenarios/estimates/opinions must never be
 *    presentable as observed FACT (claimType drives visible semantics).
 *  - Credentials/regulatory status/reputation are never invented: a
 *    credential requires an accepted evidence reference.
 *  - Review authority is bound to the exact content digest; material
 *    content change makes the review stale.
 */

export const TRUST_GOVERNANCE_SCHEMA_VERSION = "trust-governance-v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// YMYL classification (Block 5) — exactly one per page, from ACTUAL content
// ---------------------------------------------------------------------------

export const ymylClassificationSchema = z.enum([
  "NON_YMYL",
  "YMYL_INFORMATIONAL",
  "YMYL_DECISION_SUPPORT",
  "YMYL_HIGH_IMPACT",
]);
export type YmylClassification = z.infer<typeof ymylClassificationSchema>;

// ---------------------------------------------------------------------------
// Decision roles (Block 4) — bounded vocabulary for intent differentiation
// ---------------------------------------------------------------------------

export const decisionRoleSchema = z.enum([
  "NAVIGATIONAL_BRAND",
  "COMMERCIAL_SERVICE_EVALUATION",
  "GEOGRAPHIC_SERVICE_RELEVANCE",
  "FINANCIAL_DECISION_SUPPORT",
  "INFORMATIONAL_RESEARCH",
  "ENTITY_EXPERT_TRUST",
]);
export type DecisionRole = z.infer<typeof decisionRoleSchema>;

// ---------------------------------------------------------------------------
// Page intent authority (Blocks 3-4) — durable, inspectable page strategy
// ---------------------------------------------------------------------------

/**
 * One page's strategy authority. Persisted at planning time (before content
 * acceptance) so the anti-cannibalization check is a deterministic
 * comparison over stored authority, never over prose similarity alone.
 */
export const pageIntentAuthoritySchema = z
  .object({
    schemaVersion: z.literal(TRUST_GOVERNANCE_SCHEMA_VERSION),
    projectId: idSchema,
    pageIdentity: boundedText(200),
    /** Primary user intent (bounded free text from accepted search authority). */
    primaryIntent: boundedText(300),
    /** Secondary intents (bounded; may be empty). */
    secondaryIntents: z.array(boundedText(300)).max(5),
    /** Primary query cluster id/text from the accepted gap authority. */
    primaryQueryCluster: boundedText(300),
    /** Secondary query clusters (bounded). */
    secondaryQueryClusters: z.array(boundedText(300)).max(5),
    /** What content gap this page fills (from the accepted gap snapshot). */
    contentGapPurpose: boundedText(500),
    /** The page's role in the site. */
    siteRole: boundedText(300),
    /** Target audience for this page. */
    targetAudience: boundedText(300),
    /** The main user decision/task this page serves. */
    mainUserTask: boundedText(500),
    /** Primary conversion / next action. */
    primaryConversionAction: boundedText(300),
    /** YMYL classification derived from the actual content intent. */
    ymylClassification: ymylClassificationSchema,
    /** The decision role this page plays (cannibalization axis). */
    decisionRole: decisionRoleSchema,
    /** Internal links out (route targets, validated downstream). */
    internalLinksOut: z.array(boundedText(300)).max(10),
    /** Lineage: the accepted gap snapshot this strategy derives from. */
    gapSnapshotId: idSchema.optional(),
    gapSnapshotVersion: z.number().int().min(1).optional(),
    gapSnapshotDigest: digestSchema.optional(),
  })
  .strict();
export type PageIntentAuthority = z.infer<typeof pageIntentAuthoritySchema>;

export function parsePageIntentAuthority(input: unknown): PageIntentAuthority {
  return pageIntentAuthoritySchema.parse(input);
}

/**
 * Deterministic anti-cannibalization check (Block 4). A pair is a
 * cannibalization BLOCK when: materially equivalent primary query cluster
 * AND materially equivalent primary intent AND materially equivalent
 * decision role AND no explicit differentiation. Equivalence is exact-match
 * on the normalized stored authority fields (deliberately strict; near
 * matches surface as REVIEW for human judgment — never a numeric score).
 */
export interface CannibalizationPairFinding {
  pageA: string;
  pageB: string;
  overlap: Array<"primary_intent" | "primary_query_cluster" | "decision_role">;
  verdict: "REVIEW" | "FAIL";
  detail: string;
}

const normKey = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

export function checkCannibalization(
  intents: ReadonlyArray<PageIntentAuthority>,
): { findings: CannibalizationPairFinding[]; verdict: "PASS" | "REVIEW" | "FAIL" } {
  const findings: CannibalizationPairFinding[] = [];
  for (let i = 0; i < intents.length; i++) {
    for (let j = i + 1; j < intents.length; j++) {
      const a = intents[i]!;
      const b = intents[j]!;
      const overlap: CannibalizationPairFinding["overlap"] = [];
      if (normKey(a.primaryIntent) === normKey(b.primaryIntent)) overlap.push("primary_intent");
      if (normKey(a.primaryQueryCluster) === normKey(b.primaryQueryCluster)) overlap.push("primary_query_cluster");
      if (a.decisionRole === b.decisionRole) overlap.push("decision_role");
      if (overlap.length === 3) {
        findings.push({
          pageA: a.pageIdentity,
          pageB: b.pageIdentity,
          overlap,
          verdict: "FAIL",
          detail: `Pages ${a.pageIdentity} and ${b.pageIdentity} share identical primary intent, primary query cluster and decision role with no explicit differentiation.`,
        });
      } else if (overlap.length === 2) {
        findings.push({
          pageA: a.pageIdentity,
          pageB: b.pageIdentity,
          overlap,
          verdict: "REVIEW",
          detail: `Pages ${a.pageIdentity} and ${b.pageIdentity} overlap on ${overlap.join(" + ")}; human review must confirm differentiation.`,
        });
      }
    }
  }
  if (findings.some((f) => f.verdict === "FAIL")) return { findings, verdict: "FAIL" };
  if (findings.length > 0) return { findings, verdict: "REVIEW" };
  return { findings, verdict: "PASS" };
}

// ---------------------------------------------------------------------------
// Claim classification (Block 10)
// ---------------------------------------------------------------------------

export const claimTypeSchema = z.enum([
  "FACT",
  "FIRST_PARTY_FACT",
  "SOURCE_DERIVED_FACT",
  "CALCULATION",
  "ASSUMPTION",
  "ESTIMATE",
  "FORECAST",
  "SCENARIO",
  "EXPERT_INTERPRETATION",
  "OPINION",
]);
export type ClaimType = z.infer<typeof claimTypeSchema>;

/**
 * Claim types that must NEVER be presented to a user as observed fact
 * (Block 10 hard rule). Visible semantics (labels/tables/captions) are
 * derived from this set.
 */
export const UNCERTAIN_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set([
  "ASSUMPTION",
  "ESTIMATE",
  "FORECAST",
  "SCENARIO",
  "EXPERT_INTERPRETATION",
  "OPINION",
]);

// ---------------------------------------------------------------------------
// Source authority (Block 12) + freshness (Block 13)
// ---------------------------------------------------------------------------

export const sourceTierSchema = z.enum(["TIER_A", "TIER_B", "TIER_C", "TIER_D", "TIER_E"]);
export type SourceTier = z.infer<typeof sourceTierSchema>;

export const sourceRefSchema = z
  .object({
    /** Bounded source identifier (title/URL/registry reference). */
    ref: boundedText(500),
    tier: sourceTierSchema,
    /** The claim-specific observation/effective/reporting date (ISO date or datetime). */
    sourceDate: boundedText(40),
    /** Claim-specific freshness basis (NOT a blanket 12-month rule). */
    freshnessBasis: z.enum([
      "observation_date",
      "applicable_date",
      "effective_legal_period",
      "reporting_period",
      "effective_version",
      "model_as_of_date",
      "historical_date",
    ]),
    /**
     * Explicit citation entailment status (Block 11).
     * Omission does NOT default to SUPPORTED; verified claims require explicit
     * entailment: "SUPPORTED" and a non-empty supportingExcerpt.
     */
    entailment: z.enum(["SUPPORTED", "UNSUPPORTED"]).optional(),
    /** Optional authoritative URI / registry reference for provenance verification. */
    sourceUrl: boundedText(500).optional(),
    /** Verbatim or near-verbatim excerpt from the cited document/intake record that entails the claim. */
    supportingExcerpt: boundedText(2000).optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;

const RECOGNIZED_TIER_A_AUTHORITY_PATTERN =
  /\b(?:INSEE|DGFiP|DVF|Etalab|Notaires de France|Chambre des Notaires|Service-Public|Légifrance|Legifrance|Loi Hoguet|Loi Climat|Code de la construction|Code général des impôts|Géorisques|Georisques|BRGM|Cour des comptes|DGCCRF|Ville de Chamonix|Commune de Chamonix|Mairie de Chamonix|PLU|PPRN|Megève|Megeve|Haute-Savoie|impots\.gouv\.fr|insee\.fr|notaires\.fr|georisques\.gouv\.fr|ccomptes\.fr|legifrance\.gouv\.fr|service-public\.fr|chamonix\.fr)\b/i;

/**
 * Verifies that a single SourceRef is substantively verified rather than
 * self-certified or unverified.
 */
export function verifySourceRef(ref: SourceRef): { valid: boolean; reason: string | null } {
  if (ref.entailment === "UNSUPPORTED") {
    return { valid: false, reason: "Cited source does not substantively support the claim (entailment: UNSUPPORTED)." };
  }
  if (ref.entailment !== "SUPPORTED") {
    return {
      valid: false,
      reason: "Source ref is missing explicit entailment: \"SUPPORTED\" verification (omitted entailment fails closed).",
    };
  }
  if (!ref.supportingExcerpt || ref.supportingExcerpt.trim().length < 10) {
    return {
      valid: false,
      reason: "Source ref lacks a verifiable supportingExcerpt from the cited document or accepted intake authority.",
    };
  }
  if (ref.tier === "TIER_A") {
    const isFirstPartyIntake = /^intake:/i.test(ref.ref.trim()) || (ref.sourceUrl ? /^intake:/i.test(ref.sourceUrl.trim()) : false);
    const isRecognizedAuthority =
      RECOGNIZED_TIER_A_AUTHORITY_PATTERN.test(ref.ref) ||
      (ref.sourceUrl ? RECOGNIZED_TIER_A_AUTHORITY_PATTERN.test(ref.sourceUrl) : false);
    const hasVerifiedEndpoint =
      isFirstPartyIntake || (typeof ref.sourceUrl === "string" && /^https:\/\//i.test(ref.sourceUrl.trim()));
    if ((!isFirstPartyIntake && !isRecognizedAuthority) || !hasVerifiedEndpoint) {
      return {
        valid: false,
        reason:
          "Self-declared TIER_A source is not backed by a recognized primary statutory/statistical/institutional authority with sourceUrl or accepted first-party intake record.",
      };
    }
  }
  return { valid: true, reason: null };
}

/** Tier D/E must not be the sole support for high-impact financial claims; unverified sources fail closed. */
export function sourceAuthorityVerdict(
  refs: ReadonlyArray<SourceRef>,
  ymyl: YmylClassification,
): "PASS" | "REVIEW" | "FAIL" {
  if (refs.length === 0) return ymyl === "NON_YMYL" ? "PASS" : "FAIL";
  for (const ref of refs) {
    const verification = verifySourceRef(ref);
    if (!verification.valid) return "FAIL";
  }
  const strongest = refs.reduce(
    (best, ref) => Math.min(best, tierRank(ref.tier)),
    5,
  );
  if (ymyl === "YMYL_HIGH_IMPACT") {
    if (strongest <= 2) return "PASS";
    const hasFirstParty = refs.some((ref) => tierRank(ref.tier) <= 2);
    if (!hasFirstParty) return "FAIL";
    return "REVIEW";
  }
  if (ymyl === "YMYL_DECISION_SUPPORT" || ymyl === "YMYL_INFORMATIONAL") {
    return strongest <= 3 ? "PASS" : "REVIEW";
  }
  return "PASS";
}

function tierRank(tier: SourceTier): number {
  return { TIER_A: 1, TIER_B: 2, TIER_C: 3, TIER_D: 4, TIER_E: 5 }[tier];
}

// ---------------------------------------------------------------------------
// Claim lineage (Block 11) + calculation provenance (Block 14/20)
// ---------------------------------------------------------------------------

export const claimLineageSchema = z
  .object({
    claimId: idSchema,
    claimText: boundedText(2000),
    claimType: claimTypeSchema,
    /** Source refs that MUST substantively support the claim (entailment). */
    sourceRefs: z.array(sourceRefSchema).max(10),
    /** The accepted page content carrying this claim. */
    pageIdentity: boundedText(200),
    /** Calculation provenance when claimType === CALCULATION. */
    calculationRef: z
      .object({
        /** Formula/model identity + version. */
        modelId: boundedText(200),
        /** Ordered inputs with units. */
        inputs: z.array(z.object({ name: boundedText(100), value: boundedText(100), unit: boundedText(40) }).strict()).max(20),
        /** Assumption refs feeding the calculation. */
        assumptionRefs: z.array(idSchema).max(20),
        /** Output value + unit (never false precision). */
        output: z.object({ value: boundedText(100), unit: boundedText(40) }).strict(),
        /** Calculation date (as-of). */
        calculatedAt: boundedText(40),
      })
      .strict()
      .optional(),
    /** Limitation/status note (bounded). */
    limitation: z.string().trim().max(500).default(""),
  })
  .strict();
export type ClaimLineage = z.infer<typeof claimLineageSchema>;

export function parseClaimLineage(input: unknown): ClaimLineage {
  return claimLineageSchema.parse(input);
}

const OBSERVED_FACT_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set([
  "FACT",
  "FIRST_PARTY_FACT",
  "SOURCE_DERIVED_FACT",
]);

const FORECAST_AS_FACT_PATTERN = /\bwill\s+(?:appreciate|return|yield|earn|grow|gain)\b/i;

function extractNormalizedNumbers(text: string): string[] {
  const matches = text.match(/\b\d[\d,._]*\b/g) ?? [];
  return matches
    .map((m) => m.replace(/[,_]/g, ""))
    .filter((m) => /^\d+(?:\.\d+)?$/.test(m));
}

function extractSubstantiveTokens(text: string): string[] {
  return normKey(text)
    .split(" ")
    .filter((t) => t.length >= 4);
}

/**
 * Detailed deterministic problem list for a ClaimLineage record (Block 11).
 */
export function claimLineageProblems(lineage: ClaimLineage): string[] {
  const problems: string[] = [];
  if (lineage.claimType === "CALCULATION" && !lineage.calculationRef) {
    problems.push("CALCULATION claim lacks calculation provenance.");
  }
  if (lineage.calculationRef && lineage.calculationRef.inputs.length === 0) {
    problems.push("Calculation provenance has no inputs.");
  }
  if (UNCERTAIN_CLAIM_TYPES.has(lineage.claimType) && lineage.limitation.trim() === "") {
    problems.push(`Uncertain claim type ${lineage.claimType} requires an explicit limitation/status.`);
  }
  if (
    lineage.claimType !== "EXPERT_INTERPRETATION" &&
    lineage.claimType !== "OPINION" &&
    lineage.claimType !== "ASSUMPTION" &&
    lineage.sourceRefs.length === 0
  ) {
    problems.push("Material claim has no supporting source ref.");
  }
  for (const ref of lineage.sourceRefs) {
    const check = verifySourceRef(ref);
    if (!check.valid && check.reason) {
      problems.push(check.reason);
    }
  }
  if (lineage.sourceRefs.length > 0) {
    const combinedEvidence = [
      ...lineage.sourceRefs.map((r) => `${r.ref} ${r.supportingExcerpt ?? ""}`),
      lineage.calculationRef
        ? `${lineage.calculationRef.modelId} ${lineage.calculationRef.output.value} ${lineage.calculationRef.inputs.map((i) => `${i.name} ${i.value}`).join(" ")}`
        : "",
    ].join(" ");
    const evidenceNumbers = new Set(extractNormalizedNumbers(combinedEvidence));
    const claimNumbers = extractNormalizedNumbers(lineage.claimText);
    for (const num of claimNumbers) {
      if (!evidenceNumbers.has(num)) {
        problems.push(
          `Numeric figure "${num}" in claimText is not substantiated by any sourceRef supportingExcerpt or calculationRef.`,
        );
      }
    }
    const evidenceTokens = new Set(extractSubstantiveTokens(combinedEvidence));
    const claimTokens = extractSubstantiveTokens(lineage.claimText);
    const hasLexicalOverlap =
      claimTokens.length === 0 || claimTokens.some((tok) => evidenceTokens.has(tok));
    if (!hasLexicalOverlap) {
      problems.push("Claim text has no lexical overlap with cited supportingExcerpt evidence.");
    }
  }
  if (OBSERVED_FACT_CLAIM_TYPES.has(lineage.claimType)) {
    if (lineage.sourceRefs.some((ref) => ref.freshnessBasis === "model_as_of_date")) {
      problems.push(
        "Observed fact claim cannot rely on a model_as_of_date source (must be labelled FORECAST, SCENARIO, ESTIMATE, or CALCULATION).",
      );
    }
    if (FORECAST_AS_FACT_PATTERN.test(lineage.claimText)) {
      problems.push("Future financial outcome statement cannot be classified as an observed FACT.");
    }
  }
  return problems;
}

/**
 * Citation entailment gate (Block 11): a citation passes ONLY when the
 * source actually supports the claim with explicit SUPPORTED entailment,
 * verified source tier provenance, and excerpt/numeric alignment.
 */
export function claimLineageVerdict(lineage: ClaimLineage): "PASS" | "REVIEW" | "FAIL" {
  const problems = claimLineageProblems(lineage);
  if (problems.length > 0) return "FAIL";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Review authority (Block 9) — real review events, digest-bound
// ---------------------------------------------------------------------------

export const reviewAuthoritySchema = z
  .object({
    schemaVersion: z.literal(TRUST_GOVERNANCE_SCHEMA_VERSION),
    projectId: idSchema,
    pageIdentity: boundedText(200),
    /** Reviewer identity reference (accepted Person/Organization authority id). */
    reviewerRef: idSchema,
    /** Reviewer relevant-expertise statement (accepted evidence only). */
    reviewerExpertise: boundedText(500),
    /** Exact content digest this review binds (staleness anchor). */
    reviewedContentDigest: digestSchema,
    /** Review date (ISO). */
    reviewedAt: boundedText(40),
    /** Review result. */
    result: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
    /** Bounded review note. */
    note: z.string().trim().max(1000).default(""),
    /** Optional explicit list of claim IDs verified during this review. */
    verifiedClaimIds: z.array(idSchema).max(100).optional(),
  })
  .strict();
export type ReviewAuthority = z.infer<typeof reviewAuthoritySchema>;

export function parseReviewAuthority(input: unknown): ReviewAuthority {
  return reviewAuthoritySchema.parse(input);
}

/** A review is stale when the reviewed content digest no longer matches. */
export function reviewStaleness(
  review: ReviewAuthority,
  currentContentDigest: string,
): { stale: boolean; reason: string | null } {
  if (review.reviewedContentDigest !== currentContentDigest) {
    return { stale: true, reason: "Reviewed content changed materially after review; the review is stale." };
  }
  return { stale: false, reason: null };
}

// ---------------------------------------------------------------------------
// Creator/credential authority (Blocks 6-8) — evidence-gated
// ---------------------------------------------------------------------------

export const credentialEvidenceSchema = z
  .object({
    /** Credential name as it may be VISIBLY published. */
    name: boundedText(200),
    /** Accepted evidence reference that VERIFIES this credential. */
    evidenceRef: boundedText(500),
    evidenceKind: z.enum(["registry", "institution", "document", "profile", "first_party_record"]),
  })
  .strict();
export type CredentialEvidence = z.infer<typeof credentialEvidenceSchema>;

/**
 * Visible-credential rule: a credential may be published ONLY with accepted
 * verifiable evidence. No evidence -> the credential must not be published.
 */
export function credentialPublishable(credential: CredentialEvidence): boolean {
  return credential.evidenceRef.trim().length > 0;
}

/**
 * Topic <-> expertise alignment (Block 7): verifies that the responsible
 * creator/reviewer expertise covers the required competence domains for a
 * substantive YMYL page.
 */
export function checkTopicExpertiseMatch(
  requiredDomains: ReadonlyArray<string>,
  expertiseStatement: string,
): { verdict: "PASS" | "FAIL"; missingDomains: string[] } {
  const normalizedExpertise = normKey(expertiseStatement);
  if (!normalizedExpertise) {
    return { verdict: "FAIL", missingDomains: [...requiredDomains] };
  }
  const missingDomains = requiredDomains.filter(
    (domain) => !normalizedExpertise.includes(normKey(domain)),
  );
  return {
    verdict: missingDomains.length === 0 ? "PASS" : "FAIL",
    missingDomains,
  };
}

/**
 * Conflict-of-interest / commercial relationship disclosure gate (Block 8):
 * when a material commercial relationship or conflict exists, an explicit
 * visible disclosure is mandatory.
 */
export function checkConflictDisclosure(input: {
  hasMaterialConflict: boolean;
  disclosureText?: string | null;
}): "PASS" | "FAIL" {
  if (!input.hasMaterialConflict) return "PASS";
  if (!input.disclosureText || input.disclosureText.trim().length === 0) {
    return "FAIL";
  }
  return "PASS";
}

// ---------------------------------------------------------------------------
// Original value gate (Block 19) — inspectable per substantive page
// ---------------------------------------------------------------------------

export const originalValueRecordSchema = z
  .object({
    schemaVersion: z.literal(TRUST_GOVERNANCE_SCHEMA_VERSION),
    pageIdentity: boundedText(200),
    kind: z.enum([
      "original_calculation",
      "original_framework",
      "original_comparison",
      "original_table_chart",
      "original_decision_model",
      "first_party_observation",
      "original_methodology_application",
      "expert_interpretation",
      "transparent_synthesis",
    ]),
    /** What the user gains that repetition cannot provide (bounded). */
    description: boundedText(1000),
    /** Lineage binding: the claim/calculation id realizing this value. */
    lineageClaimId: idSchema.optional(),
    /** Verifiable textual/quantitative anchors that MUST appear in rendered page HTML for YMYL pages. */
    verifiableAnchors: z.array(boundedText(300)).min(2).max(20).optional(),
  })
  .strict();
export type OriginalValueRecord = z.infer<typeof originalValueRecordSchema>;

export function parseOriginalValueRecord(input: unknown): OriginalValueRecord {
  return originalValueRecordSchema.parse(input);
}

// ---------------------------------------------------------------------------
// QA verdict reuse: the trust gates return the shared triad
// ---------------------------------------------------------------------------

export type TrustGateVerdict = z.infer<typeof qaVerdictSchema>;
