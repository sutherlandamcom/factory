-- Budget reservation ledger: durable representation of authorized-but-not-yet-
-- accounted model spend. A reservation row in state 'ACTIVE' means money MAY
-- already have been spent that is not yet durably accounted; authorization
-- always sums accounted spend + active reservations before permitting a new
-- reservation (fail-closed hard ceiling).
CREATE TABLE IF NOT EXISTS "competitor_budget_reservations" (
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
  CONSTRAINT "competitor_budget_reservations_state_valid" CHECK ("state" IN ('ACTIVE', 'ACCOUNTED', 'RELEASED')),
  CONSTRAINT "competitor_budget_reservations_accounted_valid" CHECK (
    ("state" = 'ACTIVE' AND "accounted_micros" IS NULL AND "accounted_at" IS NULL)
    OR ("state" = 'ACCOUNTED' AND "accounted_micros" IS NOT NULL AND "accounted_at" IS NOT NULL)
    OR ("state" = 'RELEASED' AND "accounted_micros" IS NULL AND "accounted_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_budget_reservations_state_created_idx" ON "competitor_budget_reservations" USING btree ("state", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_budget_reservations_created_idx" ON "competitor_budget_reservations" USING btree ("created_at");
