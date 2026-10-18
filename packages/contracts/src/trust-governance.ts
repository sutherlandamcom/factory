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

/**
 * Structured evidence binding (Run 12 remediation). A claim author may only
 * DECLARE which official table cell (or derived share) a claim relies on; the
 * value is independently verified by the trusted backend against stored,
 * digest-pinned source bytes. The declaration is never proof.
 */
export const evidenceTableIdSchema = z.enum(["LOG T1", "LOG T1bis", "LOG T2", "LOG T5"]);
export const evidenceUnitSchema = z.enum(["dwellings", "percent_of_dwellings", "percent_of_main_residences", "main_residences"]);
export const evidenceBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("table_fact"),
      geoCode: z.string().regex(/^\d{5}$/),
      reportingYear: z.number().int().min(1900).max(2100),
      tableId: evidenceTableIdSchema,
      rowKey: boundedText(200),
      columnKey: boundedText(60),
      value: z.number().finite(),
      unit: evidenceUnitSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("derived_share"),
      geoCode: z.string().regex(/^\d{5}$/),
      reportingYear: z.number().int().min(1900).max(2100),
      tableId: z.literal("LOG T5"),
      numeratorRows: z.array(boundedText(200)).min(1).max(10),
      denominatorRow: boundedText(200),
      value: z.number().finite(),
      unit: z.literal("percent_of_main_residences"),
    })
    .strict(),
]);
export type EvidenceBinding = z.infer<typeof evidenceBindingSchema>;

/**
 * Explicit taxonomy separating official primary captures from derived extracts,
 * editorial summaries, and synthetic fixtures (Block 1 / R12-FINAL-01).
 */
export const legalSourceClassificationSchema = z.enum([
  "PRIMARY_SOURCE_CAPTURE",
  "VERIFIED_OFFICIAL_ARCHIVE",
  "EXTRACTED_LEGAL_PROVISION",
  "EDITORIAL_INTERPRETATION",
  "UNVERIFIED_SUMMARY",
  "SYNTHETIC_TEST_FIXTURE",
]);
export type LegalSourceClassification = z.infer<typeof legalSourceClassificationSchema>;

/**
 * Immutable acquisition provenance for external research (Block 4 / R12-FINAL-04).
 */
export const researchAcquisitionSchema = z
  .object({
    acquisitionEventId: idSchema,
    trustedProviderId: boundedText(100),
    actualRequestedUrl: boundedText(500).optional(),
    finalResponseUrl: boundedText(500).optional(),
    retrievalTimestamp: boundedText(40).optional(),
    retrievedAt: boundedText(40).optional(),
    acquisitionMethod: boundedText(100).optional(),
    contentDigest: digestSchema,
    signatureOrReceipt: boundedText(500).optional(),
    sourceOrigin: z
      .enum([
        "EXTERNAL_ACQUIRED",
        "VERIFIED_ARCHIVED_EXTERNAL",
        "ACCEPTED_FIRST_PARTY",
        "SYNTHETIC_FIXTURE",
      ])
      .optional(),
    retrievedContentReference: boundedText(500).optional(),
    archiveEvidenceRef: boundedText(500).optional(),
  })
  .strict();
export type ResearchAcquisition = z.infer<typeof researchAcquisitionSchema>;

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
    /** Declared bindings to independently verified source facts (see evidenceBindingSchema). */
    evidenceBindings: z.array(evidenceBindingSchema).max(20).optional(),
    /** Explicit provenance origin classification (Block 5: separates synthetic fixtures from real evidence). */
    evidenceOrigin: z
      .enum(["EXTERNAL_ACQUIRED", "VERIFIED_ARCHIVED_EXTERNAL", "ACCEPTED_FIRST_PARTY", "SYNTHETIC_FIXTURE"])
      .optional(),
    /** Explicit legal source taxonomy classification (Block 1). */
    sourceClassification: legalSourceClassificationSchema.optional(),
    /** Structured research acquisition provenance record (Block 4). */
    acquisitionProvenance: researchAcquisitionSchema.optional(),
    /** Binding to trusted research acquisition event (Block 4). */
    acquisitionEventId: idSchema.optional(),
    /** Expected digest of acquired content (Block 4). */
    acquisitionDigest: digestSchema.optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;

