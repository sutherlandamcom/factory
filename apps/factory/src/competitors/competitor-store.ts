import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  parseAcceptedContentGapSnapshotData,
  parseCompetitorPageAnalysisData,
  parseCompetitorPageSnapshotData,
  parseContentGapReportData,
  type ContentGapReportData,
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
import { decisionsDigest } from "./gap-engine.js";
import { FactoryError } from "../executor/errors.js";

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

  async getIntelligenceSnapshot(
    projectId: string,
    intelligenceSnapshotId: string,
  ): Promise<typeof searchIntelligenceSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(searchIntelligenceSnapshots)
      .where(
        and(
          eq(searchIntelligenceSnapshots.projectId, projectId),
          eq(searchIntelligenceSnapshots.id, intelligenceSnapshotId),
        ),
      );
    return row ?? null;
  }

  async getLatestIntelligenceForQuery(
    projectId: string,
    query: string,
  ): Promise<typeof searchIntelligenceSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(searchIntelligenceSnapshots)
      .where(
        and(
          eq(searchIntelligenceSnapshots.projectId, projectId),
          eq(searchIntelligenceSnapshots.query, query),
        ),
      )
      .orderBy(desc(searchIntelligenceSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }

  async getLatestSerpForQuery(
    projectId: string,
    query: string,
  ): Promise<typeof serpSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(serpSnapshots)
      .where(
        and(
          eq(serpSnapshots.projectId, projectId),
          eq(serpSnapshots.query, query),
        ),
      )
      .orderBy(desc(serpSnapshots.observedAt))
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
    reusedFromAnalysisId?: string | null;
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
      reusedFromAnalysisId: input.reusedFromAnalysisId ?? null,
      data,
    });
    const [row] = await this.db
      .insert(competitorPageAnalyses)
      .values({
        id: randomUUID(),
        runId: input.runId,
        projectId: input.projectId,
        pageSnapshotId: input.pageSnapshotId,
        reusedFromAnalysisId: input.reusedFromAnalysisId ?? null,
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
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
      costMicros?: number | null;
    } | null;
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
        reviewRevision: 0,
        decisionsDigest: null,
        usage: input.usage ?? null,
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

  async markGapReportAccepted(reportId: string): Promise<void> {
    await this.db
      .update(contentGapReports)
      .set({ reviewState: "accepted" })
      .where(eq(contentGapReports.id, reportId));
  }

  // ---- Decisions -------------------------------------------------------------

  async saveGapDecisionsWithConcurrency(input: {
    projectId: string;
    reportId: string;
    expectedReviewRevision: number;
    decisions: Array<{
      gapId: string;
      disposition: string;
      priority: string | null;
      note: string | null;
    }>;
  }): Promise<{ reviewRevision: number; decisionsDigest: string }> {
    return await this.db.transaction(async (tx) => {
      const [report] = await tx
        .select()
        .from(contentGapReports)
        .where(
          and(
            eq(contentGapReports.projectId, input.projectId),
            eq(contentGapReports.id, input.reportId),
          ),
        )
        .for("update");
      if (!report) {
        throw new FactoryError("content_gap_report_not_found", "Content gap report not found.");
      }
      if (report.reviewState === "accepted") {
        throw new FactoryError(
          "content_gap_decision_invalid",
          "Cannot modify decisions for an already accepted content gap report.",
        );
      }
      if (report.reviewRevision !== input.expectedReviewRevision) {
        throw new FactoryError(
          "content_gap_stale",
          `Review revision mismatch: review was updated concurrently (expected rev ${input.expectedReviewRevision}, current rev ${report.reviewRevision}).`,
        );
      }
      await tx
        .delete(contentGapDecisions)
        .where(
          and(
            eq(contentGapDecisions.projectId, input.projectId),
            eq(contentGapDecisions.reportId, input.reportId),
          ),
        );
      if (input.decisions.length > 0) {
        await tx.insert(contentGapDecisions).values(
          input.decisions.map((d) => ({
            id: randomUUID(),
            projectId: input.projectId,
            reportId: input.reportId,
            ...d,
          })),
        );
      }
      const newDigest = decisionsDigest(report.snapshotDigest, input.decisions);
      const newRevision = report.reviewRevision + 1;
      await tx
        .update(contentGapReports)
        .set({
          reviewRevision: newRevision,
          decisionsDigest: newDigest,
          reviewState: "operator_reviewed",
        })
        .where(eq(contentGapReports.id, input.reportId));

      return { reviewRevision: newRevision, decisionsDigest: newDigest };
    });
  }

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

  /**
   * Atomic acceptance of a content gap report:
   * 1. Acquires row lock on contentGapReports (for update).
   * 2. Validates expectedReportDigest, expectedReviewRevision, expectedDecisionsDigest inside tx.
   * 3. Handles idempotent re-acceptance if already accepted with identical digests.
   * 4. Reads decisions inside tx and validates count and decisions digest.
   * 5. Runs validateStaleness inside tx (or callback).
   * 6. Materializes decisions into accepted gap snapshot data.
   * 7. Determines next version and inserts acceptedContentGapSnapshots row.
   * 8. Marks contentGapReports as reviewState='accepted'.
   * 9. Commits atomically.
   */
  async acceptGapReportAtomic(input: {
    projectId: string;
    reportId: string;
    expectedReportDigest: string;
    expectedReviewRevision: number;
    expectedDecisionsDigest: string;
    validateStaleness: (report: ContentGapReportRecord, reportData: ContentGapReportData) => Promise<void>;
  }): Promise<{ version: number; snapshotId: string }> {
    return await this.db.transaction(async (tx) => {
      const [report] = await tx
        .select()
        .from(contentGapReports)
        .where(
          and(
            eq(contentGapReports.projectId, input.projectId),
            eq(contentGapReports.id, input.reportId),
          ),
        )
        .for("update");
      if (!report) {
        throw new FactoryError("content_gap_report_not_found", "Content gap report not found.");
      }

      if (input.expectedReportDigest !== report.snapshotDigest) {
        throw new FactoryError(
          "content_gap_accept_failed",
          "Report digest mismatch: the report changed since review. Re-review and retry.",
        );
      }

      if (report.reviewRevision !== input.expectedReviewRevision) {
        throw new FactoryError(
          "content_gap_stale",
          `Review revision mismatch: review was updated concurrently (expected rev ${input.expectedReviewRevision}, current rev ${report.reviewRevision}). Re-review and retry.`,
        );
      }

      if (!report.decisionsDigest || report.decisionsDigest !== input.expectedDecisionsDigest) {
        throw new FactoryError(
          "content_gap_accept_failed",
          "Decisions digest mismatch: review decisions changed since review. Re-review and retry.",
        );
      }

      const [existingSnapshot] = await tx
        .select()
        .from(acceptedContentGapSnapshots)
        .where(eq(acceptedContentGapSnapshots.reportId, input.reportId))
        .limit(1);

      if (existingSnapshot) {
        if (
          existingSnapshot.decisionsDigest === input.expectedDecisionsDigest &&
          existingSnapshot.reportDigest === input.expectedReportDigest
        ) {
          return { version: existingSnapshot.version, snapshotId: existingSnapshot.id };
        }
        throw new FactoryError(
          "content_gap_accept_failed",
          "Report was already accepted with different decisions.",
        );
      }

      const decisions = await tx
        .select()
        .from(contentGapDecisions)
        .where(eq(contentGapDecisions.reportId, input.reportId))
        .orderBy(contentGapDecisions.gapId);

      const reportData = report.data as ContentGapReportData;
      if (decisions.length !== reportData.gaps.length) {
        throw new FactoryError(
          "content_gap_accept_failed",
          "Acceptance requires a recorded decision for every gap.",
        );
      }

      const currentDecDigest = decisionsDigest(
        report.snapshotDigest,
        decisions.map((d) => ({
          gapId: d.gapId,
          disposition: d.disposition,
          priority: d.priority,
          note: d.note,
        })),
      );

      if (currentDecDigest !== input.expectedDecisionsDigest) {
        throw new FactoryError(
          "content_gap_accept_failed",
          "Decisions digest mismatch: review decisions changed since review. Re-review and retry.",
        );
      }

      await input.validateStaleness(report, reportData);

      const decisionByGapId = new Map(decisions.map((d) => [d.gapId, d]));
      const materializedGaps = reportData.gaps.map((g) => {
        const d = decisionByGapId.get(g.id);
        if (!d) {
          throw new FactoryError("content_gap_accept_failed", `Missing decision for gap "${g.id}".`);
        }
        return {
          ...g,
          recommendedDisposition: g.recommendedDisposition,
          recommendedPriority: g.priority ?? null,
          disposition: d.disposition as "REQUIRED" | "OPTIONAL" | "EXCLUDE",
          priority: (d.priority as "HIGH" | "MEDIUM" | "LOW" | null) ?? g.priority ?? null,
          note: d.note ?? null,
        };
      });

      const acceptedData = parseAcceptedContentGapSnapshotData({
        ...reportData,
        classificationDigest: reportData.classificationDigest,
        effectiveClassifications: reportData.effectiveClassifications,
        gaps: materializedGaps,
        decisions: decisions.map((d) => ({
          gapId: d.gapId,
          disposition: d.disposition,
          priority: d.priority ?? null,
          note: d.note ?? null,
        })),
        reviewState: "accepted",
      });

      const [latestRow] = await tx
        .select({ version: acceptedContentGapSnapshots.version })
        .from(acceptedContentGapSnapshots)
        .where(eq(acceptedContentGapSnapshots.projectId, input.projectId))
        .orderBy(desc(acceptedContentGapSnapshots.version))
        .limit(1);

      const version = (latestRow?.version ?? 0) + 1;
      const snapshotDigest = deterministicDigest({
        projectId: input.projectId,
        version,
        reportId: report.id,
        reportDigest: report.snapshotDigest,
        decisionsDigest: currentDecDigest,
        data: acceptedData,
      });

      const [snapshot] = await tx
        .insert(acceptedContentGapSnapshots)
        .values({
          id: randomUUID(),
          projectId: input.projectId,
          version,
          reportId: report.id,
          reportDigest: report.snapshotDigest,
          decisionsDigest: currentDecDigest,
          acceptedInputSnapshotId: report.acceptedInputSnapshotId,
          acceptedInputVersion: report.acceptedInputVersion,
          acceptedInputDigest: report.acceptedInputDigest,
          serpSnapshotId: report.serpSnapshotId,
          serpSnapshotDigest: report.serpSnapshotDigest,
          intelligenceSnapshotId: report.intelligenceSnapshotId,
          intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
          pageSnapshotRefs: reportData.pageSnapshotRefs ?? [],
          analysisRefs: reportData.analysisRefs ?? [],
          data: acceptedData,
          snapshotDigest,
        })
        .returning();

      await tx
        .update(contentGapReports)
        .set({ reviewState: "accepted" })
        .where(eq(contentGapReports.id, report.id));

      return { version: snapshot!.version, snapshotId: snapshot!.id };
    });
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

  async getAcceptedGapSnapshotByReportId(
    reportId: string,
  ): Promise<AcceptedContentGapSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedContentGapSnapshots)
      .where(eq(acceptedContentGapSnapshots.reportId, reportId))
      .limit(1);
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
   * competitor page analyses AND PASS-2 aggregate content gap proposals.
   * Null costs (UNKNOWN) are uncounted, never fabricated. SERP acquisition
   * cost lives in the search domain's own gate.
   */
  async sumTodayCompetitorCostMicros(): Promise<number> {
    const [pageRow] = await this.db
      .select({
        total: sql<number>`coalesce(sum((${competitorPageAnalyses.usage} -> 'costMicros')::numeric), 0)`,
      })
      .from(competitorPageAnalyses)
      .where(
        sql`${competitorPageAnalyses.createdAt} >= date_trunc('day', now() at time zone 'utc')`,
      );
    const [gapRow] = await this.db
      .select({
        total: sql<number>`coalesce(sum((${contentGapReports.usage} -> 'costMicros')::numeric), 0)`,
      })
      .from(contentGapReports)
      .where(
        sql`${contentGapReports.createdAt} >= date_trunc('day', now() at time zone 'utc')`,
      );
    const pageTotal = Number(pageRow?.total ?? 0);
    const gapTotal = Number(gapRow?.total ?? 0);
    const total = (Number.isFinite(pageTotal) ? pageTotal : 0) + (Number.isFinite(gapTotal) ? gapTotal : 0);
    return total > 0 ? Math.round(total) : 0;
  }

  private activeReservationsMicros = 0;
  private reservationLock = Promise.resolve();

  private async withReservationLock<T>(fn: () => Promise<T>): Promise<T> {
    const prevLock = this.reservationLock;
    let release: () => void;
    this.reservationLock = new Promise((resolve) => {
      release = resolve;
    });
    await prevLock;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * Concurrency-safe budget reservation.
   *
   * Enforces fail-closed hard ceiling:
   *   spentToday + activeReservations + estimatedCostMicros <= dailyBudgetMicros
   *
   * Blocks execution before external spend occurs. Returns a release callback
   * that decrements activeReservations in finally blocks.
   */
  async reserveBudget(estimatedCostMicros: number, dailyLimitUsd: number): Promise<() => void> {
    return await this.withReservationLock(async () => {
      const budgetMicros = Math.round(dailyLimitUsd * 1_000_000);
      const spentToday = await this.sumTodayCompetitorCostMicros();
      if (spentToday + this.activeReservationsMicros + estimatedCostMicros > budgetMicros) {
        throw new FactoryError(
          "competitor_budget_blocked",
          `Daily competitor budget reached (${dailyLimitUsd} USD).`,
        );
      }
      this.activeReservationsMicros += estimatedCostMicros;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.activeReservationsMicros = Math.max(0, this.activeReservationsMicros - estimatedCostMicros);
        }
      };
    });
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

  async analysesByIds(projectId: string, ids: string[]): Promise<CompetitorPageAnalysisRecord[]> {
    if (ids.length === 0) return [];
    return await this.db
      .select()
      .from(competitorPageAnalyses)
      .where(
        and(
          eq(competitorPageAnalyses.projectId, projectId),
          inArray(competitorPageAnalyses.id, ids),
        ),
      );
  }

  async getLatestClassificationOverridesForPages(
    projectId: string,
    pageSnapshotIds: string[],
  ): Promise<Map<string, { classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY"; reason: string }>> {
    if (pageSnapshotIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(competitorClassificationOverrides)
      .where(
        and(
          eq(competitorClassificationOverrides.projectId, projectId),
          inArray(competitorClassificationOverrides.pageSnapshotId, pageSnapshotIds),
        ),
      )
      .orderBy(desc(competitorClassificationOverrides.createdAt));

    const map = new Map<string, { classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY"; reason: string }>();
    for (const r of rows) {
      if (!map.has(r.pageSnapshotId)) {
        map.set(r.pageSnapshotId, {
          classification: r.classification as "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY",
          reason: r.reason,
        });
      }
    }
    return map;
  }

  async getLatestSerpForSearchIdentity(
    projectId: string,
    identity: {
      query: string;
      location: string | null;
      language: string | null;
      device: string;
    },
  ): Promise<typeof serpSnapshots.$inferSelect | null> {
    const conditions = [
      eq(serpSnapshots.projectId, projectId),
      eq(serpSnapshots.query, identity.query),
      eq(serpSnapshots.device, identity.device),
    ];
    if (identity.location != null) {
      conditions.push(eq(serpSnapshots.location, identity.location));
    } else {
      conditions.push(sql`${serpSnapshots.location} IS NULL`);
    }
    if (identity.language != null) {
      conditions.push(eq(serpSnapshots.language, identity.language));
    } else {
      conditions.push(sql`${serpSnapshots.language} IS NULL`);
    }
    const [row] = await this.db
      .select()
      .from(serpSnapshots)
      .where(and(...conditions))
      .orderBy(desc(serpSnapshots.observedAt))
      .limit(1);
    return row ?? null;
  }

  async getLatestIntelligenceForSearchIdentity(
    projectId: string,
    identity: {
      query: string;
      location: string | null;
      language: string | null;
      device: string;
    },
  ): Promise<typeof searchIntelligenceSnapshots.$inferSelect | null> {
    const latestSerp = await this.getLatestSerpForSearchIdentity(projectId, identity);
    if (!latestSerp) return null;
    return await this.getIntelligenceForSerpSnapshot(projectId, latestSerp.id);
  }

  async getLatestPageSnapshotForUrl(
    projectId: string,
    requestedUrl: string,
  ): Promise<typeof competitorPageSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(competitorPageSnapshots)
      .where(
        and(
          eq(competitorPageSnapshots.projectId, projectId),
          eq(competitorPageSnapshots.requestedUrl, requestedUrl),
        ),
      )
      .orderBy(desc(competitorPageSnapshots.observedAt))
      .limit(1);
    return row ?? null;
  }

  async latestSucceededRunForSerp(
    projectId: string,
    serpSnapshotId: string,
  ): Promise<typeof competitorRuns.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(competitorRuns)
      .where(
        and(
          eq(competitorRuns.projectId, projectId),
          eq(competitorRuns.serpSnapshotId, serpSnapshotId),
          eq(competitorRuns.status, "succeeded"),
        ),
      )
      .orderBy(desc(competitorRuns.createdAt))
      .limit(1);
    return row ?? null;
  }
}
