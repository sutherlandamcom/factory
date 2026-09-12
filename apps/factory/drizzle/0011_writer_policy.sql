-- Factory Writer Policy: versioned, digest-bound, immutable-once-approved
-- projection of the accepted Content Constitution (NOT a second editable SOT).
CREATE TABLE IF NOT EXISTS "writer_policies" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "state" text NOT NULL,
  "accepted_input_snapshot_id" text NOT NULL,
  "accepted_input_version" integer NOT NULL,
  "accepted_input_digest" text NOT NULL,
  "data" jsonb NOT NULL,
  "policy_digest" text NOT NULL,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "writer_policies_state_valid" CHECK ("state" IN ('draft', 'approved')),
  CONSTRAINT "writer_policies_project_version_unique" UNIQUE ("project_id", "version"),
  CONSTRAINT "writer_policies_approved_state_valid" CHECK (
    ("state" = 'draft' AND "approved_at" IS NULL)
    OR ("state" = 'approved' AND "approved_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "writer_policies_project_idx" ON "writer_policies" USING btree ("project_id", "version");
