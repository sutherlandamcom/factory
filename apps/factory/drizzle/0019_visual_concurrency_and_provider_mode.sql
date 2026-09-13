-- Run 7 Remediation: add provider_mode to accepted_visual_asset_sets (production/fixture isolation)
-- and expand visual_generation_requests.result_state to include running/pending for single-flight concurrency.

ALTER TABLE "accepted_visual_asset_sets"
  ADD COLUMN IF NOT EXISTS "provider_mode" text NOT NULL DEFAULT 'live';

ALTER TABLE "accepted_visual_asset_sets"
  DROP CONSTRAINT IF EXISTS "accepted_visual_asset_sets_provider_mode_valid";

ALTER TABLE "accepted_visual_asset_sets"
  ADD CONSTRAINT "accepted_visual_asset_sets_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture'));

ALTER TABLE "visual_generation_requests"
  DROP CONSTRAINT IF EXISTS "visual_generation_requests_result_state_valid";

ALTER TABLE "visual_generation_requests"
  ADD CONSTRAINT "visual_generation_requests_result_state_valid" CHECK ("result_state" IN ('pending', 'running', 'succeeded', 'failed'));
