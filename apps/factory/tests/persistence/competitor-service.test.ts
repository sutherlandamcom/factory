import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  CompetitorContentGapService,
  DEFAULT_COMPETITOR_CONFIG,
  CLASSIFICATION_POLICY_VERSION,
} from "../../src/competitors/service.js";
import { CompetitorStore } from "../../src/competitors/competitor-store.js";
import { FixtureCompetitorAnalyst } from "../../src/competitors/analyst.js";
import { FixtureGapAnalyst } from "../../src/competitors/gap-analyst.js";
import type { CompetitorPageProvider, PageAcquisitionOutcome } from "../../src/competitors/direct-http.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import { projects } from "../../src/persistence/schema.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * Governed service tests (real PostgreSQL, injected page provider +
 * fixture analysts — zero external calls). Covers: candidate selection from
 * persisted SERP evidence only, browser-cannot-supply-URL, acquisition
 * outcome persistence, analysis, proposal, review, accept v1/v2, staleness,
 * digest binding, project isolation.
 */

class StubPageProvider implements CompetitorPageProvider {
  readonly id = "direct_http";
  constructor(private readonly outcomes: Map<string, PageAcquisitionOutcome>) {}
  async acquire(request: { url: string }): Promise<PageAcquisitionOutcome> {
    const outcome = this.outcomes.get(request.url);
    if (outcome) return outcome;
    return {
      status: "FAILED",
      httpStatus: null,
      contentType: null,
      finalUrl: null,
      observedAt: new Date(),
      reason: "No stubbed outcome for URL.",
    };
  }
}

function successOutcome(url: string, html: string): PageAcquisitionOutcome {
  const rawBytes = Buffer.from(html);
  return {
    status: "SUCCESS",
    finalUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    rawBytes,
    rawDigest: "d".repeat(64),
    truncated: false,
    observedAt: new Date("2026-09-06T10:00:00Z"),
  };
}

const PAGE_HTML_1 = `<html><head><title>Chamonix Property Guide</title></head><body>
  <h1>Buying in Chamonix</h1><h2>Pricing</h2><p>What does a chalet cost? Prices vary.</p>
  <p>Should you invest now? Many ask.</p></body></html>`;
const PAGE_HTML_2 = `<html><head><title>Second</title></head><body><h1>Two</h1><p>Content two.</p></body></html>`;

async function seedEnvironment() {
  const inst = await setupMigratedTestDatabase();
  await inst.db.insert(projects).values([
    { id: "proj-1", key: "p1", name: "P1" },
    { id: "proj-2", key: "p2", name: "P2" },
  ]);
  await inst.db.execute(
    `INSERT INTO project_input_snapshots (id, project_id, version, source_revision, payload, digest)
     VALUES ('in-1', 'proj-1', 1, 1, '{"evidence":{"operatorFacts":["Operator operates in Chamonix since 2019"],"allowedClaims":["Member of tourist office"]}}'::jsonb, 'd1'),
            ('in-2', 'proj-2', 1, 1, '{}'::jsonb, 'd2')`,
  );
  await inst.db.execute(
    `INSERT INTO search_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, request_digest, status)
     VALUES ('sr-1', 'proj-1', 'in-1', 1, 'd1', 'investissement immobilier chamonix', 'desktop', 'fixture', 'rd-1', 'succeeded')`,
  );
  const organic = JSON.stringify([
    { position: 1, url: "https://guide-a.example/chamonix", domain: "guide-a.example", title: "Guide A", snippet: "s" },
    { position: 2, url: "https://reddit.com/r/chamonix", domain: "reddit.com", title: "Reddit thread", snippet: "s" },
    { position: 3, url: "https://report.example/report.pdf", domain: "report.example", title: "PDF report", snippet: "s" },
    { position: 4, url: "https://www.amazon.example/x", domain: "www.amazon.example", title: "Marketplace", snippet: "s" },
    { position: 5, url: "https://guide-b.example/article", domain: "guide-b.example", title: "Guide B", snippet: "s" },
  ]);
  await inst.db.execute(sql`
    INSERT INTO serp_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, observed_at, request_digest, snapshot_digest, organic, raw_digest)
    VALUES ('serp-1', 'sr-1', 'proj-1', 'in-1', 1, 'd1', 'investissement immobilier chamonix', 'desktop', 'fixture', now(), 'rd-1', 'sd-1', ${organic}::jsonb, 'rawd-1')
  `);
  const intel = JSON.stringify({
    primaryIntent: "commercial",
    intentRationale: "r",
    secondaryIntents: [],
    queryClusters: [],
    longTailOpportunities: [],
    entities: [],
    topics: [],
    questions: ["What rental yield can investors expect?"],
    modifiers: [],
    searchVocabulary: [],
    relatedConcepts: [],
    semanticCoverageRequirements: ["Explain expected rental yield", "Cover purchase taxes"],
    userNeeds: ["Understand expected rental yield", "Know purchase taxes"],
    evidenceRefs: [{ kind: "serp_snapshot", id: "serp-1", digest: "sd-1" }],
    reviewState: "model_proposed",
  });
  await inst.db.execute(sql`
    INSERT INTO search_intelligence_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, model, provider, prompt_version, prompt_digest, serp_snapshot_id, evidence_digests, data, snapshot_digest)
    VALUES ('intel-1', 'sr-1', 'proj-1', 'in-1', 1, 'd1', 'investissement immobilier chamonix', 'fixture-analyst', 'fixture', 'search-analyst-v1', 'pd', 'serp-1', '{}'::jsonb, ${intel}::jsonb, 'id-1')
  `);
  return inst;
}

