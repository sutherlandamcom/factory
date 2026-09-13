import assert from "node:assert/strict";
import test from "node:test";
import { designApi } from "../src/api/client.js";

/**
 * Design UI contract tests (Run 6): the Dashboard design surface exposes
 * exactly the semantic endpoints the Operator API defines and constructs
 * sandboxed preview URLs from content-addressed digests. No network, no DOM.
 */

test("design UI contract: endpoints match the operator API surface", () => {
  assert.equal(
    typeof designApi.workspace,
    "function",
    "workspace read model must be exposed",
  );
  assert.equal(typeof designApi.deriveInputSnapshot, "function");
  assert.equal(typeof designApi.generate, "function");
  assert.equal(typeof designApi.accept, "function");
  assert.equal(typeof designApi.reject, "function");
  assert.equal(typeof designApi.artifactUrl, "function");
});

test("design UI contract: artifact URLs are digest-scoped and encoded", () => {
  const url = designApi.artifactUrl("proj-1", "a".repeat(64));
  assert.equal(url, `/api/projects/proj-1/design/artifacts/${"a".repeat(64)}`);
  // Path traversal in a digest can never produce a URL outside the endpoint.
  const traversal = designApi.artifactUrl("proj-1", "../../etc/passwd");
  assert.ok(traversal.includes("%2F") || traversal.includes("%2f"), "dot segments must be percent-encoded");
  assert.ok(!traversal.includes("/etc/"));
});

test("design UI contract: review actions bind the exact candidate digest", () => {
  // The accept/reject signatures require an explicit digest — the UI cannot
  // submit a review decision without binding an exact candidate version.
  assert.equal(designApi.accept.length, 4);
  assert.equal(designApi.reject.length, 4);
});
