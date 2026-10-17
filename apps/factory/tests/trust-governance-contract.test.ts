import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePageIntentAuthority,
  parseClaimLineage,
  parseReviewAuthority,
  parseOriginalValueRecord,
  checkCannibalization,
  sourceAuthorityVerdict,
  verifySourceRef,
  claimLineageVerdict,
  claimLineageProblems,
  reviewStaleness,
  credentialPublishable,
  UNCERTAIN_CLAIM_TYPES,
  type PageIntentAuthority,
  type ClaimLineage,
  type SourceRef,
} from "@factory/contracts";

/**
 * RUN 12 TRUST GOVERNANCE — deterministic contract tests (no DB needed).
 *
 * Proves the fail-closed semantics of the trust contracts:
 *   - page intent authority schema (YMYL, decision roles, lineage)
 *   - cannibalization pair detection (FAIL/REVIEW/PASS, no numeric score)
 *   - claim lineage verdicts (calculation provenance, uncertainty labelling,
 *     mandatory entailment, excerpt verification, numeric entailment)
 *   - source authority floors per YMYL level (verified Tier-A provenance)
 *   - review staleness (content digest binding)
 *   - credential evidence gate (no evidence -> not publishable)
 */

const BASE_INTENT: Omit<PageIntentAuthority, "pageIdentity" | "primaryIntent" | "primaryQueryCluster" | "decisionRole" | "ymylClassification"> = {
  schemaVersion: "trust-governance-v1",
  projectId: "proj-1",
  secondaryIntents: [],
  secondaryQueryClusters: [],
  contentGapPurpose: "gap",
  siteRole: "role",
  targetAudience: "audience",
  mainUserTask: "task",
  primaryConversionAction: "action",
  internalLinksOut: [],
};

function intent(overrides: Partial<PageIntentAuthority>): PageIntentAuthority {
  return parsePageIntentAuthority({ ...BASE_INTENT, pageIdentity: "p1", primaryIntent: "i", primaryQueryCluster: "c", decisionRole: "INFORMATIONAL_RESEARCH", ymylClassification: "NON_YMYL", ...overrides });
}

const VALID_TIER_A_SOURCE: SourceRef = {
  ref: "INSEE Dossier complet Commune de Chamonix-Mont-Blanc (74056)",
  sourceUrl: "https://www.insee.fr/fr/statistiques/2011101?geo=COM-74056",
  supportingExcerpt: "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings and 72.6% secondary residences.",
  tier: "TIER_A",
  sourceDate: "2026-01-01",
  freshnessBasis: "observation_date",
  entailment: "SUPPORTED",
};

const VALID_TIER_B_SOURCE: SourceRef = {
  ref: "Notaires de France Immobilier Alpine Schedule",
  sourceUrl: "https://www.immobilier.notaires.fr/en/property-market-statistics",
  supportingExcerpt: "Model forecast assumptions and acquisition fee schedule for alpine residential property.",
  tier: "TIER_B",
  sourceDate: "2026-01-01",
  freshnessBasis: "model_as_of_date",
  entailment: "SUPPORTED",
};

const BASE_CLAIM: Omit<ClaimLineage, "claimId" | "claimText" | "claimType" | "sourceRefs" | "pageIdentity"> = {
  limitation: "",
};

function claim(overrides: Partial<ClaimLineage>): ClaimLineage {
  return parseClaimLineage({
    ...BASE_CLAIM,
    claimId: "claim-1",
    claimText: "INSEE Chamonix-Mont-Blanc records 13,864 total dwellings.",
    claimType: "FACT",
    sourceRefs: [],
    pageIdentity: "p1",
    ...overrides,
  });
}

test("page intent authority parses with all mandatory strategy fields", () => {
  const parsed = intent({});
  assert.equal(parsed.ymylClassification, "NON_YMYL");
  assert.equal(parsed.decisionRole, "INFORMATIONAL_RESEARCH");
});

test("page intent authority rejects unknown YMYL classification and decision roles", () => {
  assert.throws(() => intent({ ymylClassification: "SOMETHING_ELSE" as never }));
  assert.throws(() => intent({ decisionRole: "RANDOM_ROLE" as never }));
});

test("cannibalization: identical intent+cluster+role FAILS closed", () => {
  const a = intent({ pageIdentity: "a", primaryIntent: "Buy advisory", primaryQueryCluster: "advisory", decisionRole: "COMMERCIAL_SERVICE_EVALUATION", ymylClassification: "YMYL_INFORMATIONAL" });
  const b = intent({ pageIdentity: "b", primaryIntent: "Buy advisory", primaryQueryCluster: "advisory", decisionRole: "COMMERCIAL_SERVICE_EVALUATION", ymylClassification: "YMYL_INFORMATIONAL" });
  const result = checkCannibalization([a, b]);
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.findings[0]!.verdict, "FAIL");
});

