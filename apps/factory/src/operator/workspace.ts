import type { ProjectIntakePayload } from "@factory/contracts";
import { ProjectIntakeStore } from "./intake-store.js";
import { evaluateIntakeReadiness, type IntakeReadiness } from "./readiness.js";

export interface WorkspaceProjectSummary {
  id: string;
  key: string;
  name: string;
}

export interface WorkspaceDraft {
  revision: number;
  digest: string | null;
  payload: ProjectIntakePayload | null;
}

export interface WorkspaceSnapshot {
  version: number;
  digest: string;
  acceptedAt: Date;
  sourceRevision: number;
}

export interface WorkspaceProjection {
  project: WorkspaceProjectSummary;
  currentDraft: WorkspaceDraft;
  readiness: IntakeReadiness;
  currentAcceptedSnapshot: WorkspaceSnapshot | null;
  history: WorkspaceSnapshot[];
  draftDiffersFromAccepted: boolean;
  status: IntakeReadiness["status"];
  nextActions: string[];
}

/**
 * Builds the canonical operator-facing projection of a project's intake
 * state. The Dashboard consumes this projection; it never reconstructs
 * business state from raw records itself.
 */
export async function getProjectOperatorWorkspace(
  store: ProjectIntakeStore,
  project: { id: string; key: string; name: string },
): Promise<WorkspaceProjection | null> {
  const draft = await store.getDraft(project.id);
  if (!draft) return null;

  const history = await store.listSnapshots(project.id);
  const currentAcceptedSnapshot = history.length > 0 ? history[history.length - 1]! : null;

  const hasDraftPayload = draft.payload !== null && draft.digest !== null;
  const readiness: IntakeReadiness = hasDraftPayload
    ? evaluateIntakeReadiness(draft.payload!)
    : { status: "DRAFT", blockers: [], warnings: [], nextActions: [] };

  const draftDiffersFromAccepted = Boolean(
    currentAcceptedSnapshot && draft.digest && draft.digest !== currentAcceptedSnapshot.digest,
  );

  const status: IntakeReadiness["status"] = draftDiffersFromAccepted
    ? "CHANGED"
    : currentAcceptedSnapshot && !draftDiffersFromAccepted
      ? "APPROVED"
      : readiness.status;

  return {
    project: { id: project.id, key: project.key, name: project.name },
    currentDraft: {
      revision: draft.revision,
      digest: draft.digest,
      payload: draft.payload,
    },
    readiness,
    currentAcceptedSnapshot: currentAcceptedSnapshot
      ? {
          version: currentAcceptedSnapshot.version,
          digest: currentAcceptedSnapshot.digest,
          acceptedAt: currentAcceptedSnapshot.acceptedAt,
          sourceRevision: currentAcceptedSnapshot.sourceRevision,
        }
      : null,
    history: history.map((s) => ({
      version: s.version,
      digest: s.digest,
      acceptedAt: s.acceptedAt,
      sourceRevision: s.sourceRevision,
    })),
    draftDiffersFromAccepted,
    status,
    nextActions: [...readiness.nextActions],
  };
}
