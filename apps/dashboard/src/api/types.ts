/**
 * Read-model types mirroring the Operator API's ProjectOperatorWorkspace.
 * Single source of truth is the API client; this module re-exports the
 * surface the UI consumes. The Dashboard owns NO business logic.
 */
export type {
  ApiErrorBody,
  DraftInfo,
  IntakeReadiness,
  ProjectOperatorWorkspace,
  ProjectSummary,
  SnapshotInfo,
} from "./client";
export { OperatorApiError } from "./client";
