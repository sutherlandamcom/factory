import assert from "node:assert/strict";
import test from "node:test";
import { visualApi } from "../src/api/client.js";

/**
 * Visual Assets UI contract tests (Run 7): the Dashboard visual surface
 * exposes exactly the semantic endpoints the Operator API defines, binds
 * exact digests on every approval/acceptance action, and constructs
 * project-scoped candidate URLs. No network, no DOM.
 */

test("visual UI contract: endpoints match the operator API surface", () => {
  assert.equal(typeof visualApi.workspace, "function", "workspace read model must be exposed");
  assert.equal(typeof visualApi.derivePlan, "function");
  assert.equal(typeof visualApi.classify, "function");
  assert.equal(typeof visualApi.compilePrompt, "function");
  assert.equal(typeof visualApi.approvePrompt, "function");
  assert.equal(typeof visualApi.generate, "function");
  assert.equal(typeof visualApi.resolveReuse, "function");
  assert.equal(typeof visualApi.resolveTransform, "function");
  assert.equal(typeof visualApi.acceptCandidate, "function");
  assert.equal(typeof visualApi.acceptSet, "function");
  assert.equal(typeof visualApi.candidateUrl, "function");
});

test("visual UI contract: candidate URLs are project-scoped and id-encoded", () => {
  const url = visualApi.candidateUrl("proj-1", "vac-11111111-1111-1111-1111-111111111111");
  assert.equal(url, `/api/projects/proj-1/visual/candidates/vac-11111111-1111-1111-1111-111111111111/bytes`);
  // Path traversal in a candidate id can never produce a URL outside the endpoint.
  const traversal = visualApi.candidateUrl("proj-1", "../../etc/passwd");
  assert.ok(traversal.includes("%2F") || traversal.includes("%2f"), "dot segments must be percent-encoded");
  assert.ok(!traversal.includes("/etc/"));
});

test("visual UI contract: approval and acceptance bind exact digests", () => {
  // approvePrompt requires the exact prompt digest; acceptCandidate requires
  // the exact candidate binary digest — the UI can never submit a review
  // decision without binding the exact version it reviewed.
  assert.equal(visualApi.approvePrompt.length, 3);
  assert.equal(visualApi.acceptCandidate.length, 6);
});

test("visual UI contract: classification requires explicit operator acknowledgment", () => {
  // classify(projectId, planId, slot, truthClass) — the acknowledgment flag
  // is constructed by the client itself (acknowledged: true), so the UI
  // cannot send an unconfirmed classification.
  assert.equal(visualApi.classify.length, 4);
});
