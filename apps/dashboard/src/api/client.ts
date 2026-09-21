/**
 * Thin same-origin fetch wrapper for the trusted Operator API.
 * The Dashboard owns no business logic; it only calls semantic endpoints
 * and renders the canonical ProjectOperatorWorkspace read-model.
 */

import { OPERATOR_ERROR_CODES, type OperatorErrorCode } from "@factory/contracts";

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Typed error surfaced by every failed API call. `code` is a stable
 * OperatorErrorCode whenever the server sent the contract envelope; network
 * failures and non-JSON responses degrade to `network_error`/`http_<status>`
 * with a safe message.
 */
export class OperatorApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "OperatorApiError";
    this.code = code;
    this.status = status;
  }
}

const GENERIC_ERROR_MESSAGE = "Request failed. Please try again.";

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  createdAt: string;
}

export interface DraftInfo {
  revision: number;
  digest: string | null;
  updatedAt: string | null;
  payload: unknown;
}

export interface SnapshotInfo {
  id: string;
  version: number;
  sourceRevision: number;
  digest: string;
  acceptedAt: string;
  acceptedBy: string;
  acceptanceState: string;
  payload: unknown;
}

export interface IntakeReadiness {
  status: "DRAFT" | "READY" | "APPROVED" | "CHANGED" | "BLOCKED";
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  nextActions: string[];
}

export interface ProjectOperatorWorkspace {
  project: ProjectSummary;
  currentDraft: DraftInfo;
  readiness: IntakeReadiness;
  currentAcceptedSnapshot: SnapshotInfo | null;
  /** Ascending by version; the LAST entry is the currently accepted one. */
  history: SnapshotInfo[];
  draftDiffersFromAccepted: boolean;
  status: IntakeReadiness["status"];
  nextActions: string[];
}

const OPERATOR_ERROR_CODES_SET = new Set<string>(OPERATOR_ERROR_CODES);

function isOperatorErrorCode(value: string): value is OperatorErrorCode {
  return OPERATOR_ERROR_CODES_SET.has(value);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    // Network-level failure (server down, offline): no response envelope.
    throw new OperatorApiError("network_error", GENERIC_ERROR_MESSAGE, 0);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const body = (parsed as ApiErrorBody | undefined)?.error;
    const rawCode = typeof body?.code === "string" ? body.code : `http_${res.status}`;
    const code = isOperatorErrorCode(rawCode) ? rawCode : `http_${res.status}`;
    // Never render raw server error text for unexpected internal faults;
    // contract codes may carry operator-facing messages.
    const message =
      code === "internal_error" || !isOperatorErrorCode(rawCode)
        ? GENERIC_ERROR_MESSAGE
        : (body?.message ?? GENERIC_ERROR_MESSAGE);
    throw new OperatorApiError(code, message, res.status);
  }
  return parsed as T;
}

export type WorkflowAreaId =
  | "intake"
  | "research"
  | "content"
  | "assets"
  | "design"
  | "production"
  | "qa"
  | "versions"
  | "costs"
  | "deployment";

export type WorkflowState =
  | "NOT_STARTED"
  | "READY"
  | "IN_PROGRESS"
  | "REVIEW_REQUIRED"
  | "ACCEPTED"
  | "STALE"
  | "BLOCKED"
  | "NOT_APPLICABLE";

export interface WorkflowAuthorityRef {
  kind: string;
  id: string;
  version?: number;
  digest?: string;
  acceptedAt?: string;
  pageIdentity?: string;
}

export interface WorkflowBlocker {
  code: string;
  area: WorkflowAreaId;
  message: string;
  pageIdentity?: string;
  authorityRef?: WorkflowAuthorityRef;
  resolutionRoute?: string;
}

export interface WorkflowNextAction {
  actionId: string;
  area: WorkflowAreaId;
  label: string;
  route: string;
  reasonCode: string;
  reasonMessage: string;
  pageIdentity?: string;
}

export interface PageWorkflowCell {
  state: WorkflowState;
  relation?: "CURRENT" | "HISTORICAL";
  freshness?: "CURRENT" | "STALE";
  version?: number;
  digest?: string;
}

export interface PageWorkflowRow {
  pageIdentity: string;
  content: PageWorkflowCell;
  assets: PageWorkflowCell;
  design: PageWorkflowCell;
  derivatives: PageWorkflowCell;
  production: PageWorkflowCell;
  qa: PageWorkflowCell;
}

export interface DeploymentReadiness {
  state: "BLOCKED" | "READY_FOR_DEPLOYMENT";
  candidate?: WorkflowAuthorityRef;
  blockers: WorkflowBlocker[];
  qaCurrent: boolean;
}

export interface ProjectWorkflowReadModel {
  projectId: string;
  overall: "IN_PROGRESS" | "BLOCKED" | "READY_FOR_DEPLOYMENT";
  areas: Array<{
    area: WorkflowAreaId;
    state: WorkflowState;
    blockers: WorkflowBlocker[];
    staleReasons: Array<{ code: string; message: string; authorityRef?: WorkflowAuthorityRef }>;
    currentAuthorities: WorkflowAuthorityRef[];
    historicalCount?: number;
    pageCounts?: { total: number; current: number; stale: number; blocked: number };
  }>;
  nextAction: WorkflowNextAction | null;
  secondaryActionCount: number;
  pages: PageWorkflowRow[];
  deployment: DeploymentReadiness;
}

export interface ArtifactVersionSummary {
  artifactKind: string;
  pageIdentity?: string;
  id: string;
  version: number;
  digest: string;
  acceptedAt?: string;
  relation: "CURRENT" | "HISTORICAL";
  freshness?: "CURRENT" | "STALE";
  sourceAuthorities?: WorkflowAuthorityRef[];
}

