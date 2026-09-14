ALTER TABLE asset_page_assignments DROP CONSTRAINT assignment_page_lineage_complete;
--> statement-breakpoint
ALTER TABLE asset_page_assignments ADD CONSTRAINT assignment_page_lineage_complete CHECK (
 (accepted_page_content_id IS NULL AND accepted_page_content_version IS NULL AND accepted_page_content_digest IS NULL) OR
 (accepted_page_content_id IS NOT NULL AND accepted_page_content_version IS NOT NULL AND accepted_page_content_digest IS NOT NULL AND accepted_page_content_version > 0 AND accepted_page_content_digest ~ '^[0-9a-f]{64}$')
);
