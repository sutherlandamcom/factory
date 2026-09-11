ALTER TABLE "competitor_page_analyses" ADD COLUMN "semantic_input_digest" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_page_analyses_semantic_digest_idx" ON "competitor_page_analyses" USING btree ("semantic_input_digest");