test("cannibalization: two-of-three overlap surfaces REVIEW (human judgment), never a score", () => {
  const a = intent({ pageIdentity: "a", primaryIntent: "Buy advisory", primaryQueryCluster: "advisory", decisionRole: "COMMERCIAL_SERVICE_EVALUATION" });
  const b = intent({ pageIdentity: "b", primaryIntent: "Buy advisory", primaryQueryCluster: "advisory", decisionRole: "FINANCIAL_DECISION_SUPPORT" });
  const result = checkCannibalization([a, b]);
  assert.equal(result.verdict, "REVIEW");
});

test("cannibalization: differentiated pages PASS (keyword overlap with different task is permitted)", () => {
  const a = intent({ pageIdentity: "service", primaryIntent: "Evaluate advisory engagement", primaryQueryCluster: "property advisory france", decisionRole: "COMMERCIAL_SERVICE_EVALUATION" });
  const b = intent({ pageIdentity: "research", primaryIntent: "Understand market methodology", primaryQueryCluster: "alpine market data", decisionRole: "INFORMATIONAL_RESEARCH" });
  assert.equal(checkCannibalization([a, b]).verdict, "PASS");
});

test("claim lineage: CALCULATION without provenance FAILS", () => {
  const c = claim({
    claimText: "Illustrative gross yield of 7.2% under stated assumptions.",
    claimType: "CALCULATION",
    sourceRefs: [VALID_TIER_A_SOURCE],
  });
  assert.equal(claimLineageVerdict(c), "FAIL");
});

test("claim lineage: CALCULATION with full provenance PASSES", () => {
  const c = claim({
    claimText: "Illustrative gross yield of 7.2% under stated assumptions.",
    claimType: "CALCULATION",
    sourceRefs: [
      {
        ...VALID_TIER_A_SOURCE,
        supportingExcerpt: "Illustrative gross yield of 7.2% computed from annual rent 26,400 EUR and purchase price 366,000 EUR.",
      },
    ],
    calculationRef: {
      modelId: "yield-model-v1",
      inputs: [{ name: "price", value: "366000", unit: "EUR" }],
      assumptionRefs: [],
      output: { value: "7.2", unit: "%" },
      calculatedAt: "2026-09-01",
    },
  });
  assert.equal(claimLineageVerdict(c), "PASS");
});

test("claim lineage: FORECAST without limitation FAILS; with limitation PASSES", () => {
  const noLimit = claim({
    claimText: "Model forecast assumptions for alpine residential property.",
    claimType: "FORECAST",
    sourceRefs: [VALID_TIER_B_SOURCE],
  });
  assert.equal(claimLineageVerdict(noLimit), "FAIL");
  const withLimit = claim({
    claimText: "Model forecast assumptions for alpine residential property.",
    claimType: "FORECAST",
    limitation: "Model forecast, not a guaranteed outcome.",
    sourceRefs: [VALID_TIER_B_SOURCE],
  });
  assert.equal(claimLineageVerdict(withLimit), "PASS");
});

test("claim lineage: material FACT without any source FAILS", () => {
  const c = claim({ claimType: "SOURCE_DERIVED_FACT" });
  assert.equal(claimLineageVerdict(c), "FAIL");
});

test("P1-3: omitted entailment, missing excerpt, self-certified TIER_A, or numeric mismatch FAILS closed", () => {
  // 1. Omitted entailment must NOT pass.
  const omittedEntailment = claim({
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: VALID_TIER_A_SOURCE.ref,
        sourceUrl: VALID_TIER_A_SOURCE.sourceUrl,
        supportingExcerpt: VALID_TIER_A_SOURCE.supportingExcerpt,
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "observation_date",
      },
    ],
  });
  assert.equal(claimLineageVerdict(omittedEntailment), "FAIL");
  assert.ok(claimLineageProblems(omittedEntailment).some((p) => /entailment/i.test(p)));

  // 2. Self-certified TIER_A without recognized authority/URL must FAIL.
  const selfCertifiedTierA: SourceRef = {
    ref: "My random blog post",
    sourceUrl: "https://random-blog.example.com/post",
    supportingExcerpt: "INSEE Chamonix-Mont-Blanc records 13,864 total dwellings.",
    tier: "TIER_A",
    sourceDate: "2026-01-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
  };
  assert.equal(verifySourceRef(selfCertifiedTierA).valid, false);
  assert.equal(sourceAuthorityVerdict([selfCertifiedTierA], "YMYL_DECISION_SUPPORT"), "FAIL");

  // 3. Numeric mismatch between claimText and supportingExcerpt must FAIL.
  const numericMismatch = claim({
    claimText: "INSEE Chamonix-Mont-Blanc records 99,999 total dwellings.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [VALID_TIER_A_SOURCE],
  });
  assert.equal(claimLineageVerdict(numericMismatch), "FAIL");
  assert.ok(claimLineageProblems(numericMismatch).some((p) => /99999/.test(p)));
});

