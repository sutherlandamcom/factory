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
};
