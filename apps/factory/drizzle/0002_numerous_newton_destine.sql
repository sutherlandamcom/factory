CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_commit" text NOT NULL,
	"artifact_digest" text,
	"version_id" text,
	"preview_url" text,
	"previous_version_id" text,
	"worker_name" text NOT NULL,
	"production_url" text NOT NULL,
	"status" text NOT NULL,
	"preview_verified" boolean DEFAULT false NOT NULL,
	"production_verified" boolean DEFAULT false NOT NULL,
	"rolled_back" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"artifact_directory" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "deployments_status_valid" CHECK ("deployments"."status" IN ('preparing', 'uploaded', 'preview_verified', 'promoting', 'promoted', 'verified', 'rolled_back', 'failed', 'needs_review'))
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "cloudflare_worker_name" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "production_url" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_site_id_created_at_idx" ON "deployments" USING btree ("site_id","created_at");