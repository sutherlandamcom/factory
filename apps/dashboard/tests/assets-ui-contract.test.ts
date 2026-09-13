import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_ERROR_CODES } from "@factory/contracts";
import { readFileSync } from "node:fs";

/**
 * Asset Library UI contract (Macro Run 5): the Dashboard consumes an
 * authoritative read model and a closed error-code union. These tests keep
 * the client-side types and the semantic surface aligned with the Operator
 * contract so UI states never claim something the backend does not enforce.
 */

test("assets read-model: every UI-consumed field exists in the client types", () => {
  const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
  // Version fields the UI renders.
  for (const field of [
    "binaryDigest",
    "governanceDigest",
    "approvalState",
    "rightsStatus",
    "provenance",
    "altIntent",
    "byteSize",
    "width",
    "height",
    "originalFilename",
  ]) {
    assert.ok(client.includes(field), `AssetVersionView must expose ${field}`);
  }
  // Assignment fields including computed staleness.
  for (const field of [
    "replacementAvailable",
    "latestApprovedVersionId",
    "versionNumber",
    "pageSlug",
    "role",
    "versionDigest",
  ]) {
    assert.ok(client.includes(field), `AssetAssignmentView must expose ${field}`);
  }
});

test("assets client methods hit the exact semantic API routes", () => {
  const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
  const routes = [
    "/assets/workspace",
    "/assets/uploads",
    "/assets/versions/${encodeURIComponent(versionId)}/approve",
    "/assets/versions/${encodeURIComponent(versionId)}/reject",
    "/assets/versions/${encodeURIComponent(versionId)}/metadata",
    "/assets/assignments",
    "/assets/assignments/${encodeURIComponent(assignmentId)}/replace",
    "/assets/settings",
  ];
  for (const route of routes) {
    assert.ok(client.includes(route), `assetsApi must call ${route}`);
  }
});

test("asset error codes are part of the closed operator union", () => {
  for (const code of [
    "asset_upload_invalid",
    "asset_not_found",
    "asset_version_not_found",
    "asset_assignment_not_found",
    "asset_approval_failed",
    "asset_version_immutable",
    "asset_rights_blocked",
    "asset_assignment_conflict",
    "asset_storage_failed",
  ]) {
    assert.ok(OPERATOR_ERROR_CODES.includes(code as never), `${code} must exist in OPERATOR_ERROR_CODES`);
  }
});

test("asset UI maps every asset error code to operator-facing copy; unknown codes degrade", () => {
  const page = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  for (const code of [
    "asset_upload_invalid",
    "asset_approval_failed",
    "asset_version_immutable",
    "asset_rights_blocked",
    "asset_assignment_conflict",
    "asset_storage_failed",
  ]) {
    assert.ok(page.includes(`${code}:`) || page.includes(`"${code}"`), `AssetsPage must map ${code} to operator copy`);
  }
  // Degrade path: unknown codes fall back to the message/fallback chain.
  assert.match(page, /ASSET_ERROR_COPY\[error\.code\] \?\?/);
});

test("asset UI never implies automatic replacement of accepted assignments", () => {
  const page = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  // The staleness banner must state the assignment stays unchanged.
  assert.match(page, /assignment UNCHANGED until you replace explicitly/);
  // Replacement requires an explicit confirm action.
  assert.match(page, /Confirm replace/);
});

test("asset UI surfaces unresolved rights visibly", () => {
  const page = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /unresolved/);
  // Unknown-rights versions never render assignment controls (gated on approvalState + rights).
  assert.ok(!/approvalState === "approved" && !version\.rightsStatus/.test(page) || page.includes('version.rightsStatus !== "unknown"'));
});

test("upload UX sends base64 JSON to the dedicated route (server remains authority)", () => {
  const page = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /readAsDataURL/);
  assert.match(page, /assetsApi\.upload\(/);
});
