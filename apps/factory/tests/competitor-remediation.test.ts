import test from "node:test";
import assert from "node:assert/strict";
import {
  validateContentGapGrounding,
  collectFirstPartyEvidence,
  validateGapFirstPartyRefs,
  decisionsDigest,
  type GapGroundingContext,
} from "../src/competitors/gap-engine.js";
import {
  CompetitorContentGapService,
  RESERVED_PAGE_ANALYSIS_COST_MICROS,
  RESERVED_GAP_ANALYSIS_COST_MICROS,
} from "../src/competitors/service.js";
import { CompetitorStore } from "../src/competitors/competitor-store.js";
import { SearchIntelligenceService } from "../src/search/service.js";
import { OpenRouterGapAnalyst } from "../src/competitors/gap-analyst.js";
import { OpenRouterSearchAnalyst } from "../src/search/analyst.js";
import type { ContentGap } from "@factory/contracts";
import { FactoryError } from "../src/executor/errors.js";
import { deterministicDigest } from "../src/intelligence/digest.js";

function createValidGap(overrides: Partial<ContentGap> = {}): ContentGap {
  return {
    id: "gap-001",
    userNeed: "Understand rental yield calculation",
    topicQuestion: "What rental yield can investors expect?",
    searchEvidenceRefs: [
      { kind: "serp_snapshot", id: "serp-1", digest: "s".repeat(64) },
      { kind: "search_intelligence_snapshot", id: "intel-1", digest: "i".repeat(64) },
    ],
    competitorCoverage: "PARTIAL",
    competitorsCoveringIt: ["page-1"],
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
    evidenceRefs: [
      { pageSnapshotId: "page-1", segmentId: "seg-101" },
    ],
    ...overrides,
  };
}

function createGroundingContext(overrides: Partial<GapGroundingContext> = {}): GapGroundingContext {
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
      {
        id: "page-2",
        digest: "p2".repeat(32),
        classification: "REFERENCE_ONLY",
        validSegmentIds: new Set(["seg-201"]),
      },
    ],
    analyses: [
      {
        id: "analysis-1",
        digest: "a1".repeat(32),
        pageSnapshotId: "page-1",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Defect F: Evidence Grounding Validation Tests
// ---------------------------------------------------------------------------

test("grounding: valid gap passes validation smoothly", () => {
  const gap = createValidGap();
  const ctx = createGroundingContext();
  assert.doesNotThrow(() => validateContentGapGrounding([gap], ctx));
});

test("grounding: empty searchEvidenceRefs fails closed", () => {
  const gap = createValidGap({ searchEvidenceRefs: [] });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /requires searchEvidenceRefs/i.test(err.message),
  );
});

test("grounding: foreign or mismatched SERP snapshot ref fails closed", () => {
  const gap = createValidGap({
    searchEvidenceRefs: [
      { kind: "serp_snapshot", id: "wrong-serp", digest: "s".repeat(64) },
    ],
  });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /invalid or foreign SERP snapshot/i.test(err.message),
  );

  const gapDigestMismatch = createValidGap({
    searchEvidenceRefs: [
      { kind: "serp_snapshot", id: "serp-1", digest: "wrong-digest".padEnd(64, "0") },
    ],
  });
  assert.throws(
    () => validateContentGapGrounding([gapDigestMismatch], ctx),
    (err: unknown) => err instanceof FactoryError && /invalid or foreign SERP snapshot/i.test(err.message),
  );
});

test("grounding: foreign or mismatched search intelligence snapshot ref fails closed", () => {
  const gap = createValidGap({
    searchEvidenceRefs: [
      { kind: "search_intelligence_snapshot", id: "intel-1", digest: "wrong-digest".padEnd(64, "0") },
    ],
  });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /invalid or foreign search intelligence snapshot/i.test(err.message),
  );
});

test("grounding: competitorsCoveringIt referencing unknown page fails closed", () => {
  const gap = createValidGap({ competitorsCoveringIt: ["page-nonexistent"] });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /unknown competitor page/i.test(err.message),
  );
});

test("grounding: competitorsCoveringIt referencing non-INCLUDE page fails closed", () => {
  const gap = createValidGap({ competitorsCoveringIt: ["page-2"] }); // page-2 is REFERENCE_ONLY
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /only INCLUDE pages may represent competitive coverage/i.test(err.message),
  );
});

test("grounding: competitorsCoveringIt referencing unanalyzed page fails closed", () => {
  const ctx = createGroundingContext({
    pageSnapshots: [
      { id: "page-1", digest: "p1".repeat(32), classification: "INCLUDE" },
      { id: "page-unanalyzed", digest: "p3".repeat(32), classification: "INCLUDE" },
    ],
    analyses: [{ id: "analysis-1", digest: "a1".repeat(32), pageSnapshotId: "page-1" }],
  });
  const gap = createValidGap({ competitorsCoveringIt: ["page-unanalyzed"] });
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /was not analyzed in this run/i.test(err.message),
  );
});

test("grounding: evidenceRefs referencing unknown page snapshot fails closed", () => {
  const gap = createValidGap({
    evidenceRefs: [{ pageSnapshotId: "unknown-page", segmentId: "seg-101" }],
  });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /unknown page snapshot/i.test(err.message),
  );
});

test("grounding: evidenceRefs referencing unknown segment ID fails closed", () => {
  const gap = createValidGap({
    evidenceRefs: [{ pageSnapshotId: "page-1", segmentId: "nonexistent-seg" }],
  });
  const ctx = createGroundingContext();
  assert.throws(
    () => validateContentGapGrounding([gap], ctx),
    (err: unknown) => err instanceof FactoryError && /unknown segment/i.test(err.message),
  );
});

test("grounding: first-party evidence separation rejects smuggled competitor claims or out-of-bound indices", () => {
  const evidence = collectFirstPartyEvidence({
    evidence: {
      operatorFacts: ["Operator operates since 2019 in Chamonix"],
      allowedClaims: ["Certified mountain guide"],
    },
  });

  const gapBadIndex = createValidGap({
    ourEvidenceAvailable: [{ intakeField: "operatorFacts", itemIndex: 5, excerpt: "Foo" }],
  });
  assert.throws(
    () => validateGapFirstPartyRefs([gapBadIndex], evidence),
    /does not exist in accepted inputs/,
  );

  const gapMisquote = createValidGap({
    ourEvidenceAvailable: [
      { intakeField: "operatorFacts", itemIndex: 0, excerpt: "Competitors claim 12% yield" },
    ],
  });
  assert.throws(
    () => validateGapFirstPartyRefs([gapMisquote], evidence),
    /misquotes first-party evidence/,
  );
});

// ---------------------------------------------------------------------------
// Defect C: Centralized Upstream Staleness Evaluation Tests
// ---------------------------------------------------------------------------