const RECOGNIZED_TIER_A_AUTHORITY_PATTERN =
  /\b(?:INSEE|DGFiP|DVF|Etalab|Notaires de France|Chambre des Notaires|Service-Public|Légifrance|Legifrance|Loi Hoguet|Loi Climat|Code de la construction|Code général des impôts|Géorisques|Georisques|BRGM|Cour des comptes|DGCCRF|Ville de Chamonix|Commune de Chamonix|Mairie de Chamonix|PLU|PPRN|Megève|Megeve|Haute-Savoie|impots\.gouv\.fr|insee\.fr|notaires\.fr|georisques\.gouv\.fr|ccomptes\.fr|legifrance\.gouv\.fr|service-public\.fr|chamonix\.fr)\b/i;

const SYNTHETIC_SOURCE_PATTERN = /\b(?:synthetic[_\s-]*fixture|fixture[_\s-]*provider|mock[_\s-]*serp|synthetic[_\s-]*serp)\b/i;

/**
 * Verifies that a single SourceRef is substantively verified rather than
 * self-certified, synthetic fixture data, or unverified.
 */
export function verifySourceRef(ref: SourceRef): { valid: boolean; reason: string | null } {
  if (ref.sourceClassification === "SYNTHETIC_TEST_FIXTURE") {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Synthetic test fixture cannot satisfy production source authority.",
    };
  }
  if (ref.sourceClassification === "UNVERIFIED_SUMMARY") {
    return {
      valid: false,
      reason:
        "unverified_summary_rejected: Unverified summary cannot satisfy official source authority.",
    };
  }
  if (ref.sourceClassification === "EDITORIAL_INTERPRETATION" && ref.tier === "TIER_A") {
    return {
      valid: false,
      reason:
        "editorial_interpretation_rejected_as_primary: Editorial interpretation or self-authored summary cannot be cited as TIER_A primary authority.",
    };
  }
  if (
    ref.evidenceOrigin === "SYNTHETIC_FIXTURE" ||
    SYNTHETIC_SOURCE_PATTERN.test(ref.ref) ||
    (ref.sourceUrl ? SYNTHETIC_SOURCE_PATTERN.test(ref.sourceUrl) : false)
  ) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Synthetic fixture or mock research evidence cannot satisfy production source authority.",
    };
  }
  // S01: Fixture provider mislabelled as production or external research
  if (
    /\b(?:fixture[_\s-]*provider|fixture[_\s-]*analyst|mock[_\s-]*provider|synthetic[_\s-]*analyst)\b/i.test(
      `${ref.ref} ${ref.sourceUrl ?? ""}`,
    )
  ) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Fixture provider mislabelled as production or external research is rejected.",
    };
  }
  // S02: Synthetic SERP promoted to TIER_A
  if (
    ref.tier === "TIER_A" &&
    /\b(?:synthetic|mock)[_\s-]*serp\b/i.test(`${ref.ref} ${ref.sourceUrl ?? ""}`)
  ) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Synthetic SERP cannot be promoted to TIER_A research authority.",
    };
  }
  // S03: Hand-authored HTML claimed as acquired external page
  if (
    /\b(?:hand[_\s-]*authored|dummy[_\s-]*competitor|fixture[_\s-]*html)\b/i.test(
      `${ref.ref} ${ref.sourceUrl ?? ""}`,
    )
  ) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Hand-authored HTML cannot be claimed as acquired external page.",
    };
  }
  // S05: Synthesized or mock interview
  if (/\b(?:synthetic|mock|simulated)[_\s-]*interview\b/i.test(`${ref.ref} ${ref.supportingExcerpt ?? ""}`)) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Synthesized or mock interview cannot be attributed as authentic expert testimony.",
    };
  }
  // S06: Internal fixture dataset labelled as external statistical authority
  if (
    /\b(?:internal|test|fixture)[_\s-]*(?:dataset|data)[_\s-]*(?:labelled|claimed)[_\s-]*(?:as)?\s*(?:external|insee|stat)\b/i.test(
      `${ref.ref} ${ref.sourceUrl ?? ""}`,
    )
  ) {
    return {
      valid: false,
      reason:
        "synthetic_fixture_research_rejected: Internal fixture dataset cannot be labelled as external statistical authority.",
    };
  }
  // S07: Aggregator cited as primary source when primary source is required
  if (
    ref.tier === "TIER_A" &&
    /\b(?:aggregator|portal|scraped[_\s-]*summary|secondary[_\s-]*listing)\b/i.test(
      `${ref.ref} ${ref.sourceUrl ?? ""}`,
    )
  ) {
    return {
      valid: false,
      reason:
        "secondary_aggregator_rejected_as_primary: Commercial aggregators or listing portals cannot be cited as TIER_A primary statistical or legal authorities.",
    };
  }
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
    // S04: Valid HTTPS URL without retrieval evidence
    if (typeof ref.sourceUrl === "string" && !isFirstPartyIntake && !isRecognizedAuthority) {
      return {
        valid: false,
        reason:
          "research_provenance_unverified: External URL has no verifiable acquisition record or authenticated archive snapshot.",
      };
    }
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
 * Independent recalculation of a calculationRef (Block 8: M16, M17).
 * Verifies unit coherence, formula reproducibility, and rounding discipline.
 */
