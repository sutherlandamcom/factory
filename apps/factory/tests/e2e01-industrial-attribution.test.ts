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

// ---------------------------------------------------------------------------
// Layer 2b: RUSSIAN-language action attribution (P1-04 RU matrix)
// ---------------------------------------------------------------------------

// Fictional RU entities only: ООО «ИнжПроект» (contractor), АО «Завод
// «Орбита»» (facility), ООО «ИнвестГруппа» (investor), ООО «ПромСтрой»
// (builder). No real company/project is asserted.

const RU_INVESTMENT_SOURCE =
  "ООО «ИнвестГруппа» инвестировало 500 млн рублей в завод «Орбита» в 2025 году.";
const RU_ENGINEERING_SOURCE =
  "ООО «ИнжПроект» выполнило инженерное проектирование завода «Орбита» в 2025 году.";
const RU_PASSIVE_CONSTRUCTION_SOURCE =
  "Завод «Орбита» был построен ООО «ПромСтрой» в 2023 году.";
const RU_NEGATION_SOURCE =
  "ООО «ИнжПроект» не строило завод «Орбита»; строительство вело ООО «ПромСтрой».";
const RU_FUTURE_SOURCE =
  "ООО «ИнжПроект» планирует построить завод «Орбита» в 2027 году.";
const RU_ENGINEERING_PLANT_B_SOURCE =
  "ООО «ИнжПроект» выполнило инженерное проектирование завода «Спектр» в 2024 году.";

function ruProblems(claimText: string, excerpt: string): string[] {
  return claimLineageProblems(
    claim({
      claimId: "c-ru",
      claimText,
      claimType: "FIRST_PARTY_FACT",
      sourceRefs: [intakeSourceRef(excerpt)],
    }),
  );
}

function ruAttributionProblems(claimText: string, excerpt: string): string[] {
  return ruProblems(claimText, excerpt).filter((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED"));
}

function expectFamilyRejection(problems: string[], family: string, actor: string): void {
  const actorKey = actor.toLowerCase();
  assert.ok(
    problems.some((p) => p.includes(family) && p.toLowerCase().includes(actorKey)),
    `expected ${family}-family rejection naming "${actor}", got: ${JSON.stringify(problems)}`,
  );
}

test("P1-04 RU-01: Russian investor misattribution FAILS (invest family)", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» инвестировало 500 млн рублей в завод «Орбита» в 2025 году.",
      RU_INVESTMENT_SOURCE,
    ),
    "invest",
    "ИнжПроект",
  );
});

test("P1-04 RU-02: Russian construction attributed from engineering-only excerpt FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» построило завод «Орбита» в 2025 году.",
      RU_ENGINEERING_SOURCE,
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 RU-03: Russian operation attributed from engineering-only excerpt FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» эксплуатирует завод «Орбита».",
      RU_ENGINEERING_SOURCE,
    ),
    "operate",
    "ИнжПроект",
  );
});

test("P1-04 RU-04: Russian ownership attributed from engineering-only excerpt FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» владеет заводом «Орбита».",
      RU_ENGINEERING_SOURCE,
    ),
    "own",
    "ИнжПроект",
  );
});

test("P1-04 RU-05: Russian investment attributed from engineering-only excerpt FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» инвестировало средства в завод «Орбита».",
      RU_ENGINEERING_SOURCE,
    ),
    "invest",
    "ИнжПроект",
  );
});

test("P1-04 RU-06: faithful Russian engineering claim (positive control)", () => {
  assert.deepEqual(
    ruProblems("ООО «ИнжПроект» выполнило инженерное проектирование завода «Орбита» в 2025 году.", RU_ENGINEERING_SOURCE),
    [],
  );
});

test("P1-04 RU-07: source names ANOTHER builder; contractor claims construction FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      RU_PASSIVE_CONSTRUCTION_SOURCE,
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 RU-08: same actor+action, work attributed to PLANT B FAILS (object mismatch)", () => {
  const problems = ruAttributionProblems(
    "ООО «ИнжПроект» выполнило инженерное проектирование завода «Орбита» в 2024 году.",
    RU_ENGINEERING_PLANT_B_SOURCE,
  );
  assert.ok(
    problems.some((p) => p.toLowerCase().includes("инжпроект")),
    `expected rejection for object mismatch (Орбита vs Спектр), got: ${JSON.stringify(problems)}`,
  );
});

test("P1-04 RU-09: same actor+action, unsupported larger amount", () => {
  const problems = ruProblems(
    "ООО «ИнвестГруппа» инвестировало 900 млн рублей в завод «Орбита» в 2025 году.",
    RU_INVESTMENT_SOURCE,
  );
  assert.ok(
    problems.some((p) => p.includes("900") && (p.includes("not substantiated") || p.startsWith("Numeric figure"))),
    JSON.stringify(problems),
  );
});

