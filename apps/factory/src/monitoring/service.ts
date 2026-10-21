import { randomUUID } from "node:crypto";
import type { FactoryDb } from "../persistence/db.js";
import type { FactoryStore } from "../persistence/store.js";
import type {
  MonitoringObservation,
  MonitoringObservationStatus,
  MonitoringObservationType,
  MonitoringSummary,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

export interface SearchConsoleInspectionResult {
  status: MonitoringObservationStatus;
  indexCoverageStatus: string | null;
  googleSelectedCanonical: string | null;
  userDeclaredCanonical: string | null;
  lastCrawlTime: string | null;
  robotsTxtStatus: string | null;
  issues: string[];
  errorMessage: string | null;
}

export interface LighthouseLabResult {
  status: MonitoringObservationStatus;
  score: number | null;
  p75LcpMs: number | null;
  p75Cls: number | null;
  p75InpMs: number | null;
  errorMessage: string | null;
}

export interface CruxFieldResult {
  status: MonitoringObservationStatus;
  p75LcpMs: number | null;
  p75InpMs: number | null;
  p75Cls: number | null;
  collectionPeriod: string;
  errorMessage: string | null;
}

export interface OperationalCheckResult {
  status: MonitoringObservationStatus;
  statusCode: number;
  canonicalMatches: boolean;
  robotsValid: boolean;
  sitemapValid: boolean;
  summary: string;
  errorMessage: string | null;
}

export interface MonitoringAdapters {
  searchConsole?: {
    inspectUrl: (url: string, property?: string) => Promise<SearchConsoleInspectionResult>;
  };
  lighthouse?: {
    runLab: (url: string) => Promise<LighthouseLabResult>;
  };
  crux?: {
    queryFieldMetrics: (url: string) => Promise<CruxFieldResult>;
  };
  operationalVerifier?: {
    verifyUrl: (url: string, canonicalUrl: string) => Promise<OperationalCheckResult>;
  };
}

export class MonitoringService {
  private readonly db: FactoryDb;
  private readonly store: FactoryStore;
  private readonly adapters: MonitoringAdapters;

  constructor(deps: {
    db: FactoryDb;
    store: FactoryStore;
    adapters?: MonitoringAdapters;
  }) {
    this.db = deps.db;
    this.store = deps.store;
    this.adapters = deps.adapters ?? {};
  }

  /**
   * Records technical verification observations immediately following Publish.
   */
  async recordTechnicalVerification(input: {
    projectId: string;
    siteId: string;
    deploymentId: string;
    versionId: string;
    routes: string[];
    passed: boolean;
    evidenceRef?: string;
  }): Promise<void> {
    const status: MonitoringObservationStatus = input.passed ? "PASS" : "FAIL";
    const now = new Date();

    for (const route of input.routes) {
      await this.store.insertMonitoringObservation({
        id: `mon-tech-${randomUUID()}`,
        projectId: input.projectId,
        siteId: input.siteId,
        route,
        deploymentId: input.deploymentId,
        versionId: input.versionId,
        observationType: "technical_verification",
        source: "playwright",
        status,
        collectionWindow: "realtime",
        freshness: "fresh",
        metrics: {
          exitCode: input.passed ? 0 : 1,
          verifiedRoutesCount: input.routes.length,
        },
        evidenceRef: input.evidenceRef ?? null,
        errorMessage: input.passed ? null : "Production hostname Playwright remote QA failed",
        observedAt: now,
        createdAt: now,
      });
    }
  }

  /**
   * Executes an on-demand or scheduled operational check across providers:
   * 1. Operational verification (HTTP, canonical, robots, sitemap)
   * 2. Search Console inspection (official API or double; NOT_CONFIGURED when no credentials)
   * 3. Lighthouse lab measurement
   * 4. CrUX field CWV observation (INSUFFICIENT_DATA or NOT_CONFIGURED when no field traffic)
   */
  async runOperationalCheck(projectId: string): Promise<MonitoringSummary> {
    const site = await this.store.findSiteByProjectId(projectId);
    if (!site || !site.productionUrl) {
      throw new FactoryError("unknown_site", `Site for project '${projectId}' not found or productionUrl unset.`);
    }

    let activeVersionId: string | null = null;
    let deploymentId: string | null = null;

    const transition = typeof this.store.getCurrentEffectiveTransition === "function"
      ? await this.store.getCurrentEffectiveTransition(site.id)
      : null;

    if (transition) {
      activeVersionId = transition.versionId;
      deploymentId = transition.deploymentId;
    }
    // P1-05: Do not infer activeVersionId or deploymentId from deployments table when no transition exists
    const targetUrl = site.productionUrl.replace(/\/$/, "");
    const now = new Date();

    // 1. Operational check (technical ping / verification)
    const opResult: OperationalCheckResult = this.adapters.operationalVerifier
      ? await this.adapters.operationalVerifier.verifyUrl(targetUrl, targetUrl)
      : {
          status: "NOT_CONFIGURED",
          statusCode: 0,
          canonicalMatches: false,
          robotsValid: false,
          sitemapValid: false,
          summary: "Operational crawler adapter not configured.",
          errorMessage: "Operational crawler adapter not configured in environment.",
        };

    await this.store.insertMonitoringObservation({
      id: `mon-op-${randomUUID()}`,
      projectId,
      siteId: site.id,
      route: "/",
      deploymentId,
      versionId: activeVersionId,
      observationType: "operational_check",
      source: "operational_crawler",
      status: opResult.status,
      collectionWindow: "realtime",
      freshness: "fresh",
      metrics: {
        statusCode: opResult.statusCode,
        canonicalMatches: opResult.canonicalMatches,
        robotsValid: opResult.robotsValid,
        sitemapValid: opResult.sitemapValid,
      },
      evidenceRef: null,
      errorMessage: opResult.errorMessage,
      observedAt: now,
      createdAt: now,
    });

    // 2. Google Search Console inspection
    const scResult: SearchConsoleInspectionResult = this.adapters.searchConsole
      ? await this.adapters.searchConsole.inspectUrl(targetUrl, site.key)
      : {
          status: "NOT_CONFIGURED",
          indexCoverageStatus: null,
          googleSelectedCanonical: null,
          userDeclaredCanonical: null,
          lastCrawlTime: null,
          robotsTxtStatus: null,
          issues: [],
          errorMessage: "Google Search Console adapter not configured in environment.",
        };

    await this.store.insertMonitoringObservation({
      id: `mon-gsc-${randomUUID()}`,
      projectId,
      siteId: site.id,
      route: "/",
      deploymentId,
      versionId: activeVersionId,
      observationType: "search_console_indexing",
      source: "google_search_console",
      status: scResult.status,
      collectionWindow: "last_crawl",
      freshness: "fresh",
      metrics: {
        indexCoverageStatus: scResult.indexCoverageStatus,
        googleSelectedCanonical: scResult.googleSelectedCanonical,
        userDeclaredCanonical: scResult.userDeclaredCanonical,
        lastCrawlTime: scResult.lastCrawlTime,
        robotsTxtStatus: scResult.robotsTxtStatus,
        issues: scResult.issues,
      },
      evidenceRef: null,
      errorMessage: scResult.errorMessage,
      observedAt: now,
      createdAt: now,
    });

    // 3. Lighthouse lab measurement
    const lhResult: LighthouseLabResult = this.adapters.lighthouse
      ? await this.adapters.lighthouse.runLab(targetUrl)
      : {
          status: "NOT_CONFIGURED",
          score: null,
          p75LcpMs: null,
          p75Cls: null,
          p75InpMs: null,
          errorMessage: "Lighthouse lab runner not configured in environment.",
        };

    await this.store.insertMonitoringObservation({
      id: `mon-lh-${randomUUID()}`,
      projectId,
      siteId: site.id,
      route: "/",
      deploymentId,
      versionId: activeVersionId,
      observationType: "lighthouse_lab",
      source: "lighthouse",
      status: lhResult.status,
      collectionWindow: "realtime",
      freshness: "fresh",
      metrics: {
        score: lhResult.score,
        p75LcpMs: lhResult.p75LcpMs,
        p75Cls: lhResult.p75Cls,
        p75InpMs: lhResult.p75InpMs,
      },
      evidenceRef: null,
      errorMessage: lhResult.errorMessage,
      observedAt: now,
      createdAt: now,
    });

    // 4. CrUX real-user field CWV observation
    const cruxResult: CruxFieldResult = this.adapters.crux
      ? await this.adapters.crux.queryFieldMetrics(targetUrl)
      : {
          status: "NOT_CONFIGURED",
          p75LcpMs: null,
          p75InpMs: null,
          p75Cls: null,
          collectionPeriod: "none",
          errorMessage: "Field Core Web Vitals (CrUX) adapter not configured in environment.",
        };

    await this.store.insertMonitoringObservation({
      id: `mon-crux-${randomUUID()}`,
      projectId,
      siteId: site.id,
      route: "/",
      deploymentId,
      versionId: activeVersionId,
      observationType: "crux_field_cwv",
      source: "crux",
      status: cruxResult.status,
      collectionWindow: cruxResult.collectionPeriod,
      freshness: "fresh",
      metrics: {
        p75LcpMs: cruxResult.p75LcpMs,
        p75InpMs: cruxResult.p75InpMs,
        p75Cls: cruxResult.p75Cls,
      },
      evidenceRef: null,
      errorMessage: cruxResult.errorMessage,
      observedAt: now,
      createdAt: now,
    });

    return await this.getMonitoringSummary(projectId);
  }

  /**
   * Reconstructs the current monitoring summary from persisted observations.
   */
  async getMonitoringSummary(projectId: string): Promise<MonitoringSummary> {
    const site = await this.store.findSiteByProjectId(projectId);
    if (!site) {
      throw new FactoryError("unknown_site", `Site for project '${projectId}' not found.`);
    }

    let activeVersionId: string | null = null;
    const transition = typeof this.store.getCurrentEffectiveTransition === "function"
      ? await this.store.getCurrentEffectiveTransition(site.id)
      : null;

    if (transition) {
      activeVersionId = transition.versionId;
    }
    // P1-05: Do not infer activeVersionId from deployments table when no transition exists

    const observations = await this.store.listMonitoringObservations(site.id, 50);
    const latestByType = await this.store.getLatestMonitoringObservationsByType(site.id);

    const techObs = latestByType.get("technical_verification");
    const opObs = latestByType.get("operational_check");
    const scObs = latestByType.get("search_console_indexing");
    const lhObs = latestByType.get("lighthouse_lab");
    const cruxObs = latestByType.get("crux_field_cwv");

    const scMetrics = (scObs?.metrics as any) ?? {};
    const lhMetrics = (lhObs?.metrics as any) ?? {};
    const cruxMetrics = (cruxObs?.metrics as any) ?? {};

    return {
      projectId,
      siteId: site.id,
      targetProductionUrl: site.productionUrl ?? "https://example.com",
      activeVersionId,
      technicalVerification: {
        status: (techObs?.status as MonitoringObservationStatus) ?? "UNAVAILABLE",
        checkedAt: techObs?.observedAt.toISOString() ?? null,
        summary: techObs?.errorMessage ?? (techObs ? "Production verification passed" : "No verification recorded"),
      },
      lastOperationalCheck: {
        status: (opObs?.status as MonitoringObservationStatus) ?? "UNAVAILABLE",
        checkedAt: opObs?.observedAt.toISOString() ?? null,
        summary: opObs?.errorMessage ?? (opObs ? "Operational ping passed" : "No operational check recorded"),
      },
      searchConsole: {
        status: (scObs?.status as MonitoringObservationStatus) ?? "NOT_CONFIGURED",
        checkedAt: scObs?.observedAt.toISOString() ?? null,
        indexCoverage: scMetrics.indexCoverageStatus ?? null,
        issues: Array.isArray(scMetrics.issues) ? scMetrics.issues : [],
        property: site.key,
      },
      lighthouse: {
        status: (lhObs?.status as MonitoringObservationStatus) ?? "UNAVAILABLE",
        checkedAt: lhObs?.observedAt.toISOString() ?? null,
        score: typeof lhMetrics.score === "number" ? lhMetrics.score : null,
        p75LcpMs: typeof lhMetrics.p75LcpMs === "number" ? lhMetrics.p75LcpMs : null,
        p75Cls: typeof lhMetrics.p75Cls === "number" ? lhMetrics.p75Cls : null,
      },
      fieldCwv: {
        status: (cruxObs?.status as MonitoringObservationStatus) ?? "INSUFFICIENT_DATA",
        checkedAt: cruxObs?.observedAt.toISOString() ?? null,
        p75LcpMs: typeof cruxMetrics.p75LcpMs === "number" ? cruxMetrics.p75LcpMs : null,
        p75InpMs: typeof cruxMetrics.p75InpMs === "number" ? cruxMetrics.p75InpMs : null,
        p75Cls: typeof cruxMetrics.p75Cls === "number" ? cruxMetrics.p75Cls : null,
      },
      observations: observations.map((o) => ({
        id: o.id,
        projectId: o.projectId,
        siteId: o.siteId,
        route: o.route,
        deploymentId: o.deploymentId,
        versionId: o.versionId,
        observationType: o.observationType as MonitoringObservationType,
        source: o.source as any,
        status: o.status as MonitoringObservationStatus,
        collectionWindow: o.collectionWindow,
        freshness: o.freshness,
        metrics: (o.metrics as Record<string, unknown>) ?? null,
        evidenceRef: o.evidenceRef,
        errorMessage: o.errorMessage,
        observedAt: o.observedAt.toISOString(),
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }
}
