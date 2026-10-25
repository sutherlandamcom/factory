import assert from "node:assert/strict";
import test from "node:test";
import { claimLineageProblems, type ClaimLineage, type SourceRef } from "@factory/contracts";

/**
 * E2E-P1-A — SourceRef isolation (per-source evidence boundaries).
 *
 * Defect class: claimLineageProblems() joins ALL SourceRef supportingExcerpts
 * into one combined blob with ".join(\" \")" before numeric / lexical /
 * attribution checks. That lets a figure or an actor-verb pairing that lives
 * ONLY in ref B falsely substantiate a claim attributed to ref A (and lets a
 * fragment split across two refs fuse into a supported pairing).
 *
 * Acceptance rule after the fix: each SourceRef must INDEPENDENTLY support
 * the claim's figures/actor-verb pairings for that ref to count as evidence
 * for them. A number appearing only in one excerpt does not authorize a claim
 * citing a different excerpt, and a pairing assembled from fragments of two
 * separate sources is not a genuine supported pairing.
 *
 * All entities are TEST-ONLY FICTIONAL (Vendor Ltd, Orbital Works, Funding
 * Group, ООО «ИнжПроект», завод «Орбита»). No real company/project asserted.
 */

const EN_ACTOR_SOURCE = "Vendor Ltd";
const EN_ACTION_SOURCE = "invested 500 million units in Orbital Works in 2025.";
const EN_FULL_SOURCE = "Vendor Ltd invested 500 million units in Orbital Works in 2025.";

// Co-located multi-source prose WITHOUT terminal punctuation between the
// fragments is explicitly handled by per-ref splitting (F-05).
const EN_FRAGMENT_ACTOR = "Vendor Ltd";
const EN_FRAGMENT_ACTION = "invested 500 million units in Orbital Works";

function ref(excerpt: string, name = "vendor-first-party-records"): SourceRef {
  return {
    ref: `intake:${name}`,
    sourceUrl: `intake:${name}`,
    supportingExcerpt: excerpt,
    tier: "TIER_A",
    sourceDate: "2026-01-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    sourceClassification: "ORIGINAL_WORK_PRODUCT",
    evidenceOrigin: "ACCEPTED_FIRST_PARTY",
  };
}

function lineage(
  claimText: string,
  excerpts: Array<string>,
  extra: Partial<ClaimLineage> = {},
): ClaimLineage {
  return {
    claimId: "c-p1a",
    claimText,
    claimType: "FIRST_PARTY_FACT",
    claimSource: "ACCEPTED_CONTENT",
    pageIdentity: "vendor/homepage",
    limitation: "",
    sourceRefs: excerpts.map((e) => ref(e)),
    ...extra,
  } as ClaimLineage;
}

// ---------------------------------------------------------------------------
// F-01 EN: actor fragment in ref A + action fragment in ref B must NOT fuse
// ---------------------------------------------------------------------------

test("P1-A F-01: EN split-source attribution fusion must FAIL (actor ref separate from action ref)", () => {
  const problems = claimLineageProblems(
    lineage("Vendor Ltd invested 500 million units in Orbital Works in 2025.", [
      EN_ACTOR_SOURCE,
      EN_ACTION_SOURCE,
    ]),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution (no single ref pairs actor+action), got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// F-02 RU: same fusion class with Russian fragments
// ---------------------------------------------------------------------------

test("P1-A F-02: RU split-source attribution fusion must FAIL", () => {
  const problems = claimLineageProblems(
    lineage("ООО «ИнжПроект» построило завод «Орбита» в 2023 году.", [
      "ООО «ИнжПроект»",
      "построило завод «Орбита» в 2023 году.",
    ]),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// F-03 numeric cross-ref laundering: figure only in ref B, claim cites both
// A (relevant excerpt WITHOUT the figure) and B (unnrelated excerpt) — the
// figure is not substantiated by ref A's evidence.
// ---------------------------------------------------------------------------

test("P1-A F-03: figure appearing only in unrelated second ref does not substantiate the claim", () => {
  const problems = claimLineageProblems(
    lineage("Vendor Ltd performed engineering for Orbital Works for 500 million units.", [
      "Vendor Ltd performed engineering for Orbital Works in 2025.",
      "Orbital Works received 500 million units of investment in 2025.",
    ]),
  );
  assert.ok(
    problems.some(
      (p) =>
        p.includes("500") &&
        (p.includes("not substantiated") || p.startsWith("Numeric figure")),
    ),
    `expected numeric figure rejection bound to the supporting excerpt, got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// F-04 POSITIVE CONTROL: a single self-sufficient ref still PASSES, and a
// claim whose figure and actor-action pairing both live inside ONE ref
// supported BY THAT SAME ref keeps passing.
// ---------------------------------------------------------------------------

test("P1-A F-04: single self-sufficient source still PASSES lineage (positive control)", () => {
  assert.deepEqual(
    claimLineageProblems(lineage(EN_FULL_SOURCE, [EN_FULL_SOURCE])),
    [],
  );
});

test("P1-A F-04b: two refs EACH independently supporting different figures of one claim PASSES", () => {
  // Legitimate multi-source claim: each figure comes from its own
  // independently supporting ref. Claim is a single sentence so the
  // claim-side actor windows stay well-formed.
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd performed engineering for Orbital Works in 2025 and Funding Group invested 300 units in the works program.",
      [
        "Vendor Ltd performed engineering for Orbital Works in 2025.",
        "Funding Group invested 300 units in the works program.",
      ],
    ),
  );
  assert.deepEqual(problems, [], `expected clean multi-source support, got: ${JSON.stringify(problems)}`);
});

// ---------------------------------------------------------------------------
// F-05 UNPUNCTUATED co-located fragments INSIDE ONE ref may legitimately be
// one source; per-ref split keeps them evaluable for THAT ref only.
// ---------------------------------------------------------------------------

test("P1-A F-05: two refs, ONE of them self-sufficient, still covers that pairing via its own ref", () => {
  const problems = claimLineageProblems(
    lineage(EN_FULL_SOURCE, [
      EN_FULL_SOURCE, // self-sufficient: this ref alone supports the claim
      EN_FRAGMENT_ACTOR, // extra unrelated fragment ref adds no support/removal risk
    ]),
  );
  assert.deepEqual(
    problems,
    [],
    `a self-sufficient ref plus an unrelated fragment ref must still PASS, got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// F-06 actor-verb pairing existing ONLY across the ref boundary (EN): actor
// token lives in ref A, verb family token lives in ref B — no single ref
// pairs them.
// ---------------------------------------------------------------------------

test("P1-A F-06: cross-ref actor-verb pairing (EN, verb only in ref B) must FAIL", () => {
  const problems = claimLineageProblems(
    lineage("Vendor Ltd funded the Orbital Works modernization in 2024.", [
      "Vendor Ltd",
      "funded the Orbital Works modernization in 2024.",
    ]),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});
