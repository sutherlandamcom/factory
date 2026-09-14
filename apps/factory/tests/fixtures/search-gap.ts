import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { SearchStore } from "../../src/search/search-store.js";
import { SearchIntelligenceService } from "../../src/search/service.js";
import { FixtureSerpProvider } from "../../src/search/serp-fixture.js";
import { FixtureSearchAnalyst } from "../../src/search/analyst.js";
import { FixtureGroundedSearchProvider } from "../../src/search/grounded-types.js";
import { CompetitorContentGapService } from "../../src/competitors/service.js";
import { CompetitorStore } from "../../src/competitors/competitor-store.js";
import { FixtureCompetitorAnalyst } from "../../src/competitors/analyst.js";
import { FixtureGapAnalyst } from "../../src/competitors/gap-analyst.js";
import { FixturePageProvider } from "../../src/competitors/fixture-page-provider.js";
import type { ContentGapReportData } from "@factory/contracts";

export async function acquireAcceptedGap(db: FactoryDatabaseInstance, projectId: string) {
  const intake = new ProjectIntakeStore(db.db);
  const serp = new FixtureSerpProvider();
  const search = new SearchIntelligenceService({ intake, searchStore: new SearchStore(db.db), productionSerpProvider: serp, fixtureSerpProvider: serp,
    analyst: new FixtureSearchAnalyst(), groundedProvider: new FixtureGroundedSearchProvider(), config: { providerMode: "fixture" } });
  const evidence = await search.runSearch({ projectId, query: "roof repair austin", device: "desktop", refresh: true });
  const service = new CompetitorContentGapService({ intake, competitorStore: new CompetitorStore(db.db),
    competitorAnalyst: new FixtureCompetitorAnalyst(), gapAnalyst: new FixtureGapAnalyst(), pageProvider: new FixturePageProvider(), config: { mode: "fixture" } });
  const competitors = await service.runCompetitors({ projectId, serpSnapshotId: evidence.serp!.snapshotId });
  const { reportId } = await service.proposeGaps({ projectId, competitorRunId: competitors.run.id });
  const detail = await service.getGapReportDetail(projectId, reportId);
  const decisions = await service.saveGapDecisions({ projectId, reportId, expectedReviewRevision: detail.report.reviewRevision,
    decisions: (detail.report.data as ContentGapReportData).gaps.map(gap => ({ gapId: gap.id, disposition: "REQUIRED", priority: "HIGH", note: "Reviewed fixture evidence" })) });
  const accepted = await service.acceptGapReport({ projectId, reportId, expectedDigest: detail.report.snapshotDigest,
    expectedReviewRevision: decisions.reviewRevision, expectedDecisionsDigest: decisions.decisionsDigest });
  return { evidence, competitors, accepted, service, search };
}
