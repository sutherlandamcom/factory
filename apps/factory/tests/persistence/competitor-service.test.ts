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
  const service = buildService(inst, outcomes);
  const run = await service.runCompetitors({ projectId: "proj-1", serpSnapshotId: "serp-1" });

  const { reportId } = await service.proposeGaps({ projectId: "proj-1", competitorRunId: run.run.id });
  const detail = await service.getGapReportDetail("proj-1", reportId);
  const reportData = detail.report.data as { gaps: Array<{ id: string; recommendedDisposition: string; userNeed: string }> };
  assert.ok(reportData.gaps.length >= 1);

  // Accept without decisions fails closed.
  await assert.rejects(
    service.acceptGapReport({ projectId: "proj-1", reportId, expectedDigest: detail.report.snapshotDigest }),
    /decision for every gap/,
  );

  // Wrong digest fails closed.
  await service.saveGapDecisions({
    projectId: "proj-1",
    reportId,
    decisions: reportData.gaps.map((g) => ({ gapId: g.id, disposition: "REQUIRED" as const, priority: "HIGH" as const })),
  });
  await assert.rejects(
    service.acceptGapReport({ projectId: "proj-1", reportId, expectedDigest: "0".repeat(64) }),
    /digest mismatch/,
  );

  // Correct acceptance => v1.
  const v1 = await service.acceptGapReport({ projectId: "proj-1", reportId, expectedDigest: detail.report.snapshotDigest });
  assert.equal(v1.version, 1);

  // Old digest replay (double acceptance) fails: version uniqueness + report digest binding is fine, but accepting again creates v2 — acceptable (new version). Verify v1 remains inspectable:
  const v1Detail = await service.acceptedGapDetail("proj-1", 1);
  assert.equal(v1Detail.snapshot.version, 1);
  assert.equal(v1Detail.stale, false);

  // Accept again (same reviewed report) => v2 immutable history preserved.
  const v2 = await service.acceptGapReport({ projectId: "proj-1", reportId, expectedDigest: detail.report.snapshotDigest });
  assert.equal(v2.version, 2);
  const v1After = await service.acceptedGapDetail("proj-1", 1);
  assert.equal(v1After.snapshot.snapshotDigest, v1Detail.snapshot.snapshotDigest);

  // Accepting a nonexistent report fails.
  await assert.rejects(
    service.acceptGapReport({ projectId: "proj-1", reportId: "missing", expectedDigest: "x" }),
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
      decisions: [{ gapId: "gap-999", disposition: "REQUIRED" }],
    }),
    /Unknown gap/,
  );
  if (reportData.gaps.length > 1) {
    await assert.rejects(
      service.saveGapDecisions({
        projectId: "proj-1",
        reportId,
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
