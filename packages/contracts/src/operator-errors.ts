/**
 * Stable Operator API error contract (trusted boundary).
 *
 * The Operator API always serializes failures as:
 *
 *   { "error": { "code": OperatorErrorCode, "message": string } }
 *
 * `code` values are a closed union so the Dashboard can branch on them
 * without parsing English messages. Unexpected server faults are mapped to
 * the single `internal_error` code with a FIXED, sanitized message — raw
 * internal `error.message` content (stacks, driver text, DB URLs, provider
 * secrets) must never reach the client.
 */

export const OPERATOR_ERROR_CODES = [
  /** Request body is not valid JSON. */
  "invalid_json",
  /** Body failed strict request-shape validation. */
  "validation_error",
  /** Request body exceeded the configured byte ceiling. */
  "payload_too_large",
  /** Mutation without Content-Type: application/json. */
  "unsupported_media_type",
  /** Host header outside the local operator allowlist. */
  "invalid_host",
  /** Cross-origin state-changing request rejected. */
  "cross_origin_forbidden",
  /** Unknown endpoint/resource. */
  "not_found",
  /** Path version parameter is not a positive integer. */
  "invalid_version",
  /** Optimistic-concurrency save rejected: base revision is not current. */
  "intake_stale_revision",
  /** Acceptance rejected: draft fails deterministic readiness blockers. */
  "intake_blocked",
  /** Acceptance rejected: expected revision is not the current draft revision. */
  "intake_revision_mismatch",
  /** Acceptance rejected: expected digest does not match the stored draft. */
  "intake_digest_mismatch",
  /** Referenced draft/snapshot does not exist. */
  "intake_draft_not_found",
  /** Stored or submitted intake payload violates the Project Intake contract. */
  "intake_schema_invalid",
  /** Unexpected server fault (message is always the sanitized fixed string). */
  "internal_error",
] as const;

export type OperatorErrorCode = (typeof OPERATOR_ERROR_CODES)[number];

/** HTTP status for each operator error code (stable mapping, single source). */
export const OPERATOR_ERROR_STATUS: Readonly<Record<OperatorErrorCode, number>> = {
  invalid_json: 400,
  validation_error: 400,
  invalid_version: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_host: 403,
  cross_origin_forbidden: 403,
  not_found: 404,
  intake_stale_revision: 409,
  intake_blocked: 422,
  intake_revision_mismatch: 409,
  intake_digest_mismatch: 409,
  intake_draft_not_found: 404,
  intake_schema_invalid: 422,
  internal_error: 500,
};

/** Fixed, sanitized message for unexpected internal failures. */
export const OPERATOR_INTERNAL_ERROR_MESSAGE = "Internal server error.";
