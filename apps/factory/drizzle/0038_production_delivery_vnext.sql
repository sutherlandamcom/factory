ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "candidate_id" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "qa_run_id" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "release_approval_id" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "candidate_routes" jsonb;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "snapshot_data" jsonb;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."production_candidates"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_qa_run_id_fk" FOREIGN KEY ("qa_run_id") REFERENCES "public"."production_qa_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_candidate_id_idx" ON "deployments" USING btree ("candidate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_release_approval_id_idx" ON "deployments" USING btree ("release_approval_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"site_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"qa_run_id" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"preview_version_id" text NOT NULL,
	"target_worker_name" text NOT NULL,
	"target_production_url" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"session_id" text NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"verification_seal" text,
	"seal_key_id" text DEFAULT 'v1' NOT NULL,
	"seal_status" text DEFAULT 'SEALED' NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_approvals_candidate_preview_unique" UNIQUE("candidate_id", "preview_version_id"),
	CONSTRAINT "release_approvals_artifact_digest_shape" CHECK ("artifact_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "release_approvals_verification_seal_shape" CHECK (
		("seal_status" = 'LEGACY_UNSEALED' AND "verification_seal" IS NULL)
		OR
		("seal_status" = 'SEALED' AND "verification_seal" IS NOT NULL AND "verification_seal" ~ '^[0-9a-f]{64}$')
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."production_candidates"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_qa_run_id_fk" FOREIGN KEY ("qa_run_id") REFERENCES "public"."production_qa_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_approvals_project_site_idx" ON "release_approvals" USING btree ("project_id", "site_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_approvals_candidate_idx" ON "release_approvals" USING btree ("candidate_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_release_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'release_approvals is append-only: DELETE is prohibited (id=%)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.site_id IS DISTINCT FROM OLD.site_id
       OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.qa_run_id IS DISTINCT FROM OLD.qa_run_id
       OR NEW.artifact_digest IS DISTINCT FROM OLD.artifact_digest
       OR NEW.preview_version_id IS DISTINCT FROM OLD.preview_version_id
       OR NEW.target_worker_name IS DISTINCT FROM OLD.target_worker_name
       OR NEW.target_production_url IS DISTINCT FROM OLD.target_production_url
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.actor_name IS DISTINCT FROM OLD.actor_name
       OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.is_synthetic IS DISTINCT FROM OLD.is_synthetic
       OR NEW.verification_seal IS DISTINCT FROM OLD.verification_seal
       OR NEW.seal_key_id IS DISTINCT FROM OLD.seal_key_id
       OR NEW.seal_status IS DISTINCT FROM OLD.seal_status
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'release_approvals protected fields are immutable (id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked = true AND NEW.revoked = false THEN
      RAISE EXCEPTION 'release_approvals revocation is irreversible (id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "release_approvals_immutable_trg" ON "release_approvals";
--> statement-breakpoint
CREATE TRIGGER "release_approvals_immutable_trg"
BEFORE UPDATE OR DELETE ON "release_approvals"
FOR EACH ROW EXECUTE FUNCTION enforce_release_approval_immutability();
