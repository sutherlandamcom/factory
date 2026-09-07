import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  type CompetitorsWorkspaceReadModel,
  type CompetitorRunReadModel,
  type ContentGapsWorkspaceReadModel,
  type ContentGapReportDetail,
  type AcceptedGapDetail,
} from "../src/api/client";

/**
 * Competitors/Content-Gaps UI↔contract shape audit (Macro Run 3).
 *
 * Pins the EXACT read-model field shapes the Competitors and Content Gaps
 * UI consumes against canonical payloads, so backend contract drift that
 * drops/renames a UI-consumed field fails here (PR #18 defect class).
 * Also pins the exact endpoint paths the UI produces and forbids any
 * secret/provider-plumbing field on the read-models.
 */

const COMPETITORS_WS: CompetitorsWorkspaceReadModel = {
  acceptedInput: { snapshotId: "in-1", version: 1, digest: "d".repeat(64) },
  readiness: { canRun: true, blockers: [], mode: "fixture" },
  serpRuns: [
    { serpSnapshotId: "serp-1", query: "investissement immobilier chamonix", observedAt: "2026-09-06T10:00:00.000Z", hasIntelligence: true },
  ],
  recentRuns: [{ id: "run-1", status: "succeeded", startedAt: "2026-09-06T10:00:00.000Z", errorCode: null }],
};

const COMPETITOR_RUN: CompetitorRunReadModel = {
  run: {
    id: "run-1",
    status: "succeeded",
    serpSnapshotId: "serp-1",
    pipelineVersion: "competitor-pipeline-v1",
    startedAt: "2026-09-06T10:00:00.000Z",
    finishedAt: "2026-09-06T10:01:00.000Z",
    errorCode: null,
    errorMessage: null,
  },
  acceptedInput: { snapshotId: "in-1", version: 1, digest: "d".repeat(64), stale: false },
  candidates: [
    {
      pageSnapshotId: "snap-1",
      serpPosition: 1,
      requestedUrl: "https://guide-a.example/chamonix",
      domain: "guide-a.example",
      classification: "INCLUDE",
      classificationReason: "Organic result plausibly competing for this query intent.",
      acquisitionStatus: "SUCCESS",
      httpStatus: 200,
      observedAt: "2026-09-06T10:00:30.000Z",
      analyzed: true,
      dedupedFromSnapshotId: null,
      pageType: "editorial_guide",
      topics: ["chalet pricing"],
      questions: ["What does a chalet cost?"],
      freshness: "No update signal observed.",
      commercialPositioning: "Neutral editorial positioning (fixture).",
      evidenceSegmentCount: 3,
    },
    {
      pageSnapshotId: "snap-2",
      serpPosition: 2,
      requestedUrl: "https://blocked.example/x",
      domain: "blocked.example",
      classification: "INCLUDE",
      classificationReason: "Organic result plausibly competing for this query intent.",
      acquisitionStatus: "BLOCKED",
      httpStatus: 403,
      observedAt: "2026-09-06T10:00:30.000Z",
      analyzed: false,
      dedupedFromSnapshotId: null,
      pageType: null,
      topics: [],
      questions: [],
      freshness: null,
      commercialPositioning: null,
      evidenceSegmentCount: 0,
    },
  ],
  usage: { competitorPagesFetched: 2, analyzedCount: 1, blockedCount: 1, failedCount: 0 },
};

const GAPS_WS: ContentGapsWorkspaceReadModel = {
  reports: [
    {
      id: "report-1",
      snapshotDigest: "r".repeat(64),
      reviewState: "model_proposed",
      createdAt: "2026-09-06T10:05:00.000Z",
      gapCounts: { total: 2, required: 1, optional: 1, excluded: 0 },
      serpSnapshotId: "serp-1",
      stale: false,
      staleReasons: [],
    },
  ],
  accepted: [
    {
      id: "acc-1",
      version: 1,
      snapshotDigest: "a".repeat(64),
      acceptedAt: "2026-09-06T10:10:00.000Z",
      reportId: "report-1",
      stale: false,
      staleReasons: [],
      gapCounts: { total: 2, required: 1, optional: 1, excluded: 0 },
    },
  ],
  readiness: { canPropose: true, blockers: [] },
};

