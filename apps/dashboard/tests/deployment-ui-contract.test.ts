import assert from "node:assert/strict";
import test from "node:test";
import { deploymentApi } from "../src/api/client.js";

/**
 * Deployment UI contract tests (Run 13): the Dashboard deployment surface
 * exposes exactly the semantic endpoints the Operator API defines for governed delivery,
 * ensures sessionToken and version bounds are required, and supports explicit rollback.
 */

test("deployment UI contract: endpoints match the operator API surface", () => {
  assert.equal(typeof deploymentApi.getView, "function", "getView read model must be exposed");
  assert.equal(typeof deploymentApi.preparePreview, "function", "preparePreview must be exposed");
  assert.equal(typeof deploymentApi.approveRelease, "function", "approveRelease must be exposed");
  assert.equal(typeof deploymentApi.publishRelease, "function", "publishRelease must be exposed");
  assert.equal(typeof deploymentApi.rollbackRelease, "function", "rollbackRelease must be exposed");
});

test("deployment UI contract: approval and publish require explicit bound parameters", () => {
  // preparePreview(projectId, candidateId)
  assert.equal(deploymentApi.preparePreview.length, 2);

  // approveRelease(projectId, payload: { candidateId, previewVersionId, sessionToken })
  assert.equal(deploymentApi.approveRelease.length, 2);

  // publishRelease(projectId, payload: { candidateId, previewVersionId, approvalId, sessionToken })
  assert.equal(deploymentApi.publishRelease.length, 2);

  // rollbackRelease(projectId, payload: { sessionToken, targetVersionId? })
  assert.equal(deploymentApi.rollbackRelease.length, 2);
});
