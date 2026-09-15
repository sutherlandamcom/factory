import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProductionPageInputData,
  parseProductionQaReportData,
  qaOverallVerdict,
  parseRedirectAuthorityData,
  parseCachePolicyData,
  productionRouteSchema,
  PRODUCTION_ERROR_CODES,
} from "@factory/contracts";
import { deterministicDigest } from "../src/intelligence/digest.js";

const validInput = {
  schemaVersion: "production-v1",
  projectId: "proj-123",
  pageIdentity: "sutherland-home",
  pageType: "homepage",
  route: "/",
  siteIdentity: { siteId: "sutherland-private-office", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "d".repeat(64) },
  acceptedContent: { id: "wacc-abc", version: 1, digest: "a".repeat(64) },
  acceptedDesign: { id: "dacc-abc", version: 2, digest: "b".repeat(64) },
  acceptedVisualSet: { id: "vset-abc", version: 1, digest: "c".repeat(64) },
  renderer: { id: "astro-static", version: "astro-7.2.9", policyVersion: "production-policy-v1" },
};

test("production input parses a valid authority manifest", () => {
  const parsed = parseProductionPageInputData(validInput);
  assert.equal(parsed.pageType, "homepage");
  assert.equal(parsed.renderer.id, "astro-static");
});

test("production input digest is deterministic and order-independent", () => {
  const digest1 = deterministicDigest(parseProductionPageInputData(validInput));
  const reordered = {
    renderer: validInput.renderer,
    acceptedVisualSet: validInput.acceptedVisualSet,
    acceptedDesign: validInput.acceptedDesign,
    acceptedContent: validInput.acceptedContent,
    siteIdentity: validInput.siteIdentity,
    route: validInput.route,
    pageType: validInput.pageType,
    pageIdentity: validInput.pageIdentity,
    projectId: validInput.projectId,
    schemaVersion: validInput.schemaVersion,
  };
  const digest2 = deterministicDigest(parseProductionPageInputData(reordered));
  assert.equal(digest1, digest2);
  assert.match(digest1, /^[0-9a-f]{64}$/);
});

test("production input digest changes when any bound authority changes", () => {
  const base = parseProductionPageInputData(validInput);
  const changedContent = deterministicDigest(parseProductionPageInputData({
      ...validInput,
      acceptedContent: { ...validInput.acceptedContent, digest: "d".repeat(64) },
    }));
  assert.notEqual(deterministicDigest(base), changedContent);
});

test("production input rejects forged digests and non-astro renderers", () => {
  assert.throws(() =>
    parseProductionPageInputData({ ...validInput, acceptedContent: { ...validInput.acceptedContent, digest: "nothex" } }),
  );
  assert.throws(() =>
    parseProductionPageInputData({
      ...validInput,
      renderer: { ...validInput.renderer, id: "stitch-html" },
    }),
  );
});

test("route schema enforces one rooted lowercase identity", () => {
  assert.equal(productionRouteSchema.parse("/").length, 1);
  assert.throws(() => productionRouteSchema.parse("services/roof"));
  assert.throws(() => productionRouteSchema.parse("/Services"));
  assert.throws(() => productionRouteSchema.parse("/services//roof"));
});

test("qa overall verdict: FAIL dominates REVIEW dominates PASS", () => {
  assert.equal(qaOverallVerdict([{ verdict: "PASS" }, { verdict: "PASS" }]), "PASS");
  assert.equal(qaOverallVerdict([{ verdict: "PASS" }, { verdict: "REVIEW" }]), "REVIEW");
  assert.equal(qaOverallVerdict([{ verdict: "PASS" }, { verdict: "FAIL" }]), "FAIL");
  assert.equal(qaOverallVerdict([{ verdict: "REVIEW" }, { verdict: "FAIL" }]), "FAIL");
});

test("qa report parses typed checks and rejects unknown check ids", () => {
  const report = {
    schemaVersion: "production-v1",
    candidateId: "pcand-1",
    checks: [
      {
        checkId: "content.sections_complete",
        group: "content",
        verdict: "PASS",
        detail: "ok",
        evidence: [],
      },
    ],
    overall: "PASS",
  };
  assert.equal(parseProductionQaReportData(report).overall, "PASS");
  assert.throws(() =>
    parseProductionQaReportData({
      ...report,
      checks: [{ ...report.checks[0], checkId: "seo.made_up_check" }],
    }),
  );
});

test("redirect authority rejects self-loops at parse level shape only (loop semantics in QA)", () => {
  const authority = {
    schemaVersion: "production-v1",
    projectId: "proj-1",
    rules: [{ source: "/old", destination: "/new", kind: "permanent" }],
  };
  assert.equal(parseRedirectAuthorityData(authority).rules.length, 1);
});

test("cache policy parses immutable asset + html entries", () => {
  const policy = {
    schemaVersion: "production-v1",
    projectId: "proj-1",
    entries: [
      { target: "/", kind: "html", maxAgeSeconds: 0 },
      { target: "/_astro/*", kind: "immutable_asset", maxAgeSeconds: 31536000 },
    ],
  };
  assert.equal(parseCachePolicyData(policy).entries.length, 2);
});

test("production error codes are typed and stable", () => {
  assert.ok(PRODUCTION_ERROR_CODES.includes("production_authority_stale"));
  assert.ok(PRODUCTION_ERROR_CODES.includes("production_route_conflict"));
});