function createMockServiceWithDeps(overrides: {
  listSnapshots?: () => Promise<unknown[]>;
  getSerpSnapshot?: () => Promise<unknown>;
  getLatestSerpForQuery?: () => Promise<unknown>;
  getLatestSerpForSearchIdentity?: () => Promise<unknown>;
  getIntelligenceSnapshot?: () => Promise<unknown>;
  getLatestIntelligenceForQuery?: () => Promise<unknown>;
  getLatestIntelligenceForSearchIdentity?: () => Promise<unknown>;
  getLatestPageSnapshotForUrl?: () => Promise<unknown>;
  latestSucceededRunForSerp?: () => Promise<unknown>;
  pageSnapshotsByIds?: () => Promise<unknown[]>;
  analysesByIds?: () => Promise<unknown[]>;
}) {
  const deps = {
    intake: {
      listSnapshots: overrides.listSnapshots ?? (async () => [
        { id: "in-1", version: 1, digest: "d1" },
      ]),
    },
    competitorStore: {
      getSerpSnapshot: overrides.getSerpSnapshot ?? (async () => ({
        id: "serp-1",
        snapshotDigest: "s1",
        query: "chamonix property",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01T10:00:00Z"),
      })),
      getLatestSerpForSearchIdentity:
        overrides.getLatestSerpForSearchIdentity ??
        overrides.getLatestSerpForQuery ??
        (async () => ({
          id: "serp-1",
          snapshotDigest: "s1",
          query: "chamonix property",
          location: null,
          language: null,
          device: "desktop",
          observedAt: new Date("2026-09-01T10:00:00Z"),
        })),
      getIntelligenceSnapshot: overrides.getIntelligenceSnapshot ?? (async () => ({
        id: "intel-1",
        snapshotDigest: "i1",
        createdAt: new Date("2026-09-01T10:05:00Z"),
      })),
      getLatestIntelligenceForSearchIdentity:
        overrides.getLatestIntelligenceForSearchIdentity ??
        overrides.getLatestIntelligenceForQuery ??
        (async () => ({
          id: "intel-1",
          snapshotDigest: "i1",
          createdAt: new Date("2026-09-01T10:05:00Z"),
        })),
      getLatestPageSnapshotForUrl: overrides.getLatestPageSnapshotForUrl ?? (async () => null),
      latestSucceededRunForSerp: overrides.latestSucceededRunForSerp ?? (async () => null),
      pageSnapshotsByIds: overrides.pageSnapshotsByIds ?? (async () => [
        {
          id: "page-1",
          snapshotDigest: "p1",
          requestedUrl: "https://example.com/p1",
          contentDigest: "cd1",
          observedAt: new Date("2026-09-01T10:00:00Z"),
        },
      ]),
      analysesByIds: overrides.analysesByIds ?? (async () => [
        { id: "analysis-1", snapshotDigest: "a1" },
      ]),
    },
    competitorAnalyst: {} as never,
    gapAnalyst: {} as never,
  };

  return new CompetitorContentGapService(deps as never);
}

const standardBound = {
  acceptedInputSnapshotId: "in-1",
  acceptedInputVersion: 1,
  acceptedInputDigest: "d1",
  serpSnapshotId: "serp-1",
  serpSnapshotDigest: "s1",
  intelligenceSnapshotId: "intel-1",
  intelligenceSnapshotDigest: "i1",
  pageSnapshotRefs: [{ id: "page-1", digest: "p1" }],
  analysisRefs: [{ id: "analysis-1", digest: "a1" }],
};

test("staleness: fresh dependencies report stale = false", async () => {
  const service = createMockServiceWithDeps({});
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, false);
  assert.equal(result.staleReasons.length, 0);
});

test("staleness: newer project inputs mark report stale", async () => {
  const service = createMockServiceWithDeps({
    listSnapshots: async () => [{ id: "in-2", version: 2, digest: "d2" }],
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /Accepted project inputs changed/i.test(r)));
});

test("staleness: missing bound SERP snapshot marks report stale", async () => {
  const service = createMockServiceWithDeps({
    getSerpSnapshot: async () => null,
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /SERP snapshot .* no longer exists/i.test(r)));
});

test("staleness: newer SERP for same query marks report stale", async () => {
  const service = createMockServiceWithDeps({
    getLatestSerpForQuery: async () => ({
      id: "serp-2",
      snapshotDigest: "s2",
      query: "chamonix property",
      observedAt: new Date("2026-09-06T10:00:00Z"), // Newer than 2026-09-01
    }),
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /newer SERP snapshot was observed/i.test(r)));
});

test("staleness: newer search intelligence for same query marks report stale", async () => {
  const service = createMockServiceWithDeps({
    getLatestIntelligenceForQuery: async () => ({
      id: "intel-2",
      snapshotDigest: "i2",
      createdAt: new Date("2026-09-06T12:00:00Z"), // Newer than 2026-09-01
    }),
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /newer search intelligence snapshot was created/i.test(r)));
});

test("staleness: competitor page snapshot digest change marks report stale", async () => {
  const service = createMockServiceWithDeps({
    pageSnapshotsByIds: async () => [{ id: "page-1", snapshotDigest: "different-p1" }],
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /page snapshot .* digest changed/i.test(r)));
});

test("staleness: competitor analysis digest change marks report stale", async () => {
  const service = createMockServiceWithDeps({
    analysesByIds: async () => [{ id: "analysis-1", snapshotDigest: "different-a1" }],
  });
  const result = await service.evaluateUpstreamStaleness("proj-1", standardBound);
  assert.equal(result.stale, true);
  assert.ok(result.staleReasons.some((r) => /competitor analysis .* digest changed/i.test(r)));
});

// ---------------------------------------------------------------------------
// Defect D: Fail-Closed Credential Checks
// ---------------------------------------------------------------------------

test("credentials: missing OpenRouter key fails closed for search intelligence analyst", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const analyst = new OpenRouterSearchAnalyst({
      callModel: async () => ({ text: "{}" }),
    });
    const service = new SearchIntelligenceService({
      intake: {
        listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1" }],
      } as never,
      searchStore: {
        sumTodaySearchCostMicros: async () => 0,
      } as never,
      productionSerpProvider: {} as never,
      analyst,
    });

    await assert.rejects(
      service.runSearch({ projectId: "proj-1", query: "test query", device: "desktop" }),
      (err: unknown) => err instanceof FactoryError && err.code === "search_analyst_not_configured",
    );
  } finally {
    if (originalKey !== undefined) {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  }
});

test("credentials: missing OpenRouter key fails closed for competitor gap analyst", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const gapAnalyst = new OpenRouterGapAnalyst({
      callModel: async () => ({ text: "{}" }),
    });
    const service = new CompetitorContentGapService({
      intake: {} as never,
      competitorStore: {} as never,
      competitorAnalyst: {} as never,
      gapAnalyst,
    });

    await assert.rejects(
      service.proposeGaps({ projectId: "proj-1", competitorRunId: "run-1" }),
      (err: unknown) => err instanceof FactoryError && err.code === "competitor_analyst_not_configured",
    );
  } finally {
    if (originalKey !== undefined) {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  }
});