const REPORT_DETAIL: ContentGapReportDetail = {
  report: {
    id: "report-1",
    snapshotDigest: "r".repeat(64),
    reviewState: "operator_reviewed",
    reviewRevision: 1,
    decisionsDigest: "d".repeat(64),
    createdAt: "2026-09-06T10:05:00.000Z",
    model: "fixture-gap-analyst",
    provider: "fixture",
    data: {
      coverageMatrix: {
        policyVersion: "coverage-matrix-v1",
        rows: [
          {
            requirementId: "req-yield",
            requirement: "Understand expected rental yield",
            cells: [{ pageSnapshotId: "snap-1", domain: "guide-a.example", level: "PARTIAL" }],
          },
        ],
      },
      gaps: [
        {
          id: "gap-001",
          coverageRequirementId: "req-yield",
          userNeed: "Understand expected rental yield",
          topicQuestion: "What rental yield can investors expect?",
          competitorCoverage: "PARTIAL",
          competitorsCoveringIt: ["snap-1"],
          treatmentPattern: "Generic national averages only",
          baselineExpectation: "Provide yield ranges with assumptions",
          ourEvidenceAvailable: [{ intakeField: "operatorFacts", itemIndex: 0, excerpt: "Operator operates in Chamonix" }],
          ourEvidenceMissing: ["Actual operator yield data"],
          claimConstraints: ["No specific yields without first-party data"],
          differentiationOpportunity: "Evidence-first treatment",
          recommendedDisposition: "REQUIRED",
          priority: "HIGH",
          rationale: "Competitors cover partially; our evidence missing.",
          evidenceRefs: [{ pageSnapshotId: "snap-1", segmentId: "seg-001" }],
        },
      ],
      differentiationRequirements: {
        items: [{ requirement: "First-party market evidence", basis: "accepted_evidence", rationale: "Operator evidence exists." }],
      },
      searchSemantics: {
        intelligenceSnapshotId: "intel-1",
        intelligenceSnapshotDigest: "i".repeat(64),
        primaryIntent: "commercial_investigation",
        semanticCoverageRequirements: ["Understand expected rental yield"],
        userNeeds: ["Understand expected rental yield"],
      },
    },
  },
  decisions: [
    { gapId: "gap-001", disposition: "REQUIRED", priority: "HIGH", note: "agree" },
  ],
  stale: false,
  staleReasons: [],
};

const ACCEPTED_DETAIL: AcceptedGapDetail = {
  snapshot: {
    id: "acc-1",
    version: 1,
    snapshotDigest: "a".repeat(64),
    acceptedAt: "2026-09-06T10:10:00.000Z",
    reportId: "report-1",
    reportDigest: "r".repeat(64),
    decisionsDigest: "d".repeat(64),
    data: {
      ...REPORT_DETAIL.report.data,
      gaps: [
        {
          ...REPORT_DETAIL.report.data.gaps[0]!,
          disposition: "REQUIRED",
          priority: "HIGH",
          note: "agree",
          recommendedDisposition: "REQUIRED",
          recommendedPriority: "HIGH",
        },
      ],
      decisions: [
        { gapId: "gap-001", disposition: "REQUIRED", priority: "HIGH", note: "agree" },
      ],
    },
  },
  stale: false,
  staleReasons: [],
};

function assertFieldsPresent(obj: unknown, fields: Array<[string, unknown]>, label: string): void {
  assert.ok(typeof obj === "object" && obj !== null, `${label} must be an object`);
  for (const [path, value] of fields) {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const part of parts) {
      assert.ok(
        typeof cur === "object" && cur !== null && part in (cur as Record<string, unknown>),
        `${label} missing field ${path}`,
      );
      cur = (cur as Record<string, unknown>)[part];
    }
    assert.deepEqual(cur, value, `${label} field ${path} drifted`);
  }
}

test("competitors workspace read-model pins every UI-consumed field", () => {
  assertFieldsPresent(COMPETITORS_WS, [
    ["acceptedInput.snapshotId", "in-1"],
    ["readiness.canRun", true],
    ["readiness.mode", "fixture"],
    ["serpRuns.0.serpSnapshotId", "serp-1"],
    ["serpRuns.0.hasIntelligence", true],
    ["recentRuns.0.status", "succeeded"],
  ], "competitors workspace");
});

test("competitor run read-model pins candidate fields consumed by the table", () => {
  assertFieldsPresent(COMPETITOR_RUN, [
    ["run.status", "succeeded"],
    ["acceptedInput.stale", false],
    ["candidates.0.serpPosition", 1],
    ["candidates.0.domain", "guide-a.example"],
    ["candidates.0.classification", "INCLUDE"],
    ["candidates.0.acquisitionStatus", "SUCCESS"],
    ["candidates.0.observedAt", "2026-09-06T10:00:30.000Z"],
    ["candidates.0.analyzed", true],
    ["candidates.0.pageType", "editorial_guide"],
    ["candidates.1.acquisitionStatus", "BLOCKED"],
    ["candidates.1.dedupedFromSnapshotId", null],
    ["usage.competitorPagesFetched", 2],
    ["usage.analyzedCount", 1],
    ["usage.blockedCount", 1],
  ], "competitor run");
});

