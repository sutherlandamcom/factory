CREATE TABLE IF NOT EXISTS "page_archetype_authorities" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"archetype" text NOT NULL,
	"version" integer NOT NULL,
	"authority_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_archetype_authorities_project_page_version_unique" UNIQUE("project_id","page_identity","version"),
	CONSTRAINT "page_archetype_authorities_archetype_valid" CHECK ("archetype" IN ('homepage', 'service', 'location', 'editorial', 'investment_advisory')),
	CONSTRAINT "page_archetype_authorities_digest_shape" CHECK ("authority_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_archetype_authorities" ADD CONSTRAINT "page_archetype_authorities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_archetype_authorities_project_page_idx" ON "page_archetype_authorities" USING btree ("project_id","page_identity","version");
