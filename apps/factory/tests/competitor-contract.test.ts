import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCompetitorPageSnapshotData,
  parseCompetitorPageAnalysisData,
  parseContentGapReportData,
  parseContentGapDecisionsData,
  competitorPageSnapshotDataSchema,
  contentGapReportDataSchema,
  OPERATOR_ERROR_CODES,
  COMPETITOR_ERROR_CODES,
} from "@factory/contracts";

/**
 * Competitor + Content Gap contract tests (Macro Run 3 v0).
 * Strict schemas: unknown fields fail closed; evidence segment refs must
 * resolve; no fabricated numeric scores exist anywhere in the contract.
 */

function validPageSnapshotData() {
  return {
    requestedUrl: "https://example.com/guide",
    finalUrl: "https://example.com/guide",
    domain: "example.com",
    httpStatus: 200,
    contentType: "text/html; charset=utf-8",
    observedAt: "2026-09-06T10:00:00.000Z",
    rawDigest: "a".repeat(64),
    extractionDigest: "b".repeat(64),
    extracted: {
      pageTitle: "Guide",
      headings: [
        { id: "seg-001", kind: "heading", text: "Pricing", level: 2 },
      ],
      segments: [
        { id: "seg-001", kind: "heading", text: "Pricing", level: 2 },
        { id: "seg-002", kind: "paragraph", text: "Prices start at 100 EUR." },
      ],
      questions: ["How much does it cost?"],
      jsonLdTypes: ["Article"],
      hasFaqSchema: false,
      outboundLinks: [{ url: "https://source.example.com/data", text: "Source" }],
      publicationDate: "2025-01-15",
      ctaSignals: ["Contact us"],
      wordCount: 1200,
      extractionVersion: "extract-v1",
    },
    provider: "direct_http",
    acquisitionMethodVersion: "direct-http-v1",
  };
}

function validAnalysisData() {
  return {
    pageType: "editorial_guide",
    primaryIntent: "informational",
    topics: ["chalet pricing"],
    subtopics: ["seasonal variation"],
    entities: ["Chamonix"],
    questionsAnswered: ["How much does it cost?"],
    questionsUnanswered: [],
    coverageAreas: [
      { area: "Pricing", level: "STRONG", rationale: "Dedicated section with numbers." },
    ],
    dataFactsUsed: ["Prices start at 100 EUR."],
    sourceSignals: ["Cites mountain statistics office"],
    trustSignals: [],
    experienceSignals: [],
    commercialPositioning: "Neutral editorial",
    ctaTreatment: "Weak newsletter CTA only",
    freshnessAssessment: "Published 2025-01, no update signal",
    strengths: ["Clear pricing table"],
    weaknesses: ["No risk discussion"],
    uniqueTreatment: ["Seasonal price chart"],
    missingTreatment: ["Tax implications"],
    evidenceSegmentRefs: [
      { pageSnapshotId: "snap-1", segmentId: "seg-001" },
      { pageSnapshotId: "snap-1", segmentId: "seg-002" },
    ],
    confidence: 0.7,
  };
}

test("competitor page snapshot contract accepts a valid snapshot", () => {
  const parsed = parseCompetitorPageSnapshotData(validPageSnapshotData());
  assert.equal(parsed.domain, "example.com");
  assert.equal(parsed.provider, "direct_http");
});

test("competitor page snapshot contract rejects unknown fields and bad URLs", () => {
  assert.throws(() =>
    competitorPageSnapshotDataSchema.parse({
      ...validPageSnapshotData(),
      unexpected: true,
    }),
  );
  assert.throws(() =>
    competitorPageSnapshotDataSchema.parse({
      ...validPageSnapshotData(),
      requestedUrl: "ftp://example.com/x",
    }),
  );
  assert.throws(() =>
    competitorPageSnapshotDataSchema.parse({
      ...validPageSnapshotData(),
      requestedUrl: "https://user:pass@example.com/x",
    }),
  );
});

test("segment ids must be stable seg-NNN and unknown refs fail closed", () => {
  const bad = validAnalysisData();
  bad.evidenceSegmentRefs = [{ pageSnapshotId: "snap-1", segmentId: "evidence-7" }];
  assert.throws(() => parseCompetitorPageAnalysisData(bad));

  const unknown = validAnalysisData();
  assert.throws(() =>
    parseCompetitorPageAnalysisData(unknown, new Set(["seg-009"])),
  );
  const ok = parseCompetitorPageAnalysisData(unknown, new Set(["seg-001", "seg-002"]));
  assert.equal(ok.evidenceSegmentRefs.length, 2);
});

