CREATE TABLE IF NOT EXISTS "editorial_approval_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_identity" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"review_action" text NOT NULL,
	"content_digest" text NOT NULL,
	"claim_set_digest" text NOT NULL,
	"source_evidence_set_digest" text NOT NULL,
	"audit_event_reference" text NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_approval_audit_events_review_action_valid" CHECK ("review_action" IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')),
	CONSTRAINT "editorial_approval_audit_events_content_digest_shape" CHECK ("content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "editorial_approval_audit_events_claim_set_digest_shape" CHECK ("claim_set_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "editorial_approval_audit_events_source_evidence_digest_shape" CHECK ("source_evidence_set_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "editorial_approval_audit_events" ADD CONSTRAINT "editorial_approval_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "editorial_approval_audit_events_project_page_idx" ON "editorial_approval_audit_events" USING btree ("project_id","page_identity","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_reviewer_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_reviewer_memberships_project_actor_unique" UNIQUE("project_id","actor_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_reviewer_memberships" ADD CONSTRAINT "project_reviewer_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_reviewer_memberships_project_actor_idx" ON "project_reviewer_memberships" USING btree ("project_id","actor_id");
