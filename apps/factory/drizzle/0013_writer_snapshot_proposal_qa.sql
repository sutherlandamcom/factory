-- WriterPromptSnapshot: the EXACT compiled prompt packet sent to the writer.
-- Versioned, deterministic digest, persisted, human-reviewable; approved
-- snapshots are immutable. No paid writer call before approval of the exact
-- snapshot digest.
CREATE TABLE IF NOT EXISTS "writer_prompt_snapshots" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "state" text NOT NULL,
  "brief_id" text NOT NULL,
  "brief_version" integer NOT NULL,
  "brief_digest" text NOT NULL,
  "system_prompt" text NOT NULL,
  "user_prompt" text NOT NULL,
  "max_output_tokens" integer NOT NULL,
  "data" jsonb NOT NULL,
  "snapshot_digest" text NOT NULL,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "writer_prompt_snapshots_state_valid" CHECK ("state" IN ('draft', 'approved')),
  CONSTRAINT "writer_prompt_snapshots_project_version_unique" UNIQUE ("project_id", "version"),
  CONSTRAINT "writer_prompt_snapshots_approved_state_valid" CHECK (
    ("state" = 'draft' AND "approved_at" IS NULL)
    OR ("state" = 'approved' AND "approved_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "writer_prompt_snapshots_project_idx" ON "writer_prompt_snapshots" USING btree ("project_id", "version");
--> statement-breakpoint
-- PageContentProposal: structured writer output bound to the exact approved
-- snapshot digest. Malformed output FAILS CLOSED (never persisted silently).
CREATE TABLE IF NOT EXISTS "page_content_proposals" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "snapshot_id" text NOT NULL,
  "snapshot_version" integer NOT NULL,
  "snapshot_digest" text NOT NULL,
  "slug" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "override_applied" boolean NOT NULL DEFAULT false,
  "overridden_champion" text,
  "data" jsonb NOT NULL,
  "proposal_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "page_content_proposals_project_version_unique" UNIQUE ("project_id", "version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_content_proposals_project_idx" ON "page_content_proposals" USING btree ("project_id", "version");
--> statement-breakpoint
-- Deterministic QA report for a proposal (factual + search + editorial).
CREATE TABLE IF NOT EXISTS "content_qa_reports" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "proposal_id" text NOT NULL,
  "proposal_version" integer NOT NULL,
  "proposal_digest" text NOT NULL,
  "data" jsonb NOT NULL,
  "report_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_qa_reports_proposal_unique" UNIQUE ("proposal_id")
);
--> statement-breakpoint
-- AcceptedPageContent: final human-approved content. Immutable; mutation
-- creates a new version; downstream derivatives become STALE.
CREATE TABLE IF NOT EXISTS "accepted_page_content" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "slug" text NOT NULL,
  "proposal_id" text NOT NULL,
  "proposal_version" integer NOT NULL,
  "proposal_digest" text NOT NULL,
  "qa_report_digest" text NOT NULL,
  "data" jsonb NOT NULL,
  "content_digest" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_page_content_project_version_unique" UNIQUE ("project_id", "version"),
  CONSTRAINT "accepted_page_content_project_slug_unique" UNIQUE ("project_id", "slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_page_content_project_idx" ON "accepted_page_content" USING btree ("project_id", "version");
