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
  /** Search provider credentials or settings are missing. */
  "search_provider_not_configured",
  /** Search analyst credentials (e.g. OpenRouter API key) are missing in production mode. */
  "search_analyst_not_configured",
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
  /** Competitor or gap analyst credentials (e.g. OpenRouter API key) are missing in production mode. */
  "competitor_analyst_not_configured",
  /** Competitor run failed for an internal reason (sanitized diagnostics). */
  "competitor_run_failed",
  /** Competitor run or underlying SERP is stale versus current accepted ProjectInput. */
  "competitor_upstream_stale",
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
  /** No accepted ProjectInputSnapshot exists for this project (writer). */
  "writer_input_not_accepted",
  /** No accepted ContentGap snapshot exists and no explicit no-gap-lineage acknowledgement was provided. */
  "content_gap_lineage_missing",
  /** Factory Writer Policy does not exist or is not approved for this project. */
  "writer_policy_not_approved",
  /** Writer policy/brief/snapshot approval rejected (digest mismatch, stale revision, or invalid state). */
  "writer_approval_failed",
  /** Writer policy/brief/snapshot is stale versus an upstream accepted input mutation. */
  "writer_artifact_stale",
  /** Referenced writer artifact (brief/snapshot/proposal) does not exist for this project. */
  "writer_artifact_not_found",
  /** Writer artifact payload violates the writer content contract. */
  "writer_content_invalid",
  /** Trusted writer budget policy blocks this execution (fail before spend). */
  "writer_budget_blocked",
  /** Writer provider credentials (e.g. OpenRouter API key) are missing in production mode. */
  "writer_provider_not_configured",
  /** Writer provider endpoint unreachable/failed before or during generation. */
  "writer_provider_unavailable",
  /** Writer proposal output failed strict contract validation (fail closed, no silent repair). */
  "writer_proposal_invalid",
  /** Page content acceptance rejected (digest mismatch, stale, or QA not passed). */
  "content_accept_failed",
  /** Accepted page content does not exist for this project. */
  "accepted_content_not_found",
  /** Deterministic QA report already exists for this proposal at a different digest (insert-only, never replaced). */
  "writer_qa_conflict",
  /** Budget ledger invariant trip; usage was durably accounted before failing. */
  "budget_invariant_violation",
  /** Asset upload failed deterministic validation (type, size, corruption, mismatch). */
  "asset_upload_invalid",
  /** Asset does not exist for this project. */
  "asset_not_found",
  /** Asset version does not exist for this project. */
  "asset_version_not_found",
  /** Asset page assignment does not exist for this project. */
  "asset_assignment_not_found",
  /** Asset approval/rejection rejected (digest mismatch or non-pending state). */
  "asset_approval_failed",
  /** Metadata mutation rejected: approved asset versions are immutable. */
  "asset_version_immutable",
  /** Assignment rejected: version not approved or rights unresolved. */
  "asset_rights_blocked",
  /** Assignment slot conflict or replacement digest/version mismatch. */
  "asset_assignment_conflict",
  /** Trusted local asset storage failed (fail closed, nothing persisted). */
  "asset_storage_failed",
  /** No accepted ProjectInputSnapshot exists for this project (design). */
  "design_input_not_accepted",
  /** Design input snapshot/candidate/accepted design does not exist for this project. */
  "design_not_found",
  /** Design input snapshot is stale versus upstream accepted authorities. */
  "design_input_stale",
  /** Design approval/rejection rejected (digest mismatch or invalid state). */
  "design_approval_failed",
  /** Accepted design is immutable; a new version is required. */
  "design_immutable",
  /** Design provider credentials/configuration are missing. */
  "design_provider_not_configured",
  /** Design provider endpoint unreachable/failed before or during generation. */
  "design_provider_unavailable",
  /** Provider output failed strict contract validation (fail closed). */
  "design_provider_output_invalid",
  /** DESIGN.md artifact failed validation (structural or lint errors). */
  "design_md_invalid",
  /** Trusted design provider budget policy blocks this execution (fail before spend). */
  "design_budget_blocked",
  /** Accepted design missing/stale/fixture-classified for a visual live path. */
  "visual_design_not_eligible",
  /** Visual plan is stale versus the accepted design; re-derive required. */
  "visual_plan_stale",
  /** Truth classification must be confirmed before this operation. */
  "visual_classification_required",
  /** Requested resolution mode is forbidden for the slot's truth class. */
  "visual_truth_policy_violation",
  /** Prompt snapshot missing/not approved, or digest mismatch. */
  "visual_prompt_not_approved",
  /** Visual provider credentials/configuration are missing. */
  "visual_provider_not_configured",
  /** Visual provider endpoint failed before or during execution. */
  "visual_provider_unavailable",
  /** Visual provider output failed strict byte/contract validation. */
  "visual_provider_output_invalid",
  /** Trusted visual budget policy blocks this execution (fail before spend). */
  "visual_budget_blocked",
  /** Visual plan/prompt/request/candidate/set does not exist for this project. */
  "visual_not_found",
  /** Slot acceptance rejected (digest mismatch, invalid state, or lineage). */
  "visual_acceptance_failed",
  /** Accepted visual set is immutable; resolve remaining slots or re-accept. */
  "visual_set_immutable",
  /** Slot has no accepted resolution yet (set acceptance fail-closed). */
  "visual_slot_unresolved",
  // Run 10 — page derivatives (summary + narration/audio)
  "derivative_policy_not_found",
  "derivative_authority_stale",
  "derivative_authority_digest_mismatch",
  "derivative_authority_wrong_project",
  "derivative_required_artifact_missing",
  "derivative_fixture_not_production_authority",
  "derivative_binary_digest_mismatch",
  "derivative_artifact_immutable",
  "derivative_generation_blocked",
  "derivative_qa_failed",
  "summary_provider_not_configured",
  /** A mandatory trusted QA tool is unavailable in this environment (fail closed; never treated as PASS). */
  "qa_tool_unavailable",
  /** A trusted QA tool exceeded its bounded execution time budget (fail closed). */
  "qa_tool_timeout",
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
  search_analyst_not_configured: 409,
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
  competitor_analyst_not_configured: 409,
  competitor_run_failed: 500,
  competitor_upstream_stale: 409,
  content_gap_report_not_found: 404,
  content_gap_invalid: 502,
  content_gap_stale: 409,
  content_gap_decision_invalid: 422,
  content_gap_accept_failed: 409,
  writer_input_not_accepted: 409,
  content_gap_lineage_missing: 409,
  writer_policy_not_approved: 409,
  writer_approval_failed: 409,
  writer_artifact_stale: 409,
  writer_artifact_not_found: 404,
  writer_content_invalid: 422,
  writer_budget_blocked: 402,
  writer_provider_not_configured: 409,
  writer_provider_unavailable: 502,
  writer_proposal_invalid: 502,
  content_accept_failed: 409,
  accepted_content_not_found: 404,
  writer_qa_conflict: 409,
  budget_invariant_violation: 409,
  asset_upload_invalid: 422,
  asset_not_found: 404,
  asset_version_not_found: 404,
  asset_assignment_not_found: 404,
  asset_approval_failed: 409,
  asset_version_immutable: 409,
  asset_rights_blocked: 409,
  asset_assignment_conflict: 409,
  asset_storage_failed: 500,
  design_input_not_accepted: 409,
  design_not_found: 404,
  design_input_stale: 409,
  design_approval_failed: 409,
  design_immutable: 409,
  design_provider_not_configured: 409,
  design_provider_unavailable: 502,
  design_provider_output_invalid: 502,
  design_md_invalid: 502,
  design_budget_blocked: 402,
  visual_design_not_eligible: 409,
  visual_plan_stale: 409,
  visual_classification_required: 409,
  visual_truth_policy_violation: 422,
  visual_prompt_not_approved: 409,
  visual_provider_not_configured: 409,
  visual_provider_unavailable: 502,
  visual_provider_output_invalid: 502,
  visual_budget_blocked: 402,
  visual_not_found: 404,
  visual_acceptance_failed: 409,
  visual_set_immutable: 409,
  visual_slot_unresolved: 409,
  derivative_policy_not_found: 404,
  derivative_authority_stale: 409,
  derivative_authority_digest_mismatch: 409,
  derivative_authority_wrong_project: 403,
  derivative_required_artifact_missing: 404,
  derivative_fixture_not_production_authority: 409,
  derivative_binary_digest_mismatch: 409,
  derivative_artifact_immutable: 409,
  derivative_generation_blocked: 409,
  derivative_qa_failed: 409,
  qa_tool_unavailable: 503,
  qa_tool_timeout: 504,
  summary_provider_not_configured: 503,
  internal_error: 500,
};

/** Fixed, sanitized message for unexpected internal failures. */
export const OPERATOR_INTERNAL_ERROR_MESSAGE = "Internal server error.";
