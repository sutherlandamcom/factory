import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv } from "../src/executor/env.js";
import { runProcess } from "../src/executor/process.js";

test("successful process returns exit code and output", async () => {
  const result = await runProcess("node", ["-e", "console.log('hello')"], {
    cwd: "/tmp",
    env: buildChildEnv(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.trim(), "hello");
});

test("timeout kills the process and normalizes to timedOut", async () => {
  const started = Date.now();
  const result = await runProcess("node", ["-e", "setTimeout(() => {}, 60_000)"], {
    cwd: "/tmp",
    env: buildChildEnv(),
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 10_000, "kill must be prompt");
});
