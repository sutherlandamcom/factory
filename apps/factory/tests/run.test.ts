import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { taskResultSchema, type SiteTask } from "@factory/contracts";
import { FactoryError } from "../src/executor/errors.js";
import type { CodexRunRequest, CodexRunResult } from "../src/executor/codex.js";
import { runSiteTask } from "../src/executor/run.js";
import { gitIn, makeTempRepo } from "./helpers.js";

const TASK: SiteTask = {
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair services",
    sections: ["hero", "benefits", "faq", "cta"],
  },
};

/** Mock Codex boundary: no real Codex calls in tests. */
function mockCodex(
  behave: (req: CodexRunRequest) => Promise<void>,
  result: Partial<CodexRunResult> = {},
) {
  return async (req: CodexRunRequest): Promise<CodexRunResult> => {
    await behave(req);
    return { exitCode: 0, timedOut: false, version: "codex-cli 0.150.1 (mock)", stdout: "", stderr: "", ...result };
  };
}

const noopDeps = async () => {};
const passQa = async () => ({ passed: true, exitCode: 0, timedOut: false });
const passVerify = async () => ({ passed: true, details: "mock verification passed" });

function runDirOf(repo: string, runId: string): string {
  return path.join(repo, ".factory", "runs", runId);
}

test("happy path: succeeded TaskResult, patch artifact, cleanup", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "happy",
    codexRunner: mockCodex(async (req) => {
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, "---\n---\n<h1>Roof Repair</h1>\n");
    }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.finalStage, "complete");
  assert.equal(result.totalAttempts, 1);
  assert.equal(result.successfulAttempt, 1);
  assert.equal(result.baseCommit, gitIn(repo, ["rev-parse", "HEAD"]));
  assert.deepEqual(result.changes?.changedFiles, ["sites/starter/src/pages/services/roof-repair.astro"]);

  // Patch artifact contains the new page.
  const patch = await readFile(path.join(runDirOf(repo, "happy"), "diff.patch"), "utf8");
  assert.match(patch, /roof-repair\.astro/);
  assert.match(patch, /Roof Repair/);

  // TaskResult file is schema-valid.
  const raw = JSON.parse(await readFile(path.join(runDirOf(repo, "happy"), "task-result.json"), "utf8"));
  assert.deepEqual(taskResultSchema.parse(raw), raw);

  // Cleanup: worktree removed, main tree clean.
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "happy")));
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("codex process failure normalizes to codex_failed with cleanup", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "codex-fail",
    codexRunner: mockCodex(async () => {}, { exitCode: 1, stderr: "boom" }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "codex");
  assert.equal(result.error?.code, "codex_failed");
  assert.equal(result.codex?.exitCode, 1);
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "codex-fail")));
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("codex timeout normalizes to codex_timeout", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "codex-timeout",
    codexRunner: mockCodex(async () => {}, { exitCode: null, timedOut: true }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "codex_timeout");
  assert.equal(result.codex?.timedOut, true);
});

test("scope violation fails with evidence preserved before cleanup", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "scope-violation",
    codexRunner: mockCodex(async (req) => {
      await writeFile(path.join(req.worktreePath, "package.json"), '{"name":"pwned"}\n');
      await writeFile(
        path.join(req.worktreePath, "sites", "starter", "src", "pages", "ok.astro"),
        "<h1>ok</h1>\n",
      );
    }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "scope");
  assert.equal(result.error?.code, "scope_violation");
  assert.match(result.error!.message, /package\.json/);

  // Evidence (changed-files + patch) survives worktree cleanup.
  const changed = await readFile(path.join(runDirOf(repo, "scope-violation"), "changed-files.txt"), "utf8");
  assert.match(changed, /package\.json/);
  const patch = await readFile(path.join(runDirOf(repo, "scope-violation"), "diff.patch"), "utf8");
  assert.match(patch, /pwned/);
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "scope-violation")));
});

test("QA failure with maxAttempts=1 fails with needs_review", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "qa-fail",
    maxAttempts: 1,
    codexRunner: mockCodex(async (req) => {
      await writeFile(
        path.join(req.worktreePath, "sites", "starter", "src", "pages", "ok.astro"),
        "<h1>ok</h1>\n",
      );
    }),
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: false, exitCode: 1, timedOut: false }),
    verifyFn: passVerify,
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.finalStage, "qa");
  assert.equal(result.error?.code, "qa_failed");
  assert.equal(result.qa?.passed, false);
});

test("task verification failure with maxAttempts=1 fails with needs_review", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "verify-fail",
    maxAttempts: 1,
    codexRunner: mockCodex(async () => {}),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: async () => ({ passed: false, details: "expected built page missing" }),
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.finalStage, "verify");
  assert.equal(result.error?.code, "verification_failed");
  assert.equal(result.taskVerification?.passed, false);
});

test("dirty working tree fails preflight before any worktree exists", async () => {
  const repo = await makeTempRepo();
  await writeFile(path.join(repo, "package.json"), '{"name":"dirty"}\n');
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "dirty",
    codexRunner: mockCodex(async () => {}),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "preflight");
  assert.equal(result.error?.code, "dirty_working_tree");
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "dirty")));
});

test("invalid task input fails validation without touching git", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(
    { type: "create_page", siteId: "demo", page: { slug: "../escape" } },
    { repoRoot: repo, runId: "invalid", codexRunner: mockCodex(async () => {}) },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "validation");
  assert.equal(result.error?.code, "invalid_task");
  assert.equal(result.baseCommit, "");
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "invalid")));
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("missing codex binary fails closed with codex_environment_failed", async () => {
  const repo = await makeTempRepo();
  const { createCodexRunner } = await import("../src/executor/codex.js");
  const runner = createCodexRunner({ codexPath: "/nonexistent/codex" });
  await assert.rejects(
    () =>
      runner({
        worktreePath: repo,
        prompt: "x",
        runDir: repo,
        timeoutMs: 1000,
      }),
    (err: unknown) => err instanceof FactoryError && err.code === "codex_environment_failed",
  );
});
