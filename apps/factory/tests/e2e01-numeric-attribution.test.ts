import assert from "node:assert/strict";
import test from "node:test";
import { claimLineageProblems, type ClaimLineage, type SourceRef } from "@factory/contracts";

/**
 * E2E-P1-A2 — numeric-attribution binding (the remaining P1-A defect round).
 *
 * Defect class: the numeric substantiation gate accepted a claim figure when
 * ANY cited SourceRef contained SOME actional actor-verb pairing — even when
 * that pairing belonged to a DIFFERENT actor/action than the claim itself.
 * The figure 500 carried by an unrelated ref's own pairing ("Funding Group
 * invested 500 million units") launding support for a claim that attributes
 * that 500 to "Vendor Ltd performed engineering".
 *
 * Acceptance rule after the fix: a SourceRef substantiates a claim figure
 * ONLY when that ref INDEPENDENTLY pairs the claim's own substantive
 * actor/action (and, where quoted objects exist, the same object). A figure
 * supplied by a ref that pairs nobody relevant cannot launder support.
 *
 * All entities are TEST-ONLY FICTIONAL (Vendor Ltd, Orbital Works, Funding
 * Group, ООО «ИнжПроект», завод «Орбита», объект «Аврора»). No real
 * company/project asserted.
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
    claimId: "c-na",
    claimText,
    claimType: "FIRST_PARTY_FACT",
    claimSource: "ACCEPTED_CONTENT",
    pageIdentity: "vendor/homepage",
    limitation: "",
    sourceRefs: excerpts.map((e, i) => ref(e, `vendor-records-${i}`)),
    ...extra,
  } as ClaimLineage;
}

function expectNumericOrAttributionFailure(problems: string[], figure: string, label: string) {
  assert.ok(
    problems.length > 0,
    `${label}: expected a rejection (never PASS), got an empty problem list`,
  );
  assert.ok(
    !problems.some((p) => /^PASS$/i.test(p)),
    `${label}: must never report PASS`,
  );
  assert.ok(
    problems.some(
      (p) =>
        p.includes(figure) &&
        (p.includes("not substantiated") || p.startsWith("Numeric figure")),
    ) ||
      problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")),
    `${label}: expected the exact unsupported-numeric/attribution code, got: ${JSON.stringify(problems)}`,
  );
}

// ---------------------------------------------------------------------------
// NA-01 — the brief's exact defect case: the 500 belongs to Funding Group's
// investment, NOT to Vendor Ltd's engineering contract.
// ---------------------------------------------------------------------------

test("NA-01: figure from unrelated actor's own pairing cannot substantiate the claim", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd performed engineering for Orbital Works worth 500 million units.",
      [
        "Vendor Ltd performed engineering for Orbital Works in 2025.",
        "Funding Group invested 500 million units in Orbital Works in 2025.",
      ],
    ),
  );
  expectNumericOrAttributionFailure(problems, "500", "NA-01");
});

// ---------------------------------------------------------------------------
// NA-02 — same action family, DIFFERENT actor, figure only in the other
// actor's excerpt.
// ---------------------------------------------------------------------------

test("NA-02: same action with a different actor does not substantiate the figure", () => {
  const problems = claimLineageProblems(
    lineage("Vendor Ltd performed supervision for Orbital Works worth 120 units.", [
      "Vendor Ltd performed supervision for Orbital Works in 2025.",
      "Funding Group performed supervision for Logistics Depot worth 120 units.",
    ]),
  );
  expectNumericOrAttributionFailure(problems, "120", "NA-02");
});

// ---------------------------------------------------------------------------
// NA-03 — same actor, DIFFERENT action family, figure only in the other
// action's excerpt.
// ---------------------------------------------------------------------------

test("NA-03: same actor with a different action does not substantiate the figure", () => {
  const problems = claimLineageProblems(
    lineage("Vendor Ltd performed engineering for Orbital Works worth 340 units.", [
      "Vendor Ltd performed engineering for Orbital Works in 2025.",
      "Vendor Ltd funded research programs worth 340 units.",
    ]),
  );
  expectNumericOrAttributionFailure(problems, "340", "NA-03");
});

// ---------------------------------------------------------------------------
// NA-04 — object mismatch (quoted objects): same actor, same action, figure
// attached to a different quoted object.
// ---------------------------------------------------------------------------

test("NA-04: figure bound to a different quoted object does not substantiate the claim", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» выполнило проектирование объекта «Орбита» стоимостью 500 млн.",
      [
        "ООО «ИнжПроект» выполнило проектирование объекта «Орбита» в 2025 году.",
        "ООО «ИнжПроект» выполнило проектирование объекта «Аврора» стоимостью 500 млн.",
      ],
    ),
  );
  expectNumericOrAttributionFailure(problems, "500", "NA-04");
});

// ---------------------------------------------------------------------------
// NA-05 — multiple sources AND multiple numbers, both cross-attributed:
// neither figure may be substantiated by the unrelated excerpts.
// ---------------------------------------------------------------------------

test("NA-05: multiple figures cross-attributed from multiple unrelated sources must FAIL", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd performed engineering for Orbital Works worth 500 million units in 2025.",
      [
        "Vendor Ltd performed engineering for Orbital Works in 2024.",
        "Funding Group invested 700 million units in Orbital Works in 2026.",
      ],
    ),
  );
  expectNumericOrAttributionFailure(problems, "500", "NA-05");
  expectNumericOrAttributionFailure(problems, "2025", "NA-05");
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS
// ---------------------------------------------------------------------------

test("NA-06 positive control: single self-sufficient source with its own figure PASSES", () => {
  assert.deepEqual(
    claimLineageProblems(
      lineage("Vendor Ltd performed engineering for Orbital Works worth 400 units in 2025.", [
        "Vendor Ltd performed engineering for Orbital Works worth 400 units in 2025.",
      ]),
    ),
    [],
  );
});

test("NA-07 positive control: multi-source where EACH figure-bearing ref independently pairs the claim actor/action PASSES", () => {
  const problems = claimLineageProblems(
    lineage(
      "Vendor Ltd performed engineering for Orbital Works worth 400 units in 2025 and Funding Group invested 300 units in the works program.",
      [
        "Vendor Ltd performed engineering for Orbital Works worth 400 units in 2025.",
        "Funding Group invested 300 units in the works program.",
      ],
    ),
  );
  assert.deepEqual(problems, [], `expected clean multi-source support, got: ${JSON.stringify(problems)}`);
});

test("NA-08 positive control: quoted-object figure bound to the SAME object PASSES", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» выполнило проектирование объекта «Орбита» стоимостью 500 млн.",
      [
        "ООО «ИнжПроект» выполнило проектирование объекта «Орбита» стоимостью 500 млн. в 2025 году.",
      ],
    ),
  );
  assert.deepEqual(problems, [], `expected clean quoted-object support, got: ${JSON.stringify(problems)}`);
});

// ---------------------------------------------------------------------------
// REGRESSION GUARDS — the fix must not disturb the already-proven rounds.
// ---------------------------------------------------------------------------

test("NA-09 regression: F-04b two refs each independently supporting different figures still PASSES", () => {
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

test("NA-10 regression: negated RU claim stays an explicit limitation (no new false rejection)", () => {
  const problems = claimLineageProblems(
    lineage(
      "ООО «ИнжПроект» не строило завод «Орбита».",
      ["ООО «ИнжПроект» не строило завод «Орбита»; строительство вело ООО «ПромСтрой»."],
    ),
  );
  assert.deepEqual(
    problems,
    [],
    `negated self-consistent claim must still carry no unsupported attribution, got: ${JSON.stringify(problems)}`,
  );
});
