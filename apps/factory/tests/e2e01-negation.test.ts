import assert from "node:assert/strict";
import test from "node:test";
import { claimLineageProblems, type ClaimLineage, type SourceRef } from "@factory/contracts";

/**
 * E2E-P1-B — Unicode negation recognition (dead-guard fix).
 *
 * Defect class: the negation guard in extractActorVerbPairsSentence uses
 * `/\b(?:не|нет)\b/i` — JavaScript `\b` is ASCII-only, so the guard never
 * matches Cyrillic text. The dead guard means a negated evidence occurrence
 * is treated as a positive pairing whenever the neighboring stopword walk
 * (RU_ACTOR_STOPWORDS contains «не» as a WINDOW terminator, not a negation
 * recognizer) does not already suppress it. Probes established:
 *   - RU «не построило/не инвестировало» currently rejected only when «не»
 *     sits inside the actor window as a stopword-circuit-breaker;
 *   - EN "did not invest" / "Not Vendor Ltd but Funding Group built" produce
 *     FALSE PASS today (no EN negation handling at all);
 *   - RU distance negation («официально не инвестировало» >12 chars) is
 *     missed when «не» falls outside the 12-char lookback window.
 *
 * Acceptance: negated verb occurrences in EVIDENCE must never pair as
 * support (tense intent); negated occurrences in the CLAIM are explicit
 * limitations and impose no support requirement. Positive controls keep
 * passing.
 *
 * All entities are TEST-ONLY FICTIONAL (ООО «ИнжПроект», завод «Орбита»,
 * Vendor Ltd, Orbital Works, Funding Group). No real company asserted.
 */

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
    claimId: "c-p1b",
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
// RU negated evidence must not support the claim
// ---------------------------------------------------------------------------