function buildService(inst: Awaited<ReturnType<typeof seedEnvironment>>, outcomes: Map<string, PageAcquisitionOutcome>, config?: Record<string, unknown>) {
  const store = new CompetitorStore(inst.db);
  return new CompetitorContentGapService({
    intake: {
      listSnapshots: async (projectId: string) => {
        if (projectId === "proj-1") {
          return [
            { id: "in-1", version: 1, digest: "d1", acceptedAt: new Date(), payload: { evidence: { operatorFacts: ["Operator operates in Chamonix since 2019"], allowedClaims: ["Member of tourist office"] } } },
          ] as never;
        }
        return [
          { id: "in-2", version: 1, digest: "d2", acceptedAt: new Date(), payload: {} } as never,
        ];
      },
    } as never,
    competitorStore: store,
    pageProvider: new StubPageProvider(outcomes),
    competitorAnalyst: new FixtureCompetitorAnalyst(),
    gapAnalyst: new FixtureGapAnalyst(),
    config,
  });
}

test("competitor run: classification from persisted SERP, acquisition outcomes, analysis", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  const outcomes = new Map<string, PageAcquisitionOutcome>([
    ["https://guide-a.example/chamonix", successOutcome("https://guide-a.example/chamonix", PAGE_HTML_1)],
    ["https://guide-b.example/article", successOutcome("https://guide-b.example/article", PAGE_HTML_2)],
  ]);
  const service = buildService(inst, outcomes);
  const result = await service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" });
  assert.equal(result.run.status, "succeeded");
  // Reddit => REFERENCE_ONLY, PDF => REFERENCE_ONLY, amazon => EXCLUDE (not fetched).
  const byDomain = Object.fromEntries(result.candidates.map((c) => [c.domain, c]));
  assert.equal(result.candidates.filter((c) => c.acquisitionStatus === "SUCCESS").length, 2);
  assert.ok(result.candidates.every((c) => c.domain !== "reddit.com" && c.domain !== "www.amazon.example"));
  assert.ok(result.candidates.every((c) => c.domain !== "report.example"));
  const guideA = byDomain["guide-a.example"];
  assert.equal(guideA?.analyzed, true);
  assert.ok((guideA?.topics.length ?? 0) >= 1);
  assert.equal(result.usage.analyzedCount, 2);
});

test("competitor run: rejected when SERP has no includable candidates", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  await inst.db.execute(
    `UPDATE serp_snapshots SET organic='[{"position":1,"url":"https://reddit.com/r/x","domain":"reddit.com","title":"t","snippet":"s"}]'::jsonb WHERE id='serp-1'`,
  );
  const service = buildService(inst, new Map());
  await assert.rejects(
    service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" }),
    /No includable competitor candidates/,
  );
});

test("security: browser-supplied arbitrary URL cannot enter acquisition; unknown SERP fails", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  const service = buildService(inst, new Map());
  // The API surface only accepts serpSnapshotId; a URL is not part of the
  // run input contract — enforce by checking unknown snapshot rejection.
  await assert.rejects(
    service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "https://evil.example/steal" }),
    /SERP snapshot not found/,
  );
  // Project isolation: proj-2 cannot read proj-1 SERP evidence.
  await assert.rejects(
    service.runCompetitors({ projectId: "proj-2", serpSnapshotId: "serp-1" }),
    /SERP snapshot not found/,
  );
});

