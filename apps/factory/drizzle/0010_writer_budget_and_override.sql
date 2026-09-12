-- Writer budget reservation ledger + dev-time model override provenance.
--
-- writer_budget_reservations reuses the EXACT lifecycle mechanism of
-- competitor_budget_reservations (migration 0009): ACTIVE -> ACCOUNTED |
-- RELEASED with ceiling-check + INSERT under an advisory xact lock, trusted
-- usage retained across failures, unknown cost accounted at the authorized
-- conservative amount, overrun => full accounting + budget invariant
-- violation. This is a separate scoped table (not a rename) because the
-- writer role has its own daily limit: FACTORY_WRITER_DAILY_LIMIT_USD.
CREATE TABLE IF NOT EXISTS "writer_budget_reservations" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "authorized_micros" integer NOT NULL,
  "accounted_micros" integer,
  "state" text NOT NULL,
  "invocation_digest" text NOT NULL,
  "lineage" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accounted_at" timestamp with time zone,
  CONSTRAINT "writer_budget_reservations_state_valid" CHECK ("state" IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')),
  CONSTRAINT "writer_budget_reservations_accounted_valid" CHECK (
    ("state" = 'ACTIVE' AND "accounted_micros" IS NULL AND "accounted_at" IS NULL)
    OR ("state" = 'ACCOUNTED' AND "accounted_micros" IS NOT NULL AND "accounted_at" IS NOT NULL)
    OR ("state" = 'RELEASED' AND "accounted_micros" IS NULL AND "accounted_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "writer_budget_reservations_state_created_idx" ON "writer_budget_reservations" USING btree ("state", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "writer_budget_reservations_created_idx" ON "writer_budget_reservations" USING btree ("created_at");
--> statement-breakpoint
-- Dev-time model override provenance: an invocation produced under
-- FACTORY_MODEL_OVERRIDE__* must never masquerade as champion-produced.
ALTER TABLE "model_invocations" ADD COLUMN "override_applied" boolean;
--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "overridden_champion" text;
