-- Design: Google Stitch Design Provider (Macro Run 6).
-- Governed design pipeline: immutable DesignInputSnapshot (authority-bound
-- lineage) -> provider candidate (immutable evidence) -> human acceptance ->
-- immutable AcceptedDesignArtifact (version/digest bound).
--
-- Snapshot-chain note: the drizzle meta snapshot chain on the accepted main
-- branch stops at 0006 (migrations 0007-0014 were hand-written with
-- IF NOT EXISTS, matching the accepted repository convention). This migration
-- follows the same convention and creates ONLY the three Run 6 tables.

CREATE TABLE IF NOT EXISTS "design_input_snapshots" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "data" jsonb NOT NULL,
  "input_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "design_input_snapshots_project_version_unique" UNIQUE("project_id", "version"),
  CONSTRAINT "design_input_snapshots_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "design_input_snapshots_digest_shape" CHECK ("input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_input_snapshots_project_idx" ON "design_input_snapshots" USING btree ("project_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_candidates" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "input_snapshot_id" text NOT NULL REFERENCES "design_input_snapshots"("id") ON DELETE CASCADE,
  "input_snapshot_version" integer NOT NULL,
  "input_digest" text NOT NULL,
  "provider" text NOT NULL,
  "provider_project_name" text NOT NULL,
  "data" jsonb NOT NULL,
  "candidate_digest" text NOT NULL,
  "approval_state" text DEFAULT 'pending' NOT NULL,
  "accepted_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "review_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "design_candidates_approval_state_valid" CHECK ("approval_state" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "design_candidates_digest_shape" CHECK ("candidate_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_candidates_input_digest_shape" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_candidates_state_timestamps_valid" CHECK (
    (
      ("approval_state" = 'pending' AND "accepted_at" IS NULL AND "rejected_at" IS NULL)
      OR ("approval_state" = 'accepted' AND "accepted_at" IS NOT NULL AND "rejected_at" IS NULL)
      OR ("approval_state" = 'rejected' AND "accepted_at" IS NULL AND "rejected_at" IS NOT NULL)
    )
  ),
  CONSTRAINT "design_candidates_provider_valid" CHECK ("provider" IN ('google-stitch'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_candidates_project_idx" ON "design_candidates" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_candidates_input_idx" ON "design_candidates" USING btree ("input_snapshot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accepted_design_artifacts" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "candidate_id" text NOT NULL REFERENCES "design_candidates"("id") ON DELETE RESTRICT,
  "candidate_digest" text NOT NULL,
  "input_snapshot_id" text NOT NULL,
  "input_snapshot_version" integer NOT NULL,
  "input_digest" text NOT NULL,
  "provider" text NOT NULL,
  "provider_project_name" text NOT NULL,
  "design_md_digest" text NOT NULL,
  "data" jsonb NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_design_artifacts_project_version_unique" UNIQUE("project_id", "version"),
  CONSTRAINT "accepted_design_artifacts_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "accepted_design_artifacts_candidate_digest_shape" CHECK ("candidate_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accepted_design_artifacts_input_digest_shape" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accepted_design_artifacts_design_md_digest_shape" CHECK ("design_md_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accepted_design_artifacts_provider_valid" CHECK ("provider" IN ('google-stitch'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_design_artifacts_project_idx" ON "accepted_design_artifacts" USING btree ("project_id", "version");
