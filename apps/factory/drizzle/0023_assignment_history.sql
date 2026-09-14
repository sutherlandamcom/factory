CREATE TABLE asset_assignment_history (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), assignment_id text NOT NULL REFERENCES asset_page_assignments(id),
 binding jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION factory_immutable_assignment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Assignment history is immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_assignment_history BEFORE UPDATE OR DELETE ON asset_assignment_history FOR EACH ROW EXECUTE FUNCTION factory_immutable_assignment_history();
