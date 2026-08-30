import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWorktree, removeWorktree, worktreePathFor } from "../src/executor/worktree.js";
import { gitIn, makeTempRepo } from "./helpers.js";

test("worktree is created detached at baseCommit and removed cleanly", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);
  const wt = await createWorktree(repo, baseCommit, "test-run");

  assert.equal(wt, worktreePathFor(repo, "test-run"));
  assert.ok(existsSync(path.join(wt, "sites", "starter", "src", "pages", "index.astro")));
  assert.equal(gitIn(wt, ["rev-parse", "HEAD"]), baseCommit);
  // Detached: no branch checked out in the worktree.
  assert.equal(gitIn(wt, ["branch", "--show-current"]), "");

  // A change inside the worktree never touches the main tree.
  await writeFile(path.join(wt, "sites", "starter", "src", "pages", "x.astro"), "<h1>x</h1>\n");
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");

  await removeWorktree(repo, wt);
  assert.ok(!existsSync(wt));
  const worktreeEntries = gitIn(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktreeEntries.length, 1);
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("removeWorktree is idempotent", async () => {
  const repo = await makeTempRepo();
  const wt = await createWorktree(repo, gitIn(repo, ["rev-parse", "HEAD"]), "test-run-2");
  await removeWorktree(repo, wt);
  await removeWorktree(repo, wt); // second call must not throw
  assert.ok(!existsSync(wt));
});
