CREATE TABLE IF NOT EXISTS "production_effective_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"site_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"version_id" text NOT NULL,
	"candidate_id" text,
	"event_type" text NOT NULL,
	"from_version_id" text,
	"to_version_id" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"actor_role" text,
	"session_id" text,
	"candidate_routes" jsonb,
	"artifact_digest" text,
	"evidence_ref" text,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_effective_transitions_event_type_check" CHECK ("event_type" IN ('PUBLISH', 'ROLLBACK'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_effective_transitions" ADD CONSTRAINT "production_effective_transitions_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_effective_transitions" ADD CONSTRAINT "production_effective_transitions_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_effective_transitions" ADD CONSTRAINT "production_effective_transitions_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prod_eff_trans_site_effective_idx" ON "production_effective_transitions" USING btree ("site_id", "effective_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prod_eff_trans_project_site_idx" ON "production_effective_transitions" USING btree ("project_id", "site_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_production_effective_transitions_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production_effective_transitions is append-only: DELETE is prohibited (id=%)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'production_effective_transitions is append-only: UPDATE is prohibited (id=%)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_production_effective_transitions_immutability ON "production_effective_transitions";
--> statement-breakpoint
CREATE TRIGGER trg_production_effective_transitions_immutability
  BEFORE UPDATE OR DELETE ON "production_effective_transitions"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_production_effective_transitions_immutability();