test("analysis without any evidence ref fails closed", () => {
  const noRefs = validAnalysisData();
  noRefs.evidenceSegmentRefs = [];
  assert.throws(() => parseCompetitorPageAnalysisData(noRefs));
});

test("coverage levels are categorical; numeric fake scores are impossible", () => {
  const bad = validAnalysisData();
  bad.coverageAreas = [{ area: "Pricing", level: "STRONG", rationale: "x" }];
  (bad as Record<string, unknown>).seoScore = 92;
  assert.throws(() => parseCompetitorPageAnalysisData(bad));
});

function validReportData() {
  return {
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "c".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "d".repeat(64),
    pageSnapshotRefs: [{ id: "snap-1", digest: "e".repeat(64) }],
    analysisRefs: [{ id: "analysis-1", digest: "f".repeat(64) }],
    acceptedInputSnapshotId: "input-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "0".repeat(64),
    coverageMatrix: {
      policyVersion: "coverage-matrix-v1",
      rows: [
        {
          requirement: "Expected rental yield",
          cells: [
            { pageSnapshotId: "snap-1", domain: "example.com", level: "PARTIAL" },
          ],
        },
      ],
    },
    gaps: [
      {
        id: "gap-001",
        userNeed: "Understand expected rental yield",
        topicQuestion: "What rental yield can investors expect?",
        searchEvidenceRefs: [
          { kind: "serp_snapshot", id: "serp-1", digest: "c".repeat(64) },
        ],
        competitorCoverage: "PARTIAL",
        competitorsCoveringIt: ["snap-1"],
        treatmentPattern: "Generic national averages only",
        baselineExpectation: "Provide yield ranges with assumptions",
        ourEvidenceAvailable: [],
        ourEvidenceMissing: ["Actual operator yield data"],
        claimConstraints: ["Cannot claim specific yields without first-party data"],
        differentiationOpportunity: "Honest evidence-first treatment",
        recommendedDisposition: "OPTIONAL",
        priority: "MEDIUM",
        rationale: "Competitors cover partially; our evidence missing.",
        evidenceRefs: [{ pageSnapshotId: "snap-1", segmentId: "seg-001" }],
      },
    ],
    differentiationRequirements: {
      items: [
        {
          requirement: "First-party market evidence",
          basis: "accepted_evidence",
          rationale: "Operator operates in the market.",
        },
      ],
    },
    model: "fixture-gap-analyst",
    provider: "fixture",
    promptVersion: "gap-analyst-v1",
    reviewState: "model_proposed",
  };
}

test("content gap report contract accepts a valid report and binds provenance", () => {
  const parsed = parseContentGapReportData(validReportData());
  assert.equal(parsed.gaps.length, 1);
  assert.equal(parsed.coverageMatrix.rows[0]!.cells[0]!.level, "PARTIAL");
});

test("content gap report rejects unknown disposition/priority values", () => {
  const bad = validReportData();
  bad.gaps[0]!.recommendedDisposition = "MAYBE" as never;
  assert.throws(() => parseContentGapReportData(bad));
});

test("decisions reject duplicates and constrain dispositions", () => {
  const valid = parseContentGapDecisionsData({
    reportId: "report-1",
    reportDigest: "a".repeat(64),
    decisions: [
      { gapId: "gap-001", disposition: "REQUIRED", priority: "HIGH", note: "must have" },
      { gapId: "gap-002", disposition: "EXCLUDE" },
    ],
  });
  assert.equal(valid.decisions.length, 2);

  assert.throws(() =>
    parseContentGapDecisionsData({
      reportId: "report-1",
      reportDigest: "a".repeat(64),
      decisions: [
        { gapId: "gap-001", disposition: "REQUIRED" },
        { gapId: "gap-001", disposition: "EXCLUDE" },
      ],
    }),
  );
  assert.throws(() =>
    parseContentGapDecisionsData({
      reportId: "report-1",
      reportDigest: "a".repeat(64),
      decisions: [{ gapId: "gap-001", disposition: "SOMETIMES" }],
    }),
  );
});

test("competitor error codes are inside the closed operator error union", () => {
  for (const code of COMPETITOR_ERROR_CODES) {
    assert.ok(
      (OPERATOR_ERROR_CODES as readonly string[]).includes(code),
      `${code} missing from OPERATOR_ERROR_CODES`,
    );
  }
});
