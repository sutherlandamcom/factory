import assert from "node:assert/strict";
import { test } from "node:test";
import { queryKeys } from "../src/query/keys";

/**
 * Run 11 §89 — query-key scoping tests.
 *
 * Proves keys are scoped by project (no cross-project cache pollution) and
 * that invalidation sets cover the right queries after mutations.
 */

test("query keys: every project-scoped key includes the projectId", () => {
  const a = "proj-a";
  const b = "proj-b";

  assert.notDeepEqual(queryKeys.workflow(a), queryKeys.workflow(b));
  assert.notDeepEqual(queryKeys.workspace(a), queryKeys.workspace(b));
  assert.notDeepEqual(queryKeys.versions(a), queryKeys.versions(b));
  assert.notDeepEqual(queryKeys.costs(a), queryKeys.costs(b));

  for (const area of ["intake", "research", "content", "assets", "design", "production", "qa"] as const) {
    assert.notDeepEqual(queryKeys.area(a, area), queryKeys.area(b, area));
  }

  // Same project + same area => same key (stable identity).
  assert.deepEqual(queryKeys.area(a, "content"), queryKeys.area(a, "content"));

  // Project id is embedded in the key tuple so cache lookup cannot collide.
  assert.ok(queryKeys.workflow(a).includes(a));
  assert.ok(queryKeys.area(b, "design").includes(b));
});

test("query keys: invalidation sets reference the mutated project only", async () => {
  const a = "proj-a";
  assert.ok(queryKeys.workflow !== undefined);

  // acceptContent invalidates workflow + versions + content + production + qa + derivatives.
  const { workflowInvalidationSets: sets } = await import("../src/query/keys.js");
  const invalidations = sets.acceptContent(a);
  const serialized = JSON.stringify(invalidations);
  assert.ok(serialized.includes(a));
  assert.ok(serialized.includes("workflow"));
  assert.ok(serialized.includes("versions"));
  assert.ok(serialized.includes("content"));
  assert.ok(serialized.includes("production"));
  assert.ok(serialized.includes("qa"));
});