test("P1-5: OriginalValueRecord requires at least two verifiableAnchors", () => {
  assert.throws(() =>
    parseOriginalValueRecord({
      schemaVersion: "trust-governance-v1",
      pageIdentity: "locations/chamonix",
      kind: "first_party_observation",
      description: "Declarative description without verifiable anchors.",
      verifiableAnchors: ["only-one"],
    }),
  );
  const valid = parseOriginalValueRecord({
    schemaVersion: "trust-governance-v1",
    pageIdentity: "locations/chamonix",
    kind: "first_party_observation",
    description: "Comparative commune analysis with verifiable anchors.",
    lineageClaimId: "claim-chamonix-insee",
    verifiableAnchors: ["13,864 total dwellings", "72.6% secondary residences"],
  });
  assert.equal(valid.verifiableAnchors?.length, 2);
});

test("uncertain claim types set matches Block 10 hard rule", () => {
  for (const t of ["ASSUMPTION", "ESTIMATE", "FORECAST", "SCENARIO", "EXPERT_INTERPRETATION", "OPINION"]) {
    assert.ok(UNCERTAIN_CLAIM_TYPES.has(t as never), `${t} must be uncertain`);
  }
  assert.ok(!UNCERTAIN_CLAIM_TYPES.has("FACT"));
  assert.ok(!UNCERTAIN_CLAIM_TYPES.has("CALCULATION"));
});

test("source authority: HIGH_IMPACT with only Tier D FAILS; verified Tier A/B PASSES", () => {
  const tierD: SourceRef[] = [
    {
      ref: "Industry commentary blog",
      sourceUrl: "https://example.com/blog",
      supportingExcerpt: "Commentary on alpine property market conditions and buyer considerations.",
      tier: "TIER_D",
      sourceDate: "2026-01-01",
      freshnessBasis: "observation_date",
      entailment: "SUPPORTED",
    },
  ];
  assert.equal(sourceAuthorityVerdict(tierD, "YMYL_HIGH_IMPACT"), "FAIL");
  assert.equal(sourceAuthorityVerdict([VALID_TIER_A_SOURCE], "YMYL_HIGH_IMPACT"), "PASS");
});

test("source authority: empty sources on YMYL page FAIL", () => {
  assert.equal(sourceAuthorityVerdict([], "YMYL_INFORMATIONAL"), "FAIL");
  assert.equal(sourceAuthorityVerdict([], "NON_YMYL"), "PASS");
});

test("review staleness: digest change makes review stale", () => {
  const review = parseReviewAuthority({
    schemaVersion: "trust-governance-v1",
    projectId: "proj-1",
    pageIdentity: "research/report",
    reviewerRef: "person-1",
    reviewerExpertise: "Property market analysis",
    reviewedContentDigest: "a".repeat(64),
    reviewedAt: "2026-09-20",
    result: "APPROVED",
    note: "",
  });
  assert.equal(reviewStaleness(review, "a".repeat(64)).stale, false);
  const stale = reviewStaleness(review, "b".repeat(64));
  assert.equal(stale.stale, true);
  assert.match(stale.reason!, /stale/);
});

test("credential gate: no evidence -> not publishable", () => {
  assert.equal(credentialPublishable({ name: "CFA", evidenceRef: "", evidenceKind: "registry" }), false);
  assert.equal(credentialPublishable({ name: "CFA", evidenceRef: "registry-entry-123", evidenceKind: "registry" }), true);
});

test("Run 12: root redirect stub is deterministic, noindex, and targets the governed homepage", async () => {
  const { generateRootRedirectStub } = await import("../src/production/seo-engine.js");
  const manifest = {
    input: {
      id: "ppin-x", version: 1, digest: "a".repeat(64), projectId: "proj-x",
      pageIdentity: "home", pageType: "homepage" as const, route: "/home",
      siteIdentity: { siteId: "s", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "4".repeat(64) },
    },
    seo: { fullTitle: "Independent Advisory", description: "Evidence-led advisory.", canonicalUrl: "https://sutherlandam.com/home", ogTitle: "", ogDescription: "", ogUrl: "" },
  } as never;
  const stub = generateRootRedirectStub({ manifests: [manifest] });
  assert.ok(stub, "stub emitted when no / route exists");
  assert.equal(stub.targetRoute, "/home");
  assert.match(stub.html, /noindex/);
  assert.match(stub.html, /url=\/home/);
  assert.match(stub.html, /rel="canonical" href="https:\/\/sutherlandam\.com\/home"/);
  // Deterministic: identical manifests -> identical stub.
  const stub2 = generateRootRedirectStub({ manifests: [manifest] });
  assert.equal(stub.html, stub2!.html);
  // No stub when a / route already exists.
  const withRoot = structuredClone(manifest) as { input: { route: string } };
  withRoot.input.route = "/";
  assert.equal(generateRootRedirectStub({ manifests: [withRoot as never] }), null);
});
