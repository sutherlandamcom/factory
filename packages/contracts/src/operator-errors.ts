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
  /** No accepted ProjectInputSnapshot exists for the project. */
  "search_input_not_accepted",
  /** Search query failed deterministic validation/normalization. */
  "search_query_invalid",
  /** No structured SERP provider is configured in trusted backend config. */
  "search_provider_not_configured",
  /** Provider endpoint unreachable/failed before or during acquisition. */
  "search_provider_unavailable",
  /** Provider rejected authentication (credentials configured but invalid). */
  "search_provider_auth_failed",
  /** Trusted budget/quota policy blocks this execution (fail before spend). */
  "search_provider_budget_blocked",
  /** Provider rate limit hit; retry later with backoff. */
  "search_provider_rate_limited",
  /** Provider response unusable (malformed, schema violation, ceiling). */
  "search_response_invalid",
  /** Provider payload could not be deterministically normalized. */
  "search_normalization_failed",
  /** Analyst model output failed strict intelligence schema validation. */
  "search_intelligence_invalid",
  /** Search run/snapshot does not exist for this project. */
  "search_run_not_found",
  /** Search run failed for an internal reason (sanitized diagnostics). */
  "search_run_failed",
  /** No accepted ProjectInputSnapshot exists for this project (competitors). */
  "competitor_input_not_accepted",
  /** Referenced SERP snapshot does not exist for this project. */
  "competitor_serp_not_found",
  /** SERP evidence yielded no includable competitor candidates. */
  "competitor_no_candidates",
  /** Competitor run does not exist for this project. */
  "competitor_run_not_found",
  /** Competitor page acquisition/analysis failed (categorical; sanitized). */
  "competitor_page_failed",
  /** Competitor analyst output failed strict contract/evidence validation. */
  "competitor_analysis_invalid",
  /** Trusted competitor/analysis budget policy blocks this execution. */
  "competitor_budget_blocked",
  /** Competitor run failed for an internal reason (sanitized diagnostics). */
  "competitor_run_failed",
  /** Content gap report does not exist for this project. */
  "content_gap_report_not_found",
  /** Content gap proposal failed strict contract validation. */
  "content_gap_invalid",
  /** Accepted/being-accepted gap set is stale versus upstream artifacts. */
  "content_gap_stale",
  /** Operator decisions invalid (unknown gap, missing decision, bad shape). */
  "content_gap_decision_invalid",
  /** Acceptance rejected (digest mismatch, stale, or invalid state). */
  "content_gap_accept_failed",
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
  search_input_not_accepted: 409,
  search_query_invalid: 400,
  search_provider_not_configured: 409,
  search_provider_unavailable: 502,
  search_provider_auth_failed: 502,
  search_provider_budget_blocked: 402,
  search_provider_rate_limited: 429,
  search_response_invalid: 502,
  search_normalization_failed: 502,
  search_intelligence_invalid: 502,
  search_run_not_found: 404,
  search_run_failed: 500,
  competitor_input_not_accepted: 409,
  competitor_serp_not_found: 404,
  competitor_no_candidates: 422,
  competitor_run_not_found: 404,
  competitor_page_failed: 502,
  competitor_analysis_invalid: 502,
  competitor_budget_blocked: 402,
  competitor_run_failed: 500,
  content_gap_report_not_found: 404,
  content_gap_invalid: 502,
  content_gap_stale: 409,
  content_gap_decision_invalid: 422,
  content_gap_accept_failed: 409,
  internal_error: 500,
};

/** Fixed, sanitized message for unexpected internal failures. */
export const OPERATOR_INTERNAL_ERROR_MESSAGE = "Internal server error.";
