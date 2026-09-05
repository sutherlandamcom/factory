CREATE TABLE "project_input_drafts" (
	"project_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"digest" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_input_drafts_revision_non_negative" CHECK ("project_input_drafts"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_input_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"source_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"accepted_by" text DEFAULT 'operator' NOT NULL,
	"acceptance_state" text DEFAULT 'human_accepted' NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_input_snapshots_project_version_unique" UNIQUE("project_id","version"),
	CONSTRAINT "project_input_snapshots_version_positive" CHECK ("project_input_snapshots"."version" >= 1),
	CONSTRAINT "project_input_snapshots_source_revision_positive" CHECK ("project_input_snapshots"."source_revision" >= 1),
	CONSTRAINT "project_input_snapshots_acceptance_state_valid" CHECK ("project_input_snapshots"."acceptance_state" IN ('human_accepted'))
);
--> statement-breakpoint
ALTER TABLE "project_input_drafts" ADD CONSTRAINT "project_input_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_input_snapshots" ADD CONSTRAINT "project_input_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_input_snapshots_project_idx" ON "project_input_snapshots" USING btree ("project_id","version");