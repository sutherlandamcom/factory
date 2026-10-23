CREATE TABLE IF NOT EXISTS "monitoring_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"site_id" text NOT NULL,
	"route" text NOT NULL,
	"deployment_id" text,
	"version_id" text,
	"observation_type" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"collection_window" text DEFAULT 'realtime' NOT NULL,
	"freshness" text DEFAULT 'fresh' NOT NULL,
	"metrics" jsonb,
	"evidence_ref" text,
	"error_message" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monitoring_observations" ADD CONSTRAINT "monitoring_observations_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monitoring_observations" ADD CONSTRAINT "monitoring_observations_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monitoring_observations" ADD CONSTRAINT "monitoring_observations_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitoring_observations_project_site_idx" ON "monitoring_observations" USING btree ("project_id", "site_id", "observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitoring_observations_route_idx" ON "monitoring_observations" USING btree ("site_id", "route", "observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitoring_observations_deployment_idx" ON "monitoring_observations" USING btree ("deployment_id");
