import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  parseCompetitorPageAnalysisData,
  parseCompetitorPageSnapshotData,
  parseContentGapReportData,
  type SearchUsage,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedContentGapSnapshots,
  competitorClassificationOverrides,
  competitorPageAnalyses,
  competitorPageSnapshots,
  competitorRuns,
  contentGapDecisions,
  contentGapReports,
  searchIntelligenceSnapshots,
  serpSnapshots,
  type AcceptedContentGapSnapshotRecord,
  type CompetitorPageAnalysisRecord,
  type CompetitorPageSnapshotRecord,
  type CompetitorRunRecord,
  type ContentGapDecisionRecord,
  type ContentGapReportRecord,
} from "../persistence/schema.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * CompetitorStore — owns persistence for Competitors + Content Gap v0.
 *
 * Semantics (mirroring SearchStore):
 * - completed runs never mutate their snapshots; refresh = new observation;
 * - failed runs persist status='failed' and never masquerade as evidence;
 * - project isolation is enforced by projectId predicates on every read;
 * - JSONB payloads are re-parsed through the current contracts on read
 *   (fail closed on drift);
 * - accepted gap snapshots are immutable rows versioned per project.
 */
export class CompetitorStore {
  constructor(private readonly db: FactoryDb) {}

  // ---- Runs --------------------------------------------------------------

  async createRun(input: {
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    serpSnapshotId: string;
    serpSnapshotDigest: string;
    intelligenceSnapshotId: string;
    intelligenceSnapshotDigest: string;
    pipelineVersion: string;
  }): Promise<CompetitorRunRecord> {
    const [row] = await this.db
      .insert(competitorRuns)
      .values({ id: randomUUID(), status: "running", ...input })
      .returning();
    return row!;
  }

  async finishRun(
    runId: string,
    status: "succeeded" | "failed",
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.db
      .update(competitorRuns)
      .set({
        status,
        errorCode,
        errorMessage: errorMessage === null ? null : errorMessage.slice(0, 1024),
        finishedAt: new Date(),
        durationMs: sql`GREATEST(0, EXTRACT(EPOCH FROM (now() - ${competitorRuns.startedAt})) * 1000)::int`,
      })
      .where(eq(competitorRuns.id, runId));
  }

