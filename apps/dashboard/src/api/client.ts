/**
 * Thin same-origin fetch wrapper for the trusted Operator API.
 * The Dashboard owns no business logic; it only calls semantic endpoints
 * and renders the canonical ProjectOperatorWorkspace read-model.
 */

import type { OperatorErrorCode } from "@factory/contracts";

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

const OPERATOR_ERROR_CODES: readonly OperatorErrorCode[] = [
  "invalid_json",
  "validation_error",
  "payload_too_large",
  "unsupported_media_type",
  "invalid_host",
  "cross_origin_forbidden",
  "not_found",
  "invalid_version",
  "intake_stale_revision",
  "intake_blocked",
  "intake_revision_mismatch",
  "intake_digest_mismatch",
  "intake_draft_not_found",
  "intake_schema_invalid",
  "search_input_not_accepted",
  "search_query_invalid",
  "search_provider_not_configured",
  "search_provider_unavailable",
  "search_provider_auth_failed",
  "search_provider_budget_blocked",
  "search_provider_rate_limited",
  "search_response_invalid",
  "search_normalization_failed",
  "search_intelligence_invalid",
  "search_run_not_found",
  "search_run_failed",
  "internal_error",
];

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
};

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