// ---------------------------------------------------------------------------
// Defect A: Decisions Digest Determinism & Immutability
// ---------------------------------------------------------------------------

test("decisions digest: order independent canonical sorting", () => {
  const reportDigest = "r".repeat(64);
  const d1 = [
    { gapId: "gap-1", disposition: "REQUIRED", priority: "HIGH", note: "Note 1" },
    { gapId: "gap-2", disposition: "OPTIONAL", priority: "LOW", note: "Note 2" },
  ];
  const d2 = [
    { gapId: "gap-2", disposition: "OPTIONAL", priority: "LOW", note: "Note 2" },
    { gapId: "gap-1", disposition: "REQUIRED", priority: "HIGH", note: "Note 1" },
  ];

  assert.equal(decisionsDigest(reportDigest, d1), decisionsDigest(reportDigest, d2));

  // Modifying note or priority changes digest
  const dModified = [
    { gapId: "gap-1", disposition: "REQUIRED", priority: "MEDIUM", note: "Note 1" },
    { gapId: "gap-2", disposition: "OPTIONAL", priority: "LOW", note: "Note 2" },
  ];
  assert.notEqual(decisionsDigest(reportDigest, d1), decisionsDigest(reportDigest, dModified));
});

// ---------------------------------------------------------------------------
// P1-1: Exact Upstream Lineage Tests (runCompetitors & proposeGaps)
// ---------------------------------------------------------------------------

test("lineage: runCompetitors fails closed when SERP was generated for older ProjectInput", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32), acceptedAt: new Date(), payload: {} },
        { id: "snap-2", version: 2, digest: "v2".repeat(32), acceptedAt: new Date(), payload: {} },
      ],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 0,
      getSerpSnapshot: async () => ({
        id: "serp-1",
        projectId: "proj-1",
        acceptedInputDigest: "v1".repeat(32), // From v1
        organic: [],
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "competitor_upstream_stale" &&
      err.message.includes("Selected SERP snapshot was generated for ProjectInput digest"),
  );
});

test("lineage: proposeGaps fails closed when CompetitorRun was generated for older ProjectInput", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32), acceptedAt: new Date(), payload: {} },
        { id: "snap-2", version: 2, digest: "v2".repeat(32), acceptedAt: new Date(), payload: {} },
      ],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 0,
      getRun: async () => ({
        id: "run-1",
        status: "succeeded",
        acceptedInputDigest: "v1".repeat(32), // From v1
        serpSnapshotId: "serp-1",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.proposeGaps({ projectId: "proj-1", competitorRunId: "run-1" }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_stale" &&
      err.message.includes("Competitor run was generated for ProjectInput digest"),
  );
});

// ---------------------------------------------------------------------------
// P1-2: Competitor Classification Overrides Downstream & in Read Models
// ---------------------------------------------------------------------------

test("classification overrides: proposeGaps excludes candidates overridden to EXCLUDE", async () => {
  let proposedAnalyses: unknown[] = [];
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32), acceptedAt: new Date(), payload: {} },
      ],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 0,
      getRun: async () => ({
        id: "run-1",
        status: "succeeded",
        acceptedInputDigest: "v1".repeat(32),
        serpSnapshotId: "serp-1",
        serpSnapshotDigest: "s".repeat(64),
      }),
      getSerpSnapshot: async () => ({
        id: "serp-1",
        acceptedInputDigest: "v1".repeat(32),
      }),
      listPageSnapshotsForRun: async () => [
        { id: "page-1", domain: "comp1.com", acquisitionStatus: "SUCCESS", classification: "INCLUDE", snapshotDigest: "p1".repeat(32) },
        { id: "page-2", domain: "comp2.com", acquisitionStatus: "SUCCESS", classification: "INCLUDE", snapshotDigest: "p2".repeat(32) },
      ],
      getLatestClassificationOverridesForPages: async () =>
        new Map([["page-2", { classification: "EXCLUDE", reason: "Irrelevant directory" }]]),
      listAnalysesForRun: async () => [
        { id: "a-1", pageSnapshotId: "page-1", snapshotDigest: "a1".repeat(32), data: { topics: [], questionsAnswered: [], coverageAreas: [] } },
        { id: "a-2", pageSnapshotId: "page-2", snapshotDigest: "a2".repeat(32), data: { topics: [], questionsAnswered: [], coverageAreas: [] } },
      ],
      getIntelligenceForSerpSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        data: {
          primaryIntent: "Intent",
          userNeeds: ["Need 1"],
          questions: ["Q1"],
          semanticCoverageRequirements: ["Req 1"],
          topics: ["Topic 1"],
        },
      }),
      insertGapReport: async (input: unknown) => ({ id: "report-1", snapshotDigest: "d".repeat(64), ...(input as object) }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: {
      provider: "fixture",
      propose: async (input: { analyses: unknown[] }) => {
        proposedAnalyses = input.analyses;
        return {
          model: "test",
          provider: "test",
          promptVersion: "1.0",
          gaps: [],
        };
      },
    } as never,
  });

  const res = await service.proposeGaps({ projectId: "proj-1", competitorRunId: "run-1" });
  assert.equal(res.reportId, "report-1");
  // page-2 was overridden to EXCLUDE, so only page-1 analysis was sent to gap analyst
  assert.equal(proposedAnalyses.length, 1);
  assert.equal((proposedAnalyses[0] as { pageSnapshotId: string }).pageSnapshotId, "page-1");
});

test("classification overrides: runReadModel candidates reflect operator overrides", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32), acceptedAt: new Date(), payload: {} },
      ],
    } as never,
    competitorStore: {
      getRun: async () => ({
        id: "run-1",
        status: "succeeded",
        serpSnapshotId: "serp-1",
        pipelineVersion: "1.0",
        startedAt: new Date(),
        finishedAt: new Date(),
        acceptedInputVersion: 1,
        acceptedInputDigest: "v1".repeat(32),
      }),
      listPageSnapshotsForRun: async () => [
        {
          id: "page-1",
          serpPosition: 1,
          requestedUrl: "https://comp1.com",
          domain: "comp1.com",
          classification: "INCLUDE",
          classificationReason: "Organic competitor",
          acquisitionStatus: "SUCCESS",
          httpStatus: 200,
          observedAt: new Date(),
        },
      ],
      getLatestClassificationOverridesForPages: async () =>
        new Map([["page-1", { classification: "REFERENCE_ONLY", reason: "Informational blog" }]]),
      listAnalysesForRun: async () => [],
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const model = await service.runReadModel("proj-1", "run-1");
  assert.equal(model.candidates[0]?.classification, "REFERENCE_ONLY");
  assert.ok(model.candidates[0]?.classificationReason.includes("Informational blog"));
});