test("gap report detail pins fields consumed by review UI", () => {
  assertFieldsPresent(REPORT_DETAIL, [
    ["report.snapshotDigest", "r".repeat(64)],
    ["report.reviewState", "operator_reviewed"],
    ["report.reviewRevision", 1],
    ["report.decisionsDigest", "d".repeat(64)],
    ["report.data.coverageMatrix.rows.0.requirement", "Understand expected rental yield"],
    ["report.data.coverageMatrix.rows.0.cells.0.level", "PARTIAL"],
    ["report.data.gaps.0.userNeed", "Understand expected rental yield"],
    ["report.data.gaps.0.competitorCoverage", "PARTIAL"],
    ["report.data.gaps.0.ourEvidenceAvailable.0.intakeField", "operatorFacts"],
    ["report.data.gaps.0.ourEvidenceMissing.0", "Actual operator yield data"],
    ["report.data.gaps.0.claimConstraints.0", "No specific yields without first-party data"],
    ["report.data.gaps.0.differentiationOpportunity", "Evidence-first treatment"],
    ["report.data.gaps.0.recommendedDisposition", "REQUIRED"],
    ["report.data.gaps.0.evidenceRefs.0.segmentId", "seg-001"],
    ["report.data.differentiationRequirements.items.0.basis", "accepted_evidence"],
    ["decisions.0.disposition", "REQUIRED"],
    ["stale", false],
  ], "gap report detail");
});

test("accepted gap detail pins immutability + staleness fields", () => {
  assertFieldsPresent(ACCEPTED_DETAIL, [
    ["snapshot.version", 1],
    ["snapshot.reportDigest", "r".repeat(64)],
    ["snapshot.decisionsDigest", "d".repeat(64)],
    ["snapshot.data.gaps.0.id", "gap-001"],
    ["snapshot.data.gaps.0.disposition", "REQUIRED"],
    ["snapshot.data.gaps.0.priority", "HIGH"],
    ["snapshot.data.gaps.0.note", "agree"],
    ["stale", false],
  ], "accepted gap detail");
});

test("UI produces exactly the semantic competitor/gap endpoints", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  try {
    void api.getCompetitorsWorkspace("p1");
    void api.runCompetitors("p1", { serpSnapshotId: "serp-1" });
    void api.getCompetitorRun("p1", "r1");
    void api.setCandidateClassification("p1", "snap-1", { classification: "EXCLUDE", reason: "not relevant" });
    void api.getContentGapsWorkspace("p1");
    void api.proposeContentGaps("p1");
    void api.getContentGapReport("p1", "report-1");
    void api.saveGapDecisions("p1", "report-1", {
      expectedReviewRevision: 0,
      decisions: [{ gapId: "gap-001", disposition: "REQUIRED" }],
    });
    void api.acceptContentGaps("p1", "report-1", {
      expectedReportDigest: "r".repeat(64),
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "d".repeat(64),
    });
    void api.getAcceptedGapDetail("p1", 1);
    await new Promise((r) => setTimeout(r, 10));
    const paths = calls.map((c) => c.path);
    for (const expected of [
      "/api/projects/p1/competitors/workspace",
      "/api/projects/p1/competitors/runs",
      "/api/projects/p1/competitors/runs/r1",
      "/api/projects/p1/competitors/candidates/snap-1/classification",
      "/api/projects/p1/content-gaps/workspace",
      "/api/projects/p1/content-gaps/proposals",
      "/api/projects/p1/content-gaps/reports/report-1",
      "/api/projects/p1/content-gaps/reports/report-1/decisions",
      "/api/projects/p1/content-gaps/reports/report-1/accept",
      "/api/projects/p1/content-gaps/accepted/1/detail",
    ]) {
      assert.ok(paths.includes(expected), `missing endpoint: ${expected}`);
    }
    const saveCall = calls.find((c) => c.path === "/api/projects/p1/content-gaps/reports/report-1/decisions");
    assert.ok(saveCall?.init?.body);
    const saveBody = JSON.parse(String(saveCall.init.body));
    assert.equal(saveBody.expectedReviewRevision, 0);
    assert.equal(saveBody.decisions[0].gapId, "gap-001");

    const acceptCall = calls.find((c) => c.path === "/api/projects/p1/content-gaps/reports/report-1/accept");
    assert.ok(acceptCall?.init?.body);
    const acceptBody = JSON.parse(String(acceptCall.init.body));
    assert.equal(acceptBody.expectedReportDigest, "r".repeat(64));
    assert.equal(acceptBody.expectedReviewRevision, 1);
    assert.equal(acceptBody.expectedDecisionsDigest, "d".repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no secret/config/provider fields exist anywhere on the competitor read-models", () => {
  const flat = JSON.stringify({ COMPETITORS_WS, COMPETITOR_RUN, GAPS_WS, REPORT_DETAIL, ACCEPTED_DETAIL });
  for (const forbidden of ["apiKey", "api_key", "password", "secret", "credential", "tokenValue", "fetchUrl", "provider_", "systemPrompt"]) {
    assert.ok(!flat.toLowerCase().includes(forbidden.toLowerCase()), `forbidden field: ${forbidden}`);
  }
});
