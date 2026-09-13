-- Run 7 QA remediation (P2-F1): extend the accepted-slot truth-policy CHECK to
-- the FULL contract matrix. The 0017 constraint blocked `ai_generate` for
-- documentary/documentary_edited/data_visualization, but the contract matrix
-- VISUAL_TRUTH_POLICY additionally forbids `ai_edit` for `data_visualization`
-- (quantitative truth stays deterministic; an image model must never redraw
-- factual data). The service and schema layers already enforce the full matrix
-- (defense in depth held), so no existing row can violate the tightened
-- predicate; this migration only aligns the durable DB gate with the contract.
--
-- Additive/tightening-only: the same-named constraint is replaced in place
-- with a strictly stronger predicate. No historical migration is modified.

-- Safety pre-condition: if any existing row already violates the tightened
-- predicate, the ADD CONSTRAINT below fails loudly (fail closed) instead of
-- silently leaving a weaker gate. Expected empty: the service layer never
-- produced such rows (independently verified during the Run 7 QA audit).
DO $$
DECLARE violations integer;
BEGIN
  SELECT count(*) INTO violations
  FROM "accepted_visual_asset_slots"
  WHERE "resolution_mode" = 'ai_edit' AND "truth_class" = 'data_visualization';
  IF violations > 0 THEN
    RAISE EXCEPTION 'Cannot tighten truth-policy CHECK: % existing row(s) violate the matrix', violations;
  END IF;
END $$;

ALTER TABLE "accepted_visual_asset_slots"
  DROP CONSTRAINT IF EXISTS "accepted_visual_asset_slots_documentary_forbids_generated";

ALTER TABLE "accepted_visual_asset_slots"
  ADD CONSTRAINT "accepted_visual_asset_slots_documentary_forbids_generated" CHECK (
    NOT ("resolution_mode" = 'ai_generate' AND "truth_class" IN ('documentary', 'documentary_edited', 'data_visualization'))
    AND NOT ("resolution_mode" = 'ai_edit' AND "truth_class" = 'data_visualization')
  );
