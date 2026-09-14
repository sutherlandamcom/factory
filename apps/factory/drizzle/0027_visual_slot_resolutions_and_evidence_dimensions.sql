-- Run 7 Remediation: add durable visual_slot_resolutions table (P1-01 / P1-02)
-- and explicit evidence dimensions to accepted_visual_asset_slots (P2).

ALTER TABLE "accepted_visual_asset_slots"
  ADD COLUMN IF NOT EXISTS "visual_provider_consumed_source_asset" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "visual_provider_produced_asset" boolean NOT NULL DEFAULT false;

-- Backfill historical accepted slot rows truthfully based on resolution_mode
UPDATE "accepted_visual_asset_slots"
SET "visual_provider_produced_asset" = true
WHERE "resolution_mode" IN ('ai_generate', 'ai_edit');

UPDATE "accepted_visual_asset_slots"
SET "visual_provider_consumed_source_asset" = true
WHERE "resolution_mode" = 'ai_edit';

CREATE TABLE IF NOT EXISTS "visual_slot_resolutions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "plan_id" text NOT NULL REFERENCES "visual_asset_plans"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "page_slug" text NOT NULL,
  "role" text NOT NULL,
  "from_asset_id" text,
  "from_version_id" text,
  "from_binary_digest" text,
  "from_governance_digest" text,
  "to_asset_id" text NOT NULL,
  "to_version_id" text NOT NULL REFERENCES "asset_versions"("id") ON DELETE RESTRICT,
  "to_binary_digest" text NOT NULL,
  "to_governance_digest" text NOT NULL,
  "resolution_mode" text NOT NULL,
  "visual_provider_consumed_source_asset" boolean NOT NULL DEFAULT false,
  "visual_provider_produced_asset" boolean NOT NULL DEFAULT false,
  "prompt_snapshot_id" text REFERENCES "visual_prompt_snapshots"("id") ON DELETE SET NULL,
  "generation_request_id" text REFERENCES "visual_generation_requests"("id") ON DELETE SET NULL,
  "candidate_id" text REFERENCES "visual_asset_candidates"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visual_slot_resolutions_plan_slot_unique" UNIQUE ("plan_id", "slot"),
  CONSTRAINT "visual_slot_resolutions_to_digests_shape" CHECK ("to_binary_digest" ~ '^[0-9a-f]{64}$' AND "to_governance_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_slot_resolutions_from_digests_shape" CHECK (
    ("from_binary_digest" IS NULL OR "from_binary_digest" ~ '^[0-9a-f]{64}$')
    AND ("from_governance_digest" IS NULL OR "from_governance_digest" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "visual_slot_resolutions_resolution_mode_valid" CHECK (
    "resolution_mode" IN ('reuse_real', 'deterministic_transform', 'ai_edit', 'ai_generate')
  )
);

CREATE INDEX IF NOT EXISTS "visual_slot_resolutions_project_idx" ON "visual_slot_resolutions" ("project_id", "plan_id");