test("gap proposal: coverage matrix, first-party refs, review, accept v1/v2, staleness", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  const outcomes = new Map<string, PageAcquisitionOutcome>([
    ["https://guide-a.example/chamonix", successOutcome("https://guide-a.example/chamonix", PAGE_HTML_1)],
    ["https://guide-b.example/article", successOutcome("https://guide-b.example/article", PAGE_HTML_2)],
  ]);
  const store = new CompetitorStore(inst.db);
  const service = buildService(inst, outcomes);
  const run = await service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" });

  const { reportId } = await service.proposeGaps({ projectId: "proj-1", competitorRunId: run.run.id });
  const detail = await service.getGapReportDetail("proj-1", reportId);
  const reportData = detail.report.data as { gaps: Array<{ id: string; recommendedDisposition: string; userNeed: string }> };
  assert.ok(reportData.gaps.length >= 1);

  // Accept without decisions fails closed.
  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId,
      expectedDigest: detail.report.snapshotDigest,
      expectedReviewRevision: detail.report.reviewRevision,
      expectedDecisionsDigest: detail.report.decisionsDigest ?? "0".repeat(64),
    }),
    /decision/,
  );

  // Wrong digest fails closed.
  const saved = await service.saveGapDecisions({
    projectId: "proj-1",
    reportId,
    expectedReviewRevision: detail.report.reviewRevision,
    decisions: reportData.gaps.map((g) => ({
      gapId: g.id,
      disposition: "REQUIRED" as const,
      priority: "HIGH" as const,
      note: "human note",
    })),
  });
  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId,
      expectedDigest: "0".repeat(64),
      expectedReviewRevision: saved.reviewRevision,
      expectedDecisionsDigest: saved.decisionsDigest,
    }),
    /digest mismatch/,
  );

  // Correct acceptance => v1.
  const v1 = await service.acceptGapReport({
    projectId: "proj-1",
    reportId,
    expectedDigest: detail.report.snapshotDigest,
    expectedReviewRevision: saved.reviewRevision,
    expectedDecisionsDigest: saved.decisionsDigest,
  });
  assert.equal(v1.version, 1);

  // Verify v1 detail and materialized human truth
  const v1Detail = await service.acceptedGapDetail("proj-1", 1);
  assert.equal(v1Detail.snapshot.version, 1);
  assert.equal(v1Detail.stale, false);

  const snapshotData = v1Detail.snapshot.data as {
    gaps: Array<{
      id: string;
      disposition: string;
      priority: string | null;
      note: string | null;
      recommendedDisposition: string;
    }>;
    decisions: Array<{ gapId: string; disposition: string }>;
  };
  const acceptedGaps = snapshotData.gaps;
  assert.ok(acceptedGaps.length >= 1);
  for (const gap of acceptedGaps) {
    assert.equal(gap.disposition, "REQUIRED");
    assert.equal(gap.priority, "HIGH");
    assert.equal(gap.note, "human note");
    assert.ok(gap.recommendedDisposition);
  }
  const acceptedDecisions = snapshotData.decisions;
  assert.ok(Array.isArray(acceptedDecisions));
  assert.equal(acceptedDecisions.length, acceptedGaps.length);

  // Double acceptance of the same report does NOT mint v2: returns existing snapshot (idempotent)
  const v2 = await service.acceptGapReport({
    projectId: "proj-1",
    reportId,
    expectedDigest: detail.report.snapshotDigest,
    expectedReviewRevision: saved.reviewRevision,
    expectedDecisionsDigest: saved.decisionsDigest,
  });
  assert.equal(v2.version, 1);
  assert.equal(v2.snapshotId, v1.snapshotId);
  const latestVer = await store.latestAcceptedGapVersion("proj-1");
  assert.equal(latestVer, 1);

  // Modifying decisions for an already accepted report fails closed
  await assert.rejects(
    service.saveGapDecisions({
      projectId: "proj-1",
      reportId,
      expectedReviewRevision: saved.reviewRevision,
      decisions: reportData.gaps.map((g) => ({ gapId: g.id, disposition: "OPTIONAL" as const })),
    }),
    /already accepted/,
  );

  // Accepting a nonexistent report fails.
  await assert.rejects(
    service.acceptGapReport({
      projectId: "proj-1",
      reportId: "missing",
      expectedDigest: "x",
      expectedReviewRevision: 0,
      expectedDecisionsDigest: "0".repeat(64),
    }),
    /not found/,
  );
});

