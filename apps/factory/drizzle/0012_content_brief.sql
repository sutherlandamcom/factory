-- Content Production Brief: page-level writer brief composed deterministically
-- from accepted intake + approved writer policy + Page Target + accepted gap
-- snapshot lineage. The Page Target fields are brief draft fields entered
-- through the Dashboard and versioned with the brief — NOT a pages registry.
CREATE TABLE IF NOT EXISTS "content_briefs" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "state" text NOT NULL,
  "accepted_input_snapshot_id" text NOT NULL,
  "accepted_input_version" integer NOT NULL,
  "accepted_input_digest" text NOT NULL,
  "writer_policy_id" text NOT NULL,
  "writer_policy_version" integer NOT NULL,
  "writer_policy_digest" text NOT NULL,
  "gap_snapshot_id" text,
  "gap_snapshot_version" integer,
  "gap_snapshot_digest" text,
  "no_gap_lineage_acknowledged" boolean NOT NULL DEFAULT false,
  "slug" text NOT NULL,
  "data" jsonb NOT NULL,
  "brief_digest" text NOT NULL,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_briefs_state_valid" CHECK ("state" IN ('draft', 'approved')),
  CONSTRAINT "content_briefs_project_version_unique" UNIQUE ("project_id", "version"),
  CONSTRAINT "content_briefs_approved_state_valid" CHECK (
    ("state" = 'draft' AND "approved_at" IS NULL)
    OR ("state" = 'approved' AND "approved_at" IS NOT NULL)
  ),
  CONSTRAINT "content_briefs_gap_lineage_valid" CHECK (
    (
      -- default: accepted gap snapshot REQUIRED
      ("gap_snapshot_id" IS NOT NULL AND "gap_snapshot_version" IS NOT NULL AND "gap_snapshot_digest" IS NOT NULL)
      OR "no_gap_lineage_acknowledged" = true
    )
  ),
  CONSTRAINT "content_briefs_no_gap_flag_consistent" CHECK (
    ("no_gap_lineage_acknowledged" = false) OR ("gap_snapshot_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_briefs_project_slug_idx" ON "content_briefs" USING btree ("project_id", "slug");