export interface ProjectVersionsReadModel {
  projectId: string;
  artifacts: ArtifactVersionSummary[];
}

export type CostValue = { kind: "KNOWN"; amountUsd: number } | { kind: "UNKNOWN" };

export interface ProjectCostsReadModel {
  projectId: string;
  rows: Array<{
    provider: string;
    model: string | null;
    operation: string;
    pageIdentity: string | null;
    calls: number;
    knownCost: CostValue;
    unknownCostCalls: number;
  }>;
  unattributedCalls: number;
  unavailableSources: Array<{ source: string; reason: string }>;
}

export const api = {
  listProjects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),

  createProject: (input: { key: string; name: string }) =>
    request<ProjectSummary>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getWorkspace: (projectId: string) =>
    request<ProjectOperatorWorkspace>(`/api/projects/${encodeURIComponent(projectId)}/workspace`),

  saveDraft: (projectId: string, input: { baseRevision: number; payload: unknown }) =>
    request<{ revision: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/intake-draft`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  accept: (projectId: string, input: { expectedRevision: number; expectedDigest: string }) =>
    request<SnapshotInfo>(`/api/projects/${encodeURIComponent(projectId)}/intake/accept`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listVersions: (projectId: string) =>
    request<{ versions: SnapshotInfo[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/intake/versions`,
    ),

  getVersion: (projectId: string, version: number) =>
    request<SnapshotInfo>(
      `/api/projects/${encodeURIComponent(projectId)}/intake/versions/${version}`,
    ),

  // ---- Search Intelligence (Macro Run 2) ---------------------------------

  getSearchWorkspace: (projectId: string) =>
    request<SearchWorkspaceReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/search/workspace`,
    ),

  runSearch: (
    projectId: string,
    input: { query: string; location?: string; language?: string; device: "desktop" | "mobile" | "tablet"; refresh?: boolean },
  ) =>
    request<SearchRunReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/search/runs`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  listSearchRuns: (projectId: string) =>
    request<{ runs: SearchRunSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/search/runs`,
    ),

  getSearchRun: (projectId: string, runId: string) =>
    request<SearchRunReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/search/runs/${encodeURIComponent(runId)}`,
    ),

  // ---- Competitors + Content Gap (Macro Run 3) ----------------------------

  getCompetitorsWorkspace: (projectId: string) =>
    request<CompetitorsWorkspaceReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/competitors/workspace`,
    ),

  runCompetitors: (
    projectId: string,
    input: { serpSnapshotId: string; maxPages?: number },
  ) =>
    request<CompetitorRunReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/competitors/runs`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  getCompetitorRun: (projectId: string, runId: string) =>
    request<CompetitorRunReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/competitors/runs/${encodeURIComponent(runId)}`,
    ),

  setCandidateClassification: (
    projectId: string,
    pageSnapshotId: string,
    input: { classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY"; reason: string },
  ) =>
    request<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/competitors/candidates/${encodeURIComponent(pageSnapshotId)}/classification`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),

  getContentGapsWorkspace: (projectId: string) =>
    request<ContentGapsWorkspaceReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/workspace`,
    ),

  proposeContentGaps: (projectId: string, competitorRunId?: string) =>
    request<{ reportId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/proposals`,
      { method: "POST", body: JSON.stringify(competitorRunId ? { competitorRunId } : {}) },
    ),

  getContentGapReport: (projectId: string, reportId: string) =>
    request<ContentGapReportDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/reports/${encodeURIComponent(reportId)}`,
    ),

  saveGapDecisions: (
    projectId: string,
    reportId: string,
    input: {
      expectedReviewRevision: number;
      decisions: Array<{
        gapId: string;
        disposition: "REQUIRED" | "OPTIONAL" | "EXCLUDE";
        priority?: "HIGH" | "MEDIUM" | "LOW";
        note?: string;
      }>;
    },
  ) => {
    return request<{ ok: boolean; reviewRevision: number; decisionsDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/reports/${encodeURIComponent(reportId)}/decisions`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },

  acceptContentGaps: (
    projectId: string,
    reportId: string,
    input: {
      expectedReportDigest?: string;
      expectedDigest?: string;
      expectedReviewRevision: number;
      expectedDecisionsDigest: string;
    },
  ) => {
    return request<{ version: number; snapshotId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/reports/${encodeURIComponent(reportId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedReportDigest: input.expectedReportDigest ?? input.expectedDigest,
          expectedReviewRevision: input.expectedReviewRevision,
          expectedDecisionsDigest: input.expectedDecisionsDigest,
        }),
      },
    );
  },

  getAcceptedGapDetail: (projectId: string, version: number) =>
    request<AcceptedGapDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/content-gaps/accepted/${version}/detail`,
    ),

  // ---- Run 11 — derived operator workflow read model (read-only) ----------

  getWorkflow: (projectId: string) =>
    request<ProjectWorkflowReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow`,
    ),

  getWorkflowVersions: (projectId: string) =>
    request<ProjectVersionsReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-versions`,
    ),

  getWorkflowCosts: (projectId: string) =>
    request<ProjectCostsReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-costs`,
    ),
};

// ---- Competitors + Content Gap read-model shapes (mirror the API exactly) --

export interface CompetitorsWorkspaceReadModel {
  acceptedInput: { snapshotId: string; version: number; digest: string } | null;
  readiness: { canRun: boolean; blockers: string[]; mode: "production" | "fixture" };
  serpRuns: Array<{ serpSnapshotId: string; query: string; observedAt: string; hasIntelligence: boolean; stale?: boolean }>;
  recentRuns: Array<{ id: string; status: string; startedAt: string; errorCode: string | null }>;
}