// ---------------------------------------------------------------------------
// Search Identity & Competitor Refresh Staleness Tests
// ---------------------------------------------------------------------------

test("evaluateUpstreamStaleness: different device/market does not trigger false staleness", async () => {
  const boundSerp = {
    id: "serp-1",
    snapshotDigest: "s".repeat(64),
    query: "real estate investment",
    location: "France",
    language: "fr",
    device: "desktop",
    observedAt: new Date("2026-09-01T10:00:00Z"),
  };
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32) },
      ],
    } as never,
    competitorStore: {
      getSerpSnapshot: async () => boundSerp,
      // Same query but different market/device: returned latest for desktop France is unchanged
      getLatestSerpForSearchIdentity: async (_projId: string, id: { device: string; location: string | null }) => {
        if (id.device === "desktop" && id.location === "France") {
          return boundSerp;
        }
        return {
          ...boundSerp,
          id: "serp-2",
          location: "USA",
          device: "mobile",
          observedAt: new Date("2026-09-02T10:00:00Z"),
        };
      },
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({
        id: "intel-1",
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      pageSnapshotsByIds: async () => [],
      analysesByIds: async () => [],
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.evaluateUpstreamStaleness("proj-1", {
    acceptedInputSnapshotId: "snap-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "v1".repeat(32),
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "s".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "i".repeat(64),
    pageSnapshotRefs: [],
    analysisRefs: [],
  });

  assert.equal(res.stale, false);
});

test("evaluateUpstreamStaleness: competitor page content change triggers staleness", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32) },
      ],
    } as never,
    competitorStore: {
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "s".repeat(64),
        query: "investment property",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01T10:00:00Z"),
      }),
      getLatestSerpForSearchIdentity: async () => ({
        id: "serp-1",
        observedAt: new Date("2026-09-01T10:00:00Z"),
      }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({
        id: "intel-1",
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      pageSnapshotsByIds: async () => [
        {
          id: "page-1",
          snapshotDigest: "p1".repeat(32),
          requestedUrl: "https://comp1.com/pricing",
          contentDigest: "c1".repeat(32),
          observedAt: new Date("2026-09-01T10:00:00Z"),
        },
      ],
      // Newer observation of same URL has different contentDigest!
      getLatestPageSnapshotForUrl: async () => ({
        id: "page-new",
        requestedUrl: "https://comp1.com/pricing",
        contentDigest: "c2_different".padEnd(64, "0"),
        observedAt: new Date("2026-09-03T10:00:00Z"),
      }),
      analysesByIds: async () => [],
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.evaluateUpstreamStaleness("proj-1", {
    acceptedInputSnapshotId: "snap-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "v1".repeat(32),
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "s".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "i".repeat(64),
    pageSnapshotRefs: [{ id: "page-1", digest: "p1".repeat(32) }],
    analysisRefs: [],
  });

  assert.equal(res.stale, true);
  assert.ok(res.staleReasons.some((r) => r.includes("content changed")));
});

test("evaluateUpstreamStaleness: newer competitor run for SERP triggers staleness", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "snap-1", version: 1, digest: "v1".repeat(32) },
      ],
    } as never,
    competitorStore: {
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "s".repeat(64),
        query: "investment property",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01T10:00:00Z"),
      }),
      getLatestSerpForSearchIdentity: async () => ({
        id: "serp-1",
        observedAt: new Date("2026-09-01T10:00:00Z"),
      }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({
        id: "intel-1",
        createdAt: new Date("2026-09-01T10:05:00Z"),
      }),
      getRun: async () => ({
        id: "run-old",
        createdAt: new Date("2026-09-01T10:10:00Z"),
      }),
      latestSucceededRunForSerp: async () => ({
        id: "run-new",
        createdAt: new Date("2026-09-03T10:00:00Z"),
      }),
      pageSnapshotsByIds: async () => [],
      analysesByIds: async () => [],
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.evaluateUpstreamStaleness("proj-1", {
    acceptedInputSnapshotId: "snap-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "v1".repeat(32),
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "s".repeat(64),
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "i".repeat(64),
    pageSnapshotRefs: [],
    analysisRefs: [],
    competitorRunId: "run-old",
  });

  assert.equal(res.stale, true);
  assert.ok(res.staleReasons.some((r) => r.includes("newer competitor run was executed")));
});

// ---------------------------------------------------------------------------
// Idempotent Accept Digest Validation Test
// ---------------------------------------------------------------------------

test("acceptGapReport: rejects wrong expectedDigest even if already accepted", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "report-1",
        snapshotDigest: "correct-digest".padEnd(64, "0"),
      }),
      getAcceptedGapSnapshotByReportId: async () => ({
        id: "accepted-snap-1",
        version: 1,
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "report-1",
      expectedDigest: "wrong-digest".padEnd(64, "0"),
      expectedReviewRevision: 0,
      expectedDecisionsDigest: "decisions-digest-1".padEnd(64, "0"),
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_accept_failed" &&
      err.message.includes("Report digest mismatch"),
  );
});

// ---------------------------------------------------------------------------
// DNS Timeout Bounding Test
// ---------------------------------------------------------------------------

