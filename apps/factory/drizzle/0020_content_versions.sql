ALTER TABLE accepted_page_content DROP CONSTRAINT accepted_page_content_project_slug_unique;
--> statement-breakpoint
ALTER TABLE accepted_page_content ADD CONSTRAINT accepted_page_content_project_proposal_unique UNIQUE(project_id, proposal_id);
--> statement-breakpoint
CREATE INDEX accepted_page_content_slug_version_idx ON accepted_page_content(project_id, slug, version DESC);
