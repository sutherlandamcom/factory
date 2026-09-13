-- Visual Assets: Final Asset Resolution (Macro Run 7).
-- Governed final-asset-resolution pipeline on top of the accepted Run 5 media
-- authority and Run 6 design authority:
--   versioned VisualAssetPlan (truth-class proposals)
--   -> operator truth-class confirmations (classification authority)
--   -> immutable VisualPromptSnapshot (human-approved before spend)
--   -> deduplicated VisualGenerationRequest (request-digest cache)
--   -> immutable VisualAssetCandidate (byte-validated, content-addressed)
--   -> AcceptedVisualAssetSet + slots (binds EXACT AssetVersion per slot)
--   -> visual budget reservations (writer-ledger lifecycle clone)
--
-- Snapshot-chain note: the drizzle meta snapshot chain stops at 0006;
-- migrations 0007+ are hand-written with IF NOT EXISTS (accepted convention).
-- This migration creates ONLY the Run 7 tables and extends the Run 5
-- provenance vocabulary with the `derived` category (additive; no historical
-- migration file is modified).

CREATE TABLE IF NOT EXISTS "visual_asset_plans" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "design_artifact_id" text NOT NULL,
  "design_artifact_version" integer NOT NULL,
  "design_candidate_digest" text NOT NULL,
  "design_input_digest" text NOT NULL,
  "design_provider_mode" text NOT NULL,
  "slots" jsonb NOT NULL,
  "plan_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visual_asset_plans_project_version_unique" UNIQUE("project_id", "version"),
  CONSTRAINT "visual_asset_plans_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "visual_asset_plans_digest_shape" CHECK ("plan_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_asset_plans_design_digest_shape" CHECK ("design_candidate_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_asset_plans_input_digest_shape" CHECK ("design_input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_asset_plans_provider_mode_valid" CHECK ("design_provider_mode" IN ('live', 'fixture'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_asset_plans_project_idx" ON "visual_asset_plans" USING btree ("project_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visual_slot_classifications" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "visual_asset_plans"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "truth_class" text NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visual_slot_classifications_plan_slot_unique" UNIQUE("plan_id", "slot"),
  CONSTRAINT "visual_slot_classifications_truth_class_valid" CHECK (
    "truth_class" IN ('documentary', 'documentary_edited', 'illustrative', 'decorative', 'data_visualization')
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visual_prompt_snapshots" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "plan_id" text NOT NULL REFERENCES "visual_asset_plans"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "operation" text NOT NULL,
  "truth_class" text NOT NULL,
  "data" jsonb NOT NULL,
  "prompt_digest" text NOT NULL,
  "approval_state" text NOT NULL DEFAULT 'pending',
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visual_prompt_snapshots_digest_shape" CHECK ("prompt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_prompt_snapshots_operation_valid" CHECK ("operation" IN ('edit', 'generate')),
  CONSTRAINT "visual_prompt_snapshots_truth_class_valid" CHECK (
    "truth_class" IN ('documentary', 'documentary_edited', 'illustrative', 'decorative', 'data_visualization')
  ),
  CONSTRAINT "visual_prompt_snapshots_approval_state_valid" CHECK ("approval_state" IN ('pending', 'approved')),
  CONSTRAINT "visual_prompt_snapshots_approved_at_valid" CHECK (
    ("approval_state" = 'pending' AND "approved_at" IS NULL)
    OR ("approval_state" = 'approved' AND "approved_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_prompt_snapshots_project_idx" ON "visual_prompt_snapshots" USING btree ("project_id", "prompt_digest");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visual_generation_requests" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "request_digest" text NOT NULL,
  "prompt_snapshot_id" text NOT NULL REFERENCES "visual_prompt_snapshots"("id") ON DELETE CASCADE,
  "prompt_digest" text NOT NULL,
  "provider" text NOT NULL,
  "provider_mode" text NOT NULL,
  "model" text NOT NULL,
  "model_policy_version" text NOT NULL,
  "operation" text NOT NULL,
  "escalation_reason" text,
  "provider_request_ref" text,
  "result_state" text NOT NULL,
  "cost_micros" integer,
  "raw_metadata" jsonb,
  "failure_code" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "visual_generation_requests_project_digest_unique" UNIQUE("project_id", "request_digest"),
  CONSTRAINT "visual_generation_requests_digest_shape" CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_generation_requests_prompt_digest_shape" CHECK ("prompt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_generation_requests_provider_valid" CHECK ("provider" IN ('google-genai')),
  CONSTRAINT "visual_generation_requests_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture')),
  CONSTRAINT "visual_generation_requests_operation_valid" CHECK ("operation" IN ('edit', 'generate')),
  CONSTRAINT "visual_generation_requests_result_state_valid" CHECK ("result_state" IN ('succeeded', 'failed')),
  CONSTRAINT "visual_generation_requests_cost_non_negative" CHECK ("cost_micros" IS NULL OR "cost_micros" >= 0),
  CONSTRAINT "visual_generation_requests_escalation_reason_valid" CHECK (
    "escalation_reason" IS NULL OR "escalation_reason" IN (
      'composition_complexity', 'brand_consistency', 'text_rendering', 'reference_composition', 'quality_floor_failure'
    )
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_generation_requests_project_idx" ON "visual_generation_requests" USING btree ("project_id", "slot");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visual_asset_candidates" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL REFERENCES "visual_generation_requests"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "candidate_index" integer NOT NULL,
  "binary_digest" text NOT NULL,
  "media_type" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "storage_key" text NOT NULL,
  "parent_lineage" jsonb NOT NULL,
  "prompt_digest" text NOT NULL,
  "c2pa" jsonb NOT NULL,
  "provider_metadata" jsonb,
  "qa" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visual_asset_candidates_request_index_unique" UNIQUE("request_id", "candidate_index"),
  CONSTRAINT "visual_asset_candidates_digest_shape" CHECK ("binary_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_asset_candidates_prompt_digest_shape" CHECK ("prompt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "visual_asset_candidates_media_type_valid" CHECK ("media_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "visual_asset_candidates_dimensions_positive" CHECK ("width" >= 1 AND "height" >= 1 AND "byte_size" >= 1),
  CONSTRAINT "visual_asset_candidates_state_valid" CHECK ("state" IN ('pending', 'selected', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_asset_candidates_project_idx" ON "visual_asset_candidates" USING btree ("project_id", "slot");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accepted_visual_asset_sets" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "plan_id" text NOT NULL REFERENCES "visual_asset_plans"("id") ON DELETE CASCADE,
  "design_artifact_id" text NOT NULL,
  "design_artifact_version" integer NOT NULL,
  "design_candidate_digest" text NOT NULL,
  "design_input_digest" text NOT NULL,
  "set_digest" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_visual_asset_sets_project_version_unique" UNIQUE("project_id", "version"),
  CONSTRAINT "accepted_visual_asset_sets_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "accepted_visual_asset_sets_digest_shape" CHECK ("set_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accepted_visual_asset_sets_design_digest_shape" CHECK ("design_candidate_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_visual_asset_sets_project_idx" ON "accepted_visual_asset_sets" USING btree ("project_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accepted_visual_asset_slots" (
  "id" text PRIMARY KEY,
  "set_id" text NOT NULL REFERENCES "accepted_visual_asset_sets"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "page_slug" text NOT NULL,
  "role" text NOT NULL,
  "resolved_version_id" text NOT NULL REFERENCES "asset_versions"("id") ON DELETE RESTRICT,
  "binary_digest" text NOT NULL,
  "governance_digest" text NOT NULL,
  "resolution_mode" text NOT NULL,
  "truth_class" text NOT NULL,
  "prompt_snapshot_id" text REFERENCES "visual_prompt_snapshots"("id") ON DELETE SET NULL,
  "generation_request_id" text REFERENCES "visual_generation_requests"("id") ON DELETE SET NULL,
  "candidate_id" text REFERENCES "visual_asset_candidates"("id") ON DELETE SET NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_visual_asset_slots_set_slot_unique" UNIQUE("set_id", "slot"),
  CONSTRAINT "accepted_visual_asset_slots_digest_shape" CHECK ("binary_digest" ~ '^[0-9a-f]{64}$' AND "governance_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accepted_visual_asset_slots_resolution_mode_valid" CHECK (
    "resolution_mode" IN ('reuse_real', 'deterministic_transform', 'ai_edit', 'ai_generate')
  ),
  CONSTRAINT "accepted_visual_asset_slots_truth_class_valid" CHECK (
    "truth_class" IN ('documentary', 'documentary_edited', 'illustrative', 'decorative', 'data_visualization')
  ),
  -- Hard truth policy: fully generated imagery can never carry a
  -- documentary classification (documentary rows resolve by real/reused
  -- or controlled-edit authority only).
  CONSTRAINT "accepted_visual_asset_slots_documentary_forbids_generated" CHECK (
    NOT ("resolution_mode" = 'ai_generate' AND "truth_class" IN ('documentary', 'documentary_edited', 'data_visualization'))
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_visual_asset_slots_project_idx" ON "accepted_visual_asset_slots" USING btree ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visual_budget_reservations" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "authorized_micros" integer NOT NULL,
  "accounted_micros" integer,
  "state" text NOT NULL,
  "invocation_digest" text NOT NULL,
  "lineage" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accounted_at" timestamp with time zone,
  CONSTRAINT "visual_budget_reservations_state_valid" CHECK ("state" IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')),
  CONSTRAINT "visual_budget_reservations_accounted_valid" CHECK (
    ("state" = 'ACTIVE' AND "accounted_micros" IS NULL AND "accounted_at" IS NULL)
    OR ("state" = 'ACCOUNTED' AND "accounted_micros" IS NOT NULL AND "accounted_at" IS NOT NULL)
    OR ("state" = 'RELEASED' AND "accounted_micros" IS NULL AND "accounted_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_budget_reservations_state_created_idx" ON "visual_budget_reservations" USING btree ("state", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visual_budget_reservations_created_idx" ON "visual_budget_reservations" USING btree ("created_at");
--> statement-breakpoint
-- Run 7 additive vocabulary: provenance category `derived` marks versions
-- produced from an approved parent asset (deterministic transform or AI
-- edit). The Run 5 CHECK is replaced (additive value only; no historical
-- migration file modified).
ALTER TABLE "asset_versions" DROP CONSTRAINT IF EXISTS "asset_versions_provenance_category_valid";
--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_provenance_category_valid"
  CHECK ("provenance" ->> 'category' IN ('operator_upload', 'derived', 'generated', 'imported'));