test("DNS timeout: validateUrlResolved aborts when signal fires", async () => {
  const { validateUrlResolved } = await import("../src/competitors/ssrf-guard.js");
  const controller = new AbortController();
  // Simulated hanging DNS lookup
  const hangingLookup = () => new Promise<never>(() => {});

  const validationPromise = validateUrlResolved("https://example.com/test", hangingLookup as never, controller.signal);
  // Trigger abort
  controller.abort();

  await assert.rejects(
    validationPromise,
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

// ---------------------------------------------------------------------------
// Defect A: Classification Lineage & Overrides Tests (A1–A5)
// ---------------------------------------------------------------------------

test("A1: evaluateUpstreamStaleness flags report stale when candidate classification override changes", async () => {
  const effectiveClassifications = [
    { pageSnapshotId: "page-1", classification: "INCLUDE" as const },
  ];
  const boundDigest = deterministicDigest(effectiveClassifications);

  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1" }],
    } as never,
    competitorStore: {
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "sd-1",
        query: "q",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01"),
      }),
      getLatestSerpForSearchIdentity: async () => ({ id: "serp-1", observedAt: new Date("2026-09-01") }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "id-1",
        createdAt: new Date("2026-09-01"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({ id: "intel-1", createdAt: new Date("2026-09-01") }),
      pageSnapshotsByIds: async (_p: string, ids: string[]) =>
        ids.map((id) => ({ id, snapshotDigest: "pd-" + id, classification: "INCLUDE" })),
      analysesByIds: async () => [],
      getLatestClassificationOverridesForPages: async () =>
        new Map([["page-1", { classification: "EXCLUDE", reason: "Operator excluded post-proposal" }]]),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.evaluateUpstreamStaleness("proj-1", {
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    pageSnapshotRefs: [],
    analysisRefs: [],
    classificationDigest: boundDigest,
    effectiveClassifications,
  });

  assert.equal(res.stale, true);
  assert.ok(res.staleReasons.some((r) => r.includes("Competitor candidate classification changed")));
});

test("A2: acceptGapReport rejects direct acceptance when classification override makes report stale", async () => {
  const effectiveClassifications = [
    { pageSnapshotId: "page-1", classification: "INCLUDE" as const },
  ];
  const boundDigest = deterministicDigest(effectiveClassifications);

  const reportData = {
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    acceptedInputSnapshotId: "in-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "d1",
    classificationDigest: boundDigest,
    effectiveClassifications,
    coverageMatrix: { policyVersion: "coverage-matrix-v1", rows: [] },
    gaps: [createValidGap({ id: "gap-1" })],
    differentiationRequirements: { items: [] },
    pageSnapshotRefs: [],
    analysisRefs: [],
  };

  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1" }],
    } as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewState: "operator_reviewed",
        reviewRevision: 1,
        decisionsDigest: "dec-digest-1",
        acceptedInputSnapshotId: "in-1",
        acceptedInputVersion: 1,
        acceptedInputDigest: "d1",
        serpSnapshotId: "serp-1",
        serpSnapshotDigest: "sd-1",
        intelligenceSnapshotId: "intel-1",
        intelligenceSnapshotDigest: "id-1",
        data: reportData,
      }),
      getAcceptedGapSnapshotByReportId: async () => null,
      listDecisions: async () => [{ gapId: "gap-1", disposition: "REQUIRED", priority: "HIGH", note: null }],
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "sd-1",
        query: "q",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01"),
      }),
      getLatestSerpForSearchIdentity: async () => ({ id: "serp-1", observedAt: new Date("2026-09-01") }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "id-1",
        createdAt: new Date("2026-09-01"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({ id: "intel-1", createdAt: new Date("2026-09-01") }),
      pageSnapshotsByIds: async (_p: string, ids: string[]) =>
        ids.map((id) => ({ id, snapshotDigest: "pd-" + id, classification: "INCLUDE" })),
      analysesByIds: async () => [],
      getLatestClassificationOverridesForPages: async () =>
        new Map([["page-1", { classification: "EXCLUDE", reason: "Operator excluded post-proposal" }]]),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "rd-1",
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "dec-digest-1",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_stale" &&
      err.message.includes("Competitor candidate classification changed"),
  );
});

test("A3: proposeGaps binds classificationDigest and changing overrides produces new digest", async () => {
  let insertedData: any = null;
  const buildMockService = (overrideClassification: "INCLUDE" | "EXCLUDE") =>
    new CompetitorContentGapService({
      intake: {
        listSnapshots: async () => [
          { id: "in-1", version: 1, digest: "d1", payload: { business: { name: "B" }, evidence: {} } },
        ],
      } as never,
      competitorStore: {
        sumTodayCompetitorCostMicros: async () => 0,
        latestSucceededRun: async () => ({
          id: "run-1",
          status: "succeeded",
          acceptedInputDigest: "d1",
          serpSnapshotId: "serp-1",
          serpSnapshotDigest: "s".repeat(64),
        }),
        getSerpSnapshot: async () => ({
          id: "serp-1",
          acceptedInputDigest: "d1",
        }),
        listPageSnapshotsForRun: async () => [
          {
            id: "p-1",
            domain: "guide.example",
            acquisitionStatus: "SUCCESS",
            classification: "INCLUDE",
            snapshotDigest: "pd-1",
            extracted: { segments: [{ id: "seg-101" }] },
          },
          {
            id: "p-2",
            domain: "other.example",
            acquisitionStatus: "SUCCESS",
            classification: "INCLUDE",
            snapshotDigest: "pd-2",
            extracted: { segments: [{ id: "seg-201" }] },
          },
        ],
        getLatestClassificationOverridesForPages: async () =>
          new Map([["p-2", { classification: overrideClassification, reason: "test" }]]),
        listAnalysesForRun: async () => [
          { id: "a-1", pageSnapshotId: "p-1", snapshotDigest: "ad-1", data: { topics: [], questions: [], coverageAreas: [] } },
          { id: "a-2", pageSnapshotId: "p-2", snapshotDigest: "ad-2", data: { topics: [], questions: [], coverageAreas: [] } },
        ],
        getIntelligenceForSerpSnapshot: async () => ({
          id: "intel-1",
          snapshotDigest: "i".repeat(64),
          data: { primaryIntent: "commercial", userNeeds: ["need1"], semanticCoverageRequirements: [], questions: [], topics: [] },
        }),
        insertGapReport: async (input: any) => {
          insertedData = input.data;
          return { id: "rep-new", snapshotDigest: "rep-d" } as never;
        },
      } as never,
      competitorAnalyst: { provider: "fixture" } as never,
      gapAnalyst: {
        provider: "fixture",
        propose: async () => ({
          model: "m",
          provider: "fixture",
          promptVersion: "v1",
          gaps: [createValidGap({ id: "gap-1", competitorsCoveringIt: ["p-1"], evidenceRefs: [{ pageSnapshotId: "p-1", segmentId: "seg-101" }], ourEvidenceAvailable: [] })],
          differentiationRequirements: { items: [] },
          usage: { costMicros: 1000 },
        }),
      } as never,
    });

  const service1 = buildMockService("INCLUDE");
  await service1.proposeGaps({ projectId: "proj-1" });
  assert.ok(insertedData.classificationDigest);
  assert.equal(insertedData.effectiveClassifications.length, 2);
  const digest1 = insertedData.classificationDigest;

  const service2 = buildMockService("EXCLUDE");
  await service2.proposeGaps({ projectId: "proj-1" });
  assert.ok(insertedData.classificationDigest);
  const digest2 = insertedData.classificationDigest;

  assert.notEqual(digest1, digest2, "classificationDigest must change when candidate classification override changes");
});

test("A4: evaluateUpstreamStaleness ignores classification overrides for unrelated pages", async () => {
  const effectiveClassifications = [
    { pageSnapshotId: "page-1", classification: "INCLUDE" as const },
  ];
  const boundDigest = deterministicDigest(effectiveClassifications);

  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1" }],
    } as never,
    competitorStore: {
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "sd-1",
        query: "q",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01"),
      }),
      getLatestSerpForSearchIdentity: async () => ({ id: "serp-1", observedAt: new Date("2026-09-01") }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "id-1",
        createdAt: new Date("2026-09-01"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({ id: "intel-1", createdAt: new Date("2026-09-01") }),
      pageSnapshotsByIds: async (_p: string, ids: string[]) =>
        ids.map((id) => ({ id, snapshotDigest: "pd-" + id, classification: "INCLUDE" })),
      analysesByIds: async () => [],
      getLatestClassificationOverridesForPages: async () => new Map(),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.evaluateUpstreamStaleness("proj-1", {
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    pageSnapshotRefs: [],
    analysisRefs: [],
    classificationDigest: boundDigest,
    effectiveClassifications,
  });

  assert.equal(res.stale, false);
});

