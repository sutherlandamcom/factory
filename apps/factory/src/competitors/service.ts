import {
  parseAcceptedContentGapSnapshotData,
  type CompetitorAcquisitionStatus,
  type CompetitorCandidate,
  type CompetitorClassification,
  type CompetitorPageAnalysisData,
  type CompetitorPageExtracted,
  type ContentGap,
  type ContentGapReportData,
  type GapDecisionRecord,
  type SearchIntelligenceData,
  type SerpSnapshotData,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { ProjectIntakeStore } from "../operator/intake-store.js";
import type { CompetitorStore } from "./competitor-store.js";
import type { AcceptedContentGapSnapshotRecord } from "../persistence/schema.js";
import { DirectHttpPageProvider, type CompetitorPageProvider, type PageAcquisitionOutcome } from "./direct-http.js";
import { extractCompetitorPage } from "./extract.js";
import { buildEvidencePacket } from "./packet.js";
import {
  FixtureCompetitorAnalyst,
  OpenRouterCompetitorAnalyst,
  type CompetitorAnalystModel,
} from "./analyst.js";
import {
  buildCoverageMatrix,
  collectFirstPartyEvidence,
  computeGapStaleness,
  decisionsDigest as computeDecisionsDigest,
  finalizeGapReport,
} from "./gap-engine.js";
import {
  FixtureGapAnalyst,
  OpenRouterGapAnalyst,
  type GapAnalystModel,
} from "./gap-analyst.js";

/**
 * CompetitorContentGapService — the governed application service (P6).
 *
 * Vertical pipeline:
 * resolve accepted upstreams -> select candidates from the persisted SERP
 * -> acquire (SSRF-safe, bounded) -> extract deterministically -> analyze
 * (bounded, evidence-ref'd) -> aggregate proposal (two-pass) -> review ->
 * accept immutable versioned snapshot.
 *
 * Trusted configuration owns provider mode/budgets; the browser can only
 * reference existing persisted artifacts (never fetch URLs, providers or
 * prompts). All semantics live here; the Operator API is a thin projection.
 */

export const COMPETITOR_PIPELINE_VERSION = "competitor-pipeline-v1";

export interface CompetitorServiceConfig {
  /** Trusted mode: fixture (CI/E2E, zero external calls) or production. */
  mode: "production" | "fixture";
  /** Max pages acquired per run (<=10 enforced). */
  maxPages: number;
  /** Max concurrent fetches. */
  maxConcurrency: number;
  /** Daily spend ceiling for recorded competitor/analysis costs (USD). */
  dailyLimitUsd: number;
}

export const DEFAULT_COMPETITOR_CONFIG: CompetitorServiceConfig = {
  mode: "production",
  maxPages: 10,
  maxConcurrency: 3,
  dailyLimitUsd: 5,
};

/**
 * Conservative bounded cost reservations for pre-invocation budget checks.
 * Fail-closed before provider execution: spent + reserved <= dailyLimit.
 */
export const RESERVED_PAGE_ANALYSIS_COST_MICROS = 10_000; // $0.01
export const RESERVED_GAP_ANALYSIS_COST_MICROS = 20_000; // $0.02

export interface CompetitorServiceDeps {
  intake: ProjectIntakeStore;
  competitorStore: CompetitorStore;
  pageProvider?: CompetitorPageProvider;
  competitorAnalyst: CompetitorAnalystModel;
  gapAnalyst: GapAnalystModel;
  config?: Partial<CompetitorServiceConfig>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Classification heuristics (deterministic, versioned)
// ---------------------------------------------------------------------------

export const CLASSIFICATION_POLICY_VERSION = "classification-v1";

const EXCLUDE_HOST_PATTERNS = [
  /^www\.google\./,
  /facebook\.com$/,
  /instagram\.com$/,
  /pinterest\./,
  /linkedin\.com$/,
  /twitter\.com$/,
  /x\.com$/,
  /amazon\./,
  /booking\.com$/,
  /airbnb\./,
  /tripadvisor\./,
  /\.gouv\.fr$/,
  /\.gov$/,
  /\.edu$/,
];

const REFERENCE_HOST_PATTERNS = [
  /reddit\.com$/,
  /youtube\.com$/,
  /youtu\.be$/,
  /wikipedia\.org$/,
  /forum/,
];

function classifyCandidate(url: string, domain: string): { classification: CompetitorClassification; reason: string; kind: CompetitorCandidate["kind"] } {
  const lower = url.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return { classification: "REFERENCE_ONLY", reason: "PDF document: acquired evidence only, not an HTML competitor page.", kind: "document" };
  }
  if (EXCLUDE_HOST_PATTERNS.some((p) => p.test(domain))) {
    return { classification: "EXCLUDE", reason: "Aggregator/marketplace/social/government domain, not a direct competitor.", kind: /amazon\.|booking\.|airbnb\.|tripadvisor\./.test(domain) ? "marketplace" : "other" };
  }
  if (REFERENCE_HOST_PATTERNS.some((p) => p.test(domain))) {
    return { classification: "REFERENCE_ONLY", reason: "Community/video/encyclopedia source: reference context, not a competing page.", kind: domain.includes("reddit") || domain.includes("forum") ? "forum" : "video" };
  }
  if (/annuaire|directory|list/.test(lower)) {
    return { classification: "REFERENCE_ONLY", reason: "Directory-style result; reference context only.", kind: "directory" };
  }
  return { classification: "INCLUDE", reason: "Organic result plausibly competing for this query intent.", kind: "editorial_guide" };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface CompetitorRunReadModel {
  run: {
    id: string;
    status: "succeeded" | "failed";
    serpSnapshotId: string;
    pipelineVersion: string;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  acceptedInput: { snapshotId: string; version: number; digest: string; stale: boolean };
  candidates: Array<{
    pageSnapshotId: string;
    serpPosition: number;
    requestedUrl: string;
    domain: string;
    classification: CompetitorClassification;
    classificationReason: string;
    acquisitionStatus: CompetitorAcquisitionStatus;
    httpStatus: number | null;
    observedAt: string;
    analyzed: boolean;
    dedupedFromSnapshotId: string | null;
    pageType: string | null;
    topics: string[];
    questions: string[];
    freshness: string | null;
    commercialPositioning: string | null;
    evidenceSegmentCount: number;
  }>;
  usage: { competitorPagesFetched: number; analyzedCount: number; blockedCount: number; failedCount: number };
}

export interface CompetitorWorkspaceReadModel {
  acceptedInput: { snapshotId: string; version: number; digest: string } | null;
  readiness: { canRun: boolean; blockers: string[]; mode: "production" | "fixture" };
  serpRuns: Array<{ serpSnapshotId: string; query: string; observedAt: string; hasIntelligence: boolean; stale?: boolean }>;
  recentRuns: Array<{ id: string; status: string; startedAt: string; errorCode: string | null }>;
}

export interface GapWorkspaceReadModel {
  reports: Array<{
    id: string;
    snapshotDigest: string;
    reviewState: string;
    createdAt: string;
    gapCounts: { total: number; required: number; optional: number; excluded: number };
    serpSnapshotId: string;
    stale: boolean;
    staleReasons: string[];
  }>;
  accepted: Array<{
    id: string;
    version: number;
    snapshotDigest: string;
    acceptedAt: string;
    reportId: string;
    stale: boolean;
    staleReasons: string[];
    gapCounts: { total: number; required: number; optional: number; excluded: number };
  }>;
  readiness: { canPropose: boolean; blockers: string[] };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CompetitorContentGapService {
  private readonly config: CompetitorServiceConfig;
  private readonly now: () => Date;
  private readonly pageProvider: CompetitorPageProvider;

  constructor(private readonly deps: CompetitorServiceDeps) {
    this.config = { ...DEFAULT_COMPETITOR_CONFIG, ...deps.config };
    this.now = deps.now ?? (() => new Date());
    this.pageProvider = deps.pageProvider ?? new DirectHttpPageProvider();
  }

  private async resolveAcceptedInputs(projectId: string) {
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const accepted = snapshots.at(-1);
    if (!accepted) {
      throw new FactoryError(
        "competitor_input_not_accepted",
        "No accepted ProjectInputSnapshot for this project. Complete Intake acceptance first.",
      );
    }
    return { accepted, snapshots };
  }

  private async checkBudget(reservedCostMicros = 0): Promise<() => void> {
    if (typeof this.deps.competitorStore.reserveBudget === "function") {
      return await this.deps.competitorStore.reserveBudget(reservedCostMicros, this.config.dailyLimitUsd);
    }
    const budgetMicros = this.config.dailyLimitUsd * 1_000_000;
    const spent = await this.deps.competitorStore.sumTodayCompetitorCostMicros();
    if (spent + reservedCostMicros > budgetMicros || spent >= budgetMicros) {
      throw new FactoryError(
        "competitor_budget_blocked",
        `Daily competitor budget reached (${this.config.dailyLimitUsd} USD).`,
      );
    }
    return () => {};
  }

  // ---- Workspace ----------------------------------------------------------

  async workspace(projectId: string): Promise<CompetitorWorkspaceReadModel> {
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latest = snapshots.at(-1) ?? null;
    const serpRows = await this.deps.competitorStore.listSerpSnapshotsForProject(projectId, 20);
    const serpRuns = [];
    for (const serp of serpRows) {
      const intel = await this.deps.competitorStore.getIntelligenceForSerpSnapshot(projectId, serp.id);
      const isStale = latest ? serp.acceptedInputDigest !== latest.digest : false;
      serpRuns.push({
        serpSnapshotId: serp.id,
        query: serp.query,
        observedAt: serp.observedAt.toISOString(),
        hasIntelligence: Boolean(intel),
        stale: isStale,
      });
    }
    const blockers: string[] = [];
    if (!latest) blockers.push("No accepted project inputs. Complete Intake first.");
    const usable = serpRuns.filter((s) => s.hasIntelligence && !s.stale);
    if (latest && usable.length === 0) {
      blockers.push("No fresh search run with SERP + intelligence evidence for current accepted inputs. Run Search first.");
    }
    if (this.deps.competitorAnalyst.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
      blockers.push("OpenRouter API key is required for competitor analysis in production mode.");
    }
    const recentRuns = await this.deps.competitorStore.listRuns(projectId, 20);
    return {
      acceptedInput: latest
        ? { snapshotId: latest.id, version: latest.version, digest: latest.digest }
        : null,
      readiness: { canRun: blockers.length === 0, blockers, mode: this.config.mode },
      serpRuns,
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        errorCode: r.errorCode,
      })),
    };
  }

  // ---- Run ------------------------------------------------------------------

  async runCompetitors(input: {
    projectId: string;
    serpSnapshotId: string;
    maxPages?: number;
  }): Promise<CompetitorRunReadModel> {
    if (this.deps.competitorAnalyst.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
      throw new FactoryError(
        "competitor_analyst_not_configured",
        "OpenRouter API key is required for competitor analysis in production mode (fail closed).",
      );
    }
    const { accepted, snapshots } = await this.resolveAcceptedInputs(input.projectId);
    await this.checkBudget();

    const serp = await this.deps.competitorStore.getSerpSnapshot(input.projectId, input.serpSnapshotId);
    if (!serp) {
      throw new FactoryError("competitor_serp_not_found", "SERP snapshot not found for this project.");
    }
    if (serp.acceptedInputDigest !== accepted.digest) {
      throw new FactoryError(
        "competitor_upstream_stale",
        `Selected SERP snapshot was generated for ProjectInput digest "${serp.acceptedInputDigest}", but current accepted ProjectInput digest is "${accepted.digest}". Run Search for current inputs first.`,
      );
    }
    const intelligence = await this.deps.competitorStore.getIntelligenceForSerpSnapshot(
      input.projectId,
      input.serpSnapshotId,
    );
    if (!intelligence) {
      throw new FactoryError(
        "competitor_serp_not_found",
        "No Search Intelligence snapshot is bound to this SERP evidence. Run Search first.",
      );
    }
    if (intelligence.acceptedInputDigest !== accepted.digest) {
      throw new FactoryError(
        "competitor_upstream_stale",
        `Bound Search Intelligence was generated for ProjectInput digest "${intelligence.acceptedInputDigest}", but current accepted ProjectInput digest is "${accepted.digest}". Run Search for current inputs first.`,
      );
    }

    const serpData = serp.organic as SerpSnapshotData["organic"];
    const maxPages = Math.min(Math.max(1, input.maxPages ?? this.config.maxPages), 10);

    // Candidate selection: INCLUDE candidates from persisted organic results
    // (SERP rank preserved), bounded by maxPages.
    const candidates: CompetitorCandidate[] = [];
    for (const organic of serpData) {
      const { classification, reason, kind } = classifyCandidate(organic.url, organic.domain);
      if (classification === "INCLUDE") {
        candidates.push({
          serpPosition: organic.position,
          url: organic.url,
          domain: organic.domain,
          title: organic.title,
          kind,
          classification,
          classificationReason: reason,
          classificationPolicyVersion: CLASSIFICATION_POLICY_VERSION,
        });
      }
      if (candidates.length >= maxPages) break;
    }
    if (candidates.length === 0) {
      throw new FactoryError(
        "competitor_no_candidates",
        "No includable competitor candidates in this SERP evidence.",
      );
    }

    const run = await this.deps.competitorStore.createRun({
      projectId: input.projectId,
      acceptedInputSnapshotId: accepted.id,
      acceptedInputVersion: accepted.version,
      acceptedInputDigest: accepted.digest,
      serpSnapshotId: serp.id,
      serpSnapshotDigest: serp.snapshotDigest,
      intelligenceSnapshotId: intelligence.id,
      intelligenceSnapshotDigest: intelligence.snapshotDigest,
      pipelineVersion: COMPETITOR_PIPELINE_VERSION,
    });

    try {
      const intelData = intelligence.data as unknown as SearchIntelligenceData;

      for (const candidate of candidates) {
        const outcome = await this.pageProvider.acquire({ url: candidate.url });
        await this.persistPageOutcome({
          runId: run.id,
          projectId: input.projectId,
          serpSnapshotId: serp.id,
          candidate,
          outcome,
        });
      }

      // Analyze successful, non-deduped snapshots (bounded by budget gate).
      const pageRows = await this.deps.competitorStore.listPageSnapshotsForRun(run.id);
      const intakePayload = accepted.payload as Record<string, unknown>;
      let analyzedCount = 0;
      for (const pageRow of pageRows) {
        if (pageRow.acquisitionStatus !== "SUCCESS" || !pageRow.extracted) continue;
        if (pageRow.dedupedFromSnapshotId) continue;
        if (analyzedCount >= maxPages) break;
        if (pageRow.classification !== "INCLUDE") continue;
        const release = await this.checkBudget(RESERVED_PAGE_ANALYSIS_COST_MICROS);
        try {
          await this.analyzePage({
            runId: run.id,
            projectId: input.projectId,
            pageRowId: pageRow.id,
            requestedUrl: pageRow.requestedUrl,
            extracted: pageRow.extracted as CompetitorPageExtracted,
            observedAt: pageRow.observedAt,
            intelligence: intelData,
            intakePayload,
          });
        } finally {
          release();
        }
        analyzedCount++;
      }

      await this.deps.competitorStore.finishRun(run.id, "succeeded", null, null);
      const read = await this.runReadModel(input.projectId, run.id, snapshots);
      return read;
    } catch (error) {
      const code =
        error instanceof FactoryError && error.code.startsWith("competitor_")
          ? error.code
          : "competitor_run_failed";
      const message = error instanceof FactoryError ? error.message : "Competitor run failed unexpectedly.";
      await this.deps.competitorStore.finishRun(run.id, "failed", code, message);
      throw error;
    }
  }

  private async persistPageOutcome(input: {
    runId: string;
    projectId: string;
    serpSnapshotId: string;
    candidate: CompetitorCandidate;
    outcome: PageAcquisitionOutcome;
  }): Promise<void> {
    const { outcome } = input;
    if (outcome.status === "SUCCESS") {
      const extracted = extractCompetitorPage(outcome.rawBytes.toString("utf8"));
      const contentDigest = deterministicDigest({
        finalUrl: outcome.finalUrl,
        rawDigest: outcome.rawDigest,
      });
      const dedupeTarget = await this.deps.competitorStore.findContentDedupeTarget(
        input.projectId,
        contentDigest,
      );
      await this.deps.competitorStore.insertPageSnapshot({
        runId: input.runId,
        projectId: input.projectId,
        serpSnapshotId: input.serpSnapshotId,
        serpPosition: input.candidate.serpPosition,
        requestedUrl: input.candidate.url,
        finalUrl: outcome.finalUrl,
        domain: input.candidate.domain,
        classification: input.candidate.classification,
        classificationReason: input.candidate.classificationReason,
        acquisitionStatus: "SUCCESS",
        httpStatus: outcome.httpStatus,
        contentType: outcome.contentType,
        observedAt: outcome.observedAt,
        rawDigest: outcome.rawDigest,
        extractionDigest: deterministicDigest(extracted),
        extracted,
        contentDigest,
        dedupedFromSnapshotId: dedupeTarget && dedupeTarget.id !== null ? dedupeTarget.id : null,
        rawTruncated: false,
        provider: this.pageProvider.id,
      });
      return;
    }
    await this.deps.competitorStore.insertPageSnapshot({
      runId: input.runId,
      projectId: input.projectId,
      serpSnapshotId: input.serpSnapshotId,
      serpPosition: input.candidate.serpPosition,
      requestedUrl: input.candidate.url,
      finalUrl: outcome.finalUrl,
      domain: input.candidate.domain,
      classification: input.candidate.classification,
      classificationReason: input.candidate.classificationReason,
      acquisitionStatus: outcome.status,
      httpStatus: outcome.httpStatus,
      contentType: outcome.contentType,
      observedAt: outcome.observedAt,
      rawDigest: null,
      extractionDigest: null,
      extracted: null,
      contentDigest: null,
      dedupedFromSnapshotId: null,
      rawTruncated: false,
      provider: this.pageProvider.id,
    });
  }

  private async analyzePage(input: {
    runId: string;
    projectId: string;
    pageRowId: string;
    requestedUrl: string;
    extracted: CompetitorPageExtracted;
    observedAt: Date;
    intelligence: SearchIntelligenceData;
    intakePayload: Record<string, unknown>;
  }): Promise<void> {
    // Analysis dedupe: same page + model + prompt version => reuse.
    const existing = await this.deps.competitorStore.findAnalysisForPage(
      input.pageRowId,
      this.deps.competitorAnalyst.model,
      this.deps.competitorAnalyst.promptVersion,
    );
    if (existing) return;

    const pageRow = await this.deps.competitorStore.getPageSnapshot(input.projectId, input.pageRowId);
    if (!pageRow) return;

    const packet = buildEvidencePacket({
      pageSnapshotId: input.pageRowId,
      pageSnapshotDigest: pageRow.snapshotDigest,
      url: pageRow.finalUrl ?? input.requestedUrl,
      domain: pageRow.domain,
      observedAt: input.observedAt,
      extracted: input.extracted,
    });

    const result = await this.deps.competitorAnalyst.analyze({
      packet,
      projectContext: {
        businessName: ((input.intakePayload.business ?? {}) as Record<string, unknown>).name ?? "",
        offering: ((input.intakePayload.business ?? {}) as Record<string, unknown>).offerings ?? [],
      },
      searchContext: {
        primaryIntent: input.intelligence.primaryIntent,
        userNeeds: input.intelligence.userNeeds.slice(0, 10),
        semanticCoverageRequirements: input.intelligence.semanticCoverageRequirements.slice(0, 10),
        questions: input.intelligence.questions.slice(0, 10),
      },
    });

    const validSegmentIds = new Set(packet.extracted.segments.map((s) => s.id));
    await this.deps.competitorStore.insertPageAnalysis({
      runId: input.runId,
      projectId: input.projectId,
      pageSnapshotId: input.pageRowId,
      model: result.model,
      provider: result.provider,
      promptVersion: result.promptVersion,
      promptDigest: result.promptDigest,
      packetDigest: result.packetDigest,
      data: result.data,
      validSegmentIds,
      usage: result.usage
        ? {
            costMicros: result.usage.costMicros ?? null,
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            totalTokens: result.usage.totalTokens ?? null,
          }
        : null,
      observedAt: this.now(),
    });
  }

  async runReadModel(
    projectId: string,
    runId: string,
    snapshots?: Array<{ id: string; version: number; digest: string; acceptedAt: Date }>,
  ): Promise<CompetitorRunReadModel> {
    const run = await this.deps.competitorStore.getRun(projectId, runId);
    if (!run) throw new FactoryError("competitor_run_not_found", "Competitor run not found.");
    const pageRows = await this.deps.competitorStore.listPageSnapshotsForRun(runId);
    const overrides = await this.deps.competitorStore.getLatestClassificationOverridesForPages(
      projectId,
      pageRows.map((r) => r.id),
    );
    const analysisRows = await this.deps.competitorStore.listAnalysesForRun(runId);
    const analysisByPage = new Map(analysisRows.map((a) => [a.pageSnapshotId, a]));
    const snapshotList = snapshots ?? (await this.deps.intake.listSnapshots(projectId));
    const latestVersion = snapshotList.at(-1)?.version ?? run.acceptedInputVersion;

    let analyzed = 0;
    let blocked = 0;
    let failed = 0;
    const candidates = pageRows.map((row) => {
      if (row.acquisitionStatus === "SUCCESS") analyzed++;
      if (row.acquisitionStatus === "BLOCKED") blocked++;
      if (row.acquisitionStatus === "FAILED" || row.acquisitionStatus === "UNSUPPORTED") failed++;
      const analysis = analysisByPage.get(row.id);
      const data = (analysis?.data ?? null) as CompetitorPageAnalysisData | null;
      const override = overrides.get(row.id);
      const effectiveClassification = (override?.classification ?? row.classification) as CompetitorClassification;
      const effectiveReason = override ? `[Overridden] ${override.reason}` : row.classificationReason;
      return {
        pageSnapshotId: row.id,
        serpPosition: row.serpPosition,
        requestedUrl: row.requestedUrl,
        domain: row.domain,
        classification: effectiveClassification,
        classificationReason: effectiveReason,
        acquisitionStatus: row.acquisitionStatus as CompetitorAcquisitionStatus,
        httpStatus: row.httpStatus,
        observedAt: row.observedAt.toISOString(),
        analyzed: Boolean(analysis),
        dedupedFromSnapshotId: row.dedupedFromSnapshotId,
        pageType: data?.pageType ?? null,
        topics: (data?.topics ?? []).slice(0, 8),
        questions: (data?.questionsAnswered ?? []).slice(0, 5),
        freshness: data?.freshnessAssessment ?? null,
        commercialPositioning: data?.commercialPositioning ?? null,
        evidenceSegmentCount: data?.evidenceSegmentRefs.length ?? 0,
      };
    });

    return {
      run: {
        id: run.id,
        status: run.status === "succeeded" ? "succeeded" : "failed",
        serpSnapshotId: run.serpSnapshotId,
        pipelineVersion: run.pipelineVersion,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
      },
      acceptedInput: {
        snapshotId: run.acceptedInputSnapshotId,
        version: run.acceptedInputVersion,
        digest: run.acceptedInputDigest,
        stale: run.acceptedInputVersion < latestVersion,
      },
      candidates,
      usage: {
        competitorPagesFetched: pageRows.length,
        analyzedCount: analysisRows.length,
        blockedCount: blocked,
        failedCount: failed,
      },
    };
  }

  /** Operator classification override (audit-trailed). */
  async setClassification(input: {
    projectId: string;
    pageSnapshotId: string;
    classification: CompetitorClassification;
    reason: string;
  }): Promise<void> {
    const page = await this.deps.competitorStore.getPageSnapshot(input.projectId, input.pageSnapshotId);
    if (!page) throw new FactoryError("competitor_run_not_found", "Page snapshot not found.");
    await this.deps.competitorStore.insertClassificationOverride(input);
  }

  // ---- Gap proposal ------------------------------------------------------------

  async proposeGaps(input: { projectId: string; competitorRunId?: string }): Promise<{ reportId: string }> {
    if (this.deps.gapAnalyst.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
      throw new FactoryError(
        "competitor_analyst_not_configured",
        "OpenRouter API key is required for gap analysis in production mode (fail closed).",
      );
    }
    const { accepted } = await this.resolveAcceptedInputs(input.projectId);
    const releaseBudget = await this.checkBudget(RESERVED_GAP_ANALYSIS_COST_MICROS);
    try {
      const run = input.competitorRunId
        ? await this.deps.competitorStore.getRun(input.projectId, input.competitorRunId)
        : await this.deps.competitorStore.latestSucceededRun(input.projectId);
      if (!run || run.status !== "succeeded") {
        throw new FactoryError("competitor_run_not_found", "No succeeded competitor run to propose gaps from.");
      }
      if (run.acceptedInputDigest !== accepted.digest) {
        throw new FactoryError(
          "content_gap_stale",
          `Competitor run was generated for ProjectInput digest "${run.acceptedInputDigest}", but current accepted ProjectInput digest is "${accepted.digest}". Run competitor analysis for current inputs first.`,
        );
      }
      const serp = await this.deps.competitorStore.getSerpSnapshot(input.projectId, run.serpSnapshotId);
      if (!serp || serp.acceptedInputDigest !== accepted.digest) {
        throw new FactoryError(
          "content_gap_stale",
          "The SERP evidence underlying this competitor run was generated for an older ProjectInput version. Run Search first.",
        );
      }

      const allPageRows = await this.deps.competitorStore.listPageSnapshotsForRun(run.id);
      const overrides = await this.deps.competitorStore.getLatestClassificationOverridesForPages(
        input.projectId,
        allPageRows.map((r) => r.id),
      );
      const pageRows = allPageRows.filter((r) => {
        if (r.acquisitionStatus !== "SUCCESS") return false;
        const effectiveClassification = overrides.get(r.id)?.classification ?? r.classification;
        return effectiveClassification === "INCLUDE";
      });
      if (pageRows.length === 0) {
        throw new FactoryError(
          "competitor_no_candidates",
          "No includable competitor candidates remain after operator overrides.",
        );
      }
      const includedPageIds = new Set(pageRows.map((p) => p.id));
      const analysisRows = (await this.deps.competitorStore.listAnalysesForRun(run.id)).filter((a) =>
        includedPageIds.has(a.pageSnapshotId),
      );
      if (analysisRows.length === 0) {
        throw new FactoryError(
          "competitor_no_candidates",
          "No analyses remain for included competitor candidates.",
        );
      }

      const intelRow = await this.deps.competitorStore.getIntelligenceForSerpSnapshot(
        input.projectId,
        run.serpSnapshotId,
      );
      if (!intelRow) {
        throw new FactoryError("competitor_serp_not_found", "Bound search intelligence not found.");
      }
      const intelData = intelRow.data as unknown as SearchIntelligenceData;
      const intakePayload = accepted.payload as Record<string, unknown>;
      const acceptedEvidence = collectFirstPartyEvidence(intakePayload);

      // Deterministic matrix from stored analyses.
      const pageDomainById = new Map(pageRows.map((p) => [p.id, p.domain]));
      const matrix = buildCoverageMatrix({
        requirements: [
          ...intelData.userNeeds.slice(0, 20).map((need) => ({ requirement: need })),
          ...intelData.semanticCoverageRequirements.slice(0, 20).map((req) => ({ requirement: req })),
        ],
        pages: analysisRows
          .filter((a) => pageDomainById.has(a.pageSnapshotId))
          .map((a) => ({
            pageSnapshotId: a.pageSnapshotId,
            domain: pageDomainById.get(a.pageSnapshotId)!,
            analysis: a.data as never,
          })),
      });

      // PASS 2: compact analyses only.
      const analyses = analysisRows.slice(0, 10).map((a) => ({
        analysisId: a.id,
        pageSnapshotId: a.pageSnapshotId,
        domain: pageDomainById.get(a.pageSnapshotId) ?? "",
        data: a.data as Record<string, unknown>,
      }));
      const gapResult = await this.deps.gapAnalyst.propose({
        analyses,
        searchIntelligence: {
          primaryIntent: intelData.primaryIntent,
          userNeeds: intelData.userNeeds.slice(0, 15),
          questions: intelData.questions.slice(0, 15),
          topics: intelData.topics.slice(0, 10),
        },
        serpSnapshot: { id: run.serpSnapshotId, digest: run.serpSnapshotDigest },
        intelligenceSnapshot: { id: intelRow.id, digest: intelRow.snapshotDigest },
        acceptedEvidence: acceptedEvidence.map((e) => ({ field: e.field, index: e.index, text: e.text })),
        projectContext: {
          businessName: ((intakePayload.business ?? {}) as Record<string, unknown>).name ?? "",
          prohibitedClaims: (((intakePayload.evidence ?? {}) as Record<string, unknown>).prohibitedClaims ?? []) as string[],
        },
        coverageMatrixSummary: matrix.rows.map((row) => ({
          requirement: row.requirement,
          coverage: Object.fromEntries(row.cells.map((c) => [c.pageSnapshotId, c.level])),
        })),
      });

      // Segment-ref anchoring: every gap evidenceRef must resolve to a real
      // segment of a real analyzed page in this run.
      const segmentsByPage = new Map<string, Set<string>>();
      for (const a of analysisRows) {
        const page = pageRows.find((p) => p.id === a.pageSnapshotId);
        const extracted = page?.extracted as CompetitorPageExtracted | undefined;
        segmentsByPage.set(
          a.pageSnapshotId,
          new Set((extracted?.segments ?? extracted?.headings ?? []).map((s) => s.id)),
        );
      }
      for (const gap of gapResult.gaps as Array<{ evidenceRefs?: Array<{ pageSnapshotId: string; segmentId: string }> }>) {
        for (const ref of gap.evidenceRefs ?? []) {
          const segs = segmentsByPage.get(ref.pageSnapshotId);
          if (!segs || !segs.has(ref.segmentId)) {
            throw new FactoryError(
              "content_gap_invalid",
              "Gap proposal references page evidence that does not exist in this run (fail closed).",
            );
          }
        }
      }

      const effectiveClassifications = allPageRows
        .map((r) => {
          const override = overrides.get(r.id);
          const classification = (override?.classification ?? r.classification) as CompetitorClassification;
          return {
            pageSnapshotId: r.id,
            classification,
          };
        })
        .sort((a, b) => (a.pageSnapshotId < b.pageSnapshotId ? -1 : a.pageSnapshotId > b.pageSnapshotId ? 1 : 0));
      const classificationDigest = deterministicDigest(effectiveClassifications);

      const reportData = finalizeGapReport({
        modelGaps: {
          gaps: gapResult.gaps,
          differentiationRequirements: gapResult.differentiationRequirements,
        },
        serpSnapshotId: run.serpSnapshotId,
        serpSnapshotDigest: run.serpSnapshotDigest,
        intelligenceSnapshotId: intelRow.id,
        intelligenceSnapshotDigest: intelRow.snapshotDigest,
        pageSnapshotRefs: pageRows.map((p) => ({ id: p.id, digest: p.snapshotDigest })),
        analysisRefs: analysisRows.map((a) => ({ id: a.id, digest: a.snapshotDigest })),
        acceptedInputSnapshotId: accepted.id,
        acceptedInputSnapshotVersion: accepted.version,
        acceptedInputDigest: accepted.digest,
        classificationDigest,
        effectiveClassifications,
        coverageMatrix: matrix,
        model: gapResult.model,
        provider: gapResult.provider,
        promptVersion: gapResult.promptVersion,
        acceptedEvidence,
        grounding: {
          serpSnapshotId: run.serpSnapshotId,
          serpSnapshotDigest: run.serpSnapshotDigest,
          intelligenceSnapshotId: intelRow.id,
          intelligenceSnapshotDigest: intelRow.snapshotDigest,
          pageSnapshots: pageRows.map((p) => ({
            id: p.id,
            digest: p.snapshotDigest,
            classification: p.classification as CompetitorClassification,
            validSegmentIds: new Set(
              ((p.extracted as CompetitorPageExtracted | undefined)?.segments ?? []).map((s) => s.id),
            ),
          })),
          analyses: analysisRows.map((a) => ({
            id: a.id,
            pageSnapshotId: a.pageSnapshotId,
            digest: a.snapshotDigest,
          })),
        },
      });

      const usage = gapResult.usage
        ? {
            inputTokens: gapResult.usage.inputTokens ?? null,
            outputTokens: gapResult.usage.outputTokens ?? null,
            totalTokens: gapResult.usage.totalTokens ?? null,
            costMicros: gapResult.usage.costMicros ?? null,
          }
        : null;

      const report = await this.deps.competitorStore.insertGapReport({
        runId: run.id,
        projectId: input.projectId,
        acceptedInputSnapshotId: accepted.id,
        acceptedInputVersion: accepted.version,
        acceptedInputDigest: accepted.digest,
        serpSnapshotId: run.serpSnapshotId,
        serpSnapshotDigest: run.serpSnapshotDigest,
        intelligenceSnapshotId: intelRow.id,
        intelligenceSnapshotDigest: intelRow.snapshotDigest,
        model: gapResult.model,
        provider: gapResult.provider,
        promptVersion: gapResult.promptVersion,
        usage,
        data: reportData,
      });
      return { reportId: report.id };
    } finally {
      releaseBudget();
    }
  }

  // ---- Review + acceptance ----------------------------------------------------

  async evaluateUpstreamStaleness(
    projectId: string,
    bound: {
      acceptedInputSnapshotId: string;
      acceptedInputVersion: number;
      acceptedInputDigest: string;
      serpSnapshotId: string;
      serpSnapshotDigest: string;
      intelligenceSnapshotId: string;
      intelligenceSnapshotDigest: string;
      pageSnapshotRefs: Array<{ id: string; digest: string }>;
      analysisRefs: Array<{ id: string; digest: string }>;
      classificationDigest?: string;
      effectiveClassifications?: Array<{ pageSnapshotId: string; classification: CompetitorClassification; reason?: string }>;
      competitorRunId?: string;
    },
  ): Promise<{ stale: boolean; staleReasons: string[] }> {
    const reasons: string[] = [];

    // 1. Accepted Project Inputs
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latestInput = snapshots.at(-1) ?? null;
    if (!latestInput) {
      reasons.push("No accepted project input found.");
    } else if (
      latestInput.version !== bound.acceptedInputVersion ||
      latestInput.digest !== bound.acceptedInputDigest
    ) {
      reasons.push(
        `Accepted project inputs changed (bound v${bound.acceptedInputVersion}, current v${latestInput.version}).`,
      );
    }

    // 2. Authoritative SERP snapshot (matched by full search identity, not query alone)
    const boundSerp = await this.deps.competitorStore.getSerpSnapshot(projectId, bound.serpSnapshotId);
    if (!boundSerp) {
      reasons.push(`Bound SERP snapshot "${bound.serpSnapshotId}" no longer exists.`);
    } else if (boundSerp.snapshotDigest !== bound.serpSnapshotDigest) {
      reasons.push("Bound SERP snapshot digest mismatch.");
    } else {
      const latestSerp = await this.deps.competitorStore.getLatestSerpForSearchIdentity(projectId, {
        query: boundSerp.query,
        location: boundSerp.location,
        language: boundSerp.language,
        device: boundSerp.device,
      });
      if (
        latestSerp &&
        latestSerp.id !== bound.serpSnapshotId &&
        latestSerp.observedAt > boundSerp.observedAt
      ) {
        reasons.push(`A newer SERP snapshot was observed for query "${boundSerp.query}".`);
      }
    }

    // 3. Authoritative Search Intelligence snapshot (matched by full search identity)
    const boundIntel = await this.deps.competitorStore.getIntelligenceSnapshot(
      projectId,
      bound.intelligenceSnapshotId,
    );
    if (!boundIntel) {
      reasons.push(
        `Bound search intelligence snapshot "${bound.intelligenceSnapshotId}" no longer exists.`,
      );
    } else if (boundIntel.snapshotDigest !== bound.intelligenceSnapshotDigest) {
      reasons.push("Bound search intelligence snapshot digest mismatch.");
    } else if (boundSerp) {
      const latestIntel = await this.deps.competitorStore.getLatestIntelligenceForSearchIdentity(
        projectId,
        {
          query: boundSerp.query,
          location: boundSerp.location,
          language: boundSerp.language,
          device: boundSerp.device,
        },
      );
      if (
        latestIntel &&
        latestIntel.id !== bound.intelligenceSnapshotId &&
        latestIntel.createdAt > boundIntel.createdAt
      ) {
        reasons.push(
          `A newer search intelligence snapshot was created for query "${boundSerp.query}".`,
        );
      }
    }

    // 4. Bound competitor run supersession
    if (bound.competitorRunId) {
      const boundRun = await this.deps.competitorStore.getRun(projectId, bound.competitorRunId);
      const latestRun = await this.deps.competitorStore.latestSucceededRunForSerp(
        projectId,
        bound.serpSnapshotId,
      );
      if (
        boundRun &&
        latestRun &&
        latestRun.id !== bound.competitorRunId &&
        latestRun.createdAt > boundRun.createdAt
      ) {
        reasons.push("A newer competitor run was executed for this SERP evidence.");
      }
    }

    // 5. Bound competitor page snapshots & analyses (including URL content change check)
    if (bound.pageSnapshotRefs && bound.pageSnapshotRefs.length > 0) {
      const pageIds = bound.pageSnapshotRefs.map((r) => r.id);
      const pages = await this.deps.competitorStore.pageSnapshotsByIds(projectId, pageIds);
      const pageMap = new Map(pages.map((p) => [p.id, p]));
      for (const ref of bound.pageSnapshotRefs) {
        const page = pageMap.get(ref.id);
        if (!page) {
          reasons.push(`Bound competitor page snapshot "${ref.id}" no longer exists.`);
        } else if (page.snapshotDigest !== ref.digest) {
          reasons.push(`Bound competitor page snapshot "${ref.id}" digest changed.`);
        } else {
          const latestPage = await this.deps.competitorStore.getLatestPageSnapshotForUrl(
            projectId,
            page.requestedUrl,
          );
          if (
            latestPage &&
            latestPage.id !== page.id &&
            latestPage.observedAt > page.observedAt &&
            latestPage.contentDigest !== page.contentDigest
          ) {
            reasons.push(
              `Competitor page content changed for "${page.requestedUrl}".`,
            );
          }
        }
      }
    }

    if (bound.analysisRefs && bound.analysisRefs.length > 0) {
      const analysisIds = bound.analysisRefs.map((r) => r.id);
      const analyses = await this.deps.competitorStore.analysesByIds(projectId, analysisIds);
      const analysisMap = new Map(analyses.map((a) => [a.id, a]));
      for (const ref of bound.analysisRefs) {
        const analysis = analysisMap.get(ref.id);
        if (!analysis) {
          reasons.push(`Bound competitor analysis "${ref.id}" no longer exists.`);
        } else if (analysis.snapshotDigest !== ref.digest) {
          reasons.push(`Bound competitor analysis "${ref.id}" digest changed.`);
        }
      }
    }

    // 6. Bound candidate classification overrides
    if (bound.classificationDigest && bound.effectiveClassifications && bound.effectiveClassifications.length > 0) {
      const pageIds = bound.effectiveClassifications.map((c) => c.pageSnapshotId);
      const overrides = await this.deps.competitorStore.getLatestClassificationOverridesForPages(projectId, pageIds);
      const pages = await this.deps.competitorStore.pageSnapshotsByIds(projectId, pageIds);
      const pageMap = new Map(pages.map((p) => [p.id, p]));
      const currentEffective = bound.effectiveClassifications
        .map((item) => {
          const page = pageMap.get(item.pageSnapshotId);
          const baseClassification = page?.classification ?? item.classification;
          const override = overrides.get(item.pageSnapshotId);
          const effective = (override?.classification ?? baseClassification) as CompetitorClassification;
          return {
            pageSnapshotId: item.pageSnapshotId,
            classification: effective,
          };
        })
        .sort((a, b) => (a.pageSnapshotId < b.pageSnapshotId ? -1 : a.pageSnapshotId > b.pageSnapshotId ? 1 : 0));
      const currentDigest = deterministicDigest(currentEffective);
      if (currentDigest !== bound.classificationDigest) {
        reasons.push("Competitor candidate classification changed.");
      }
    }

    return { stale: reasons.length > 0, staleReasons: reasons };
  }

  private async evaluateAcceptedSnapshotStaleness(
    projectId: string,
    snapshot: AcceptedContentGapSnapshotRecord,
  ): Promise<{ stale: boolean; staleReasons: string[] }> {
    const report = await this.deps.competitorStore.getGapReport(projectId, snapshot.reportId);
    const snapData = snapshot.data as {
      classificationDigest?: string;
      effectiveClassifications?: Array<{ pageSnapshotId: string; classification: CompetitorClassification }>;
    };
    return await this.evaluateUpstreamStaleness(projectId, {
      acceptedInputSnapshotId: snapshot.acceptedInputSnapshotId,
      acceptedInputVersion: snapshot.acceptedInputVersion,
      acceptedInputDigest: snapshot.acceptedInputDigest,
      serpSnapshotId: snapshot.serpSnapshotId,
      serpSnapshotDigest: snapshot.serpSnapshotDigest,
      intelligenceSnapshotId: snapshot.intelligenceSnapshotId,
      intelligenceSnapshotDigest: snapshot.intelligenceSnapshotDigest,
      pageSnapshotRefs: (snapshot.pageSnapshotRefs as Array<{ id: string; digest: string }>) ?? [],
      analysisRefs: (snapshot.analysisRefs as Array<{ id: string; digest: string }>) ?? [],
      classificationDigest: snapData.classificationDigest,
      effectiveClassifications: snapData.effectiveClassifications,
      competitorRunId: report?.runId,
    });
  }

  async gapWorkspace(projectId: string): Promise<GapWorkspaceReadModel> {
    const reports = await this.deps.competitorStore.listGapReports(projectId, 20);
    const accepted = await this.deps.competitorStore.listAcceptedGapSnapshots(projectId);
    const latestAccepted = accepted.at(0) ?? null;

    const reportModels = [];
    for (const report of reports) {
      const data = report.data as ContentGapReportData;
      const gapCounts = {
        total: data.gaps.length,
        required: data.gaps.filter((g) => g.recommendedDisposition === "REQUIRED").length,
        optional: data.gaps.filter((g) => g.recommendedDisposition === "OPTIONAL").length,
        excluded: data.gaps.filter((g) => g.recommendedDisposition === "EXCLUDE").length,
      };
      const staleness = await this.evaluateUpstreamStaleness(projectId, {
        acceptedInputSnapshotId: report.acceptedInputSnapshotId,
        acceptedInputVersion: report.acceptedInputVersion,
        acceptedInputDigest: report.acceptedInputDigest,
        serpSnapshotId: report.serpSnapshotId,
        serpSnapshotDigest: report.serpSnapshotDigest,
        intelligenceSnapshotId: report.intelligenceSnapshotId,
        intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
        pageSnapshotRefs: data.pageSnapshotRefs ?? [],
        analysisRefs: data.analysisRefs ?? [],
        classificationDigest: data.classificationDigest,
        effectiveClassifications: data.effectiveClassifications,
        competitorRunId: report.runId,
      });
      reportModels.push({
        id: report.id,
        snapshotDigest: report.snapshotDigest,
        reviewState: report.reviewState,
        reviewRevision: report.reviewRevision,
        decisionsDigest: report.decisionsDigest,
        createdAt: report.createdAt.toISOString(),
        gapCounts,
        serpSnapshotId: report.serpSnapshotId,
        ...staleness,
      });
    }

    const acceptedModels = [];
    for (const snap of accepted) {
      const data = snap.data as {
        gaps: Array<{ recommendedDisposition: string; disposition?: string }>;
      };
      const staleness = await this.evaluateAcceptedSnapshotStaleness(projectId, snap);
      acceptedModels.push({
        id: snap.id,
        version: snap.version,
        snapshotDigest: snap.snapshotDigest,
        acceptedAt: snap.acceptedAt.toISOString(),
        reportId: snap.reportId,
        stale: staleness.stale,
        staleReasons: staleness.staleReasons,
        gapCounts: {
          total: data.gaps.length,
          required: data.gaps.filter((g) => (g.disposition ?? g.recommendedDisposition) === "REQUIRED").length,
          optional: data.gaps.filter((g) => (g.disposition ?? g.recommendedDisposition) === "OPTIONAL").length,
          excluded: data.gaps.filter((g) => (g.disposition ?? g.recommendedDisposition) === "EXCLUDE").length,
        },
      });
    }

    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latestIntake = snapshots.at(-1) ?? null;
    const blockers: string[] = [];
    if (!latestIntake) {
      blockers.push("No accepted project input found. Complete Intake first.");
    } else {
      const latestRun = await this.deps.competitorStore.latestSucceededRun(projectId);
      if (!latestRun) {
        blockers.push("No competitor run yet. Acquire competitors, then propose gaps.");
      } else if (latestRun.acceptedInputDigest !== latestIntake.digest) {
        blockers.push(
          "Competitor evidence is stale (newer ProjectInput accepted). Run competitor analysis first.",
        );
      }
    }
    return {
      reports: reportModels,
      accepted: acceptedModels,
      readiness: { canPropose: blockers.length === 0, blockers },
    };
  }

  async getGapReportDetail(projectId: string, reportId: string) {
    const report = await this.deps.competitorStore.getGapReport(projectId, reportId);
    if (!report) throw new FactoryError("content_gap_report_not_found", "Content gap report not found.");
    const decisions = await this.deps.competitorStore.listDecisions(reportId);
    const reportData = report.data as ContentGapReportData;
    const staleness = await this.evaluateUpstreamStaleness(projectId, {
      acceptedInputSnapshotId: report.acceptedInputSnapshotId,
      acceptedInputVersion: report.acceptedInputVersion,
      acceptedInputDigest: report.acceptedInputDigest,
      serpSnapshotId: report.serpSnapshotId,
      serpSnapshotDigest: report.serpSnapshotDigest,
      intelligenceSnapshotId: report.intelligenceSnapshotId,
      intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
      pageSnapshotRefs: reportData.pageSnapshotRefs ?? [],
      analysisRefs: reportData.analysisRefs ?? [],
      classificationDigest: reportData.classificationDigest,
      effectiveClassifications: reportData.effectiveClassifications,
      competitorRunId: report.runId,
    });
    return {
      report: {
        id: report.id,
        snapshotDigest: report.snapshotDigest,
        reviewState: report.reviewState,
        reviewRevision: report.reviewRevision,
        decisionsDigest: report.decisionsDigest,
        createdAt: report.createdAt.toISOString(),
        model: report.model,
        provider: report.provider,
        data: report.data,
      },
      decisions: decisions.map((d) => ({
        gapId: d.gapId,
        disposition: d.disposition,
        priority: d.priority,
        note: d.note,
      })),
      ...staleness,
    };
  }

  async saveGapDecisions(input: {
    projectId: string;
    reportId: string;
    expectedReviewRevision: number;
    decisions: Array<{ gapId: string; disposition: CompetitorClassification | string; priority?: string | null; note?: string | null }>;
  }): Promise<{ reviewRevision: number; decisionsDigest: string }> {
    const report = await this.deps.competitorStore.getGapReport(input.projectId, input.reportId);
    if (!report) throw new FactoryError("content_gap_report_not_found", "Content gap report not found.");
    if (report.reviewState === "accepted") {
      throw new FactoryError(
        "content_gap_decision_invalid",
        "Cannot modify decisions for an already accepted content gap report.",
      );
    }
    const existing = await this.deps.competitorStore.getAcceptedGapSnapshotByReportId(input.reportId);
    if (existing) {
      throw new FactoryError(
        "content_gap_decision_invalid",
        "Cannot modify decisions for an already accepted content gap report.",
      );
    }
    const data = report.data as { gaps: Array<{ id: string }> };
    const gapIds = new Set(data.gaps.map((g) => g.id));
    for (const decision of input.decisions) {
      if (!gapIds.has(decision.gapId)) {
        throw new FactoryError("content_gap_decision_invalid", `Unknown gap "${decision.gapId}".`);
      }
      if (!["REQUIRED", "OPTIONAL", "EXCLUDE"].includes(decision.disposition)) {
        throw new FactoryError("content_gap_decision_invalid", `Invalid disposition for "${decision.gapId}".`);
      }
    }
    // Review requires every gap to have a decision (operator authority).
    if (input.decisions.length !== data.gaps.length) {
      throw new FactoryError(
        "content_gap_decision_invalid",
        `Every gap requires a decision (${data.gaps.length} gaps, ${input.decisions.length} decisions).`,
      );
    }

    const normalizedDecisions = input.decisions.map((d) => ({
      gapId: d.gapId,
      disposition: d.disposition,
      priority: d.priority ?? null,
      note: d.note === undefined || d.note === null ? null : String(d.note).slice(0, 500),
    }));

    if (typeof this.deps.competitorStore.saveGapDecisionsWithConcurrency === "function") {
      return await this.deps.competitorStore.saveGapDecisionsWithConcurrency({
        projectId: input.projectId,
        reportId: input.reportId,
        expectedReviewRevision: input.expectedReviewRevision,
        decisions: normalizedDecisions,
      });
    }

    if (report.reviewRevision !== input.expectedReviewRevision) {
      throw new FactoryError(
        "content_gap_stale",
        `Review revision mismatch: review was updated concurrently (expected rev ${input.expectedReviewRevision}, current rev ${report.reviewRevision}).`,
      );
    }

    await this.deps.competitorStore.replaceDecisions(
      input.projectId,
      input.reportId,
      normalizedDecisions,
    );
    const updated = await this.deps.competitorStore.getGapReport(input.projectId, input.reportId);
    return {
      reviewRevision: updated?.reviewRevision ?? report.reviewRevision + 1,
      decisionsDigest: updated?.decisionsDigest ?? computeDecisionsDigest(report.snapshotDigest, normalizedDecisions),
    };
  }

  async acceptGapReport(input: {
    projectId: string;
    reportId: string;
    expectedReportDigest?: string;
    expectedDigest?: string;
    expectedReviewRevision: number;
    expectedDecisionsDigest: string;
  }): Promise<{ version: number; snapshotId: string }> {
    const expectedReportDigest = input.expectedReportDigest ?? input.expectedDigest;
    if (!expectedReportDigest) {
      throw new FactoryError(
        "content_gap_accept_failed",
        "Report digest is required for acceptance.",
      );
    }

    if (typeof this.deps.competitorStore.acceptGapReportAtomic === "function") {
      return await this.deps.competitorStore.acceptGapReportAtomic({
        projectId: input.projectId,
        reportId: input.reportId,
        expectedReportDigest,
        expectedReviewRevision: input.expectedReviewRevision,
        expectedDecisionsDigest: input.expectedDecisionsDigest,
        validateStaleness: async (report, reportData) => {
          const staleness = await this.evaluateUpstreamStaleness(input.projectId, {
            acceptedInputSnapshotId: report.acceptedInputSnapshotId,
            acceptedInputVersion: report.acceptedInputVersion,
            acceptedInputDigest: report.acceptedInputDigest,
            serpSnapshotId: report.serpSnapshotId,
            serpSnapshotDigest: report.serpSnapshotDigest,
            intelligenceSnapshotId: report.intelligenceSnapshotId,
            intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
            pageSnapshotRefs: reportData.pageSnapshotRefs ?? [],
            analysisRefs: reportData.analysisRefs ?? [],
            classificationDigest: reportData.classificationDigest,
            effectiveClassifications: reportData.effectiveClassifications,
            competitorRunId: report.runId,
          });
          if (staleness.stale) {
            throw new FactoryError(
              "content_gap_stale",
              `Upstream evidence changed since review: ${staleness.staleReasons.join(" ")}`,
            );
          }
        },
      });
    }

    const report = await this.deps.competitorStore.getGapReport(input.projectId, input.reportId);
    if (!report) throw new FactoryError("content_gap_report_not_found", "Content gap report not found.");

    if (expectedReportDigest !== report.snapshotDigest) {
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

    // Idempotent acceptance check: if already accepted, return existing snapshot without minting v2
    const existingSnapshot = await this.deps.competitorStore.getAcceptedGapSnapshotByReportId(input.reportId);
    if (existingSnapshot) {
      if (
        existingSnapshot.decisionsDigest === input.expectedDecisionsDigest &&
        existingSnapshot.reportDigest === expectedReportDigest
      ) {
        return { version: existingSnapshot.version, snapshotId: existingSnapshot.id };
      }
      throw new FactoryError(
        "content_gap_accept_failed",
        "Report was already accepted with different decisions.",
      );
    }
    const decisions = await this.deps.competitorStore.listDecisions(input.reportId);
    const reportData = report.data as ContentGapReportData;
    if (decisions.length !== reportData.gaps.length) {
      throw new FactoryError(
        "content_gap_accept_failed",
        "Acceptance requires a recorded decision for every gap.",
      );
    }

    const staleness = await this.evaluateUpstreamStaleness(input.projectId, {
      acceptedInputSnapshotId: report.acceptedInputSnapshotId,
      acceptedInputVersion: report.acceptedInputVersion,
      acceptedInputDigest: report.acceptedInputDigest,
      serpSnapshotId: report.serpSnapshotId,
      serpSnapshotDigest: report.serpSnapshotDigest,
      intelligenceSnapshotId: report.intelligenceSnapshotId,
      intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
      pageSnapshotRefs: reportData.pageSnapshotRefs ?? [],
      analysisRefs: reportData.analysisRefs ?? [],
      classificationDigest: reportData.classificationDigest,
      effectiveClassifications: reportData.effectiveClassifications,
      competitorRunId: report.runId,
    });
    if (staleness.stale) {
      throw new FactoryError(
        "content_gap_stale",
        `Upstream evidence changed since review: ${staleness.staleReasons.join(" ")}`,
      );
    }

    // Materialize human operator decisions into the accepted snapshot
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

    const decDigest = computeDecisionsDigest(
      report.snapshotDigest,
      decisions.map((d) => ({
        gapId: d.gapId,
        disposition: d.disposition,
        priority: d.priority,
        note: d.note,
      })),
    );

    if (decDigest !== input.expectedDecisionsDigest) {
      throw new FactoryError(
        "content_gap_accept_failed",
        "Decisions digest mismatch: review decisions changed since review. Re-review and retry.",
      );
    }

    const version = (await this.deps.competitorStore.latestAcceptedGapVersion(input.projectId)) + 1;

    let snapshot;
    try {
      snapshot = await this.deps.competitorStore.insertAcceptedGapSnapshot({
        projectId: input.projectId,
        version,
        reportId: report.id,
        reportDigest: report.snapshotDigest,
        decisionsDigest: decDigest,
        acceptedInputSnapshotId: report.acceptedInputSnapshotId,
        acceptedInputVersion: report.acceptedInputVersion,
        acceptedInputDigest: report.acceptedInputDigest,
        serpSnapshotId: report.serpSnapshotId,
        serpSnapshotDigest: report.serpSnapshotDigest,
        intelligenceSnapshotId: report.intelligenceSnapshotId,
        intelligenceSnapshotDigest: report.intelligenceSnapshotDigest,
        pageSnapshotRefs: reportData.pageSnapshotRefs,
        analysisRefs: reportData.analysisRefs,
        data: acceptedData,
      });
    } catch (err: unknown) {
      // Handle unique constraint race condition on reportId
      const raceExisting = await this.deps.competitorStore.getAcceptedGapSnapshotByReportId(input.reportId);
      if (
        raceExisting &&
        raceExisting.decisionsDigest === decDigest &&
        raceExisting.reportDigest === expectedReportDigest
      ) {
        return { version: raceExisting.version, snapshotId: raceExisting.id };
      }
      throw err;
    }

    await this.deps.competitorStore.markGapReportAccepted(report.id);
    return { version: snapshot.version, snapshotId: snapshot.id };
  }

  async acceptedGapDetail(projectId: string, version: number) {
    const snapshot = await this.deps.competitorStore.getAcceptedGapSnapshot(projectId, version);
    if (!snapshot) throw new FactoryError("content_gap_report_not_found", "Accepted gap snapshot not found.");
    const staleness = await this.evaluateAcceptedSnapshotStaleness(projectId, snapshot);
    return {
      snapshot: {
        id: snapshot.id,
        version: snapshot.version,
        snapshotDigest: snapshot.snapshotDigest,
        acceptedAt: snapshot.acceptedAt.toISOString(),
        reportId: snapshot.reportId,
        reportDigest: snapshot.reportDigest,
        decisionsDigest: snapshot.decisionsDigest,
        data: snapshot.data,
      },
      ...staleness,
    };
  }
}

/** Build the competitor/gap analyst pair per trusted mode (fixture or production). */
export function buildCompetitorAnalysts(env: NodeJS.ProcessEnv, invokeModelFn: typeof import("../models/gateway.js").invokeModel): {
  competitorAnalyst: CompetitorAnalystModel;
  gapAnalyst: GapAnalystModel;
} {
  const fixtureMode = env.FACTORY_COMPETITOR_MODE === "fixture";
  if (fixtureMode) {
    return { competitorAnalyst: new FixtureCompetitorAnalyst(), gapAnalyst: new FixtureGapAnalyst() };
  }
  const callGemini = async (systemPrompt: string, prompt: string) => {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new FactoryError(
        "competitor_analyst_not_configured",
        "OpenRouter API key is required for competitor analysis in production mode (fail closed).",
      );
    }
    const result = await invokeModelFn(
      {
        roleId: "search_analyst",
        model: "google/gemini-3.7-flash",
        systemPrompt,
        prompt,
        maxTokens: 8192,
        timeoutMs: 120_000,
      },
      { loadApiKey: () => apiKey },
    );
    return {
      text: result.content,
      usage: {
        inputTokens: result.promptTokens,
        outputTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        costMicros: result.costUsd != null ? Math.round(result.costUsd * 1_000_000) : null,
      },
    };
  };
  return {
    competitorAnalyst: new OpenRouterCompetitorAnalyst({
      model: "google/gemini-3.7-flash",
      callModel: (prompt) => callGemini(systemPromptOf("competitor"), prompt),
    }),
    gapAnalyst: new OpenRouterGapAnalyst({
      model: "google/gemini-3.7-flash",
      callModel: (prompt) => callGemini(systemPromptOf("gap"), prompt),
    }),
  };
}

import { COMPETITOR_ANALYST_SYSTEM_PROMPT } from "./analyst.js";
import { GAP_ANALYST_SYSTEM_PROMPT as GAP_PROMPT } from "./gap-analyst.js";
function systemPromptOf(kind: "competitor" | "gap"): string {
  return kind === "competitor" ? COMPETITOR_ANALYST_SYSTEM_PROMPT : GAP_PROMPT;
}
