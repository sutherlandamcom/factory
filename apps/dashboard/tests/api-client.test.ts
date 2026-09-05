import assert from "node:assert/strict";
import test from "node:test";
import { ApiErrorBody, ProjectOperatorWorkspace } from "../src/api/types";

test("api types: ApiErrorBody fields optional and workspace shape intact", () => {
  const err: ApiErrorBody = { code: "intake_blocked", message: "no" };
  assert.equal(err.code, "intake_blocked");
  const ws: ProjectOperatorWorkspace = {
    project: { id: "1", key: "k", name: "N", createdAt: new Date().toISOString() },
    currentDraft: { revision: 3, digest: null, updatedAt: "", payload: null },
    readiness: { status: "READY", blockers: [], warnings: [], nextActions: [] },
    currentAcceptedSnapshot: null,
    history: [],
    draftDiffersFromAccepted: false,
    status: "DRAFT",
    nextActions: [],
  };
  assert.equal(ws.currentDraft.revision, 3);
  assert.equal(ws.status, "DRAFT");
});
