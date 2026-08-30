import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { verifyPatchReplay } from "../src/executor/replay.js";
import { collectChanges } from "../src/executor/scope.js";
import { deriveTaskWritePolicy } from "../src/executor/module-policy.js";
import { gitIn, makeTempRepo } from "./helpers.js";

const TASK_POLICY = deriveTaskWritePolicy({
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair services",
    sections: ["hero", "benefits", "faq", "cta"],
  },
});

test("verifyPatchReplay: normal successful patch replays and passes check/build", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);

  // Create a page in repo to generate a valid diff patch
  const targetPage = path.join(repo, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
  await mkdir(path.dirname(targetPage), { recursive: true });
  await writeFile(targetPage, "---\n---\n<h1>Roof Repair</h1>\n", "utf8");

  const scopeResult = await collectChanges(repo, TASK_POLICY);
  // Reset repo to clean state so baseCommit is pristine
  gitIn(repo, ["reset", "--hard", "HEAD"]);
  gitIn(repo, ["clean", "-fdx"]);

  let checkBuildRan = false;
  const result = await verifyPatchReplay({
    repoRoot: repo,
    baseCommit,
    patch: scopeResult.patch,
    runId: "test-replay-ok",
    prepareDependenciesFn: async () => {},
    runReplayCheckBuildFn: async (worktreePath) => {
      checkBuildRan = true;
      const replayedPage = path.join(worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      assert.ok(existsSync(replayedPage), "replayed worktree must contain target page from patch");
      return { passed: true, details: "mock replay check and build passed" };
    },
  });

  assert.equal(result.passed, true);
  assert.equal(checkBuildRan, true);
  assert.match(result.details, /succeeded|passed/);
});

test("verifyPatchReplay: patch depending on uncommitted/ignored helper fails self-containment", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);

  // Page imports helper.ts
  const targetPage = path.join(repo, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
  await mkdir(path.dirname(targetPage), { recursive: true });
  await writeFile(targetPage, "---\nimport { helper } from './dist/helper.ts';\n---\n<h1>Roof Repair</h1>\n", "utf8");

  // Target page is created that imports helper
  const scopeResult = await collectChanges(repo, TASK_POLICY);
  const patch = scopeResult.patch;

  // Reset repo to clean state
  gitIn(repo, ["reset", "--hard", "HEAD"]);
  gitIn(repo, ["clean", "-fdx"]);

  const result = await verifyPatchReplay({
    repoRoot: repo,
    baseCommit,
    patch,
    runId: "test-replay-missing-helper",
    prepareDependenciesFn: async () => {},
    runReplayCheckBuildFn: async (worktreePath) => {
      const helperPath = path.join(worktreePath, "sites", "starter", "src", "pages", "services", "dist", "helper.ts");
      if (!existsSync(helperPath)) {
        return { passed: false, details: "Cannot find module './dist/helper.ts'" };
      }
      return { passed: true, details: "passed" };
    },
  });

  assert.equal(result.passed, false);
  assert.match(result.details, /Cannot find module/);
});

test("verifyPatchReplay: cleanup always removes the disposable replay worktree", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);
  const replayRunId = "test-replay-cleanup";
  const expectedReplayWorktree = path.join(repo, ".factory", "worktrees", `${replayRunId}-replay`);

  await verifyPatchReplay({
    repoRoot: repo,
    baseCommit,
    patch: "invalid patch",
    runId: replayRunId,
    prepareDependenciesFn: async () => {},
  });

  assert.ok(
    !existsSync(expectedReplayWorktree),
    `Replay worktree ${expectedReplayWorktree} must be removed after execution`,
  );
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("verifyPatchReplay: primary checkout remains clean and unchanged", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);

  const targetPage = path.join(repo, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
  await mkdir(path.dirname(targetPage), { recursive: true });
  await writeFile(targetPage, "---\n---\n<h1>Roof Repair</h1>\n", "utf8");

  const scopeResult = await collectChanges(repo, TASK_POLICY);
  gitIn(repo, ["reset", "--hard", "HEAD"]);
  gitIn(repo, ["clean", "-fdx"]);

  await verifyPatchReplay({
    repoRoot: repo,
    baseCommit,
    patch: scopeResult.patch,
    runId: "test-replay-isolation",
    prepareDependenciesFn: async () => {},
    runReplayCheckBuildFn: async () => ({ passed: true, details: "ok" }),
  });

  // Main repo working tree is completely clean and target file does not exist there
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
  assert.ok(!existsSync(targetPage));
});

test("verifyPatchReplay: binary-safe patch handling is preserved", async () => {
  const repo = await makeTempRepo();
  const baseCommit = gitIn(repo, ["rev-parse", "HEAD"]);

  const binaryFile = path.join(repo, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
  await mkdir(path.dirname(binaryFile), { recursive: true });
  // Write content with special binary / unicode bytes
  const content = "---\n---\n<h1>Roof Repair \u0000\u00FF\u{1F527}</h1>\n";
  await writeFile(binaryFile, content, "utf8");

  const scopeResult = await collectChanges(repo, TASK_POLICY);
  gitIn(repo, ["reset", "--hard", "HEAD"]);
  gitIn(repo, ["clean", "-fdx"]);

  let verifiedContent = "";
  const result = await verifyPatchReplay({
    repoRoot: repo,
    baseCommit,
    patch: scopeResult.patch,
    runId: "test-replay-binary",
    prepareDependenciesFn: async () => {},
    runReplayCheckBuildFn: async (worktreePath) => {
      const fs = await import("node:fs/promises");
      verifiedContent = await fs.readFile(
        path.join(worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro"),
        "utf8",
      );
      return { passed: true, details: "binary patch verified" };
    },
  });

  assert.equal(result.passed, true);
  assert.equal(verifiedContent, content);
});
