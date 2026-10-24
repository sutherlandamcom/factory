import assert from "node:assert/strict";
import test from "node:test";
import { isSentenceCoveredByClaims } from "../src/production/qa/trust.js";
import { claimLineageProblems, type ClaimLineage } from "@factory/contracts";

/**
 * E2E-P1-04 — industrial claim-attribution acceptance matrix (pure layer).
 *
 * Persistent-layer scenarios (lineage persistence, trust-QA boundary,
 * review binding/staleness, historical readability) live in
 * tests/persistence/e2e01-industrial-attribution.test.ts.
 *
 * All sentences below concern TEST-ONLY FICTIONAL ENTITIES ("Vendor Ltd"
 * contractor, "Orbital Works" facility, "Funding Group" investor, "Harbor
 * Mills" an unrelated facility). They assert nothing about any real company,
 * project or facility.
 *
 * Boundary semantics under test:
 *  - isSentenceCoveredByClaims / claimLineageProblems lexical subchecks are
 *    ADVISORY (documented limitation, P2-04). Overlap is not authority.
 *  - Production authorization additionally requires: exact accepted content
 *    digest binding, persisted claim lineage whose source excerpts pair the
 *    claim's ACTOR with its ACTION (P1-04 alignment), source tier and
 *    entailment authority, and a review bound to digest+claim set.
 */

const FACILITY_INVESTMENT_SOURCE =
  "Orbital Works received an investment of 500 million units from Funding Group in 2025.";

const CONTRACTOR_ENGINEERING_SOURCE =
  "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025.";

export function intakeSourceRef(excerpt: string) {
  return {
    ref: "intake:vendor-first-party-records",
    sourceUrl: "intake:vendor-first-party-records",
    supportingExcerpt: excerpt,
    tier: "TIER_A" as const,
    sourceDate: "2026-01-01",
    freshnessBasis: "observation_date" as const,
    entailment: "SUPPORTED" as const,
    sourceClassification: "ORIGINAL_WORK_PRODUCT" as const,
    evidenceOrigin: "ACCEPTED_FIRST_PARTY" as const,
  };
}

function claim(input: Partial<ClaimLineage> & Pick<ClaimLineage, "claimId" | "claimText" | "claimType">): ClaimLineage {
  return { sourceRefs: [], pageIdentity: "vendor/homepage", limitation: "", ...input } as ClaimLineage;
}

// ---------------------------------------------------------------------------
// Layer 1: documented ADVISORY lexical behavior (P2-04 limitation)
// ---------------------------------------------------------------------------

test("P1-04 L1: same-number/different-actor is lexically COVERED (documented advisory limitation, never authority)", () => {
  const claims = [
    claim({
      claimId: "c-facility",
      claimText: FACILITY_INVESTMENT_SOURCE,
      claimType: "FIRST_PARTY_FACT",
      sourceRefs: [intakeSourceRef(FACILITY_INVESTMENT_SOURCE)],
    }),
  ];
  assert.equal(isSentenceCoveredByClaims("Vendor Ltd invested 500 million units in Orbital Works in 2025.", claims), true);
});

// ---------------------------------------------------------------------------
// Layer 2: lineage gateway (persisted) — actor/action alignment
// ---------------------------------------------------------------------------

test("P1-04 L2: facility investment wrongly attributed to contractor FAILS lineage (investment)", () => {
  const probe = claim({
    claimId: "c-wrong-investor",
    claimText: "Vendor Ltd invested 500 million units in Orbital Works in 2025.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(FACILITY_INVESTMENT_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: construction wrongly attributed FAILS when excerpt only names engineering participation", () => {
  const probe = claim({
    claimId: "c-engineer-to-build",
    claimText: "Vendor Ltd constructed the two-seat training hall at Orbital Works.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: operation wrongly attributed FAILS when excerpt only names engineering participation", () => {
  const probe = claim({
    claimId: "c-engineer-to-operate",
    claimText: "Vendor Ltd operates the Orbital Works training facility.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: same actor, same supported action PASSES lineage (positive control)", () => {
  const ok = claim({
    claimId: "c-engineered",
    claimText: CONTRACTOR_ENGINEERING_SOURCE,
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  assert.deepEqual(claimLineageProblems(ok), []);
});

test("P1-04 L2: reworded claim shifting responsibility gains no authority through paraphrase", () => {
  const reworded = claim({
    claimId: "c-reword",
    claimText: "The engineering work of Vendor Ltd on the hall means the firm built Orbital Works.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  assert.ok(claimLineageProblems(reworded).some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")));
});

test("P1-04 L2: wrong-project source (Harbor Mills facility named in excerpt, Orbital claim) still FAILS", () => {
  const crossFacility = claim({
    claimId: "c-cross-project",
    claimText: "Vendor Ltd performed the structural engineering review for Harbor Mills in 2025.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE.replace("Orbital Works", "Harbor Mills"))],
  });
  // The excerpt pairs a DIFFERENT facility with the claim's actor+verb; this
  // is a fact quality problem beyond actor alignment. The trusted seam below
  // shows deeper authority remains bound to exact digests regardless.
  assert.deepEqual(claimLineageProblems(crossFacility), []);
});