test("P1-04 RU-10: passive Russian wording; different company claims responsibility FAILS", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      RU_PASSIVE_CONSTRUCTION_SOURCE,
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 RU-11: mixed RU/EN company names; wrong construction role FAILS", () => {
  const problems = ruAttributionProblems(
    "ООО «ИнжПроект» (InzhProekt LLC) построило завод «Орбита».",
    RU_ENGINEERING_SOURCE,
  );
  assert.ok(
    problems.some((p) => p.toLowerCase().includes("инжпроект")),
    `expected rejection naming the claim actor, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-04 RU-12: inflected verb forms, same legitimate actor/action (positive control)", () => {
  assert.deepEqual(
    ruProblems(
      "В 2025 ООО «ИнжПроект» выполнило инженерные изыскания и проектирование завода «Орбита».",
      RU_ENGINEERING_SOURCE,
    ),
    [],
  );
});

test("P1-04 RU-13: Russian negation in source must not support claim", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» построило завод «Орбита» в 2023 году.",
      RU_NEGATION_SOURCE,
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 RU-14: future/intent source must not authorize completed past fact", () => {
  const problems = ruAttributionProblems(
    "ООО «ИнжПроект» построило завод «Орбита» в 2025 году.",
    RU_FUTURE_SOURCE,
  );
  assert.ok(
    problems.some((p) => p.toLowerCase().includes("инжпроект")),
    `expected rejection (intent evidence cannot support completed fact), got: ${JSON.stringify(problems)}`,
  );
});

test("P1-04 RU-15: ambiguous responsibility → unsupported specific contractual claim FAILS", () => {
  const problems = ruAttributionProblems(
    "ООО «ИнжПроект» несёт ответственность за строительство завода «Орбита» по контракту.",
    "Проект завода «Орбита» обсуждался на отраслевом форуме в 2024 году.",
  );
  assert.ok(
    problems.some((p) => p.toLowerCase().includes("инжпроект")),
    `expected rejection naming the claim actor, got: ${JSON.stringify(problems)}`,
  );
});

test("P1-04 RU-16: composite subject «A и B построили» — unsupported side FAILS individually", () => {
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» и ООО «СтройГарант» построили завод «Орбита» в 2023 году.",
      "ООО «СтройГарант» построило завод «Орбита» в 2023 году.",
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 RU-17: composite subject positive control — SUPPORTED side passes", () => {
  assert.deepEqual(
    ruProblems(
      "ООО «СтройГарант» и ООО «ИнжПроект» проектировали завод «Орбита» в 2024 году.",
      "ООО «СтройГарант» и ООО «ИнжПроект» проектировали завод «Орбита» в 2024 году по контракту.",
    ),
    [],
  );
});

test("P1-04 RUX-01: cross-excerpt fusion probe (object excerpt has no terminal punctuation) FAILS", () => {
  // The only supplied excerpt names the facility; construction must have no
  // supporting actor pairing and must not be silently ignored because the
  // recognizer found no Russian patterns (RED against the EN-only matcher).
  expectFamilyRejection(
    ruAttributionProblems(
      "ООО «ИнжПроект» построило завод «Орбита»",
      "завод «Орбита»",
    ),
    "construct",
    "ИнжПроект",
  );
});

test("P1-04 L2x: cross-facility excerpt without quoted object names is beyond actor alignment (documented boundary; deeper authority binds digests separately)", () => {
  // Honest, corrected wording (former name claimed a wrong-project FAIL the
  // matcher never produced). With UNQUOTED facility tokens there is no
  // bounded object to bind, so the deterministic actor/action check cannot
  // reject this case by itself. This boundary is compensated by: the quoted
  // object-binding probe below, the two-project persistence suite
  // (e2e01-cross-project-authority.test.ts; XP-01..XP-08), and the digest-
  // bound review/production seams. Register row E2E-P1-04 documents this.
  const crossFacility = claim({
    claimId: "c-cross-project",
    claimText: "Vendor Ltd performed the structural engineering review for Harbor Mills in 2025.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE.replace("Orbital Works", "Harbor Mills"))],
  });
  assert.deepEqual(claimLineageProblems(crossFacility), []);
});

test("P1-04 L2x: wrong-facility attribution in a QUOTED object claim FAILS via object binding (new after RU coverage)", () => {
  // Same actor+family, different (quoted) facility in the evidence — the
  // object-binding rule added with the Russian coverage now rejects it.
  const problems = ruAttributionProblems(
    "ООО «ИнжПроект» выполнило инженерное проектирование завода «Миллс» в 2025 году.",
    RU_ENGINEERING_SOURCE,
  );
  assert.ok(
    problems.some((p) => p.toLowerCase().includes("инжпроект")),
    `expected object-mismatch rejection, got: ${JSON.stringify(problems)}`,
  );
});
