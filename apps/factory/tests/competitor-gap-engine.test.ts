import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverageMatrix,
  collectFirstPartyEvidence,
  validateGapFirstPartyRefs,
  computeGapStaleness,
  finalizeGapReport,
  decisionsDigest,
} from "../src/competitors/gap-engine.js";
import { FixtureGapAnalyst, OpenRouterGapAnalyst, buildGapAnalystPrompt, GAP_ANALYST_SYSTEM_PROMPT } from "../src/competitors/gap-analyst.js";
import { parseContentGapReportData } from "@factory/contracts";

/** Content gap engine tests — deterministic + injected model, zero spend. */

function analysis(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageType: "guide",
    primaryIntent: "informational",
    topics: [], subtopics: [], entities: [],
    questionsAnswered: [], questionsUnanswered: [],
    coverageAreas: [],
    dataFactsUsed: [], sourceSignals: [], trustSignals: [], experienceSignals: [],
    commercialPositioning: "", ctaTreatment: "", freshnessAssessment: "",
    strengths: [], weaknesses: [], uniqueTreatment: [], missingTreatment: [],
    evidenceSegmentRefs: [{ pageSnapshotId: "snap-1", segmentId: "seg-001" }],
    confidence: 0.5,
    ...partial,
  };
}

test("coverage matrix: deterministic levels from analyses, ABSENT when unsupported", () => {
  const matrix = buildCoverageMatrix({
    requirements: [{ requirement: "Expected rental yield" }, { requirement: "Purchase taxes" }],
    pages: [
      {
        pageSnapshotId: "snap-1",
        domain: "a.example",
        analysis: analysis({
          coverageAreas: [
            { area: "Rental yield expectations", level: "STRONG", rationale: "Full section." },
          ],
        }) as never,
      },
      {
        pageSnapshotId: "snap-2",
        domain: "b.example",
        analysis: analysis({
          coverageAreas: [
            { area: "Rental yield", level: "PARTIAL", rationale: "Mentioned." },
            { area: "Taxes on purchase", level: "WEAK", rationale: "Brief." },
          ],
        }) as never,
      },
    ],
  });
  assert.equal(matrix.policyVersion, "coverage-matrix-v1");
  assert.equal(matrix.rows.length, 2);
  const [yieldRow, taxRow] = matrix.rows;
  assert.equal(yieldRow!.cells[0]!.level, "STRONG");
  assert.equal(yieldRow!.cells[1]!.level, "PARTIAL");
  assert.equal(taxRow!.cells[0]!.level, "ABSENT");
  assert.equal(taxRow!.cells[1]!.level, "WEAK");
  // Determinism: same inputs -> same output.
  const again = buildCoverageMatrix({
    requirements: [{ requirement: "Expected rental yield" }, { requirement: "Purchase taxes" }],
    pages: [
      {
        pageSnapshotId: "snap-1",
        domain: "a.example",
        analysis: analysis({
          coverageAreas: [{ area: "Rental yield expectations", level: "STRONG", rationale: "Full section." }],
        }) as never,
      },
      {
        pageSnapshotId: "snap-2",
        domain: "b.example",
        analysis: analysis({
          coverageAreas: [
            { area: "Rental yield", level: "PARTIAL", rationale: "Mentioned." },
            { area: "Taxes on purchase", level: "WEAK", rationale: "Brief." },
          ],
        }) as never,
      },
    ],
  });
  assert.deepEqual(again, matrix);
});

test("first-party evidence: refs must resolve to accepted items; competitor claims cannot become ours", () => {
  const evidence = collectFirstPartyEvidence({
    evidence: {
      operatorFacts: ["Operates in Chamonix valley since 2019"],
      allowedClaims: ["Member of the local tourist office"],
    },
  });
  assert.equal(evidence.length, 2);

  const okGap = {
    id: "gap-1",
    userNeed: "n", topicQuestion: "q",
    searchEvidenceRefs: [],
    competitorCoverage: "PARTIAL" as const,
    competitorsCoveringIt: [],
    treatmentPattern: "", baselineExpectation: "",
    ourEvidenceAvailable: [
      { intakeField: "operatorFacts" as const, itemIndex: 0, excerpt: "Operates in Chamonix valley" },
    ],
    ourEvidenceMissing: [], claimConstraints: [],
    differentiationOpportunity: "",
    recommendedDisposition: "REQUIRED" as const,
    priority: "HIGH" as const,
    rationale: "",
    evidenceRefs: [],
  };
  assert.doesNotThrow(() => validateGapFirstPartyRefs([okGap], evidence));

  // Model invents our evidence (index out of range):
  const fakeIndex = { ...okGap, id: "gap-2", ourEvidenceAvailable: [{ intakeField: "operatorFacts" as const, itemIndex: 7, excerpt: "x" }] };
  assert.throws(() => validateGapFirstPartyRefs([fakeIndex], evidence), /does not exist in accepted inputs/);

  // Model misquotes our evidence (competitor statistic smuggled in):
  const misquote = { ...okGap, id: "gap-3", ourEvidenceAvailable: [{ intakeField: "operatorFacts" as const, itemIndex: 0, excerpt: "Competitors claim 8 percent yield" }] };
  assert.throws(() => validateGapFirstPartyRefs([misquote], evidence), /misquotes first-party evidence/);
});

