import assert from "node:assert/strict";
import test from "node:test";
import {
  MonitoringService,
  type SearchConsoleInspectionResult,
  type CruxFieldResult,
  type LighthouseLabResult,
  type OperationalCheckResult,
} from "../src/monitoring/service.js";
import type { FactoryStore } from "../src/persistence/store.js";
import type { FactoryDb } from "../src/persistence/db.js";
import type { InsertMonitoringObservation, MonitoringObservationRecord } from "../src/persistence/schema.js";

function makeMockStore(initialObs: MonitoringObservationRecord[] = []) {
  const observations: MonitoringObservationRecord[] = [...initialObs];
  return {
    findSiteByProjectId: async (projectId: string) => ({
      id: "site-mon-1",
      projectId,
      key: "sutherland-mon",
      name: "Sutherland Monitoring",
      cloudflareWorkerName: "worker-sutherland",
      productionUrl: "https://example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    listDeployments: async () => [
      {
        id: "dep-pub-1",
        siteId: "site-mon-1",
        candidateId: "cand-1",
        versionId: "ver-current-prod",
        workerName: "worker-sutherland",
        productionUrl: "https://example.com",
        status: "verified",
        previewVerified: true,
        productionVerified: true,
        sourceCommit: "c".repeat(40),
        artifactDigest: "d".repeat(64),
        rolledBack: false,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        promotedAt: new Date(),
        verifiedAt: new Date(),
      },
    ],
    insertMonitoringObservation: async (input: InsertMonitoringObservation): Promise<MonitoringObservationRecord> => {
      const rec: MonitoringObservationRecord = {
        id: input.id,
        projectId: input.projectId,
        siteId: input.siteId,
        route: input.route,
        deploymentId: input.deploymentId ?? null,
        versionId: input.versionId ?? null,
        observationType: input.observationType,
        source: input.source,
        status: input.status,
        collectionWindow: input.collectionWindow ?? "realtime",
        freshness: input.freshness ?? "fresh",
        metrics: input.metrics ?? null,
        evidenceRef: input.evidenceRef ?? null,
        errorMessage: input.errorMessage ?? null,
        observedAt: input.observedAt ? new Date(input.observedAt) : new Date(),
        createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
      };
      observations.unshift(rec);
      return rec;
    },
    listMonitoringObservations: async (siteId: string, limit = 50): Promise<MonitoringObservationRecord[]> => {
      return observations.filter((o) => o.siteId === siteId).slice(0, limit);
    },
    getLatestMonitoringObservationsByType: async (siteId: string): Promise<Map<string, MonitoringObservationRecord>> => {
      const map = new Map<string, MonitoringObservationRecord>();
      for (const o of observations.filter((x) => x.siteId === siteId)) {
        if (!map.has(o.observationType)) {
          map.set(o.observationType, o);
        }
      }
      return map;
    },
  } as unknown as FactoryStore;
}

test("MonitoringService - recordTechnicalVerification persists multi-route production QA evidence", async () => {
  const store = makeMockStore();
  const service = new MonitoringService({ db: {} as FactoryDb, store });

  await service.recordTechnicalVerification({
    projectId: "proj-1",
    siteId: "site-mon-1",
    deploymentId: "dep-pub-1",
    versionId: "ver-current-prod",
    routes: ["/", "/services", "/about"],
    passed: true,
    evidenceRef: ".factory/deployments/pub-1/qa-artifacts",
  });

  const summary = await service.getMonitoringSummary("proj-1");
  assert.equal(summary.technicalVerification.status, "PASS");
  assert.equal(summary.observations.length, 3);
  assert.equal(summary.observations[0]?.observationType, "technical_verification");
  assert.equal(summary.observations[0]?.status, "PASS");
});

test("MonitoringService - runOperationalCheck reports NOT_CONFIGURED when Search Console credentials absent", async () => {
  const store = makeMockStore();
  const originalEnv = process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_KEY;
  delete process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_KEY;
  delete process.env.CRUX_API_KEY;

  try {
    const service = new MonitoringService({ db: {} as FactoryDb, store });
    const summary = await service.runOperationalCheck("proj-1");

    assert.equal(summary.searchConsole.status, "NOT_CONFIGURED");
    assert.equal(summary.fieldCwv.status, "INSUFFICIENT_DATA");
    assert.equal(summary.lastOperationalCheck.status, "PASS");
    assert.equal(summary.lighthouse.status, "PASS");
  } finally {
    if (originalEnv) process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_KEY = originalEnv;
  }
});

test("MonitoringService - runOperationalCheck binds injected Search Console and CrUX doubles", async () => {
  const store = makeMockStore();
  const service = new MonitoringService({
    db: {} as FactoryDb,
    store,
    adapters: {
      searchConsole: {
        inspectUrl: async (url: string): Promise<SearchConsoleInspectionResult> => ({
          status: "PASS",
          indexCoverageStatus: "INDEXED",
          googleSelectedCanonical: url,
          userDeclaredCanonical: url,
          lastCrawlTime: "2026-10-20T12:00:00Z",
          robotsTxtStatus: "ALLOWED",
          issues: [],
          errorMessage: null,
        }),
      },
      crux: {
        queryFieldMetrics: async (): Promise<CruxFieldResult> => ({
          status: "PASS",
          p75LcpMs: 1850,
          p75InpMs: 65,
          p75Cls: 0.03,
          collectionPeriod: "28_day",
          errorMessage: null,
        }),
      },
      lighthouse: {
        runLab: async (): Promise<LighthouseLabResult> => ({
          status: "PASS",
          score: 99,
          p75LcpMs: 1100,
          p75Cls: 0.01,
          p75InpMs: 40,
          errorMessage: null,
        }),
      },
      operationalVerifier: {
        verifyUrl: async (): Promise<OperationalCheckResult> => ({
          status: "PASS",
          statusCode: 200,
          canonicalMatches: true,
          robotsValid: true,
          sitemapValid: true,
          summary: "Verified HTTP 200, canonical and sitemap",
          errorMessage: null,
        }),
      },
    },
  });

  const summary = await service.runOperationalCheck("proj-1");
  assert.equal(summary.searchConsole.status, "PASS");
  assert.equal(summary.searchConsole.indexCoverage, "INDEXED");
  assert.equal(summary.fieldCwv.status, "PASS");
  assert.equal(summary.fieldCwv.p75LcpMs, 1850);
  assert.equal(summary.lighthouse.score, 99);
  assert.equal(summary.lastOperationalCheck.status, "PASS");
});
