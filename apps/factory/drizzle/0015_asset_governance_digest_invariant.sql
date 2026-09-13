-- Run 5 governance invariant: an APPROVED asset version must ALWAYS carry
-- its governance digest. Binary digest (exact bytes) and governance digest
-- (approved governance metadata/lineage) are distinct authorities and are
-- never substituted for one another; the store layer fails closed without
-- this digest and the database now enforces the invariant itself.
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_approved_governance_digest_required" CHECK (
  "approval_state" <> 'approved' OR "governance_digest" IS NOT NULL
);
