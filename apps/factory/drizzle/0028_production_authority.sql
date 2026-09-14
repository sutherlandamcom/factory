-- Run 9: Production authority — ProductionPageInput, ProductionCandidate, QA runs.
-- Immutable, versioned, digest-bound production build inputs and candidates with
-- typed QA evidence. Lineage by id+version; fail closed on missing authority.

CREATE TABLE IF NOT EXISTS "production_page_inputs" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "page_identity" text NOT NULL,
  "page_type" text NOT NULL,
  "route" text NOT NULL,
  "canonical_origin" text NOT NULL,
  "accepted_content_id" text NOT NULL,
  "accepted_content_version" integer NOT NULL,
  "accepted_content_digest" text NOT NULL,
  "accepted_design_id" text NOT NULL,
  "accepted_design_version" integer NOT NULL,
  "accepted_design_digest" text NOT NULL,
  "accepted_visual_set_id" text NOT NULL,
  "accepted_visual_set_version" integer NOT NULL,
  "accepted_visual_set_digest" text NOT NULL,
  "renderer_id" text NOT NULL,
  "renderer_version" text NOT NULL,
  "renderer_policy_version" text NOT NULL,
  "data" jsonb NOT NULL,
  "input_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_page_inputs_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "production_page_inputs_digest_shape" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "production_page_inputs_authority_digests_shape" CHECK (
    "accepted_content_digest" ~ '^[0-9a-f]{64}$' AND
    "accepted_design_digest" ~ '^[0-9a-f]{64}$' AND
    "accepted_visual_set_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "production_page_inputs_renderer_valid" CHECK ("renderer_id" = 'astro-static'),
  CONSTRAINT "production_page_inputs_page_type_valid" CHECK (
    "page_type" IN ('homepage', 'service', 'location', 'editorial', 'investment_advisory')
  ),
  CONSTRAINT "production_page_inputs_project_version_unique" UNIQUE ("project_id", "version"),
  -- Route authority: one intended page = one production route per project.
  CONSTRAINT "production_page_inputs_project_route_unique" UNIQUE ("project_id", "route")
);
CREATE INDEX IF NOT EXISTS "production_page_inputs_project_idx" ON "production_page_inputs" ("project_id", "version");

CREATE TABLE IF NOT EXISTS "production_candidates" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "production_input_id" text NOT NULL REFERENCES "production_page_inputs"("id") ON DELETE RESTRICT,
  "production_input_version" integer NOT NULL,
  "production_input_digest" text NOT NULL,
  "page_identity" text NOT NULL,
  "route" text NOT NULL,
  "canonical_url" text NOT NULL,
  "artifact_digest" text,
  "artifact_ref" text,
  "asset_references" jsonb,
  "state" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_candidates_state_valid" CHECK (
    "state" IN ('pending', 'built', 'qa_passed', 'qa_failed', 'stale')
  ),
  CONSTRAINT "production_candidates_input_digest_shape" CHECK ("production_input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "production_candidates_artifact_digest_shape" CHECK ("artifact_digest" IS NULL OR "artifact_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "production_candidates_canonical_shape" CHECK ("canonical_url" LIKE 'http%')
);
CREATE INDEX IF NOT EXISTS "production_candidates_project_idx" ON "production_candidates" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "production_candidates_input_idx" ON "production_candidates" ("production_input_id");

CREATE TABLE IF NOT EXISTS "production_qa_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "candidate_id" text NOT NULL REFERENCES "production_candidates"("id") ON DELETE CASCADE,
  "candidate_artifact_digest" text,
  "data" jsonb NOT NULL,
  "overall" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_qa_runs_overall_valid" CHECK ("overall" IN ('PASS', 'REVIEW', 'FAIL'))
);
CREATE INDEX IF NOT EXISTS "production_qa_runs_candidate_idx" ON "production_qa_runs" ("candidate_id", "created_at");
