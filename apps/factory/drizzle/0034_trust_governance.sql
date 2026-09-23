CREATE TABLE IF NOT EXISTS "page_intent_authorities" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"version" integer NOT NULL,
	"intent_digest" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_intent_authorities_project_page_version_unique" UNIQUE("project_id","page_identity","version"),
	CONSTRAINT "page_intent_authorities_digest_shape" CHECK ("intent_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_intent_authorities" ADD CONSTRAINT "page_intent_authorities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_intent_authorities_project_page_idx" ON "page_intent_authorities" USING btree ("project_id","page_identity","version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_lineage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"claim_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_lineage_records_digest_shape" CHECK ("content_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_lineage_records" ADD CONSTRAINT "claim_lineage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_lineage_records_project_page_idx" ON "claim_lineage_records" USING btree ("project_id","page_identity","content_digest");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_authorities" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"version" integer NOT NULL,
	"reviewer_ref" text NOT NULL,
	"reviewed_content_digest" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_authorities_project_page_version_unique" UNIQUE("project_id","page_identity","version"),
	CONSTRAINT "review_authorities_result_valid" CHECK ("result" IN ('APPROVED', 'CHANGES_REQUESTED')),
	CONSTRAINT "review_authorities_digest_shape" CHECK ("reviewed_content_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_authorities" ADD CONSTRAINT "review_authorities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_authorities_project_page_idx" ON "review_authorities" USING btree ("project_id","page_identity","version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "original_value_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "original_value_records" ADD CONSTRAINT "original_value_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "original_value_records_project_page_idx" ON "original_value_records" USING btree ("project_id","page_identity");