test("A5: acceptGapReport preserves classification lineage into AcceptedContentGapSnapshot", async () => {
  const effectiveClassifications = [
    { pageSnapshotId: "p-1", classification: "INCLUDE" as const },
  ];
  const boundDigest = deterministicDigest(effectiveClassifications);

  const reportData = {
    model: "gap-model",
    provider: "fixture",
    promptVersion: "v1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    acceptedInputSnapshotId: "in-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "d1",
    classificationDigest: boundDigest,
    effectiveClassifications,
    coverageMatrix: { policyVersion: "coverage-matrix-v1", rows: [] },
    gaps: [createValidGap({ id: "gap-1" })],
    differentiationRequirements: { items: [] },
    pageSnapshotRefs: [],
    analysisRefs: [],
  };

  const decs = [{ gapId: "gap-1", disposition: "REQUIRED", priority: "HIGH", note: null }];
  const decDigest = decisionsDigest("rd-1", decs);
  let capturedSnapshotInsert: any = null;

  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1" }],
    } as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewState: "operator_reviewed",
        reviewRevision: 1,
        decisionsDigest: decDigest,
        acceptedInputSnapshotId: "in-1",
        acceptedInputVersion: 1,
        acceptedInputDigest: "d1",
        serpSnapshotId: "serp-1",
        serpSnapshotDigest: "sd-1",
        intelligenceSnapshotId: "intel-1",
        intelligenceSnapshotDigest: "id-1",
        data: reportData,
      }),
      getAcceptedGapSnapshotByReportId: async () => null,
      listDecisions: async () => decs,
      getSerpSnapshot: async () => ({
        id: "serp-1",
        snapshotDigest: "sd-1",
        query: "q",
        location: null,
        language: null,
        device: "desktop",
        observedAt: new Date("2026-09-01"),
      }),
      getLatestSerpForSearchIdentity: async () => ({ id: "serp-1", observedAt: new Date("2026-09-01") }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "id-1",
        createdAt: new Date("2026-09-01"),
      }),
      getLatestIntelligenceForSearchIdentity: async () => ({ id: "intel-1", createdAt: new Date("2026-09-01") }),
      pageSnapshotsByIds: async (_p: string, ids: string[]) =>
        ids.map((id) => ({ id, snapshotDigest: "pd-" + id, classification: "INCLUDE" })),
      analysesByIds: async () => [],
      getLatestClassificationOverridesForPages: async () => new Map(),
      latestAcceptedGapVersion: async () => 0,
      markGapReportAccepted: async () => {},
      insertAcceptedGapSnapshot: async (input: any) => {
        capturedSnapshotInsert = input;
        return { id: "acc-1", version: 1 };
      },
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.acceptGapReport({
    projectId: "proj-1",
    reportId: "rep-1",
    expectedReportDigest: "rd-1",
    expectedReviewRevision: 1,
    expectedDecisionsDigest: decDigest,
  });

  assert.equal(res.version, 1);
  assert.ok(capturedSnapshotInsert);
  assert.equal(capturedSnapshotInsert.data.classificationDigest, boundDigest);
  assert.deepEqual(capturedSnapshotInsert.data.effectiveClassifications, effectiveClassifications);
});

// ---------------------------------------------------------------------------
// Defect B: Gap Model Usage & Budget Governance (B1–B4)
// ---------------------------------------------------------------------------

test("B1: proposeGaps persists usage with costMicros into content_gap_reports", async () => {
  let capturedReportUsage: any = null;
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "in-1", version: 1, digest: "d1", payload: { business: { name: "B" }, evidence: {} } },
      ],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 0,
      latestSucceededRun: async () => ({
        id: "run-1",
        status: "succeeded",
        acceptedInputDigest: "d1",
        serpSnapshotId: "serp-1",
        serpSnapshotDigest: "s".repeat(64),
      }),
      getSerpSnapshot: async () => ({ id: "serp-1", acceptedInputDigest: "d1" }),
      listPageSnapshotsForRun: async () => [
        {
          id: "p-1",
          domain: "guide.example",
          acquisitionStatus: "SUCCESS",
          classification: "INCLUDE",
          snapshotDigest: "pd-1",
          extracted: { segments: [{ id: "seg-101" }] },
        },
      ],
      getLatestClassificationOverridesForPages: async () => new Map(),
      listAnalysesForRun: async () => [
        { id: "a-1", pageSnapshotId: "p-1", snapshotDigest: "ad-1", data: { topics: [], questions: [], coverageAreas: [] } },
      ],
      getIntelligenceForSerpSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        data: { primaryIntent: "commercial", userNeeds: ["need1"], semanticCoverageRequirements: [], questions: [], topics: [] },
      }),
      insertGapReport: async (input: any) => {
        capturedReportUsage = input.usage;
        return { id: "rep-new", snapshotDigest: "rep-d" } as never;
      },
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: {
      provider: "fixture",
      propose: async () => ({
        model: "gap-model",
        provider: "fixture",
        promptVersion: "v1",
        gaps: [createValidGap({ id: "gap-1", competitorsCoveringIt: ["p-1"], evidenceRefs: [{ pageSnapshotId: "p-1", segmentId: "seg-101" }], ourEvidenceAvailable: [] })],
        differentiationRequirements: { items: [] },
        usage: {
          costMicros: 3500,
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
        },
      }),
    } as never,
  });

  await service.proposeGaps({ projectId: "proj-1" });
  assert.deepEqual(capturedReportUsage, {
    costMicros: 3500,
    inputTokens: 200,
    outputTokens: 100,
    totalTokens: 300,
  });
});

test("B2: proposeGaps blocks when sumTodayCompetitorCostMicros exceeds budget", async () => {
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1", payload: {} }],
    } as never,
    competitorStore: {
      // Default limit is 10.00 USD = 10,000,000 micros
      sumTodayCompetitorCostMicros: async () => 10_000_000,
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.proposeGaps({ projectId: "proj-1" }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "competitor_budget_blocked" &&
      err.message.includes("Daily competitor budget reached"),
  );
});

test("B3: proposeGaps budget block makes 0 model calls (spy verification)", async () => {
  let modelCallCount = 0;
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [{ id: "in-1", version: 1, digest: "d1", payload: {} }],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 15_000_000,
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: {
      provider: "fixture",
      propose: async () => {
        modelCallCount++;
        return {} as never;
      },
    } as never,
  });

  await assert.rejects(
    service.proposeGaps({ projectId: "proj-1" }),
    (err: unknown) => err instanceof FactoryError && err.code === "competitor_budget_blocked",
  );

  assert.equal(modelCallCount, 0, "No model calls should be made when pre-spend budget check fails");
});

