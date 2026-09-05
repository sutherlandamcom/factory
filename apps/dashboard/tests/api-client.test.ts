import assert from "node:assert/strict";
import test from "node:test";
import { OperatorApiError, type ProjectOperatorWorkspace } from "../src/api/client";

test("workspace read-model shape: fields the Dashboard consumes are intact", () => {
  const ws: ProjectOperatorWorkspace = {
    project: { id: "1", key: "k", name: "N", createdAt: new Date().toISOString() },
    currentDraft: { revision: 3, digest: null, updatedAt: null, payload: null },
    readiness: { status: "READY", blockers: [], warnings: [], nextActions: [] },
    currentAcceptedSnapshot: null,
    history: [],
    draftDiffersFromAccepted: false,
    status: "DRAFT",
    nextActions: [],
  };
  assert.equal(ws.currentDraft.revision, 3);
  assert.equal(ws.status, "DRAFT");
  assert.equal(ws.readiness.status, "READY");
});

test("OperatorApiError: contract envelope codes map to typed errors", () => {
  const stale = new OperatorApiError("intake_stale_revision", "stale", 409);
  assert.equal(stale.code, "intake_stale_revision");
  assert.equal(stale.status, 409);
  assert.ok(stale instanceof Error);

  const blocked = new OperatorApiError("intake_blocked", "blocked", 422);
  assert.equal(blocked.code, "intake_blocked");

  const internal = new OperatorApiError("internal_error", "Internal server error.", 500);
  assert.equal(internal.status, 500);
  // The generic server-fault message is fixed and carries no internals.
  assert.equal(internal.message, "Internal server error.");
  assert.equal(
    internal.message.length,
    "Internal server error.".length,
    "internal error message must be the fixed sanitized string",
  );
});

test("OperatorApiError: unknown/non-contract codes degrade to http_<status>", () => {
  const weird = new OperatorApiError("http_502", "Request failed. Please try again.", 502);
  assert.equal(weird.code, "http_502");
  assert.equal(weird.message, "Request failed. Please try again.");
});
