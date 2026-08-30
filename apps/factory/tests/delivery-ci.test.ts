import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PR CI checks out and verifies the exact event head SHA", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/pr-ci.yml", import.meta.url),
    "utf8",
  );
  const exactEventSha = "${{ github.event.pull_request.head.sha || github.sha }}";
  assert.match(workflow, /uses: actions\/checkout@v4/u);
  assert.ok(workflow.includes(`ref: ${exactEventSha}`));
  assert.ok(workflow.includes(`EXPECTED_SHA: ${exactEventSha}`));
  assert.ok(workflow.includes("git rev-parse HEAD"));
  assert.ok(workflow.includes("CHECKED_OUT_SHA="));
});