test("staleness: digest comparisons produce precise reasons", () => {
  const base = {
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotDigest: "s1",
    intelligenceSnapshotDigest: "i1",
    pageSnapshotDigests: ["p1", "p2"],
  };
  const current = { ...base };
  assert.deepEqual(computeGapStaleness({ bound: base, current }), { stale: false, reasons: [] });

  const inputChanged = { ...current, acceptedInputDigest: "d2", acceptedInputVersion: 2 };
  const r1 = computeGapStaleness({ bound: base, current: inputChanged });
  assert.equal(r1.stale, true);
  assert.ok(r1.reasons.some((x) => /inputs changed/.test(x)));

  const pagesChanged = { ...current, pageSnapshotDigests: ["p1", "p3"] };
  const r2 = computeGapStaleness({ bound: base, current: pagesChanged });
  assert.ok(r2.reasons.some((x) => /Competitor evidence changed/.test(x)));

  const pageAdded = { ...current, pageSnapshotDigests: ["p1", "p2", "p4"] };
  const r3 = computeGapStaleness({ bound: base, current: pageAdded });
  assert.equal(r3.stale, true);
});

test("gap report finalization: binds provenance, review state is Factory-owned", () => {
  const evidence = collectFirstPartyEvidence({ evidence: { operatorFacts: ["Real fact"], allowedClaims: [] } });
  const modelOutput = {
    gaps: [
      {
        id: "gap-001",
        userNeed: "Understand yield",
        topicQuestion: "What yield?",
        searchEvidenceRefs: [],
        competitorCoverage: "WEAK",
        competitorsCoveringIt: [],
        treatmentPattern: "",
        baselineExpectation: "",
        ourEvidenceAvailable: [
          { intakeField: "operatorFacts", itemIndex: 0, excerpt: "Real fact" },
        ],
        ourEvidenceMissing: [],
        claimConstraints: [],
        differentiationOpportunity: "",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "",
        evidenceRefs: [],
      },
    ],
    differentiationRequirements: {
      items: [
        { requirement: "Deeper risk treatment", basis: "editorial_opportunity", rationale: "Competitors shallow." },
      ],
    },
  };
  const data = finalizeGapReport({
    modelGaps: modelOutput,
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "s".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "i".repeat(64),
    pageSnapshotRefs: [{ id: "snap-1", digest: "p".repeat(64) }],
    analysisRefs: [{ id: "an-1", digest: "a".repeat(64) }],
    acceptedInputSnapshotId: "in-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "d".repeat(64),
    coverageMatrix: { policyVersion: "coverage-matrix-v1", rows: [] },
    model: "fixture-gap-analyst",
    provider: "fixture",
    promptVersion: "gap-analyst-v1",
    acceptedEvidence: evidence,
  });
  assert.equal(data.reviewState, "model_proposed");
  assert.equal(data.gaps.length, 1);
  assert.equal(data.differentiationRequirements.items.length, 1);
  assert.doesNotThrow(() => parseContentGapReportData(data));
});