test("B4: null costMicros in proposal usage is handled gracefully without NaN", async () => {
  let capturedReportUsage: any = null;
  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "in-1", version: 1, digest: "d1", payload: { business: { name: "B" }, evidence: {} } },
      ],
    } as never,
    competitorStore: {
      sumTodayCompetitorCostMicros: async () => 0,
      latestSucceededRun: async () => ({
        id: "run-1",
        status: "succeeded",
        acceptedInputDigest: "d1",
        serpSnapshotId: "serp-1",
        serpSnapshotDigest: "s".repeat(64),
      }),
      getSerpSnapshot: async () => ({ id: "serp-1", acceptedInputDigest: "d1" }),
      listPageSnapshotsForRun: async () => [
        {
          id: "p-1",
          domain: "guide.example",
          acquisitionStatus: "SUCCESS",
          classification: "INCLUDE",
          snapshotDigest: "pd-1",
          extracted: { segments: [{ id: "seg-101" }] },
        },
      ],
      getLatestClassificationOverridesForPages: async () => new Map(),
      listAnalysesForRun: async () => [
        { id: "a-1", pageSnapshotId: "p-1", snapshotDigest: "ad-1", data: { topics: [], questions: [], coverageAreas: [] } },
      ],
      getIntelligenceForSerpSnapshot: async () => ({
        id: "intel-1",
        snapshotDigest: "i".repeat(64),
        data: { primaryIntent: "commercial", userNeeds: ["need1"], semanticCoverageRequirements: [], questions: [], topics: [] },
      }),
      insertGapReport: async (input: any) => {
        capturedReportUsage = input.usage;
        return { id: "rep-new", snapshotDigest: "rep-d" } as never;
      },
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: {
      provider: "fixture",
      propose: async () => ({
        model: "gap-model",
        provider: "fixture",
        promptVersion: "v1",
        gaps: [createValidGap({ id: "gap-1", competitorsCoveringIt: ["p-1"], evidenceRefs: [{ pageSnapshotId: "p-1", segmentId: "seg-101" }], ourEvidenceAvailable: [] })],
        differentiationRequirements: { items: [] },
        usage: {
          costMicros: null,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      }),
    } as never,
  });

  await service.proposeGaps({ projectId: "proj-1" });
  assert.equal(capturedReportUsage.costMicros, null);
});

// ---------------------------------------------------------------------------
// Defect C: Review Concurrency & Triple-Bound Acceptance (C1–C7)
// ---------------------------------------------------------------------------

test("C1: saveGapDecisions fails closed when expectedReviewRevision does not match", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getAcceptedGapSnapshotByReportId: async () => null,
      getGapReport: async () => ({
        id: "rep-1",
        reviewRevision: 2,
        reviewState: "operator_reviewed",
        data: { gaps: [{ id: "gap-1" }] },
      }),
      saveGapDecisionsWithConcurrency: async () => {
        throw new FactoryError(
          "content_gap_stale",
          "Review revision mismatch: review was updated concurrently (expected rev 0, current rev 2).",
        );
      },
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.saveGapDecisions({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReviewRevision: 0,
      decisions: [{ gapId: "gap-1", disposition: "REQUIRED" }],
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_stale" &&
      err.message.includes("Review revision mismatch"),
  );
});

test("C2: saveGapDecisions with matching revision returns incremented revision and decisionsDigest", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getAcceptedGapSnapshotByReportId: async () => null,
      getGapReport: async () => ({
        id: "rep-1",
        reviewRevision: 0,
        snapshotDigest: "rd-1",
        reviewState: "model_proposed",
        data: { gaps: [{ id: "gap-1" }] },
      }),
      saveGapDecisionsWithConcurrency: async (input: any) => ({
        reviewRevision: input.expectedReviewRevision + 1,
        decisionsDigest: decisionsDigest("rd-1", input.decisions),
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.saveGapDecisions({
    projectId: "proj-1",
    reportId: "rep-1",
    expectedReviewRevision: 0,
    decisions: [{ gapId: "gap-1", disposition: "REQUIRED", priority: "HIGH", note: "approved" }],
  });

  assert.equal(res.reviewRevision, 1);
  assert.ok(res.decisionsDigest);
});

test("C3: acceptGapReport fails when expectedReviewRevision does not match current report", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewRevision: 2, // Concurrent save incremented this
        decisionsDigest: "dec-2",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "rd-1",
      expectedReviewRevision: 1, // Stale tab at rev 1
      expectedDecisionsDigest: "dec-1",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_stale" &&
      err.message.includes("Review revision mismatch"),
  );
});

test("C4: acceptGapReport fails when expectedDecisionsDigest does not match", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewRevision: 1,
        decisionsDigest: "actual-decisions-digest",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "rd-1",
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "different-decisions-digest",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_accept_failed" &&
      err.message.includes("Decisions digest mismatch"),
  );
});

test("C5: acceptGapReport fails when expectedReportDigest does not match", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "actual-report-digest",
        reviewRevision: 1,
        decisionsDigest: "actual-decisions-digest",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "stale-report-digest",
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "actual-decisions-digest",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_accept_failed" &&
      err.message.includes("Report digest mismatch"),
  );
});

test("C6: acceptGapReport idempotent duplicate call with matching digests succeeds", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewRevision: 1,
        decisionsDigest: "dd-1",
      }),
      getAcceptedGapSnapshotByReportId: async () => ({
        id: "acc-1",
        version: 1,
        reportDigest: "rd-1",
        decisionsDigest: "dd-1",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const res = await service.acceptGapReport({
    projectId: "proj-1",
    reportId: "rep-1",
    expectedReportDigest: "rd-1",
    expectedReviewRevision: 1,
    expectedDecisionsDigest: "dd-1",
  });

  assert.equal(res.version, 1);
  assert.equal(res.snapshotId, "acc-1");
});

test("C7: acceptGapReport idempotent duplicate call with conflicting decisionsDigest fails closed", async () => {
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewRevision: 1,
        decisionsDigest: "dd-different",
      }),
      getAcceptedGapSnapshotByReportId: async () => ({
        id: "acc-1",
        version: 1,
        reportDigest: "rd-1",
        decisionsDigest: "dd-original",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "rd-1",
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "dd-different",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_accept_failed" &&
      err.message.includes("Report was already accepted with different decisions"),
  );
});

test("C8: near-budget boundary blocks execution before spend", async () => {
  const store = new CompetitorStore({} as never);
  // Daily budget = $5.00 = 5,000,000 micros.
  // Spent today = 4,995,000 micros.
  // Remaining budget is 5,000 micros.
  store.sumTodayCompetitorCostMicros = async () => 4_995_000;

  // Attempting to reserve RESERVED_PAGE_ANALYSIS_COST_MICROS (10,000) exceeds budget
  await assert.rejects(
    store.reserveBudget(RESERVED_PAGE_ANALYSIS_COST_MICROS, 5),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "competitor_budget_blocked" &&
      err.message.includes("Daily competitor budget reached"),
  );

  // Attempting to reserve RESERVED_GAP_ANALYSIS_COST_MICROS (20,000) also exceeds budget
  await assert.rejects(
    store.reserveBudget(RESERVED_GAP_ANALYSIS_COST_MICROS, 5),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "competitor_budget_blocked",
  );
});

