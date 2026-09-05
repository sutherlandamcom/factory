/**
 * Read-model types mirroring the Operator API's ProjectOperatorWorkspace.
 * The Dashboard owns NO business logic — it renders this projection only.
 */

export interface ApiErrorBody {
  code?: string;
  message?: string;
}

export interface IntakeReadiness {
  status: "DRAFT" | "READY" | "APPROVED" | "CHANGED" | "BLOCKED";
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  nextActions: string[];
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  createdAt: string;
}

export interface DraftInfo {
  revision: number;
  digest: string | null;
  updatedAt: string;
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

export interface ProjectOperatorWorkspace {
  project: ProjectSummary;
  currentDraft: DraftInfo;
  readiness: IntakeReadiness;
  currentAcceptedSnapshot: SnapshotInfo | null;
  history: SnapshotInfo[];
  draftDiffersFromAccepted: boolean;
  status: IntakeReadiness["status"];
  nextActions: string[];
}
