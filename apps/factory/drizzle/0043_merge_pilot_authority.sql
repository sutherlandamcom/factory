-- 0043_merge_pilot_authority — P0-01 runtime TEST-ONLY authority for the
-- Merge Gateway pilot.
--
-- The pilot profile is REGISTRY-backed authority, not a declared constant:
-- - merge_pilot_profiles: operator-registered, exact-project-bound, digest
--   recorded, REVOCABLE (state ACTIVE|REVOKED), publication_authority pinned
--   to false by check constraint.
-- - merge_pilot_runs: per-invocation-window runs bound to one profile; the
--   grant binding (projectId, runId, profileId) re-verified on every call.
--
-- Provenance columns on page_content_proposals make pilot artifacts
-- durable-traceable and authority-labelled (`pilot_no_publication`), so a
-- masked direct DB copy to another project still classifies as pilot work.

CREATE TABLE "merge_pilot_profiles" (
  "id" text PRIMARY KEY,
  "profile_version" text NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "allowed_roles" jsonb NOT NULL,
  "budget_limit_micros" integer NOT NULL DEFAULT 2000000,
  "state" text NOT NULL DEFAULT 'ACTIVE',
  "publication_authority" boolean NOT NULL DEFAULT false,
  "approved_by" text NOT NULL,
  "approved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "profile_digest" text NOT NULL
);

ALTER TABLE "merge_pilot_profiles" ADD CONSTRAINT "merge_pilot_profiles_state_valid" CHECK ("state" IN ('ACTIVE', 'REVOKED', 'BLOCKED'));
ALTER TABLE "merge_pilot_profiles" ADD CONSTRAINT "merge_pilot_profiles_provider_valid" CHECK ("provider" = 'merge');
ALTER TABLE "merge_pilot_profiles" ADD CONSTRAINT "merge_pilot_profiles_model_valid" CHECK ("model" = 'zai/glm-5.3-flash');
ALTER TABLE "merge_pilot_profiles" ADD CONSTRAINT "merge_pilot_profiles_publication_authority_false" CHECK ("publication_authority" = false);
ALTER TABLE "merge_pilot_profiles" ADD CONSTRAINT "merge_pilot_profiles_budget_limit_range" CHECK ("budget_limit_micros" > 0 AND "budget_limit_micros" <= 2000000);
CREATE UNIQUE INDEX "merge_pilot_profiles_project_version_key" ON "merge_pilot_profiles" USING btree ("project_id","profile_version") WHERE "state" <> 'REVOKED';
CREATE INDEX "merge_pilot_profiles_project_idx" ON "merge_pilot_profiles" USING btree ("project_id");

CREATE TABLE "merge_pilot_runs" (
  "id" text PRIMARY KEY,
  "profile_id" text NOT NULL REFERENCES "merge_pilot_profiles"("id"),
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'ACTIVE',
  "note" text,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone
);

ALTER TABLE "merge_pilot_runs" ADD CONSTRAINT "merge_pilot_runs_state_valid" CHECK ("state" IN ('ACTIVE', 'CLOSED', 'REVOKED'));

-- Profile/project binding cannot be a CHECK constraint (PG disallows
-- subqueries there); enforced by a trigger instead — a run may only be
-- inserted/updated when its profile's project matches its own project.
CREATE OR REPLACE FUNCTION "merge_pilot_runs_enforce_profile_project"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" <> (SELECT mpp."project_id" FROM "merge_pilot_profiles" mpp WHERE mpp."id" = NEW."profile_id") THEN
    RAISE EXCEPTION 'merge_pilot_runs profile/project mismatch: run % cannot bind profile % for project %', NEW."id", NEW."profile_id", NEW."project_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "merge_pilot_runs_profile_project_trigger"
BEFORE INSERT OR UPDATE OF "profile_id", "project_id" ON "merge_pilot_runs"
FOR EACH ROW EXECUTE FUNCTION "merge_pilot_runs_enforce_profile_project"();

CREATE INDEX "merge_pilot_runs_profile_idx" ON "merge_pilot_runs" USING btree ("profile_id","state");

-- Proposal provenance (additive, nullable — champion rows stay untouched).
ALTER TABLE "page_content_proposals" ADD COLUMN "pilot_profile_id" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "pilot_profile_version" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "pilot_run_id" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "gateway_role" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "request_digest" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "response_digest" text;
ALTER TABLE "page_content_proposals" ADD COLUMN "provider_reported_cost_micros" integer;
ALTER TABLE "page_content_proposals" ADD COLUMN "policy_estimated_cost_micros" integer;
ALTER TABLE "page_content_proposals" ADD COLUMN "accounted_cost_micros" integer;
ALTER TABLE "page_content_proposals" ADD COLUMN "authority_status" text NOT NULL DEFAULT 'champion';

ALTER TABLE "page_content_proposals" ADD CONSTRAINT "page_content_proposals_authority_valid" CHECK ("authority_status" IN ('champion', 'pilot_no_publication'));
ALTER TABLE "page_content_proposals" ADD CONSTRAINT "page_content_proposals_authority_provenance" CHECK (
  ("authority_status" = 'pilot_no_publication' AND "pilot_profile_id" IS NOT NULL AND "pilot_run_id" IS NOT NULL)
  OR ("authority_status" = 'champion' AND "pilot_profile_id" IS NULL AND "pilot_run_id" IS NULL)
);
CREATE INDEX "page_content_proposals_authority_idx" ON "page_content_proposals" USING btree ("authority_status");