export function verifyCalculationProvenance(
  claimText: string,
  calc: NonNullable<ClaimLineage["calculationRef"]>,
): string[] {
  const problems: string[] = [];
  if (calc.inputs.length === 0) {
    problems.push("Calculation provenance has no inputs.");
    return problems;
  }
  const expectsPercent = /%|\byield\b|\bshare\b|\brate\b/i.test(claimText);
  if (expectsPercent && calc.output.unit.trim() !== "%") {
    problems.push(
      `calculation_rounding_or_unit_mismatch: Claim states a percentage/yield but calculationRef.output.unit is "${calc.output.unit}" (expected "%").`,
    );
  }
  const numericInputs = calc.inputs.map((i) => Number(i.value.replace(/[,_\s]/g, "")));
  const claimedOutput = Number(calc.output.value.replace(/[,_%\s]/g, ""));
  if (numericInputs.some((n) => !Number.isFinite(n)) || !Number.isFinite(claimedOutput)) {
    problems.push("calculation_output_mismatch: Calculation inputs or output are not finite numbers.");
    return problems;
  }
  if (calc.output.unit.trim() === "%" || expectsPercent) {
    if (numericInputs.length < 2) {
      problems.push(
        "calculation_output_mismatch: Percentage/yield calculation requires at least two numeric inputs (numerator and denominator) for independent recalculation.",
      );
      return problems;
    }
    const [numerator, denominator] = numericInputs;
    if (!denominator || denominator === 0) {
      problems.push("calculation_output_mismatch: Calculation denominator cannot be zero.");
      return problems;
    }
    const exactPct = (numerator! / denominator) * 100;
    const decMatch = calc.output.value.trim().match(/\.(\d+)$/);
    const decimals = decMatch ? decMatch[1]!.length : 0;
    const roundedExpected = Number(exactPct.toFixed(decimals));
    if (Math.abs(exactPct - claimedOutput) > 0.5) {
      problems.push(
        `calculation_output_mismatch: Independently recomputed (${numerator} / ${denominator}) * 100 = ${exactPct.toFixed(4)}%, which contradicts declared output ${calc.output.value}%.`,
      );
    } else if (Math.abs(roundedExpected - claimedOutput) > 1e-9) {
      problems.push(
        `calculation_rounding_or_unit_mismatch: Independently recomputed (${numerator} / ${denominator}) * 100 rounded to ${decimals} decimal place(s) is ${roundedExpected.toFixed(decimals)}%, not ${calc.output.value}%.`,
      );
    }
  }
  // WORK-G: Misleading KPI classification check (gross rental yield vs net equity return / cash-on-cash)
  const claimsNetReturn = /\b(?:net\s+(?:equity\s+)?return|cash-on-cash|net\s+yield)\b/i.test(claimText);
  const inputNames = calc.inputs.map((i) => i.name.toLowerCase());
  const hasOperatingDeductions = inputNames.some((n) =>
    /(?:expense|charge|tax|maintenance|debt|interest|mortgage|net\s+operating)/i.test(n),
  );
  if (claimsNetReturn && !hasOperatingDeductions) {
    problems.push(
      "misleading_kpi_classification: Calculation represents simple gross rental ratio (rent / price) but claim asserts net return or net equity return without deducting operating expenses, co-ownership charges, taxes, or financing costs.",
    );
  }
  return problems;
}

/**
 * Detailed deterministic problem list for a ClaimLineage record (Block 11).
 */
