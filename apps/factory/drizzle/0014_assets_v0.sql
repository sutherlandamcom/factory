-- Assets: Asset Foundation + Operator Photography (Macro Run 5).
-- Durable authority model: upload -> validate bytes -> provenance -> rights
-- -> immutable AssetVersion -> approval (binds exact digest) -> page/slot
-- assignment (binds exact approved version) -> explicit replacement only.

CREATE TABLE IF NOT EXISTS "assets" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assets_kind_valid" CHECK ("kind" IN ('logo', 'photo', 'illustration', 'chart', 'icon'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_project_idx" ON "assets" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_versions" (
  "id" text PRIMARY KEY,
  "asset_id" text NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "binary_digest" text NOT NULL,
  "media_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "width" integer,
  "height" integer,
  "storage_key" text NOT NULL,
  "original_filename" text NOT NULL,
  "provenance" jsonb NOT NULL,
  "rights_status" text NOT NULL,
  "rights_note" text,
  "alt_intent" text,
  "approval_state" text DEFAULT 'pending' NOT NULL,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "governance_digest" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "asset_versions_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "asset_versions_byte_size_positive" CHECK ("byte_size" >= 1),
  CONSTRAINT "asset_versions_media_type_valid" CHECK ("media_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "asset_versions_rights_status_valid" CHECK ("rights_status" IN ('operator_owned', 'licensed', 'public_domain', 'unknown')),
  CONSTRAINT "asset_versions_approval_state_valid" CHECK ("approval_state" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "asset_versions_state_timestamps_valid" CHECK (
    (
      ("approval_state" = 'pending' AND "approved_at" IS NULL AND "rejected_at" IS NULL)
      OR ("approval_state" = 'approved' AND "approved_at" IS NOT NULL AND "rejected_at" IS NULL)
      OR ("approval_state" = 'rejected' AND "approved_at" IS NULL AND "rejected_at" IS NOT NULL)
    )
  ),
  CONSTRAINT "asset_versions_provenance_category_valid" CHECK ("provenance" ->> 'category' IN ('operator_upload', 'generated', 'imported')),
  CONSTRAINT "asset_versions_asset_version_unique" UNIQUE ("asset_id", "version"),
  CONSTRAINT "asset_versions_project_binary_digest_unique" UNIQUE ("project_id", "binary_digest")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_versions_asset_idx" ON "asset_versions" USING btree ("asset_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_versions_project_idx" ON "asset_versions" USING btree ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_derivatives" (
  "id" text PRIMARY KEY,
  "version_id" text NOT NULL REFERENCES "asset_versions"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "media_type" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "binary_digest" text NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "asset_derivatives_kind_valid" CHECK ("kind" IN ('web', 'thumb')),
  CONSTRAINT "asset_derivatives_width_positive" CHECK ("width" >= 1),
  CONSTRAINT "asset_derivatives_height_positive" CHECK ("height" >= 1),
  CONSTRAINT "asset_derivatives_byte_size_positive" CHECK ("byte_size" >= 1),
  CONSTRAINT "asset_derivatives_media_type_valid" CHECK ("media_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "asset_derivatives_version_kind_unique" UNIQUE ("version_id", "kind")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_derivatives_version_idx" ON "asset_derivatives" USING btree ("version_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_page_assignments" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "asset_id" text NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
  "version_id" text NOT NULL REFERENCES "asset_versions"("id") ON DELETE RESTRICT,
  "version_digest" text NOT NULL,
  "binary_digest" text NOT NULL,
  "page_slug" text NOT NULL,
  "role" text NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "asset_page_assignments_role_valid" CHECK ("role" IN ('hero', 'background', 'inline', 'chart', 'illustration', 'logo', 'supporting')),
  CONSTRAINT "asset_page_assignments_slug_shape" CHECK ("page_slug" ~ '^[a-z0-9][a-z0-9/-]*$'),
  CONSTRAINT "asset_page_assignments_slot_unique" UNIQUE ("project_id", "page_slug", "role")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_page_assignments_project_idx" ON "asset_page_assignments" USING btree ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_asset_settings" (
  "project_id" text PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "imagery_strategy" text DEFAULT 'none' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_asset_settings_imagery_strategy_valid" CHECK ("imagery_strategy" IN ('none', 'operator', 'generated', 'mixed'))
);
