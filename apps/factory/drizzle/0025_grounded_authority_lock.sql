CREATE TRIGGER grounded_search_snapshots_authority_lock BEFORE INSERT OR UPDATE ON grounded_search_snapshots FOR EACH ROW EXECUTE FUNCTION factory_lock_project_authority();
