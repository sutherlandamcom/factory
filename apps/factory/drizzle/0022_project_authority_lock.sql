CREATE FUNCTION factory_lock_project_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id, 104));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON project_input_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON serp_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON search_intelligence_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON competitor_runs FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON competitor_page_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON competitor_classification_overrides FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON accepted_content_gap_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON writer_policies FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON content_briefs FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON writer_prompt_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON page_content_proposals FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON accepted_page_content FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
--> statement-breakpoint
CREATE TRIGGER project_authority_lock BEFORE INSERT OR UPDATE ON asset_page_assignments FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
