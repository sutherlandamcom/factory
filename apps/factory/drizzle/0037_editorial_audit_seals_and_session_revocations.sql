DROP TRIGGER IF EXISTS "editorial_approval_audit_events_immutable_trg" ON "editorial_approval_audit_events";
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ADD COLUMN IF NOT EXISTS "verification_seal" text;
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ALTER COLUMN "verification_seal" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ALTER COLUMN "verification_seal" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ADD COLUMN IF NOT EXISTS "seal_key_id" text;
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ADD COLUMN IF NOT EXISTS "seal_status" text DEFAULT 'LEGACY_UNSEALED' NOT NULL;
--> statement-breakpoint
UPDATE "editorial_approval_audit_events"
SET "seal_status" = CASE
      WHEN "verification_seal" IS NOT NULL AND "verification_seal" ~ '^[0-9a-f]{64}$' THEN 'SEALED'
      ELSE 'LEGACY_UNSEALED'
    END,
    "seal_key_id" = CASE
      WHEN "verification_seal" IS NOT NULL AND "verification_seal" ~ '^[0-9a-f]{64}$' THEN coalesce("seal_key_id", 'v1')
      ELSE NULL
    END,
    "verification_seal" = CASE
      WHEN "verification_seal" IS NOT NULL AND "verification_seal" ~ '^[0-9a-f]{64}$' THEN "verification_seal"
      ELSE NULL
    END;
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ALTER COLUMN "seal_status" SET DEFAULT 'SEALED';
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" ALTER COLUMN "seal_key_id" SET DEFAULT 'v1';
--> statement-breakpoint
ALTER TABLE "editorial_approval_audit_events" DROP CONSTRAINT IF EXISTS "editorial_approval_audit_events_verification_seal_shape";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "editorial_approval_audit_events" ADD CONSTRAINT "editorial_approval_audit_events_verification_seal_shape" CHECK (
   ("seal_status" = 'LEGACY_UNSEALED' AND "verification_seal" IS NULL AND "seal_key_id" IS NULL)
   OR
   ("seal_status" = 'SEALED' AND "verification_seal" IS NOT NULL AND "verification_seal" ~ '^[0-9a-f]{64}$' AND "seal_key_id" IS NOT NULL AND length(btrim("seal_key_id")) > 0)
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_editorial_audit_event_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'editorial_approval_audit_events is append-only: DELETE is prohibited (event_id=%)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.page_identity IS DISTINCT FROM OLD.page_identity
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
       OR NEW.review_action IS DISTINCT FROM OLD.review_action
       OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.claim_set_digest IS DISTINCT FROM OLD.claim_set_digest
       OR NEW.source_evidence_set_digest IS DISTINCT FROM OLD.source_evidence_set_digest
       OR NEW.audit_event_reference IS DISTINCT FROM OLD.audit_event_reference
       OR NEW.is_synthetic IS DISTINCT FROM OLD.is_synthetic
       OR NEW.verification_seal IS DISTINCT FROM OLD.verification_seal
       OR NEW.seal_key_id IS DISTINCT FROM OLD.seal_key_id
       OR NEW.seal_status IS DISTINCT FROM OLD.seal_status
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'editorial_approval_audit_events protected fields are immutable (event_id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked = true AND NEW.revoked = false THEN
      RAISE EXCEPTION 'editorial_approval_audit_events revocation is irreversible (event_id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "editorial_approval_audit_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "editorial_approval_audit_events"
FOR EACH ROW EXECUTE FUNCTION enforce_editorial_audit_event_immutability();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "editorial_session_revocations" (
  "session_id" text PRIMARY KEY,
  "revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reason" text
);
