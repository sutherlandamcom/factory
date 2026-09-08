import test from "node:test";
import assert from "node:assert/strict";
import {
  validateContentGapGrounding,
  generateRequirementId,
  type GapGroundingContext,
} from "../src/competitors/gap-engine.js";
import { CompetitorStore } from "../src/competitors/competitor-store.js";
import { contentGapSchema, type ContentGap, type CoverageMatrix } from "@factory/contracts";
import { FactoryError } from "../src/executor/errors.js";

/**
 * PHASE 1 REPRODUCTION — P1-A budget reservation gap + P1-B categorical
 * coverage consistency. These tests FAIL against candidate 7078163 and are
 * the regression proof for the remediation.
 */

// ---------------------------------------------------------------------------
// P1-A: budget reservation lifecycle
// ---------------------------------------------------------------------------

function makeBudgetStore(): CompetitorStore {
  const store = new CompetitorStore({} as never);
  store.sumTodayCompetitorCostMicros = async () => 0;
  return store;
}

test("P1-A REPRO: reservation must remain represented until spend is durably accounted (race A completed-unaccounted blocks B)", async () => {
  const store = makeBudgetStore();
  // Daily limit 5 USD = 5,000,000 micros. Spent today 4,990,000 -> 10,000 free.
  store.sumTodayCompetitorCostMicros = async () => 4_990_000;

  // Run A reserves 10,000 and "the model call completes".
  const releaseA = await store.reserveBudget(10_000, 5);

  // Run A has NOT yet durably accounted its spend (no accounting performed).
  // Run B attempts authorization for the same amount.
  // REQUIRED: B is BLOCKED because A's cost is still represented.
  await assert.rejects(
    store.reserveBudget(10_000, 5),
    (err: unknown) => err instanceof FactoryError && err.code === "competitor_budget_blocked",
    "Run B must be blocked while Run A's spend is reserved but unaccounted",
  );

  // Cleanup for test isolation: release A's reservation (accounted flow in real impl).
  releaseA();
});

test("P1-A REPRO: unknown actual provider cost must account at least the authorized conservative amount (>= 70,000, not 10k/20k)", async () => {
  const store = makeBudgetStore();
  store.sumTodayCompetitorCostMicros = async () => 0;

  const release = await store.reserveBudget(70_000, 5);
  // Simulate: invocation completed, provider usage/cost missing -> accounting
  // must retain the authorized conservative amount, NOT downgrade to 10k/20k.
  release();

  // After the lifecycle completes, the ledger must reflect >= 70,000 accounted.
  const accounted = await store.sumTodayCompetitorCostMicros();
  assert.ok(
    accounted >= 70_000,
    `Unknown-cost accounting must be >= authorized 70,000 micros, got ${accounted}`,
  );
});

test("P1-A REPRO: trusted actual cost lower than reservation accounts actual, not the reservation", async () => {
  const store = makeBudgetStore();
  store.sumTodayCompetitorCostMicros = async () => 0;

  const handle = await store.reserveBudget(70_000, 5);
  // Trusted actual cost from provider usage: 12,345 micros.
  handle.account(12_345);
  const accounted = await store.sumTodayCompetitorCostMicros();
  assert.equal(accounted, 12_345, "Trusted actual cost must be accounted exactly");
});

test("P1-A REPRO: provable pre-submission failure releases reservation without inventing spend", async () => {
  const store = makeBudgetStore();
  store.sumTodayCompetitorCostMicros = async () => 4_995_000;

  const handle = await store.reserveBudget(10_000, 5);
  // Call provably never reached the provider (e.g. missing credentials).
  handle.releaseUnexecuted();
  const accounted = await store.sumTodayCompetitorCostMicros();
  assert.equal(accounted, 0, "Pre-submission failure must not invent spend");
});

// ---------------------------------------------------------------------------
// P1-B: deterministic coverage matrix categorical consistency
// ---------------------------------------------------------------------------

const LEVELS = ["ABSENT", "WEAK", "PARTIAL", "STRONG"] as const;
type Level = (typeof LEVELS)[number];

function makeMatrix(maxLevel: Level): CoverageMatrix {
  return {
    policyVersion: "coverage-matrix-v1",
    rows: [
      {
        requirementId: generateRequirementId("Understand rental yield calculation"),
        requirement: "Understand rental yield calculation",
        cells: [
          { pageSnapshotId: "page-1", domain: "example.com", level: maxLevel },
        ],
      },
    ],
  };
}

function makeGapWithCoverage(coverage: Level): ContentGap {
  const userNeed = "Understand rental yield calculation";
  return {
    id: "gap-001",
    coverageRequirementId: generateRequirementId(userNeed),
    userNeed,
    topicQuestion: "What rental yield can investors expect?",
    searchEvidenceRefs: [
      { kind: "serp_snapshot", id: "serp-1", digest: "s".repeat(64) },
      { kind: "search_intelligence_snapshot", id: "intel-1", digest: "i".repeat(64) },
    ],
    competitorCoverage: coverage,
    competitorsCoveringIt: coverage === "ABSENT" ? [] : ["page-1"],
    treatmentPattern: "Competitors give high-level numbers without formulas.",
    baselineExpectation: "Explain net yield vs gross yield.",
    ourEvidenceAvailable: [
      { intakeField: "operatorFacts", itemIndex: 0, excerpt: "Operator operates since 2019" },
    ],
    ourEvidenceMissing: [],
    claimConstraints: [],
    differentiationOpportunity: "Provide actual historical data and calculation tool.",
    recommendedDisposition: "REQUIRED",
    priority: "HIGH",
    rationale: "Core buyer consideration.",
    evidenceRefs:
      coverage === "ABSENT" ? [] : [{ pageSnapshotId: "page-1", segmentId: "seg-101" }],
  } as ContentGap;
}

function makeCtx(matrix: CoverageMatrix): GapGroundingContext {
  return {
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "s".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "i".repeat(64),
    pageSnapshots: [
      {
        id: "page-1",
        digest: "p1".repeat(32),
        classification: "INCLUDE",
        validSegmentIds: new Set(["seg-101", "seg-102"]),
      },
    ],
    analyses: [{ id: "analysis-1", digest: "a1".repeat(32), pageSnapshotId: "page-1" }],
    coverageMatrix: matrix,
  };
}

for (const matrixLevel of LEVELS) {
  for (const modelLevel of LEVELS) {
    if (matrixLevel === modelLevel) continue;
    test(`P1-B REPRO: matrix ${matrixLevel} / model ${modelLevel} must be rejected`, () => {
      const gap = makeGapWithCoverage(modelLevel);
      const ctx = makeCtx(makeMatrix(matrixLevel));
      // Schema-level validation must also reject non-ABSENT with empty refs /
      // ABSENT with non-empty refs — build the gap accordingly (done above),
      // then the engine must reject the categorical mismatch.
      assert.throws(
        () => {
          contentGapSchema.parse(gap);
          validateContentGapGrounding([gap], ctx);
        },
        (err: unknown) =>
          err instanceof FactoryError &&
          err.code === "content_gap_invalid" &&
          new RegExp(
            `deterministic coverage matrix.*${matrixLevel}`,
            "i",
          ).test(err.message),
      );
    });
  }
}

for (const level of LEVELS) {
  test(`P1-B REPRO: exact match matrix ${level} / model ${level} accepted`, () => {
    const gap = makeGapWithCoverage(level);
    const ctx = makeCtx(makeMatrix(level));
    assert.doesNotThrow(() => {
      contentGapSchema.parse(gap);
      validateContentGapGrounding([gap], ctx);
    });
  });
}