test("P1-B RU-NEG-01: «не построило» evidence must NOT support construction claim", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      ["ООО «ИнжПроект» не построило завод «Орбита» в 2023 году."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B RU-NEG-02: «не инвестировало» evidence must NOT support investment claim", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» инвестировало 500 млн рублей в завод «Орбита».",
      ["ООО «ИнжПроект» не инвестировало 500 млн рублей в завод «Орбита»."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B RU-NEG-03: distance negation «официально не инвестировало» must be recognized", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» инвестировало средства в завод «Орбита».",
      ["Согласно отчету, ООО «ИнжПроект» официально не инвестировало средства в завод «Орбита»."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution (negated occurrence), got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B RU-NEG-04: passive negation chain «не был построен (кем-то конкретным)» must not pair clans", () => {
  // Passive past with negation; the excerpt must not authorize the active
  // claim «ООО X построил».
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      ["Завод «Орбита» в 2023 году не был построен ООО «ИнжПроект»."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED") || p.length > 0),
    `expected rejection (negated passive must not authorize active attribution), got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B RU-NEG-05: multi-company «A не строил, а B построил» — A side must not pair as support", () => {
  // Claim attributes construction to ИнжПроект; the evidence sentence
  // explicitly negates ИнжПроект and apposits the builder as ПромСтрой.
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      ["ООО «ИнжПроект» не строило завод «Орбита»; строительство вело ООО «ПромСтрой»."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution for the negated actor, got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// EN negated evidence must not support the claim (today false-PASS)
// ---------------------------------------------------------------------------

test("P1-B EN-NEG-06: 'did not invest' evidence must NOT support investment claim", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd invested 500 million units in Orbital Works in 2025.",
      ["Vendor Ltd did not invest 500 million units in Orbital Works in 2025."],
    ),
  );
  assert.ok(
    problems.some(
      (p) =>
        p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED") ||
        p.startsWith("Numeric figure"),
    ),
    `expected rejection (negated evidence cannot support), got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B EN-NEG-07: 'Not Vendor Ltd but Funding Group built' must not pair Vendor Ltd as builder", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd built the plant in 2023.",
      ["Not Vendor Ltd but Funding Group built the plant in 2023."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution for Vendor Ltd (explicitly not the builder), got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// Negated CLAIM text is an explicit limitation: no support requirement
// ---------------------------------------------------------------------------

test("P1-B CLAIM-NEG-08: negated claim text is an explicit limitation (positive control; no false rejection)", () => {
  // Honest claim stating the company did NOT build the plant: the claim's
  // negated occurrence imposes no attribution requirement.
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» не строило завод «Орбита».",
      ["ООО «ИнжПроект» не строило завод «Орбита»; строительство вело ООО «ПромСтрой»."],
    ),
  );
  assert.deepEqual(
    problems,
    [],
    `negated self-consistent claim must carry no unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

// ---------------------------------------------------------------------------
// Positive controls: affirmative evidence keeps passing after the fix
// ---------------------------------------------------------------------------

test("P1-B RU-NEG-12: hyphenated 'не-смо́г инвестировал' must NOT pair as support (probe A3a regression lock)", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» инвестировало 500 млн рублей в завод «Орбита».",
      ["ООО «ИнжПроект» не-смо́г инвестировал 500 млн рублей в завод «Орбита»."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B RU-NEG-13: comma-separated 'не, впрочем, построило' must NOT pair as support (probe A3c regression lock)", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      ["ООО «ИнжПроект» не, впрочем, построило завод «Орбита» в 2023 году."],
    ),
  );
  assert.ok(
    problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `expected unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-B POS-14: «неверно» inside lookback does NOT over-suppress an affirmative pairing (probe A3b lock)", () => {
  // Discourse-marker adjective «неверно» in a preceding clause must not be
  // read as a negation token: the affirmative pairing stays supported.
  assert.deepEqual(
    claimLineageProblems(
      lineage(
        "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
        ["Предположение оказалось неверно; ООО «ИнжПроект» построило завод «Орбита» в 2023 году."],
      ),
    ),
    [],
  );
});

test("P1-B POS-15: negation inside a QUOTE before an affirmative verb stays a support (probe A4b lock)", () => {
  assert.deepEqual(
    claimLineageProblems(
      lineage(
        "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
        ["В рекламе значилось «не», но ООО «ИнжПроект» построило завод «Орбита» в 2023 году."],
      ),
    ),
    [],
  );
});

test("P1-B POS-09: affirmative RU construction claim PASSES (guard must not over-suppress)", () => {
  assert.deepEqual(
    claimLineageProblems(
      lineage(
        "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
        ["ООО «ИнжПроект» построило завод «Орбита» в 2023 году."],
      ),
    ),
    [],
  );
});

test("P1-B POS-10: affirmative EN investment claim PASSES", () => {
  assert.deepEqual(
    claimLineageProblems(
      lineage(
        "Vendor Ltd invested 500 million units in Orbital Works in 2025.",
        ["Vendor Ltd invested 500 million units in Orbital Works in 2025."],
      ),
    ),
    [],
  );
});

test("P1-B POS-11: RU 'построено' short-participle affirmative passive stays supported", () => {
  // The RU stopword list contains «построено» for window-termination; a
  // sentence that legitimately pairs the actor must still pass.
  assert.deepEqual(
    claimLineageProblems(
      lineage(
        "Завод «Орбита» построен ООО «ПромСтрой» в 2023 году.",
        ["Завод «Орбита» построен ООО «ПромСтрой» в 2023 году."],
      ),
    ),
    [],
  );
});

test("P1-B CALC-16: calculationRef cannot launder figures into a FIRST_PARTY_FACT claim (probe A8 regression lock)", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd performed engineering for 7.2 units.",
      ["Vendor Ltd performed engineering for Orbital Works in 2025."],
      {
        calculationRef: {
          modelId: "yield-model-v1",
          inputs: [
            { name: "annual rent", value: "26400", unit: "EUR/year" },
            { name: "price", value: "366000", unit: "EUR" },
          ],
          assumptionRefs: [],
          output: { value: "7.2", unit: "%" },
          calculatedAt: "2026-09-01",
        },
      },
    ),
  );
  assert.ok(
    problems.some(
      (p) =>
        p.includes("calculation_ref_claim_type_mismatch") ||
        p.startsWith("Numeric figure"),
    ),
    `expected calculation-type mismatch rejection, got: ${JSON.stringify(problems)}`,
  );
});