export interface CompetitorCandidateView {
  pageSnapshotId: string;
  serpPosition: number;
  requestedUrl: string;
  domain: string;
  classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY";
  classificationReason: string;
  acquisitionStatus: "SUCCESS" | "BLOCKED" | "NON_HTML" | "UNSUPPORTED" | "FAILED";
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
}

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
  candidates: CompetitorCandidateView[];
  usage: { competitorPagesFetched: number; analyzedCount: number; blockedCount: number; failedCount: number };
}

export interface ContentGapsWorkspaceReadModel {
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

export interface GapDecisionView {
  gapId: string;
  disposition: "REQUIRED" | "OPTIONAL" | "EXCLUDE";
  priority: "HIGH" | "MEDIUM" | "LOW" | null;
  note: string | null;
}

export interface ContentGapReportDetail {
  report: {
    id: string;
    snapshotDigest: string;
    reviewState: string;
    reviewRevision: number;
    decisionsDigest: string | null;
    createdAt: string;
    model: string;
    provider: string;
    data: {
      coverageMatrix: {
        policyVersion: string;
        rows: Array<{
          requirementId: string;
          requirement: string;
          cells: Array<{ pageSnapshotId: string; domain: string; level: string }>;
        }>;
      };
      gaps: Array<{
        id: string;
        coverageRequirementId: string;
        userNeed: string;
        topicQuestion: string;
        competitorCoverage: string;
        competitorsCoveringIt: string[];
        treatmentPattern: string;
        baselineExpectation: string;
        ourEvidenceAvailable: Array<{ intakeField: string; itemIndex: number; excerpt: string }>;
        ourEvidenceMissing: string[];
        claimConstraints: string[];
        differentiationOpportunity: string;
        recommendedDisposition: string;
        priority: string | null;
        rationale: string;
        evidenceRefs: Array<{ pageSnapshotId: string; segmentId: string }>;
      }>;
      differentiationRequirements: {
        items: Array<{ requirement: string; basis: string; rationale: string }>;
      };
      searchSemantics: {
        intelligenceSnapshotId: string;
        intelligenceSnapshotDigest: string;
        primaryIntent: string;
        semanticCoverageRequirements: string[];
        userNeeds: string[];
      };
    };
  };
  decisions: GapDecisionView[];
  stale: boolean;
  staleReasons: string[];
}

export type ContentGapItemView = ContentGapReportDetail["report"]["data"]["gaps"][number];

export interface AcceptedGapItem extends Omit<ContentGapItemView, "priority"> {
  disposition: "REQUIRED" | "OPTIONAL" | "EXCLUDE";
  priority: "HIGH" | "MEDIUM" | "LOW" | null;
  note: string | null;
  recommendedDisposition: "REQUIRED" | "OPTIONAL" | "EXCLUDE";
  recommendedPriority: "HIGH" | "MEDIUM" | "LOW" | null;
}

export interface AcceptedGapDetail {
  snapshot: {
    id: string;
    version: number;
    snapshotDigest: string;
    acceptedAt: string;
    reportId: string;
    reportDigest: string;
    decisionsDigest: string;
    data: Omit<ContentGapReportDetail["report"]["data"], "gaps"> & {
      gaps: AcceptedGapItem[];
      decisions?: GapDecisionView[];
    };
  };
  stale: boolean;
  staleReasons: string[];
}

// ---- Search read-model shapes (mirror the Operator API exactly) ----------

export interface SearchWorkspaceReadModel {
  acceptedInput: {
    snapshotId: string;
    version: number;
    digest: string;
    acceptedAt: string;
  } | null;
  seeds: {
    topics: string[];
    queries: string[];
    competitors: string[];
    marketHints: string[];
  };
  readiness: {
    canRun: boolean;
    providerConfigured: boolean;
    providerReason: string | null;
    providerMode: "production" | "fixture";
    blockers: string[];
  };
  recentRuns: SearchRunSummary[];
}

export interface SearchRunSummary {
  id: string;
  status: string;
  query: string;
  provider: string;
  startedAt: string;
  errorCode: string | null;
}

export interface SearchRunReadModel {
  run: {
    id: string;
    status: "succeeded" | "failed";
    query: string;
    location: string | null;
    language: string | null;
    device: "desktop" | "mobile" | "tablet";
    provider: string;
    cacheReused: boolean;
    refreshRequested: boolean;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  acceptedInput: {
    snapshotId: string;
    version: number;
    digest: string;
    /** True when a newer accepted snapshot exists than the one this run used. */
    stale: boolean;
  };
  serp: {
    snapshotId: string;
    snapshotDigest: string;
    observedAt: string;
    provider: string;
    providerRequestId: string | null;
    organic: Array<{ position: number; url: string; domain: string; title: string; snippet: string }>;
    features: string[] | null;
    peopleAlsoAsk: Array<{ question: string; answer?: string }> | null;
    relatedSearches: string[] | null;
    rawDigest: string;
    usage: {
      costMicros?: number | null;
      currency?: string;
      costUnknown?: boolean;
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
      searchQueriesCount?: number | null;
    } | null;
  } | null;
  grounded: {
    snapshotId: string;
    snapshotDigest: string;
    model: string;
    promptVersion: string;
    observedAt: string;
    webSearchQueries: string[];
    sources: Array<{ title?: string; uri: string }>;
  } | null;
  intelligence: {
    snapshotId: string;
    snapshotDigest: string;
    model: string;
    promptVersion: string;
    data: {
      primaryIntent: string;
      intentRationale: string;
      secondaryIntents: string[];
      queryClusters: Array<{
        id: string;
        label: string;
        queries: string[];
        intent: string;
        primaryQuery: string;
        secondaryQueries: string[];
        rationale?: string;
        confidence: number;
      }>;
      longTailOpportunities: Array<{ query: string; rationale?: string; confidence: number }>;
      entities: Array<{ name: string; kind?: string; notes?: string }>;
      topics: Array<{ topic: string; subtopics: string[] }>;
      questions: string[];
      modifiers: string[];
      searchVocabulary: string[];
      relatedConcepts: string[];
      semanticCoverageRequirements: string[];
      userNeeds: string[];
      evidenceRefs: Array<{ kind: string; id: string; digest: string }>;
      reviewState: string;
    };
  } | null;
}

// ---- Writer pipeline (Macro Run 4) ------------------------------------------

export interface WriterPolicyView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  lineage: {
    acceptedInputSnapshotId: string;
    acceptedInputSnapshotVersion: number;
    acceptedInputDigest: string;
  };
  rules: Record<string, unknown>;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ContentBriefView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  slug: string;
  lineage: Record<string, unknown>;
  pageTarget: {
    slug: string;
    title: string;
    objective: string;
    audience: string;
    structureGuidance: string[];
    internalLinkIntent: string[];
    ctaIntent: string;
  };
  noGapLineageAcknowledged: boolean;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface WriterSnapshotView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  briefId: string;
  briefVersion: number;
  briefDigest: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface WriterProposalView {
  id: string;
  version: number;
  digest: string;
  slug: string;
  snapshotId: string;
  snapshotVersion: number;
  snapshotDigest: string;
  provider: string;
  model: string;
  overrideApplied: boolean;
  overriddenChampion: string | null;
  data: {
    title: string;
    metaDescription: string;
    introduction: string;
    sections: Array<{ heading: string; body: string }>;
    conclusion: string;
    cta: string;
    internalLinks: string[];
  };
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

export interface WriterQaView {
  reportId: string;
  digest: string;
  proposalId: string;
  proposalDigest: string;
  factual: Array<{ checkId: string; verdict: string; detail: string; evidence: Array<{ kind: string; ref: string; note?: string }> }>;
  search: Array<{ checkId: string; verdict: string; detail: string; evidence: Array<{ kind: string; ref: string; note?: string }> }>;
  editorial: Array<{ checkId: string; verdict: string; detail: string; evidence: Array<{ kind: string; ref: string; note?: string }> }>;
  overall: string;
}

export interface AcceptedContentView {
  lineageQualification?: "complete" | "no-gap-waiver" | "unqualified";
  id: string;
  version: number;
  slug: string;
  digest: string;
  proposalId: string;
  proposalDigest: string;
  qaReportDigest: string;
  data: unknown;
  acceptedAt: string;
}

export interface WriterWorkspace {
  policy: { latest: WriterPolicyView | null; versions: Array<{ id: string; version: number; state: string; digest: string; createdAt: string }> };
  brief: { latest: ContentBriefView | null; versions: Array<{ id: string; version: number; state: string; digest: string; slug: string; createdAt: string }> };
  snapshot: { latest: WriterSnapshotView | null; versions: Array<{ id: string; version: number; state: string; digest: string; createdAt: string }> };
  proposal: { latest: WriterProposalView | null; versions: Array<{ id: string; version: number; digest: string; slug: string; createdAt: string }> };
  accepted: { latest: AcceptedContentView | null; currentPages?: Array<{ id: string; version: number; slug: string; digest: string }>; versions?: Array<{ id: string; version: number; slug: string; digest: string }> };
  devModelOverride: {
    active: boolean;
    roles: Array<{ roleId: string; model: string; championModel: string }>;
  };
}

export const writerApi = {
  acceptedDetail: (projectId: string, id: string) => request<AcceptedContentView>(`/api/projects/${encodeURIComponent(projectId)}/writer/accepted/${encodeURIComponent(id)}`),
  workspace: (projectId: string) =>
    request<WriterWorkspace>(`/api/projects/${encodeURIComponent(projectId)}/writer/workspace`),

  derivePolicyDraft: (projectId: string) =>
    request<WriterPolicyView>(`/api/projects/${encodeURIComponent(projectId)}/writer/policy-draft`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  approvePolicy: (
    projectId: string,
    input: { policyId: string; expectedVersion: number; expectedDigest: string },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/writer/policy-approve`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  saveBriefDraft: (
    projectId: string,
    input: {
      pageTarget: {
        slug: string;
        title: string;
        objective: string;
        audience: string;
        structureGuidance: string[];
        internalLinkIntent: string[];
        ctaIntent: string;
      };
      contentBriefKeyPoints: string[];
      expectedRevision?: number;
      noGapLineageAcknowledged?: boolean;
    },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/writer/brief-draft`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  approveBrief: (
    projectId: string,
    input: {
      briefId: string;
      expectedVersion: number;
      expectedDigest: string;
      noGapLineageAcknowledged?: boolean;
    },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/writer/brief-approve`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  compileSnapshot: (projectId: string) =>
    request<WriterSnapshotView>(`/api/projects/${encodeURIComponent(projectId)}/writer/snapshot-compile`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  approveSnapshot: (
    projectId: string,
    input: { snapshotId: string; expectedVersion: number; expectedDigest: string },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/writer/snapshot-approve`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  generate: (projectId: string, snapshotId: string) =>
    request<WriterProposalView>(`/api/projects/${encodeURIComponent(projectId)}/writer/generate`, {
      method: "POST",
      body: JSON.stringify({ snapshotId }),
    }),

  runQa: (projectId: string) =>
    request<WriterQaView>(`/api/projects/${encodeURIComponent(projectId)}/writer/qa`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  acceptContent: (
    projectId: string,
    input: { proposalId: string; expectedProposalDigest: string },
  ) =>
    request<AcceptedContentView>(`/api/projects/${encodeURIComponent(projectId)}/writer/accept`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

// ---------------------------------------------------------------------------
// Assets (Macro Run 5)
// ---------------------------------------------------------------------------

export interface AssetVersionView {
  id: string;
  assetId: string;
  version: number;
  binaryDigest: string;
  mediaType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  originalFilename: string;
  provenance: {
    category: string;
    originalFilename: string;
    uploadedAt: string;
    extracted?: { format?: string; space?: string; exif?: Record<string, unknown> };
  };
  rightsStatus: string;
  rightsNote: string | null;
  altIntent: string | null;
  approvalState: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  governanceDigest: string | null;
  createdAt: string;
}

export interface AssetView {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  versions: AssetVersionView[];
  latestVersion: AssetVersionView | null;
}

export interface AssetAssignmentView {
  id: string;
  assetId: string;
  assetTitle: string;
  versionId: string;
  versionNumber: number;
  versionDigest: string;
  binaryDigest: string;
  pageSlug: string;
  role: string;
  assignedAt: string;
  replacementAvailable: boolean;
  latestApprovedVersionId: string | null;
  latestApprovedVersionNumber: number | null;
  acceptedPageContentId: string | null;
  acceptedPageContentVersion: number | null;
  acceptedPageContentDigest: string | null;
}

export interface AssetsWorkspace {
  acceptedPages: Array<{ id: string; version: number; contentDigest: string; slug: string }>;
  schemaVersion: string;
  imageryStrategy: string;
  assets: AssetView[];
  assignments: AssetAssignmentView[];
}

export interface AssetUploadResponse {
  assetId: string;
  versionId: string;
  version: number;
  binaryDigest: string;
  mediaType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  derivatives: Array<{ id: string; kind: string; width: number; height: number }>;
}

export const assetsApi = {
  workspace: (projectId: string) =>
    request<AssetsWorkspace>(`/api/projects/${encodeURIComponent(projectId)}/assets/workspace`),

  upload: (
    projectId: string,
    input: {
      dataBase64: string;
      filename: string;
      kind: string;
      title: string;
      rightsStatus: string;
      rightsNote?: string;
      altIntent?: string;
    },
  ) =>
    request<AssetUploadResponse>(`/api/projects/${encodeURIComponent(projectId)}/assets/uploads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateMetadata: (
    projectId: string,
    versionId: string,
    input: { rightsStatus: string; rightsNote?: string; altIntent?: string; expectedBinaryDigest: string },
  ) =>
    request<{ id: string; rightsStatus: string; altIntent: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/versions/${encodeURIComponent(versionId)}/metadata`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  approve: (projectId: string, versionId: string, expectedBinaryDigest: string) =>
    request<{ id: string; approvalState: string; binaryDigest: string; governanceDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/versions/${encodeURIComponent(versionId)}/approve`,
      { method: "POST", body: JSON.stringify({ expectedBinaryDigest }) },
    ),

  reject: (projectId: string, versionId: string, expectedBinaryDigest: string) =>
    request<{ id: string; approvalState: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/versions/${encodeURIComponent(versionId)}/reject`,
      { method: "POST", body: JSON.stringify({ expectedBinaryDigest }) },
    ),

  assign: (
    projectId: string,
    input: { acceptedPageContentId: string; acceptedPageContentVersion: number; acceptedPageContentDigest: string; expectedGovernanceDigest: string; assetId: string; versionId: string; pageSlug: string; role: string; expectedBinaryDigest: string },
  ) =>
    request<{ id: string; versionId: string; pageSlug: string; role: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/assignments`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  replace: (
    projectId: string,
    assignmentId: string,
    input: { pageAuthority?: { id: string; version: number; contentDigest: string; slug: string }; toVersionId: string; expectedBinaryDigest: string },
  ) =>
    request<{ id: string; versionId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/assets/assignments/${encodeURIComponent(assignmentId)}/replace`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  setImageryStrategy: (projectId: string, imageryStrategy: string) =>
    request<{ imageryStrategy: string }>(`/api/projects/${encodeURIComponent(projectId)}/assets/settings`, {
      method: "PUT",
      body: JSON.stringify({ imageryStrategy }),
    }),

  originalUrl: (projectId: string, versionId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/assets/versions/${encodeURIComponent(versionId)}/original`,

  derivativeUrl: (projectId: string, derivativeId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/assets/derivatives/${encodeURIComponent(derivativeId)}`,
};

// ---------------------------------------------------------------------------
// Design (Macro Run 6)
// ---------------------------------------------------------------------------

export interface DesignPreflight {
  configured: boolean;
  provider: string;
  reachable?: boolean;
  reason?: string;
}

export interface DesignScreenView {
  id: string;
  providerScreenName: string;
  title: string;
  deviceType: string;
  archetype: string;
  htmlDigest?: string;
  screenshotDigest?: string;
}

export interface DesignArchetypeView {
  kind: string;
  purpose: string;
  providerScreenNames: string[];
  sectionPatterns: string[];
  contentRequirements: string[];
  assetSlots: Array<{ slot: string; requirement: string; placeholder: boolean; boundAssetVersionId?: string }>;
  primaryCta: string;
  secondaryCta: string;
  responsiveBehavior: string;
  trustPresentation: string;
}

export interface DesignCandidateDataView {
  schemaVersion: string;
  provider: string;
  providerProjectName: string;
  providerDesignSystemAsset?: string;
  designMdDigest: string;
  designMdToolVersion: string;
  designMdLint: { errors: number; warnings: number; infos: number };
  tokens: {
    colors: Record<string, string | undefined>;
    typography: { headingFont: string; bodyFont: string; scaleNotes?: string };
    spacing: Record<string, string>;
    rounded: Record<string, string>;
    ctaHierarchy?: string;
    navigationLanguage?: string;
    imageryTreatment?: string;
    sectionRhythm?: string;
  };
  screens: DesignScreenView[];
  archetypes: DesignArchetypeView[];
  rationale?: string;
  providerSessionId?: string;
}

export interface DesignInputSnapshotView {
  id: string;
  version: number;
  inputDigest: string;
  data: unknown;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

export interface DesignCandidateView {
  id: string;
  provider: string;
  /** Durable evidence mode: live provider execution vs deterministic fixture. */
  providerMode: string;
  providerProjectName: string;
  inputSnapshotId: string;
  inputSnapshotVersion: number;
  inputDigest: string;
  candidateDigest: string;
  approvalState: string;
  reviewNotes: string | null;
  data: DesignCandidateDataView;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

export interface AcceptedDesignView {
  id: string;
  version: number;
  candidateId: string;
  candidateDigest: string;
  inputSnapshotId: string;
  inputSnapshotVersion: number;
  inputDigest: string;
  provider: string;
  /** Durable evidence mode carried from the accepted candidate. */
  providerMode: string;
  providerProjectName: string;
  designMdDigest: string;
  data: DesignCandidateDataView;
  stale: boolean;
  staleReason: string | null;
  acceptedAt: string;
}

export interface DesignWorkspace {
  schemaVersion: string;
  provider: { preflight: DesignPreflight };
  inputSnapshots: DesignInputSnapshotView[];
  latestInputSnapshot: DesignInputSnapshotView | null;
  candidates: DesignCandidateView[];
  accepted: AcceptedDesignView | null;
  acceptedVersions: Array<{ id: string; version: number; acceptedAt: string; stale: boolean }>;
}

export const designApi = {
  workspace: (projectId: string) =>
    request<DesignWorkspace>(`/api/projects/${encodeURIComponent(projectId)}/design/workspace`),

  deriveInputSnapshot: (projectId: string) =>
    request<{ id: string; version: number; inputDigest: string; stale: boolean; staleReason: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/design/input-snapshot`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  generate: (projectId: string) =>
    request<{
      id: string;
      candidateDigest: string;
      provider: string;
      providerProjectName: string;
      approvalState: string;
      screens: Array<{ id: string; title: string; deviceType: string }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/design/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  accept: (
    projectId: string,
    candidateId: string,
    expectedCandidateDigest: string,
    reviewNotes?: string,
  ) =>
    request<{ id: string; version: number; candidateDigest: string; acceptedAt: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/design/candidates/${encodeURIComponent(candidateId)}/accept`,
      { method: "POST", body: JSON.stringify({ candidateId, expectedCandidateDigest, reviewNotes }) },
    ),

  reject: (
    projectId: string,
    candidateId: string,
    expectedCandidateDigest: string,
    reviewNotes?: string,
  ) =>
    request<{ id: string; approvalState: string; reviewNotes: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/design/candidates/${encodeURIComponent(candidateId)}/reject`,
      { method: "POST", body: JSON.stringify({ candidateId, expectedCandidateDigest, reviewNotes }) },
    ),

  artifactUrl: (projectId: string, digest: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/design/artifacts/${encodeURIComponent(digest)}`,
};

// ---------------------------------------------------------------------------
// Visual Assets (Macro Run 7) — thin typed surface over the Operator API.
// ---------------------------------------------------------------------------

export interface VisualPreflight {
  configured: boolean;
  provider: string;
  reachable?: boolean;
  configuredModels?: string[];
  verifiedModels?: string[];
  reason?: string;
}

export interface VisualCandidateView {
  id: string;
  candidateIndex: number;
  binaryDigest: string;
  mediaType: string;
  width: number;
  height: number;
  state: string;
  c2paStatus: string;
  parentLineage: Array<{ versionId: string; binaryDigest: string }>;
  requestId: string;
  providerMode: string;
  model: string;
}

export interface VisualSlotView {
  slot: string;
  pageSlug: string;
  role: string;
  requiredRole: string;
  required?: boolean;
  requirement: string;
  truthClassProposal: string;
  truthClassRationale: string;
  truthClass: string | null;
  truthClassConfirmedAt: string | null;
  proposedStrategy: string;
  strategyReason: string;
  aspectRatio: string;
  minDimensions: { width: number; height: number };
  existingVersionId: string | null;
  existingBinaryDigest: string | null;
  existingGovernanceDigest: string | null;
  unresolvedReason: string;
  resolved: boolean;
  promptSnapshot: { id: string; digest: string; approvalState: string; operation: string } | null;
  candidates: VisualCandidateView[];
  acceptedResolution: {
    resolutionMode: string;
    truthClass: string;
    versionId: string;
    binaryDigest: string;
    governanceDigest: string;
    assetId: string;
    assignmentId: string | null;
  } | null;
}

export interface VisualWorkspace {
  schemaVersion: string;
  provider: { preflight: VisualPreflight; providerMode: string };
  plan: {
    id: string;
    version: number;
    planDigest: string;
    designArtifactId: string;
    designArtifactVersion: number;
    designCandidateDigest: string;
    designInputDigest: string;
    designProviderMode: string;
    createdAt: string;
    stale: boolean;
    staleReason: string | null;
  } | null;
  slots: VisualSlotView[];
  acceptedSet: {
    id: string;
    version: number;
    setDigest: string;
    providerMode: string;
    acceptedAt: string;
    slots: Array<{
      slot: string;
      pageSlug: string;
      role: string;
      versionId: string;
      resolutionMode: string;
      truthClass: string;
      /** TRUE only when the provider actually consumed the exact asset bytes. */
      providerConsumed: boolean;
      visualProviderConsumedSourceAsset?: boolean;
      visualProviderProducedAsset?: boolean;
      designProviderReferencedFinalAsset?: boolean;
      designProviderConsumedFinalAsset?: boolean;
    }>;
  } | null;
  budget: { accountedTodayMicros: number; activeReservationMicros: number };
  finalDesignPass?: {
    required: boolean;
    frozen: boolean;
    acceptedDesignVersion: number | null;
    designStalenessCode: string | null;
    /** TRUE only when the design provider actually consumed the bound assets. */
    providerConsumed: boolean | null;
    visualProviderConsumedSourceAsset?: boolean | null;
    visualProviderProducedAsset?: boolean | null;
    designProviderReferencedFinalAsset?: boolean | null;
    designProviderConsumedFinalAsset?: boolean | null;
  };
}

export const visualApi = {
  workspace: (projectId: string) =>
    request<VisualWorkspace>(`/api/projects/${encodeURIComponent(projectId)}/visual/workspace`),

  derivePlan: (projectId: string) =>
    request<{ id: string; version: number; planDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plan`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  classify: (projectId: string, planId: string, slot: string, truthClass: string) =>
    request<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/classification`,
      { method: "PUT", body: JSON.stringify({ truthClass, acknowledged: true }) },
    ),

  compilePrompt: (projectId: string, planId: string, slot: string, operation: "edit" | "generate", sourceVersionId?: string) =>
    request<{ id: string; promptDigest: string; approvalState: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/prompt-snapshot`,
      { method: "POST", body: JSON.stringify({ operation, sourceVersionId }) },
    ),

  approvePrompt: (projectId: string, snapshotId: string, promptDigest: string) =>
    request<{ id: string; approvalState: string; promptDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/prompt-snapshots/${encodeURIComponent(snapshotId)}/approve`,
      { method: "POST", body: JSON.stringify({ promptDigest }) },
    ),

  generate: (projectId: string, planId: string, slot: string, sourceVersionId?: string, escalationReason?: string) =>
    request<{
      requestId: string;
      reused: boolean;
      model: string;
      providerMode: string;
      candidates: Array<{ id: string; candidateIndex: number; binaryDigest: string; mediaType: string; width: number; height: number; state: string }>;
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/generate`,
      { method: "POST", body: JSON.stringify({ sourceVersionId, escalationReason }) },
    ),

  resolveReuse: (projectId: string, planId: string, slot: string, versionId?: string) =>
    request<{ versionId: string; binaryDigest: string; governanceDigest: string | null; assetId: string; assignmentId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/resolve-reuse`,
      { method: "POST", body: JSON.stringify({ versionId }) },
    ),

  resolveTransform: (
    projectId: string,
    planId: string,
    slot: string,
    input: { sourceVersionId: string; maxWidth?: number; aspectRatioCrop?: string; grayscale?: boolean; brightness?: number },
  ) =>
    request<{ versionId: string; binaryDigest: string; governanceDigest: string | null; assetId: string; assignmentId: string; transformation: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/resolve-transform`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  acceptCandidate: (projectId: string, planId: string, slot: string, candidateId: string, expectedBinaryDigest: string, confirmTruthDowngrade?: boolean) =>
    request<{ versionId: string; binaryDigest: string; governanceDigest: string; assetId: string; assignmentId: string | null; truthClass: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slot)}/accept`,
      { method: "POST", body: JSON.stringify({ candidateId, expectedBinaryDigest, confirmTruthDowngrade }) },
    ),

  acceptSet: (projectId: string, planId: string) =>
    request<{ id: string; version: number; setDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/plans/${encodeURIComponent(planId)}/accept-set`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  runFinalDesignPass: (projectId: string) =>
    request<DesignCandidateView>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/final-design-pass`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  acceptFinalDesign: (
    projectId: string,
    input: { candidateId: string; expectedCandidateDigest: string; reviewNotes?: string | null },
  ) =>
    request<AcceptedDesignView>(
      `/api/projects/${encodeURIComponent(projectId)}/visual/accept-final-design`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  candidateUrl: (projectId: string, candidateId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/visual/candidates/${encodeURIComponent(candidateId)}/bytes`,
};

// ---------------------------------------------------------------------------
// Production (Macro Run 9) — thin operator surface over the governed
// production pipeline. No Publish action (publication belongs to Run 13).
// ---------------------------------------------------------------------------

export interface ProductionInputView {
  id: string;
  version: number;
  pageIdentity: string;
  pageType: string;
  route: string;
  canonicalOrigin: string;
  inputDigest: string;
  acceptedContent: { id: string; version: number };
  acceptedDesign: { id: string; version: number };
  acceptedVisualSet: { id: string; version: number };
  renderer: { id: string; version: string; policyVersion: string };
  stale: boolean;
  staleReason: string | null;
}

export interface ProductionCandidateView {
  id: string;
  route: string;
  canonicalUrl: string;
  state: string;
  artifactDigest: string | null;
  productionInputVersion: number;
  createdAt: string;
}

export interface ProductionWorkspace {
  projectId: string;
  inputs: ProductionInputView[];
  candidates: ProductionCandidateView[];
}

export interface ProductionQaCheckView {
  checkId: string;
  group: string;
  verdict: "PASS" | "REVIEW" | "FAIL";
  detail: string;
  evidence: Array<{ kind: string; ref: string; note?: string }>;
}

export interface ProductionCandidateDetail {
  id: string;
  route: string;
  canonicalUrl: string;
  state: string;
  artifactDigest: string | null;
  productionInputId: string;
  productionInputVersion: number;
  productionInputDigest: string;
  qa: {
    id: string;
    overall: "PASS" | "REVIEW" | "FAIL";
    checks: ProductionQaCheckView[];
    createdAt: string;
  } | null;
  createdAt: string;
}

export const productionApi = {
  workspace: (projectId: string) =>
    request<ProductionWorkspace>(
      `/api/projects/${encodeURIComponent(projectId)}/production/workspace`,
    ),

  deriveInput: (projectId: string, pageSlug: string) =>
    request<{ id: string; version: number; route: string; inputDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/production/derive-input`,
      { method: "POST", body: JSON.stringify({ pageSlug }) },
    ),

  prepareCandidate: (projectId: string, pageSlug: string) =>
    request<{ candidateId: string; inputId: string; inputVersion: number; stale: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/production/prepare-candidate`,
      { method: "POST", body: JSON.stringify({ pageSlug }) },
    ),

  buildCandidate: (projectId: string, candidateId: string) =>
    request<{ candidateId: string; artifactDigest: string; routeCount: number; buildDurationMs: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/production/candidates/${encodeURIComponent(candidateId)}/build`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  runQa: (projectId: string, candidateId: string) =>
    request<{ qaRunId: string; overall: string; checks: ProductionQaCheckView[]; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/production/candidates/${encodeURIComponent(candidateId)}/qa`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /**
   * Run 11: collect current mandatory trusted QA evidence (axe, keyboard,
   * Lighthouse, gitleaks, OSV) for this exact candidate through the real
   * Operator API. Does NOT set candidate state — Run QA decides.
   */
  collectQaEvidence: (projectId: string, candidateId: string) =>
    request<{ collected: number; verdicts: Record<string, string> }>(
      `/api/projects/${encodeURIComponent(projectId)}/production/candidates/${encodeURIComponent(candidateId)}/qa-evidence`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  candidateDetail: (projectId: string, candidateId: string) =>
    request<ProductionCandidateDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/production/candidates/${encodeURIComponent(candidateId)}`,
    ),
};

// ---------------------------------------------------------------------------
// Run 10 — Page derivatives (summary + narration/audio)
// ---------------------------------------------------------------------------

export interface DerivativePolicyView {
  id: string;
  version: number;
  digest: string;
  summary: { enabled: boolean; language: string; policyVersion: string };
  audio: { enabled: boolean; language: string; voiceId: string | null; policyVersion: string };
}

export interface DerivativePageStatus {
  pageIdentity: string;
  summary: { status: string; state: string; language: string; policyVersion: string };
  audio: { status: string; state: string; language: string; voiceId: string | null; policyVersion: string };
  intentSnapshotId: string | null;
  set: { id: string; version: number; digest: string; summaryState: string; audioState: string } | null;
}

export interface DerivativeWorkspace {
  projectId: string;
  policy: DerivativePolicyView | null;
  pages: DerivativePageStatus[];
}

export interface SummaryQaCheck {
  checkId: string;
  verdict: "PASS" | "REVIEW" | "FAIL";
  detail: string;
}

export interface SummaryReview {
  proposalId: string;
  pageIdentity: string;
  sourceContent: { id: string; version: number };
  summaryText: string;
  qa: { checks: SummaryQaCheck[]; overall: string } | null;
  qaOverall: string | null;
  provider: string;
  model: string;
  providerMode: string;
  cost: { micros: number | null; currency: string };
}

export interface AudioReview {
  candidateId: string;
  pageIdentity: string;
  sourceContent: { id: string | null; version: number | null };
  narrationText: string | null;
  narrationDigest: string | null;
  voiceId: string;
  provider: string;
  engine: string;
  providerMode: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  cost: { micros: number | null; currency: string };
}

export const derivativesApi = {
  workspace: (projectId: string) =>
    request<DerivativeWorkspace>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/workspace`,
    ),

  updatePolicy: (
    projectId: string,
    input: {
      summary: { enabled: boolean; language: string; policyVersion: string };
      audio: { enabled: boolean; language: string; voiceId?: string; policyVersion: string };
    },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/policy`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  updateOverride: (
    projectId: string,
    pageIdentity: string,
    input: {
      summary: { mode: "inherit" | "enabled" | "disabled"; language?: string };
      audio: { mode: "inherit" | "enabled" | "disabled"; language?: string; voiceId?: string };
    },
  ) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/override`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  deriveIntent: (projectId: string, pageIdentity: string) =>
    request<{ id: string; digest: string; reused: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/intent`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  generateSummary: (projectId: string, pageIdentity: string) =>
    request<{ proposalId: string; proposalDigest: string; qaOverall: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/summary/generate`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  summaryReview: (projectId: string, proposalId: string) =>
    request<SummaryReview>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/summary/${encodeURIComponent(proposalId)}/review`,
    ),

  acceptSummary: (projectId: string, pageIdentity: string, proposalId: string) =>
    request<{ id: string; version: number; digest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/summary/accept`,
      { method: "POST", body: JSON.stringify({ proposalId }) },
    ),

  generateAudio: (projectId: string, pageIdentity: string) =>
    request<{ candidateId: string; candidateDigest: string; binaryDigest: string; mimeType: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/audio/generate`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  audioReview: (projectId: string, candidateId: string) =>
    request<AudioReview>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/audio/${encodeURIComponent(candidateId)}/review`,
    ),

  acceptAudio: (projectId: string, pageIdentity: string, candidateId: string) =>
    request<{ id: string; version: number; digest: string; binaryDigest: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/audio/accept`,
      { method: "POST", body: JSON.stringify({ candidateId }) },
    ),

  acceptSet: (projectId: string, pageIdentity: string) =>
    request<{ id: string; version: number; digest: string; reused: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/derivatives/pages/${encodeURIComponent(pageIdentity)}/set/accept`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};

// ---------------------------------------------------------------------------
// Run 11 — derived operator workflow read model (read-only)
// ---------------------------------------------------------------------------

export const workflowApi = {
  getWorkflow: (projectId: string) =>
    request<ProjectWorkflowReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow`,
    ),

  getVersions: (projectId: string) =>
    request<ProjectVersionsReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-versions`,
    ),

  getCosts: (projectId: string) =>
    request<ProjectCostsReadModel>(
      `/api/projects/${encodeURIComponent(projectId)}/workflow-costs`,
    ),
};