test("C9: concurrent budget reservation racing: mutex serializes reservations and releases allow subsequent", async () => {
  const store = new CompetitorStore({} as never);
  // Daily budget = $5.00 = 5,000,000 micros.
  // Spent today = 4,985,000 micros.
  // Remaining budget is 15,000 micros.
  store.sumTodayCompetitorCostMicros = async () => 4_985_000;

  // Two parallel attempts to reserve 10,000 each.
  // Total needed = 20,000, but only 15,000 available.
  // Mutex ensures exactly one succeeds and one is blocked.
  const results = await Promise.allSettled([
    store.reserveBudget(10_000, 5),
    store.reserveBudget(10_000, 5),
  ]);

  const fulfilled = results.filter((r): r is PromiseFulfilledResult<() => void> => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one concurrent reservation should succeed");
  assert.equal(rejected.length, 1, "Exactly one concurrent reservation should be blocked");
  const firstFulfilled = fulfilled[0];
  const firstRejected = rejected[0];
  assert.ok(firstFulfilled);
  assert.ok(firstRejected);
  assert.ok(firstRejected.reason instanceof FactoryError);
  assert.equal((firstRejected.reason as FactoryError).code, "competitor_budget_blocked");

  // While first is active, another attempt to reserve 10,000 also fails
  await assert.rejects(
    store.reserveBudget(10_000, 5),
    (err: unknown) => err instanceof FactoryError && err.code === "competitor_budget_blocked",
  );

  // Release the first reservation
  firstFulfilled.value();

  // After release, remaining budget is once again 15,000, so a subsequent 10,000 reservation succeeds
  const release2 = await store.reserveBudget(10_000, 5);
  assert.equal(typeof release2, "function");
  release2();
});

test("C10: staleness parity: gapWorkspace and acceptedGapDetail return identical staleness when newer competitor run exists", async () => {
  const acceptedSnapshot = {
    id: "acc-1",
    version: 1,
    reportId: "rep-1",
    snapshotDigest: "acc-digest-1",
    reportDigest: "rep-digest-1",
    decisionsDigest: "dec-digest-1",
    acceptedInputSnapshotId: "input-snap-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "input-digest-1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "serp-digest-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "intel-digest-1",
    pageSnapshotRefs: [],
    analysisRefs: [],
    acceptedAt: new Date(1000),
    data: {
      gaps: [{ id: "gap-1", recommendedDisposition: "REQUIRED", disposition: "REQUIRED" }],
      classificationDigest: "class-digest-1",
      effectiveClassifications: [],
    },
  };

  const boundRun = {
    id: "run-1",
    projectId: "proj-1",
    serpSnapshotId: "serp-1",
    status: "succeeded",
    createdAt: new Date(1000),
  };

  const newerRun = {
    id: "run-2",
    projectId: "proj-1",
    serpSnapshotId: "serp-1",
    status: "succeeded",
    createdAt: new Date(2000), // Newer run supersedes run-1
  };

  const service = new CompetitorContentGapService({
    intake: {
      listSnapshots: async () => [
        { id: "input-snap-1", version: 1, digest: "input-digest-1" },
      ],
    } as never,
    competitorStore: {
      listGapReports: async () => [],
      listAcceptedGapSnapshots: async () => [acceptedSnapshot],
      getAcceptedGapSnapshot: async () => acceptedSnapshot,
      getGapReport: async () => ({
        id: "rep-1",
        runId: "run-1",
      }),
      getSerpSnapshot: async () => ({
        id: "serp-1",
        query: "chamonix property",
        acceptedInputDigest: "input-digest-1",
      }),
      getIntelligenceForSerpSnapshot: async () => ({
        id: "intel-1",
        createdAt: new Date(1000),
      }),
      getIntelligenceSnapshot: async () => ({
        id: "intel-1",
        createdAt: new Date(1000),
      }),
      getRun: async (_proj: string, runId: string) => {
        if (runId === "run-1") return boundRun;
        if (runId === "run-2") return newerRun;
        return null;
      },
      latestSucceededRunForSerp: async () => newerRun,
      latestSucceededRun: async () => newerRun,
      pageSnapshotsByIds: async () => [],
      analysesByIds: async () => [],
      getLatestClassificationOverridesForPages: async () => new Map(),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  const workspace = await service.gapWorkspace("proj-1");
  const detail = await service.acceptedGapDetail("proj-1", 1);

  assert.equal(workspace.accepted.length, 1);
  const acceptedWorkspaceEntry = workspace.accepted[0];
  assert.ok(acceptedWorkspaceEntry);
  assert.equal(acceptedWorkspaceEntry.stale, true, "workspace.accepted should be stale due to newer run");
  assert.equal(detail.stale, true, "detail should be stale due to newer run");

  assert.deepEqual(
    acceptedWorkspaceEntry.staleReasons,
    detail.staleReasons,
    "workspace and detail must return IDENTICAL staleness reasons",
  );
  assert.ok(
    detail.staleReasons.some((r) => r.includes("A newer competitor run was executed")),
    "staleReasons should explain that a newer competitor run exists",
  );
});

test("C11: snapshot uniqueness: report can have at most one accepted gap snapshot", async () => {
  let currentReportDecisionsDigest = "dd-original";
  const service = new CompetitorContentGapService({
    intake: {} as never,
    competitorStore: {
      getGapReport: async () => ({
        id: "rep-1",
        snapshotDigest: "rd-1",
        reviewRevision: 1,
        decisionsDigest: currentReportDecisionsDigest,
      }),
      getAcceptedGapSnapshotByReportId: async () => ({
        id: "acc-1",
        version: 1,
        reportDigest: "rd-1",
        decisionsDigest: "dd-original",
      }),
    } as never,
    competitorAnalyst: { provider: "fixture" } as never,
    gapAnalyst: { provider: "fixture" } as never,
  });

  // Idempotent duplicate call with matching digests succeeds and returns existing snapshot
  const res = await service.acceptGapReport({
    projectId: "proj-1",
    reportId: "rep-1",
    expectedReportDigest: "rd-1",
    expectedReviewRevision: 1,
    expectedDecisionsDigest: "dd-original",
  });
  assert.equal(res.version, 1);
  assert.equal(res.snapshotId, "acc-1");

  // Duplicate call with conflicting decisions digest fails closed
  currentReportDecisionsDigest = "dd-conflicting";
  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "rep-1",
      expectedReportDigest: "rd-1",
      expectedReviewRevision: 1,
      expectedDecisionsDigest: "dd-conflicting",
    }),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "content_gap_accept_failed" &&
      err.message.includes("Report was already accepted with different decisions"),
  );
});


