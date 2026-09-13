-- Run 7 Remediation: add provider_mode to accepted_visual_asset_sets (production/fixture isolation)
-- with fail-closed migration for historical rows (never default-live for unknown history).
-- Add single-flight execution lease fields (lease_holder, lease_expires_at) and states (pending, running, succeeded, failed).

ALTER TABLE "accepted_visual_asset_sets"
  ADD COLUMN IF NOT EXISTS "provider_mode" text;

-- Safely migrate historical rows: derive from visual_asset_plans.design_provider_mode if available,
-- but fallback strictly to 'fixture' (never default-live for unknown history).
UPDATE "accepted_visual_asset_sets" s
SET "provider_mode" = COALESCE(
  (SELECT p.design_provider_mode FROM "visual_asset_plans" p WHERE p.id = s.plan_id),
  'fixture'
)
WHERE s."provider_mode" IS NULL;

UPDATE "accepted_visual_asset_sets"
SET "provider_mode" = 'fixture'
WHERE "provider_mode" IS NULL OR "provider_mode" NOT IN ('live', 'fixture');

ALTER TABLE "accepted_visual_asset_sets"
  ALTER COLUMN "provider_mode" SET NOT NULL,
  ALTER COLUMN "provider_mode" SET DEFAULT 'fixture';

ALTER TABLE "accepted_visual_asset_sets"
  DROP CONSTRAINT IF EXISTS "accepted_visual_asset_sets_provider_mode_valid";

ALTER TABLE "accepted_visual_asset_sets"
  ADD CONSTRAINT "accepted_visual_asset_sets_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture'));

ALTER TABLE "visual_generation_requests"
  ADD COLUMN IF NOT EXISTS "lease_holder" text,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;

ALTER TABLE "visual_generation_requests"
  DROP CONSTRAINT IF EXISTS "visual_generation_requests_result_state_valid";

ALTER TABLE "visual_generation_requests"
  ADD CONSTRAINT "visual_generation_requests_result_state_valid" CHECK ("result_state" IN ('pending', 'running', 'succeeded', 'failed'));