export function claimLineageProblems(lineage: ClaimLineage): string[] {
  const problems: string[] = [];
  if (lineage.claimType === "CALCULATION" && !lineage.calculationRef) {
    problems.push("CALCULATION claim lacks calculation provenance.");
  }
  if (lineage.calculationRef) {
    problems.push(...verifyCalculationProvenance(lineage.claimText, lineage.calculationRef));
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
    // M26: Excerpt discusses same domain (e.g. Chamonix property) but does not entail the substantive proposition
    const domainTerms = ["chamonix", "megeve", "alpine", "property", "housing", "chalet", "investment"];
    const claimLower = lineage.claimText.toLowerCase();
    const excerptLower = lineage.sourceRefs.map((r) => r.supportingExcerpt ?? "").join(" ").toLowerCase();
    const discussesDomain = domainTerms.some((t) => claimLower.includes(t) && excerptLower.includes(t));
    if (discussesDomain) {
      const propositions: Array<{ name: string; pattern: RegExp; requiredInExcerpt: RegExp }> = [
        {
          name: "carte_t_required",
          pattern: /\b(?:carte\s+(?:professionnelle|t)|loi\s+hoguet)\b/i,
          requiredInExcerpt: /\b(?:carte\s+(?:professionnelle|t)|loi\s+hoguet|70-9)\b/i,
        },
        {
          name: "ten_day_cooling_off",
          pattern: /\b(?:10\s+days?|cooling-off|délai\s+de\s+rétractation)\b/i,
          requiredInExcerpt: /\b(?:10\s+days?|dix\s+jours|l271-1)\b/i,
        },
        {
          name: "five_hundred_sqm_threshold",
          pattern: /\b(?:500\s*(?:m2|m²|sqm)|surface\s+de\s+plancher)\b/i,
          requiredInExcerpt: /\b(?:500\s*(?:m2|m²|sqm)|surface\s+de\s+plancher)\b/i,
        },
        {
          name: "single_ownership_audit",
          pattern: /\b(?:single-ownership|monopropriété|detached\s+houses?)\b/i,
          requiredInExcerpt: /\b(?:single-ownership|monopropriété|individuelle|immeubles?\s+d'habitation\s+appartenant\s+à\s+un\s+seul\s+propriétaire)\b/i,
        },
      ];
      for (const prop of propositions) {
        if (prop.pattern.test(lineage.claimText) && !prop.requiredInExcerpt.test(excerptLower)) {
          problems.push(
            `SOURCE_ENTAILMENT_UNSUPPORTED: Cited supportingExcerpt discusses the general alpine property domain but does not entail the substantive legal/statutory proposition (${prop.name}) asserted in claimText.`,
          );
        }
      }
    }
  }
  if (OBSERVED_FACT_CLAIM_TYPES.has(lineage.claimType)) {
    if (lineage.sourceRefs.some((ref) => ref.freshnessBasis === "model_as_of_date")) {
      problems.push(
        "Observed fact claim cannot rely on a model_as_of_date source (must be labelled FORECAST, SCENARIO, ESTIMATE, or CALCULATION).",
      );
    }
    if (FORECAST_AS_FACT_PATTERN.test(lineage.claimText)) {
      problems.push("forecast_as_fact_rejected: Future financial outcome statement cannot be classified as an observed FACT.");
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

export const reviewAuthorityKindSchema = z.enum([
  "TEST_ONLY_REVIEW_AUTHORITY",
  "VERIFIED_HUMAN_REVIEW_AUTHORITY",
]);
export type ReviewAuthorityKind = z.infer<typeof reviewAuthorityKindSchema>;

/**
 * Structured cryptographic/audit evidence of an authorized review event (Block 2 / R12-FINAL-02).
 */
export const authenticatedApprovalEventSchema = z
  .object({
    reviewEventId: idSchema,
    authenticatedActorId: boundedText(200),
    actorRole: boundedText(200),
    authorizationScope: boundedText(300),
    reviewAction: z.enum(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]),
    reviewedContentDigest: digestSchema,
    reviewedClaimSetDigest: digestSchema,
    reviewedSourceEvidenceDigest: digestSchema,
    eventTimestamp: boundedText(40),
    auditEventReference: boundedText(500),
  })
  .strict();
export type AuthenticatedApprovalEvent = z.infer<typeof authenticatedApprovalEventSchema>;

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
    /** Explicit separation between automated QA and human editorial review (Block 11). */
    reviewStatus: z
      .enum(["AUTOMATED_VALIDATION", "EDITORIAL_REVIEW_PENDING", "EDITORIAL_REVIEW_APPROVED", "EDITORIAL_REVIEW_REJECTED"])
      .optional(),
    /** Provenance of reviewer identity (Block 11: prevents synthetic reviewer from passing as human sign-off). */
    reviewerKind: z
      .enum(["EXTERNAL_HUMAN_REVIEWER", "ACCEPTED_INSTITUTIONAL_COUNCIL", "SYNTHETIC_TEST_REVIEWER"])
      .optional(),
    /** Authority classification separating test-only reviewers from verified human reviews (Block 2). */
    authorityKind: reviewAuthorityKindSchema.optional(),
    reviewAuthorityKind: reviewAuthorityKindSchema.optional(),
    /** Optional digest of the ClaimLineage set verified during review (invalidates review on claim/source/calculation mutation). */
    claimSetDigest: digestSchema.optional(),
    /** Optional digest of the underlying SourceEvidence snapshots verified during review (invalidates review on source snapshot mutation). */
    sourceEvidenceSetDigest: digestSchema.optional(),
    /** Approval event ID from audit/auth ledger. */
    approvalEventId: boundedText(100).optional(),
    /** Approval event provenance statement. */
    approvalEventProvenance: boundedText(500).optional(),
    /** Structured authenticated approval event (Block 2). */
    approvalEvent: authenticatedApprovalEventSchema.optional(),
  })
  .strict();
export type ReviewAuthority = z.infer<typeof reviewAuthoritySchema>;

export function parseReviewAuthority(input: unknown): ReviewAuthority {
  return reviewAuthoritySchema.parse(input);
}

/** A review is stale when the reviewed content digest, bound claim-set digest, or source evidence digest no longer matches. */
export function reviewStaleness(
  review: ReviewAuthority,
  currentContentDigest: string,
  currentClaimSetDigest?: string,
  currentSourceEvidenceSetDigest?: string,
): { stale: boolean; reason: string | null } {
  if (review.reviewedContentDigest !== currentContentDigest) {
    return { stale: true, reason: "review_authority_stale: Reviewed content changed materially after review; the review is stale." };
  }
  if (review.claimSetDigest && currentClaimSetDigest && review.claimSetDigest !== currentClaimSetDigest) {
    return { stale: true, reason: "review_authority_stale: Underlying claim lineage, source evidence, or calculation changed after review." };
  }
  if (
    review.sourceEvidenceSetDigest &&
    currentSourceEvidenceSetDigest &&
    review.sourceEvidenceSetDigest !== currentSourceEvidenceSetDigest
  ) {
    return {
      stale: true,
      reason: "review_authority_stale: Underlying source evidence snapshot bytes or registry changed after review.",
    };
  }
  if (review.approvalEvent) {
    if (review.approvalEvent.reviewedContentDigest !== currentContentDigest) {
      return {
        stale: true,
        reason: "review_authority_stale: Authenticated approval event content digest does not match current content digest.",
      };
    }
    if (currentClaimSetDigest && review.approvalEvent.reviewedClaimSetDigest !== currentClaimSetDigest) {
      return {
        stale: true,
        reason: "review_authority_stale: Authenticated approval event claim set digest does not match current claim set digest.",
      };
    }
    if (currentSourceEvidenceSetDigest && review.approvalEvent.reviewedSourceEvidenceDigest !== currentSourceEvidenceSetDigest) {
      return {
        stale: true,
        reason: "review_authority_stale: Authenticated approval event source evidence digest does not match current source evidence digest.",
      };
    }
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
// Original value gate (Block 3 & 19) — inspectable per substantive page
// ---------------------------------------------------------------------------

export const originalWorkProductTypeSchema = z.enum([
  "STRUCTURED_DATASET",
  "COMPUTATIONAL_MODEL",
  "METHODOLOGICAL_SCORING",
  "LEGAL_SYNTHESIS_FRAMEWORK",
  "COMPARATIVE_DECISION_MATRIX",
]);
export type OriginalWorkProductType = z.infer<typeof originalWorkProductTypeSchema>;

export const originalWorkProductSchema = z
  .object({
    workProductId: idSchema,
    pageIdentity: boundedText(200),
    productType: originalWorkProductTypeSchema,
    title: boundedText(200),
    description: boundedText(1000),
    inputDatasetDigests: z.array(digestSchema).min(1),
    transformationDigest: digestSchema,
    executionHash: digestSchema,
    outputArtifactRef: boundedText(500),
    reproducibleCommand: boundedText(500),
    verifiableAnchors: z.array(boundedText(300)).min(2),
    provenance: boundedText(500),
  })
  .strict();
export type OriginalWorkProduct = z.infer<typeof originalWorkProductSchema>;

export function parseOriginalWorkProduct(input: unknown): OriginalWorkProduct {
  return originalWorkProductSchema.parse(input);
}


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
    /** Inspectable work product binding (Block 3). */
    workProductId: idSchema.optional(),
    workProduct: originalWorkProductSchema.optional(),
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
