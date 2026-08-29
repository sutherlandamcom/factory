import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { preflight } from "../src/executor/preflight.js";
import { gitIn, makeTempRepo } from "./helpers.js";

test("clean repo preflight resolves top level and HEAD SHA", async () => {
  const repo = await makeTempRepo();
  const result = await preflight(repo);
  assert.equal(result.repoRoot, repo);
  assert.match(result.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(result.baseCommit, gitIn(repo, ["rev-parse", "HEAD"]));
});

test("tracked modification fails with dirty_working_tree", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "package.json"), '{"name":"changed"}\n', "utf8");
  await assert.rejects(() => preflight(repo), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "dirty_working_tree");
    return true;
  });
});

test("untracked non-ignored file fails with dirty_working_tree", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "stray.txt"), "stray\n", "utf8");
  await assert.rejects(
    () => preflight(repo),
    (err: unknown) => (err as { code?: string }).code === "dirty_working_tree",
  );
});

test("non-repo path fails with repo_not_found", async () => {
  await assert.rejects(
    () => preflight("/tmp/definitely-not-a-repo-factory"),
    (err: unknown) => (err as { code?: string }).code === "repo_not_found",
  );
});
