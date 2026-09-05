CREATE TABLE "grounded_search_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"query" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"web_search_queries" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"citations" jsonb,
	"structured_output" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"usage" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_intelligence_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"query" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"serp_snapshot_id" text NOT NULL,
	"grounded_snapshot_id" text,
	"evidence_digests" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"review_state" text DEFAULT 'model_proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_intelligence_snapshots_review_state_valid" CHECK ("search_intelligence_snapshots"."review_state" IN ('model_proposed', 'operator_reviewed'))
);
--> statement-breakpoint
CREATE TABLE "search_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"query" text NOT NULL,
	"location" text,
	"language" text,
	"device" text NOT NULL,
	"provider" text NOT NULL,
	"request_digest" text NOT NULL,
	"refresh_requested" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_runs_status_valid" CHECK ("search_runs"."status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "search_runs_device_valid" CHECK ("search_runs"."device" IN ('desktop', 'mobile', 'tablet')),
	CONSTRAINT "search_runs_duration_ms_non_negative" CHECK ("search_runs"."duration_ms" IS NULL OR "search_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "serp_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"query" text NOT NULL,
	"location" text,
	"language" text,
	"device" text NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"request_digest" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"organic" jsonb NOT NULL,
	"features" jsonb,
	"people_also_ask" jsonb,
	"related_searches" jsonb,
	"raw_payload" jsonb,
	"raw_digest" text NOT NULL,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serp_snapshots_device_valid" CHECK ("serp_snapshots"."device" IN ('desktop', 'mobile', 'tablet'))
);
--> statement-breakpoint
ALTER TABLE "grounded_search_snapshots" ADD CONSTRAINT "grounded_search_snapshots_run_id_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounded_search_snapshots" ADD CONSTRAINT "grounded_search_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_intelligence_snapshots" ADD CONSTRAINT "search_intelligence_snapshots_run_id_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_intelligence_snapshots" ADD CONSTRAINT "search_intelligence_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_accepted_input_snapshot_id_project_input_snapshots_id_fk" FOREIGN KEY ("accepted_input_snapshot_id") REFERENCES "public"."project_input_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_snapshots" ADD CONSTRAINT "serp_snapshots_run_id_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_snapshots" ADD CONSTRAINT "serp_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grounded_search_snapshots_project_idx" ON "grounded_search_snapshots" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "search_intelligence_snapshots_project_idx" ON "search_intelligence_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "search_runs_project_created_idx" ON "search_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "search_runs_request_digest_idx" ON "search_runs" USING btree ("request_digest");--> statement-breakpoint
CREATE INDEX "serp_snapshots_project_idx" ON "serp_snapshots" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "serp_snapshots_request_digest_idx" ON "serp_snapshots" USING btree ("request_digest");