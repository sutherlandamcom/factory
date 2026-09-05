import { emptyProjectIntakePayload, type ProjectIntakePayload } from "@factory/contracts";
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
  /** Null until the operator saves the first draft; readers get a blank template. */
  payload: ProjectIntakePayload | null;
  updatedAt: Date | null;
}

export interface WorkspaceSnapshot {
  version: number;
  digest: string;
  acceptedAt: Date;
  sourceRevision: number;
}

export type WorkspaceStatus = "DRAFT" | "BLOCKED" | "READY" | "APPROVED" | "CHANGED";

export interface WorkspaceProjection {
  project: WorkspaceProjectSummary;
  currentDraft: WorkspaceDraft;
  readiness: IntakeReadiness;
  currentAcceptedSnapshot: WorkspaceSnapshot | null;
  /** Ascending by version; the LAST entry is the currently accepted one. */
  history: WorkspaceSnapshot[];
  draftDiffersFromAccepted: boolean;
  status: WorkspaceStatus;
  nextActions: string[];
}

/**
 * Single canonical operator read-model for Project Intake (v0).
 *
 * The Dashboard consumes this projection; neither the API layer nor the
 * Dashboard reconstructs business state from raw records. Status resolution:
 *
 * - no saved draft payload      -> DRAFT   (fresh project, immediately editable)
 * - readiness blockers          -> BLOCKED (draft cannot be accepted)
 * - snapshot && draft == snapshot digest -> APPROVED
 * - snapshot && draft differs   -> CHANGED (vN accepted; draft has edits)
 * - otherwise                   -> READY
 *
 * For a project whose draft row does not exist yet (or still has a null
 * payload), the projection substitutes the canonical BLANK intake payload so
 * the Dashboard form can bind immediately. The blank template contains no
 * business facts and fails readiness, so it can never be accepted as-is.
 */
export async function getProjectOperatorWorkspace(
  store: ProjectIntakeStore,
  project: { id: string; key: string; name: string },
): Promise<WorkspaceProjection | null> {
  const draft = await store.getDraft(project.id);
  const history = await store.listSnapshots(project.id);
  const currentAcceptedSnapshot =
    history.length > 0 ? history[history.length - 1]! : null;

  const storedPayload = draft?.payload ?? null;
  const hasDraftPayload = storedPayload !== null && draft?.digest != null;
  const effectivePayload: ProjectIntakePayload = hasDraftPayload
    ? storedPayload!
    : emptyProjectIntakePayload();

  const evaluated = evaluateIntakeReadiness(effectivePayload);
  // A never-saved draft is DRAFT (fresh + editable), even though the blank
  // template fails readiness: the blockers/nextActions still guide the
  // operator, but the project is not flagged BLOCKED before any input.
  const readiness: IntakeReadiness = hasDraftPayload
    ? evaluated
    : { ...evaluated, status: "DRAFT" };

  const draftDiffersFromAccepted = Boolean(
    currentAcceptedSnapshot && draft?.digest && draft.digest !== currentAcceptedSnapshot.digest,
  );

  const status: WorkspaceStatus = draftDiffersFromAccepted
    ? "CHANGED"
    : currentAcceptedSnapshot && !draftDiffersFromAccepted
      ? "APPROVED"
      : readiness.status;

  return {
    project: { id: project.id, key: project.key, name: project.name },
    currentDraft: {
      revision: draft?.revision ?? 0,
      digest: draft?.digest ?? null,
      // The canonical BLANK template (no business facts) until the first
      // save; the Dashboard form binds directly to this payload.
      payload: effectivePayload,
      updatedAt: draft?.updatedAt ?? null,
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
