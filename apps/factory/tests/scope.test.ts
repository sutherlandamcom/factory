import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { collectChanges } from "../src/executor/scope.js";
import { createWorktree, removeWorktree } from "../src/executor/worktree.js";
import { gitIn, makeTempRepo } from "./helpers.js";

test("allowed path under sites/starter/src/ is accepted", async () => {
  const repo = await makeTempRepo();
  const wt = await createWorktree(repo, gitIn(repo, ["rev-parse", "HEAD"]), "scope-ok");
  try {
    await writeFile(
      path.join(wt, "sites", "starter", "src", "pages", "index.astro"),
      "---\n---\n<h1>Changed</h1>\n",
    );
    const result = await collectChanges(wt);
    assert.deepEqual(result.changedFiles, ["sites/starter/src/pages/index.astro"]);
    assert.deepEqual(result.violations, []);
  } finally {
    await removeWorktree(repo, wt);
  }
});

test("untracked new file in scope is detected and lands in the patch", async () => {
  const repo = await makeTempRepo();
  const wt = await createWorktree(repo, gitIn(repo, ["rev-parse", "HEAD"]), "scope-new");
  try {
    const newPage = path.join(wt, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(newPage), { recursive: true });
    await writeFile(newPage, "---\n---\n<h1>Roof Repair</h1>\n");
    const result = await collectChanges(wt);
    assert.deepEqual(result.changedFiles, ["sites/starter/src/pages/services/roof-repair.astro"]);
    assert.deepEqual(result.violations, []);
    // New (previously untracked) file content must be in the binary patch.
    assert.match(result.patch, /diff --git a\/sites\/starter\/src\/pages\/services\/roof-repair\.astro/);
    assert.match(result.patch, /Roof Repair/);
    assert.match(result.nameStatus, /^A\t/);
  } finally {
    await removeWorktree(repo, wt);
  }
});

test("change outside the allowed scope is a violation", async () => {
  const repo = await makeTempRepo();
  const wt = await createWorktree(repo, gitIn(repo, ["rev-parse", "HEAD"]), "scope-bad");
  try {
    await writeFile(path.join(wt, "package.json"), '{"name":"pwned"}\n');
    const result = await collectChanges(wt);
    assert.deepEqual(result.violations, ["package.json"]);
    assert.deepEqual(result.changedFiles, ["package.json"]);
  } finally {
    await removeWorktree(repo, wt);
  }
});

test("staging is evidence-only: nothing is committed", async () => {
  const repo = await makeTempRepo();
  const headBefore = gitIn(repo, ["rev-parse", "HEAD"]);
  const wt = await createWorktree(repo, headBefore, "scope-nocommit");
  try {
    await writeFile(path.join(wt, "sites", "starter", "src", "pages", "y.astro"), "<h1>y</h1>\n");
    await collectChanges(wt);
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]), headBefore);
  } finally {
    await removeWorktree(repo, wt);
  }
  assert.equal(gitIn(repo, ["rev-parse", "HEAD"]), headBefore);
});