  async getRun(projectId: string, runId: string): Promise<CompetitorRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorRuns)
      .where(and(eq(competitorRuns.projectId, projectId), eq(competitorRuns.id, runId)));
    return row ?? null;
  }

  async listRuns(projectId: string, limit = 20): Promise<CompetitorRunRecord[]> {
    return await this.db
      .select()
      .from(competitorRuns)
      .where(eq(competitorRuns.projectId, projectId))
      .orderBy(desc(competitorRuns.createdAt))
      .limit(limit);
  }

  /** Latest succeeded run for a project (for gap proposal readiness). */
  async latestSucceededRun(projectId: string): Promise<CompetitorRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorRuns)
      .where(and(eq(competitorRuns.projectId, projectId), eq(competitorRuns.status, "succeeded")))
      .orderBy(desc(competitorRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ---- SERP/intelligence lineage lookups ---------------------------------

  /** Exact SERP snapshot for a project (project isolation enforced). */
  async getSerpSnapshot(
    projectId: string,
    serpSnapshotId: string,
  ): Promise<typeof serpSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(serpSnapshots)
      .where(and(eq(serpSnapshots.projectId, projectId), eq(serpSnapshots.id, serpSnapshotId)));
    return row ?? null;
  }

  /**
   * Intelligence snapshot bound to one SERP snapshot (Run 2 persisted the
   * serpSnapshotId on each intelligence row). Only succeeded lineage is used.
   */
  async getIntelligenceForSerpSnapshot(
    projectId: string,
    serpSnapshotId: string,
  ): Promise<typeof searchIntelligenceSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(searchIntelligenceSnapshots)
      .where(
        and(
          eq(searchIntelligenceSnapshots.projectId, projectId),
          eq(searchIntelligenceSnapshots.serpSnapshotId, serpSnapshotId),
        ),
      )
      .orderBy(desc(searchIntelligenceSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }

  async listSerpSnapshotsForProject(projectId: string, limit = 20) {
    return await this.db
      .select()
      .from(serpSnapshots)
      .where(eq(serpSnapshots.projectId, projectId))
      .orderBy(desc(serpSnapshots.observedAt))
      .limit(limit);
  }

  // ---- Page snapshots ------------------------------------------------------

  async insertPageSnapshot(input: {
    runId: string;
    projectId: string;
    serpSnapshotId: string;
    serpPosition: number;
    requestedUrl: string;
    finalUrl: string | null;
    domain: string;
    classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY";
    classificationReason: string;
    acquisitionStatus: "SUCCESS" | "BLOCKED" | "NON_HTML" | "UNSUPPORTED" | "FAILED";
    httpStatus: number | null;
    contentType: string | null;
    observedAt: Date;
    rawDigest: string | null;
    extractionDigest: string | null;
    extracted: unknown;
    contentDigest: string | null;
    dedupedFromSnapshotId: string | null;
    rawTruncated: boolean;
    provider: string;
  }): Promise<CompetitorPageSnapshotRecord> {
    // Fail closed: successful acquisitions must satisfy the current contract.
    if (input.acquisitionStatus === "SUCCESS") {
      parseCompetitorPageSnapshotData({
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl!,
        domain: input.domain,
        httpStatus: input.httpStatus!,
        contentType: input.contentType!,
        observedAt: input.observedAt.toISOString(),
        rawDigest: input.rawDigest!,
        extractionDigest: input.extractionDigest!,
        extracted: input.extracted,
        provider: input.provider,
        acquisitionMethodVersion: "direct-http-v1",
      });
    }
    const snapshotDigest = deterministicDigest({
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl,
      observedAt: input.observedAt.toISOString(),
      acquisitionStatus: input.acquisitionStatus,
      httpStatus: input.httpStatus,
      contentDigest: input.contentDigest,
      extractedDigest: input.extractionDigest,
      rawTruncated: input.rawTruncated,
      provider: input.provider,
    });
    const [row] = await this.db
      .insert(competitorPageSnapshots)
      .values({ id: randomUUID(), snapshotDigest, ...input })
      .returning();
    return row!;
  }

  async getPageSnapshot(
    projectId: string,
    pageSnapshotId: string,
  ): Promise<CompetitorPageSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(
        and(
          eq(competitorPageSnapshots.projectId, projectId),
          eq(competitorPageSnapshots.id, pageSnapshotId),
        ),
      );
    return row ?? null;
  }

  async listPageSnapshotsForRun(runId: string): Promise<CompetitorPageSnapshotRecord[]> {
    return await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(eq(competitorPageSnapshots.runId, runId))
      .orderBy(competitorPageSnapshots.serpPosition);
  }

  async listPageSnapshotsForProject(projectId: string, limit = 200) {
    return await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(eq(competitorPageSnapshots.projectId, projectId))
      .orderBy(desc(competitorPageSnapshots.observedAt))
      .limit(limit);
  }

  /**
   * Content-digest dedupe: an earlier SUCCESS snapshot in the same project
   * with the same content digest proves page equivalence. Lineage (SERP
   * occurrence) stays in this run's own snapshot row.
   */
  async findContentDedupeTarget(
    projectId: string,
    contentDigest: string,
  ): Promise<CompetitorPageSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(
        and(
          eq(competitorPageSnapshots.projectId, projectId),
          eq(competitorPageSnapshots.contentDigest, contentDigest),
          eq(competitorPageSnapshots.acquisitionStatus, "SUCCESS"),
        ),
      )
      .orderBy(desc(competitorPageSnapshots.observedAt))
      .limit(1);
    return row ?? null;
  }

  async insertClassificationOverride(input: {
    projectId: string;
    pageSnapshotId: string;
    classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY";
    reason: string;
  }): Promise<void> {
    await this.db.insert(competitorClassificationOverrides).values({
      id: randomUUID(),
      projectId: input.projectId,
      pageSnapshotId: input.pageSnapshotId,
      classification: input.classification,
      reason: input.reason,
    });
  }

  // ---- Analyses ----------------------------------------------------------

  async insertPageAnalysis(input: {
    runId: string;
    projectId: string;
    pageSnapshotId: string;
    model: string;
    provider: string;
    promptVersion: string;
    promptDigest: string;
    packetDigest: string;
    data: unknown;
    validSegmentIds: ReadonlySet<string>;
    usage: SearchUsage | null;
    observedAt: Date;
  }): Promise<CompetitorPageAnalysisRecord> {
    // Fail closed: analysis must satisfy the contract AND resolve every
    // evidence segment reference against the snapshot's real segments.
    const data = parseCompetitorPageAnalysisData(input.data, input.validSegmentIds);
    const snapshotDigest = deterministicDigest({
      pageSnapshotId: input.pageSnapshotId,
      model: input.model,
      promptVersion: input.promptVersion,
      packetDigest: input.packetDigest,
      data,
    });
    const [row] = await this.db
      .insert(competitorPageAnalyses)
      .values({
        id: randomUUID(),
        runId: input.runId,
        projectId: input.projectId,
        pageSnapshotId: input.pageSnapshotId,
        model: input.model,
        provider: input.provider,
        promptVersion: input.promptVersion,
        promptDigest: input.promptDigest,
        packetDigest: input.packetDigest,
        data,
        snapshotDigest,
        usage: input.usage,
        observedAt: input.observedAt,
      })
      .returning();
    return row!;
  }

  async listAnalysesForRun(runId: string): Promise<CompetitorPageAnalysisRecord[]> {
    return await this.db
      .select()
      .from(competitorPageAnalyses)
      .where(eq(competitorPageAnalyses.runId, runId));
  }

  async listAnalysesForProject(projectId: string, limit = 200) {
    return await this.db
      .select()
      .from(competitorPageAnalyses)
      .where(eq(competitorPageAnalyses.projectId, projectId))
      .orderBy(desc(competitorPageAnalyses.createdAt))
      .limit(limit);
  }

  /**
   * Analysis reuse: same page snapshot + same model + same prompt version
   * proves analysis equivalence (no duplicate model spend for identical
   * content within the same analysis policy).
   */
  async findAnalysisForPage(
    pageSnapshotId: string,
    model: string,
    promptVersion: string,
  ): Promise<CompetitorPageAnalysisRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorPageAnalyses)
      .where(
        and(
          eq(competitorPageAnalyses.pageSnapshotId, pageSnapshotId),
          eq(competitorPageAnalyses.model, model),
          eq(competitorPageAnalyses.promptVersion, promptVersion),
        ),
      )
      .orderBy(desc(competitorPageAnalyses.createdAt))
      .limit(1);
    return row ?? null;
  }

  async getAnalysis(projectId: string, analysisId: string): Promise<CompetitorPageAnalysisRecord | null> {
    const [row] = await this.db
      .select()
      .from(competitorPageAnalyses)
      .where(
        and(
          eq(competitorPageAnalyses.projectId, projectId),
          eq(competitorPageAnalyses.id, analysisId),
        ),
      );
    return row ?? null;
  }

  // ---- Content gap reports -------------------------------------------------

  async insertGapReport(input: {
    runId: string;
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    serpSnapshotId: string;
    serpSnapshotDigest: string;
    intelligenceSnapshotId: string;
    intelligenceSnapshotDigest: string;
    model: string;
    provider: string;
    promptVersion: string;
    data: unknown;
  }): Promise<ContentGapReportRecord> {
    const data = parseContentGapReportData(input.data);
    const snapshotDigest = deterministicDigest({
      runId: input.runId,
      model: input.model,
      promptVersion: input.promptVersion,
      data,
    });
    const [row] = await this.db
      .insert(contentGapReports)
      .values({
        id: randomUUID(),
        snapshotDigest,
        reviewState: "model_proposed",
        ...input,
        data,
      })
      .returning();
    return row!;
  }

  async getGapReport(projectId: string, reportId: string): Promise<ContentGapReportRecord | null> {
    const [row] = await this.db
      .select()
      .from(contentGapReports)
      .where(
        and(eq(contentGapReports.projectId, projectId), eq(contentGapReports.id, reportId)),
      );
    if (!row) return null;
    parseContentGapReportData(row.data);
    return row;
  }

  async listGapReports(projectId: string, limit = 20): Promise<ContentGapReportRecord[]> {
    return await this.db
      .select()
      .from(contentGapReports)
      .where(eq(contentGapReports.projectId, projectId))
      .orderBy(desc(contentGapReports.createdAt))
      .limit(limit);
  }

  async markGapReportReviewed(reportId: string): Promise<void> {
    await this.db
      .update(contentGapReports)
      .set({ reviewState: "operator_reviewed" })
      .where(eq(contentGapReports.id, reportId));
  }

  // ---- Decisions -------------------------------------------------------------

  async replaceDecisions(
    projectId: string,
    reportId: string,
    decisions: Array<{
      gapId: string;
      disposition: string;
      priority: string | null;
      note: string | null;
    }>,
  ): Promise<ContentGapDecisionRecord[]> {
    await this.db
      .delete(contentGapDecisions)
      .where(
        and(
          eq(contentGapDecisions.projectId, projectId),
          eq(contentGapDecisions.reportId, reportId),
        ),
      );
    if (decisions.length === 0) return [];
    const rows = await this.db
      .insert(contentGapDecisions)
      .values(decisions.map((d) => ({ id: randomUUID(), projectId, reportId, ...d })))
      .returning();
    return rows;
  }

  async listDecisions(reportId: string): Promise<ContentGapDecisionRecord[]> {
    return await this.db
      .select()
      .from(contentGapDecisions)
      .where(eq(contentGapDecisions.reportId, reportId))
      .orderBy(contentGapDecisions.gapId);
  }

  // ---- Accepted snapshots -------------------------------------------------------

  async latestAcceptedGapVersion(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ version: acceptedContentGapSnapshots.version })
      .from(acceptedContentGapSnapshots)
      .where(eq(acceptedContentGapSnapshots.projectId, projectId))
      .orderBy(desc(acceptedContentGapSnapshots.version))
      .limit(1);
    return row?.version ?? 0;
  }

  async insertAcceptedGapSnapshot(input: {
    projectId: string;
    version: number;
    reportId: string;
    reportDigest: string;
    decisionsDigest: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    serpSnapshotId: string;
    serpSnapshotDigest: string;
    intelligenceSnapshotId: string;
    intelligenceSnapshotDigest: string;
    pageSnapshotRefs: Array<{ id: string; digest: string }>;
    analysisRefs: Array<{ id: string; digest: string }>;
    data: unknown;
  }): Promise<AcceptedContentGapSnapshotRecord> {
    const snapshotDigest = deterministicDigest({
      projectId: input.projectId,
      version: input.version,
      reportId: input.reportId,
      reportDigest: input.reportDigest,
      decisionsDigest: input.decisionsDigest,
      data: input.data,
    });
    const [row] = await this.db
      .insert(acceptedContentGapSnapshots)
      .values({ id: randomUUID(), snapshotDigest, ...input })
      .returning();
    return row!;
  }

  async getAcceptedGapSnapshot(
    projectId: string,
    version: number,
  ): Promise<AcceptedContentGapSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedContentGapSnapshots)
      .where(
        and(
          eq(acceptedContentGapSnapshots.projectId, projectId),
          eq(acceptedContentGapSnapshots.version, version),
        ),
      );
    return row ?? null;
  }

  async listAcceptedGapSnapshots(projectId: string): Promise<AcceptedContentGapSnapshotRecord[]> {
    return await this.db
      .select()
      .from(acceptedContentGapSnapshots)
      .where(eq(acceptedContentGapSnapshots.projectId, projectId))
      .orderBy(desc(acceptedContentGapSnapshots.version));
  }

  // ---- Budget ------------------------------------------------------------

  /**
   * Budget gate input: recorded model/analysis cost today (UTC) from
   * competitor page analyses. Null costs (UNKNOWN) are uncounted, never
   * fabricated. SERP acquisition cost lives in the search domain's own gate.
   */
  async sumTodayCompetitorCostMicros(): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum((${competitorPageAnalyses.usage} -> 'costMicros')::numeric), 0)`,
      })
      .from(competitorPageAnalyses)
      .where(
        sql`${competitorPageAnalyses.createdAt} >= date_trunc('day', now() at time zone 'utc')`,
      );
    const total = Number(row?.total ?? 0);
    return Number.isFinite(total) && total > 0 ? Math.round(total) : 0;
  }

  // ---- Batch helpers -------------------------------------------------------

  async pageSnapshotsByIds(projectId: string, ids: string[]) {
    if (ids.length === 0) return [];
    return await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(
        and(
          eq(competitorPageSnapshots.projectId, projectId),
          inArray(competitorPageSnapshots.id, ids),
        ),
      );
  }
}