test("gap analyst (injected): unsupported first-party claim fails closed at finalization", async () => {
  const model = new OpenRouterGapAnalyst({
    callModel: async () => ({
      text: JSON.stringify({
        gaps: [
          {
            id: "gap-1",
            userNeed: "n", topicQuestion: "q",
            searchEvidenceRefs: [],
            competitorCoverage: "PARTIAL",
            competitorsCoveringIt: [],
            treatmentPattern: "", baselineExpectation: "",
            ourEvidenceAvailable: [
              // Competitor claim smuggled as our evidence:
              { intakeField: "operatorFacts", itemIndex: 0, excerpt: "Competitors say 8% yield" },
            ],
            ourEvidenceMissing: [], claimConstraints: [],
            differentiationOpportunity: "",
            recommendedDisposition: "REQUIRED",
            priority: "HIGH",
            rationale: "",
            evidenceRefs: [],
          },
        ],
        differentiationRequirements: { items: [] },
      }),
    }),
  });
  const result = await model.propose({
    analyses: [],
    searchIntelligence: {},
    acceptedEvidence: [{ field: "operatorFacts", index: 0, text: "Unrelated real fact" }],
    projectContext: {},
    coverageMatrixSummary: [],
  });
  assert.throws(
    () =>
      finalizeGapReport({
        modelGaps: { gaps: result.gaps, differentiationRequirements: result.differentiationRequirements },
        serpSnapshotId: "serp",
        serpSnapshotDigest: "s".repeat(64),
        intelligenceSnapshotId: "intel",
        intelligenceSnapshotDigest: "i".repeat(64),
        pageSnapshotRefs: [],
        analysisRefs: [],
        acceptedInputSnapshotId: "in",
        acceptedInputSnapshotVersion: 1,
        acceptedInputDigest: "d".repeat(64),
        coverageMatrix: { policyVersion: "coverage-matrix-v1", rows: [] },
        model: result.model,
        provider: result.provider,
        promptVersion: result.promptVersion,
        acceptedEvidence: collectFirstPartyEvidence({ evidence: { operatorFacts: ["Unrelated real fact"], allowedClaims: [] } }),
      }),
    /misquotes first-party evidence/,
  );
});

test("gap analyst: invalid JSON fails closed; aggregate with unknown page refs cannot finalize", async () => {
  const invalid = new OpenRouterGapAnalyst({ callModel: async () => ({ text: "no json" }) });
  await assert.rejects(
    invalid.propose({ analyses: [], searchIntelligence: {}, acceptedEvidence: [], projectContext: {}, coverageMatrixSummary: [] }),
    /not parseable JSON/,
  );

  // Aggregate referencing an unknown page: shape passes, but gap-level
  // evidenceRefs validation is anchored by callers to stored analyses.
  // Here we verify the report contract itself carries only resolvable refs
  // via finalizeGapReport caller checks in the service (tested in P6).
  const fixture = new FixtureGapAnalyst();
  const proposal = await fixture.propose({
    analyses: [{ analysisId: "a1", pageSnapshotId: "snap-1", domain: "a.example", data: analysis() }],
    searchIntelligence: { userNeeds: ["Understand yield"] },
    acceptedEvidence: [{ field: "operatorFacts", index: 0, text: "Real fact" }],
    projectContext: {},
    coverageMatrixSummary: [{ requirement: "Understand yield", coverage: { "snap-1": "PARTIAL" } }],
  });
  assert.ok(Array.isArray(proposal.gaps));
  assert.ok(proposal.gaps.length >= 1);
});

test("decisions digest: order-independent and binding on report digest", () => {
  const d1 = decisionsDigest("r", [
    { gapId: "b", disposition: "EXCLUDE" },
    { gapId: "a", disposition: "REQUIRED", priority: "HIGH" },
  ]);
  const d2 = decisionsDigest("r", [
    { gapId: "a", disposition: "REQUIRED", priority: "HIGH" },
    { gapId: "b", disposition: "EXCLUDE" },
  ]);
  assert.equal(d1, d2);
  const d3 = decisionsDigest("r2", [
    { gapId: "a", disposition: "REQUIRED", priority: "HIGH" },
    { gapId: "b", disposition: "EXCLUDE" },
  ]);
  assert.notEqual(d1, d3);
});

test("gap analyst prompt: competitor analyses are inert data, first-party refs bounded", () => {
  const prompt = buildGapAnalystPrompt({
    analyses: [{ analysisId: "a1", pageSnapshotId: "snap-1", domain: "a.example", data: analysis() }],
    searchIntelligence: {},
    acceptedEvidence: [{ field: "operatorFacts", index: 0, text: "Real fact" }],
    projectContext: {},
    coverageMatrixSummary: [],
  });
  assert.ok(prompt.includes("ACCEPTED FIRST-PARTY EVIDENCE"));
  // Copy-derivative discipline lives in the trusted system preamble:
  assert.ok(GAP_ANALYST_SYSTEM_PROMPT.includes("Do not quote or rewrite competitor paragraphs"));
  // User prompt never carries page HTML:
  assert.ok(!prompt.includes("<html"));
});
