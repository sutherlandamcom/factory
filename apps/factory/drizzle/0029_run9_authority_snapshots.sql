ALTER TABLE "production_page_inputs" DROP CONSTRAINT "production_page_inputs_project_route_unique";
ALTER TABLE "production_page_inputs" ADD COLUMN "site_id" text;
ALTER TABLE "production_page_inputs" ADD COLUMN "site_name" text;
ALTER TABLE "production_page_inputs" ADD COLUMN "site_language" text;
ALTER TABLE "production_page_inputs" ADD COLUMN "site_profile_digest" text;
ALTER TABLE "production_page_inputs" DROP CONSTRAINT "production_page_inputs_authority_digests_shape";
ALTER TABLE "production_page_inputs" ADD CONSTRAINT "production_page_inputs_authority_digests_shape" CHECK ("accepted_content_digest" ~ '^[0-9a-f]{64}$' AND "accepted_design_digest" ~ '^[0-9a-f]{64}$' AND "accepted_visual_set_digest" ~ '^[0-9a-f]{64}$' AND ("site_profile_digest" IS NULL OR "site_profile_digest" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "production_page_inputs" ADD CONSTRAINT "production_page_inputs_project_page_version_unique" UNIQUE ("project_id", "page_identity", "version");

CREATE TABLE "production_route_authorities" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "route" text NOT NULL,
  "page_identity" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_route_authorities_pkey" PRIMARY KEY ("project_id", "route"),
  CONSTRAINT "production_route_authorities_project_page_unique" UNIQUE ("project_id", "page_identity")
);
INSERT INTO "production_route_authorities" ("project_id", "route", "page_identity") SELECT "project_id", "route", "page_identity" FROM "production_page_inputs" ON CONFLICT DO NOTHING;

ALTER TABLE "production_candidates" ADD COLUMN "manifest_set_digest" text;
ALTER TABLE "production_candidates" ADD COLUMN "redirect_snapshot_digest" text;
ALTER TABLE "production_candidates" ADD COLUMN "site_profile_digest" text;
ALTER TABLE "production_candidates" ADD COLUMN "renderer_version" text;
ALTER TABLE "production_candidates" ADD COLUMN "repository_sha" text;
ALTER TABLE "production_candidates" ADD COLUMN "lockfile_digest" text;
ALTER TABLE "production_candidates" ADD CONSTRAINT "production_candidates_snapshot_digests_shape" CHECK (("manifest_set_digest" IS NULL OR "manifest_set_digest" ~ '^[0-9a-f]{64}$') AND ("redirect_snapshot_digest" IS NULL OR "redirect_snapshot_digest" ~ '^[0-9a-f]{64}$') AND ("site_profile_digest" IS NULL OR "site_profile_digest" ~ '^[0-9a-f]{64}$') AND ("lockfile_digest" IS NULL OR "lockfile_digest" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "production_candidates" ADD CONSTRAINT "production_candidates_repository_sha_shape" CHECK ("repository_sha" IS NULL OR "repository_sha" ~ '^[0-9a-f]{40}$');

CREATE TABLE "production_candidate_inputs" (
  "candidate_id" text NOT NULL REFERENCES "production_candidates"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "production_input_id" text NOT NULL REFERENCES "production_page_inputs"("id") ON DELETE RESTRICT,
  "production_input_version" integer NOT NULL, "production_input_digest" text NOT NULL,
  "page_identity" text NOT NULL, "route" text NOT NULL, "manifest_digest" text NOT NULL,
  CONSTRAINT "production_candidate_inputs_pkey" PRIMARY KEY ("candidate_id", "production_input_id"),
  CONSTRAINT "production_candidate_inputs_route_unique" UNIQUE ("candidate_id", "route"),
  CONSTRAINT "production_candidate_inputs_digests_shape" CHECK ("production_input_digest" ~ '^[0-9a-f]{64}$' AND "manifest_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "production_candidate_inputs_project_idx" ON "production_candidate_inputs" ("project_id", "candidate_id");

CREATE TABLE "production_candidate_redirects" (
  "candidate_id" text NOT NULL REFERENCES "production_candidates"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source" text NOT NULL, "destination" text NOT NULL, "kind" text NOT NULL,
  CONSTRAINT "production_candidate_redirects_pkey" PRIMARY KEY ("candidate_id", "source"),
  CONSTRAINT "production_candidate_redirects_kind_valid" CHECK ("kind" IN ('permanent', 'temporary'))
);

CREATE TABLE "production_qa_evidence" (
  "id" text PRIMARY KEY NOT NULL, "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "candidate_id" text NOT NULL REFERENCES "production_candidates"("id") ON DELETE CASCADE,
  "check_id" text NOT NULL, "scope" text NOT NULL, "subject" text NOT NULL,
  "tool" text NOT NULL, "tool_version" text NOT NULL, "execution_digest" text NOT NULL,
  "artifact_digest" text, "repository_sha" text, "lockfile_digest" text, "verdict" text NOT NULL,
  "data" jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_qa_evidence_candidate_check_subject_unique" UNIQUE ("candidate_id", "check_id", "subject"),
  CONSTRAINT "production_qa_evidence_scope_valid" CHECK ("scope" IN ('page', 'site', 'repository')),
  CONSTRAINT "production_qa_evidence_verdict_valid" CHECK ("verdict" IN ('PASS', 'REVIEW', 'FAIL')),
  CONSTRAINT "production_qa_evidence_digest_shape" CHECK ("execution_digest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "production_qa_run_checks" (
  "qa_run_id" text NOT NULL REFERENCES "production_qa_runs"("id") ON DELETE CASCADE,
  "check_id" text NOT NULL, "scope" text NOT NULL, "subject" text NOT NULL, "verdict" text NOT NULL, "data" jsonb NOT NULL,
  CONSTRAINT "production_qa_run_checks_pkey" PRIMARY KEY ("qa_run_id", "check_id", "subject")
);
