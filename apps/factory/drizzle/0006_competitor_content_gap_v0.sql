CREATE TABLE "accepted_content_gap_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"report_id" text NOT NULL,
	"report_digest" text NOT NULL,
	"decisions_digest" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"serp_snapshot_id" text NOT NULL,
	"serp_snapshot_digest" text NOT NULL,
	"intelligence_snapshot_id" text NOT NULL,
	"intelligence_snapshot_digest" text NOT NULL,
	"page_snapshot_refs" jsonb NOT NULL,
	"analysis_refs" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accepted_content_gap_snapshots_project_version_unique" UNIQUE("project_id","version"),
	CONSTRAINT "accepted_content_gap_snapshots_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
CREATE TABLE "competitor_classification_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_snapshot_id" text NOT NULL,
	"classification" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_classification_overrides_class_valid" CHECK ("competitor_classification_overrides"."classification" IN ('INCLUDE', 'EXCLUDE', 'REFERENCE_ONLY'))
);
--> statement-breakpoint
CREATE TABLE "competitor_page_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"page_snapshot_id" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"packet_digest" text NOT NULL,
	"data" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"usage" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_page_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"serp_snapshot_id" text NOT NULL,
	"serp_position" integer NOT NULL,
	"requested_url" text NOT NULL,
	"final_url" text,
	"domain" text NOT NULL,
	"classification" text NOT NULL,
	"classification_reason" text NOT NULL,
	"acquisition_status" text NOT NULL,
	"http_status" integer,
	"content_type" text,
	"observed_at" timestamp with time zone NOT NULL,
	"raw_digest" text,
	"extraction_digest" text,
	"extracted" jsonb,
	"snapshot_digest" text NOT NULL,
	"content_digest" text,
	"deduped_from_snapshot_id" text,
	"raw_truncated" boolean DEFAULT false NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_page_snapshots_classification_valid" CHECK ("competitor_page_snapshots"."classification" IN ('INCLUDE', 'EXCLUDE', 'REFERENCE_ONLY')),
	CONSTRAINT "competitor_page_snapshots_acquisition_status_valid" CHECK ("competitor_page_snapshots"."acquisition_status" IN ('SUCCESS', 'BLOCKED', 'NON_HTML', 'UNSUPPORTED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "competitor_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"serp_snapshot_id" text NOT NULL,
	"serp_snapshot_digest" text NOT NULL,
	"intelligence_snapshot_id" text NOT NULL,
	"intelligence_snapshot_digest" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_runs_status_valid" CHECK ("competitor_runs"."status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "competitor_runs_duration_ms_non_negative" CHECK ("competitor_runs"."duration_ms" IS NULL OR "competitor_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_gap_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"report_id" text NOT NULL,
	"gap_id" text NOT NULL,
	"disposition" text NOT NULL,
	"priority" text,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_gap_decisions_report_gap_unique" UNIQUE("report_id","gap_id"),
	CONSTRAINT "content_gap_decisions_disposition_valid" CHECK ("content_gap_decisions"."disposition" IN ('REQUIRED', 'OPTIONAL', 'EXCLUDE')),
	CONSTRAINT "content_gap_decisions_priority_valid" CHECK ("content_gap_decisions"."priority" IS NULL OR "content_gap_decisions"."priority" IN ('HIGH', 'MEDIUM', 'LOW'))
);
--> statement-breakpoint
CREATE TABLE "content_gap_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"accepted_input_snapshot_id" text NOT NULL,
	"accepted_input_version" integer NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"serp_snapshot_id" text NOT NULL,
	"serp_snapshot_digest" text NOT NULL,
	"intelligence_snapshot_id" text NOT NULL,
	"intelligence_snapshot_digest" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt_version" text NOT NULL,
	"data" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"review_state" text DEFAULT 'model_proposed' NOT NULL,
	"review_revision" integer DEFAULT 0 NOT NULL,
	"decisions_digest" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_gap_reports_review_state_valid" CHECK ("content_gap_reports"."review_state" IN ('model_proposed', 'operator_reviewed', 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "accepted_content_gap_snapshots" ADD CONSTRAINT "accepted_content_gap_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_content_gap_snapshots" ADD CONSTRAINT "accepted_content_gap_snapshots_report_id_content_gap_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."content_gap_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_classification_overrides" ADD CONSTRAINT "competitor_classification_overrides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_classification_overrides" ADD CONSTRAINT "competitor_classification_overrides_page_snapshot_id_competitor_page_snapshots_id_fk" FOREIGN KEY ("page_snapshot_id") REFERENCES "public"."competitor_page_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_analyses" ADD CONSTRAINT "competitor_page_analyses_run_id_competitor_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."competitor_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_analyses" ADD CONSTRAINT "competitor_page_analyses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_analyses" ADD CONSTRAINT "competitor_page_analyses_page_snapshot_id_competitor_page_snapshots_id_fk" FOREIGN KEY ("page_snapshot_id") REFERENCES "public"."competitor_page_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_snapshots" ADD CONSTRAINT "competitor_page_snapshots_run_id_competitor_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."competitor_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_snapshots" ADD CONSTRAINT "competitor_page_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_page_snapshots" ADD CONSTRAINT "competitor_page_snapshots_serp_snapshot_id_serp_snapshots_id_fk" FOREIGN KEY ("serp_snapshot_id") REFERENCES "public"."serp_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_runs" ADD CONSTRAINT "competitor_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_runs" ADD CONSTRAINT "competitor_runs_accepted_input_snapshot_id_project_input_snapshots_id_fk" FOREIGN KEY ("accepted_input_snapshot_id") REFERENCES "public"."project_input_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_runs" ADD CONSTRAINT "competitor_runs_serp_snapshot_id_serp_snapshots_id_fk" FOREIGN KEY ("serp_snapshot_id") REFERENCES "public"."serp_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_runs" ADD CONSTRAINT "competitor_runs_intelligence_snapshot_id_search_intelligence_snapshots_id_fk" FOREIGN KEY ("intelligence_snapshot_id") REFERENCES "public"."search_intelligence_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_decisions" ADD CONSTRAINT "content_gap_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_decisions" ADD CONSTRAINT "content_gap_decisions_report_id_content_gap_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."content_gap_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_reports" ADD CONSTRAINT "content_gap_reports_run_id_competitor_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."competitor_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_reports" ADD CONSTRAINT "content_gap_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_reports" ADD CONSTRAINT "content_gap_reports_accepted_input_snapshot_id_project_input_snapshots_id_fk" FOREIGN KEY ("accepted_input_snapshot_id") REFERENCES "public"."project_input_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_reports" ADD CONSTRAINT "content_gap_reports_serp_snapshot_id_serp_snapshots_id_fk" FOREIGN KEY ("serp_snapshot_id") REFERENCES "public"."serp_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_gap_reports" ADD CONSTRAINT "content_gap_reports_intelligence_snapshot_id_search_intelligence_snapshots_id_fk" FOREIGN KEY ("intelligence_snapshot_id") REFERENCES "public"."search_intelligence_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accepted_content_gap_snapshots_project_idx" ON "accepted_content_gap_snapshots" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "competitor_classification_overrides_page_idx" ON "competitor_classification_overrides" USING btree ("page_snapshot_id");--> statement-breakpoint
CREATE INDEX "competitor_page_analyses_project_idx" ON "competitor_page_analyses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_page_analyses_page_idx" ON "competitor_page_analyses" USING btree ("page_snapshot_id");--> statement-breakpoint
CREATE INDEX "competitor_page_snapshots_project_idx" ON "competitor_page_snapshots" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_page_snapshots_run_idx" ON "competitor_page_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "competitor_page_snapshots_content_digest_idx" ON "competitor_page_snapshots" USING btree ("project_id","content_digest");--> statement-breakpoint
CREATE INDEX "competitor_runs_project_created_idx" ON "competitor_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_runs_serp_snapshot_idx" ON "competitor_runs" USING btree ("serp_snapshot_id");--> statement-breakpoint
CREATE INDEX "content_gap_decisions_report_idx" ON "content_gap_decisions" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "content_gap_reports_project_idx" ON "content_gap_reports" USING btree ("project_id","created_at");