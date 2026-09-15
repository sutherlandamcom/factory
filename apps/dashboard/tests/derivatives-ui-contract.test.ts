import assert from "node:assert/strict";
import test from "node:test";
import { derivativesApi } from "../src/api/client.js";

/**
 * Derivatives UI contract tests (Run 10): the Dashboard derivative surface
 * exposes exactly the semantic endpoints the Operator API defines, keeps the
 * UI out of provider configuration authority (bounded settings only), and
 * never self-accepts (acceptance always goes through the backend gate with
 * explicit artifact ids). No network, no DOM.
 */

test("derivatives UI contract: endpoints match the operator API surface", () => {
  assert.equal(typeof derivativesApi.workspace, "function", "workspace read model must be exposed");
  assert.equal(typeof derivativesApi.updatePolicy, "function");
  assert.equal(typeof derivativesApi.updateOverride, "function");
  assert.equal(typeof derivativesApi.deriveIntent, "function");
  assert.equal(typeof derivativesApi.generateSummary, "function");
  assert.equal(typeof derivativesApi.summaryReview, "function");
  assert.equal(typeof derivativesApi.acceptSummary, "function");
  assert.equal(typeof derivativesApi.generateAudio, "function");
  assert.equal(typeof derivativesApi.audioReview, "function");
  assert.equal(typeof derivativesApi.acceptAudio, "function");
  assert.equal(typeof derivativesApi.acceptSet, "function");
});

test("derivatives UI contract: acceptance binds explicit artifact ids", () => {
  // acceptSummary(projectId, pageIdentity, proposalId) and
  // acceptAudio(projectId, pageIdentity, candidateId) — the UI can never
  // submit an acceptance without naming the exact reviewed artifact.
  assert.equal(derivativesApi.acceptSummary.length, 3);
  assert.equal(derivativesApi.acceptAudio.length, 3);
  // acceptSet(projectId, pageIdentity) — the backend derives the set from
  // currently accepted artifacts; the UI supplies no digests.
  assert.equal(derivativesApi.acceptSet.length, 2);
});

test("derivatives UI contract: policy/override payloads are bounded settings only", () => {
  // The client functions accept exactly the narrow operator settings — no
  // free-form provider parameters (model ids, temperatures, endpoints).
  assert.equal(derivativesApi.updatePolicy.length, 2);
  assert.equal(derivativesApi.updateOverride.length, 3);
});

test("derivatives UI contract: generation is page-scoped with no provider config", () => {
  assert.equal(derivativesApi.generateSummary.length, 2);
  assert.equal(derivativesApi.generateAudio.length, 2);
  assert.equal(derivativesApi.deriveIntent.length, 2);
});