test("gap decisions: unknown gap and incomplete coverage fail closed", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  const outcomes = new Map<string, PageAcquisitionOutcome>([
    ["https://guide-a.example/chamonix", successOutcome("https://guide-a.example/chamonix", PAGE_HTML_1)],
  ]);
  const service = buildService(inst, outcomes);
  const run = await service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" });
  const { reportId } = await service.proposeGaps({ projectId: "proj-1", competitorRunId: run.run.id });
  const detail = await service.getGapReportDetail("proj-1", reportId);
  const reportData = detail.report.data as { gaps: Array<{ id: string }> };

  await assert.rejects(
    service.saveGapDecisions({
      projectId: "proj-1",
      reportId,
      expectedReviewRevision: detail.report.reviewRevision,
      decisions: [{ gapId: "gap-999", disposition: "REQUIRED" }],
    }),
    /Unknown gap/,
  );
  if (reportData.gaps.length > 1) {
    await assert.rejects(
      service.saveGapDecisions({
        projectId: "proj-1",
        reportId,
        expectedReviewRevision: detail.report.reviewRevision,
        decisions: [{ gapId: reportData.gaps[0]!.id, disposition: "REQUIRED" }],
      }),
      /Every gap requires a decision/,
    );
  }
});

test("classification policy version is stable and defaults are bounded", () => {
  assert.equal(CLASSIFICATION_POLICY_VERSION, "classification-v1");
  assert.equal(DEFAULT_COMPETITOR_CONFIG.maxPages, 10);
  assert.equal(DEFAULT_COMPETITOR_CONFIG.dailyLimitUsd, 5);
});

test("concurrency race: accept revision N vs concurrent save revision N+1 on PostgreSQL", async (t) => {
  const inst = await seedEnvironment();
  t.after(() => inst.close());
  const outcomes = new Map<string, PageAcquisitionOutcome>([
    ["https://guide-a.example/chamonix", successOutcome("https://guide-a.example/chamonix", PAGE_HTML_1)],
  ]);
  const service = buildService(inst, outcomes);
  const run = await service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" });
  const { reportId } = await service.proposeGaps({ projectId: "proj-1", competitorRunId: run.run.id });
  const detail = await service.getGapReportDetail("proj-1", reportId);
  const reportData = detail.report.data as { gaps: Array<{ id: string }> };

  // Save initial decisions at revision 0 -> produces revision 1
  const initialSave = await service.saveGapDecisions({
    projectId: "proj-1",
    reportId,
    expectedReviewRevision: detail.report.reviewRevision,
    decisions: reportData.gaps.map((g) => ({
      gapId: g.id,
      disposition: "REQUIRED" as const,
      priority: "HIGH" as const,
      note: "rev1 note",
    })),
  });
  assert.equal(initialSave.reviewRevision, 1);

  // Now race: accept rev 1 vs save rev 2
  const acceptPromise = service.acceptGapReport({
    projectId: "proj-1",
    reportId,
    expectedReportDigest: detail.report.snapshotDigest,
    expectedReviewRevision: initialSave.reviewRevision,
    expectedDecisionsDigest: initialSave.decisionsDigest,
  });

  const saveRev2Promise = service.saveGapDecisions({
    projectId: "proj-1",
    reportId,
    expectedReviewRevision: initialSave.reviewRevision,
    decisions: reportData.gaps.map((g) => ({
      gapId: g.id,
      disposition: "OPTIONAL" as const,
      priority: "LOW" as const,
      note: "rev2 note",
    })),
  });

  const [acceptResult, saveResult] = await Promise.allSettled([acceptPromise, saveRev2Promise]);

  // One must succeed and one must fail closed due to row lock and concurrency checks
  if (acceptResult.status === "fulfilled") {
    // Accept acquired lock first: save rev 2 must fail because report is already accepted
    assert.equal(saveResult.status, "rejected");
    assert.ok(saveResult.reason instanceof FactoryError);
    assert.equal((saveResult.reason as FactoryError).code, "content_gap_decision_invalid");

    // Verified: accepted snapshot exists at version 1 with rev 1 decisions
    const v1Detail = await service.acceptedGapDetail("proj-1", acceptResult.value.version);
    assert.equal(v1Detail.snapshot.decisionsDigest, initialSave.decisionsDigest);
  } else {
    // Save acquired lock first: accept rev 1 must fail due to stale revision or decisions digest
    assert.equal(saveResult.status, "fulfilled");
    assert.equal(saveResult.value.reviewRevision, 2);
    assert.equal(acceptResult.status, "rejected");
    assert.ok(acceptResult.reason instanceof FactoryError);
    assert.ok(
      ["content_gap_stale", "content_gap_accept_failed"].includes(
        (acceptResult.reason as FactoryError).code,
      ),
    );
  }
});

