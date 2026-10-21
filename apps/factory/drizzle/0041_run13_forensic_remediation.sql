ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "execution_origin" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "operation_id" text;
--> statement-breakpoint
ALTER TABLE "production_effective_transitions" ADD COLUMN IF NOT EXISTS "execution_origin" text;
--> statement-breakpoint
ALTER TABLE "production_effective_transitions" ADD COLUMN IF NOT EXISTS "operation_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_effective_transitions" ADD CONSTRAINT "prod_eff_trans_deployment_id_unique" UNIQUE ("deployment_id");
EXCEPTION
 WHEN duplicate_object THEN null;
 WHEN duplicate_table THEN null;
END $$;
