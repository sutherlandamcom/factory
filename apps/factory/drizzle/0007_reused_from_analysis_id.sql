ALTER TABLE "competitor_page_analyses" ADD COLUMN "reused_from_analysis_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor_page_analyses" ADD CONSTRAINT "competitor_page_analyses_reused_from_analysis_id_competitor_page_analyses_id_fk" FOREIGN KEY ("reused_from_analysis_id") REFERENCES "public"."competitor_page_analyses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_page_analyses_reused_from_idx" ON "competitor_page_analyses" USING btree ("reused_from_analysis_id");
