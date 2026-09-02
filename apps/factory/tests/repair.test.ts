import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { taskResultSchema, type SiteTask } from "@factory/contracts";
import type { CodexRunRequest, CodexRunResult } from "../src/executor/codex.js";
import { runSiteTask } from "../src/executor/run.js";
import { buildFailureReport, MAX_FAILURE_EXCERPT_CHARS } from "../src/executor/classify.js";
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

function runDirOf(repo: string, runId: string): string {
  return path.join(repo, ".factory", "runs", runId);
}

const noopDeps = async () => {};
const passReplay = async () => ({ passed: true, details: "mock replay passed" });

test("Scenario A: initial attempt succeeds -> totalAttempts = 1, status = succeeded", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-init-ok",
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, "---\n---\n<h1>Roof Repair</h1>\n");
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: true, exitCode: 0, timedOut: false }),
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 1);
  assert.equal(result.successfulAttempt, 1);
  assert.equal(codexInvocations, 1);
  assert.equal(result.attempts?.length, 1);
  assert.equal(result.attempts[0]?.stage, "complete");
  assert.equal(result.attempts[0]?.kind, "initial");
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "repair-init-ok")));
});

test("Scenario B: 1 repair succeeds after QA failure -> totalAttempts = 2, status = succeeded", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;
  let receivedRepairPrompt = false;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-one-qa",
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });

      if (codexInvocations === 1) {
        // Attempt 1: defective code causing QA failure
        await writeFile(page, "---\n---\n<h1>Broken Roof Repair</h1>\n");
      } else {
        // Attempt 2: repaired code
        if (req.prompt.includes("REPAIR ATTEMPT #2") || req.prompt.includes("Failure Report")) {
          receivedRepairPrompt = true;
        }
        await writeFile(page, "---\n---\n<h1>Roof Repair</h1>\n");
      }

      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async (_wt, _runDir) => {
      if (codexInvocations === 1) {
        return { passed: false, exitCode: 1, timedOut: false };
      }
      return { passed: true, exitCode: 0, timedOut: false };
    },
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.successfulAttempt, 2);
  assert.equal(codexInvocations, 2);
  assert.equal(receivedRepairPrompt, true);
  assert.equal(result.attempts?.length, 2);
  assert.equal(result.attempts[0]?.classification, "repairable");
  assert.equal(result.attempts[0]?.kind, "initial");
  assert.equal(result.attempts[1]?.kind, "repair");
  assert.equal(result.attempts[1]?.stage, "complete");

  // Attempt artifacts exist
  assert.ok(existsSync(path.join(runDirOf(repo, "repair-one-qa"), "attempts", "1", "changed-files.txt")));
  assert.ok(existsSync(path.join(runDirOf(repo, "repair-one-qa"), "attempts", "1", "failure-report.json")));
  assert.ok(existsSync(path.join(runDirOf(repo, "repair-one-qa"), "attempts", "2", "diff.patch")));
});

test("Scenario C: third attempt succeeds (2 failures -> Attempt 3 passes) -> status = succeeded", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-three-attempts",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, `---\n---\n<h1>Roof Repair attempt ${codexInvocations}</h1>\n`);
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      if (codexInvocations < 3) return { passed: false, exitCode: 1, timedOut: false };
      return { passed: true, exitCode: 0, timedOut: false };
    },
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 3);
  assert.equal(result.successfulAttempt, 3);
  assert.equal(codexInvocations, 3);
  assert.equal(result.attempts?.length, 3);
  assert.equal(result.attempts[0]?.kind, "initial");
  assert.equal(result.attempts[1]?.kind, "repair");
  assert.equal(result.attempts[2]?.kind, "repair");
});

test("Scenario D: max attempts exhausted (3 attempts fail repairably) -> needs_review, no attempt 4", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-exhausted",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, `---\n---\n<h1>Broken Attempt ${codexInvocations}</h1>\n`);
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: false, exitCode: 1, timedOut: false }),
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.totalAttempts, 3);
  assert.equal(result.successfulAttempt, null);
  assert.equal(codexInvocations, 3);
  assert.equal(result.attempts?.length, 3);
  assert.equal(result.attempts[2]?.classification, "exhausted");
  assert.equal(result.error?.code, "qa_failed");
  assert.match(result.error!.message, /attempts exhausted/);

  // Schema validity of task-result.json
  const raw = JSON.parse(await readFile(path.join(runDirOf(repo, "repair-exhausted"), "task-result.json"), "utf8"));
  assert.deepEqual(taskResultSchema.parse(raw), raw);
});

test("Scenario E: scope violation on Attempt 1 stops immediately without retry", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-scope-stop-1",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      await writeFile(path.join(req.worktreePath, "package.json"), '{"name":"tampered"}\n');
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: true, exitCode: 0, timedOut: false }),
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "scope");
  assert.equal(result.error?.code, "scope_violation");
  assert.equal(codexInvocations, 1);
  assert.equal(result.totalAttempts, 1);
  assert.equal(result.attempts?.[0]?.classification, "non_repairable");
});

test("Scenario F: scope violation on Attempt 2 stops immediately without further repairs", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-scope-stop-2",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      if (codexInvocations === 1) {
        // Attempt 1: safe modification but fails QA
        const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
        await mkdir(path.dirname(page), { recursive: true });
        await writeFile(page, "---\n---\n<h1>Failing QA</h1>\n");
      } else {
        // Attempt 2: tampers with tests
        const testFile = path.join(req.worktreePath, "sites", "starter", "tests", "qa.spec.ts");
        await mkdir(path.dirname(testFile), { recursive: true });
        await writeFile(testFile, "pwned\n");
      }
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      if (codexInvocations === 1) return { passed: false, exitCode: 1, timedOut: false };
      return { passed: true, exitCode: 0, timedOut: false };
    },
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "scope");
  assert.equal(result.error?.code, "scope_violation");
  assert.equal(codexInvocations, 2);
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.attempts?.[1]?.classification, "non_repairable");
});

test("Scenario G: no-progress repair escalates to attempt 3; persistent no-progress ends needs_review", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-no-progress",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      if (codexInvocations === 1) {
        const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
        await mkdir(path.dirname(page), { recursive: true });
        await writeFile(page, "---\n---\n<h1>Unfixed</h1>\n");
      }
      // In attempt 2, Codex makes NO modifications to the worktree
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: false, exitCode: 1, timedOut: false }),
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.totalAttempts, 3);
  assert.equal(codexInvocations, 3);
  assert.equal(result.attempts?.[1]?.classification, "no_progress");
  assert.equal(result.attempts?.[2]?.classification, "no_progress");
  assert.equal(result.error?.code, "no_progress");
});

test("Scenario H: failure report bounds diagnostic context to configured limit", () => {
  const hugeLog = "X".repeat(MAX_FAILURE_EXCERPT_CHARS + 5000);
  const report = buildFailureReport({
    runId: "test-bound",
    attemptNumber: 1,
    failingStage: "qa",
    failureCode: "qa_failed",
    message: "QA failed",
    stdout: hugeLog,
    targetSlug: "/services/roof-repair",
  });

  assert.ok(report.excerpt.length <= MAX_FAILURE_EXCERPT_CHARS + 100);
  assert.ok(report.excerpt.includes("[truncated"));
});

test("Scenario I: final patch represents complete state against original base", async () => {
  const repo = await makeTempRepo();
  const baseSha = gitIn(repo, ["rev-parse", "HEAD"]);
  let codexInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-final-patch",
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      if (codexInvocations === 1) {
        await writeFile(page, "---\n---\n<h1>Initial Draft</h1>\n");
      } else {
        await writeFile(page, "---\n---\n<h1>Final Repaired Roof Repair</h1>\n");
      }
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      if (codexInvocations === 1) return { passed: false, exitCode: 1, timedOut: false };
      return { passed: true, exitCode: 0, timedOut: false };
    },
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: passReplay,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.baseCommit, baseSha);
  const patch = await readFile(path.join(runDirOf(repo, "repair-final-patch"), "diff.patch"), "utf8");
  assert.match(patch, /Final Repaired Roof Repair/);
  assert.ok(!patch.includes("Initial Draft"));
});

test("Scenario J: replay failure on Attempt 1 enters repair and succeeds on Attempt 2", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;
  let replayInvocations = 0;

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "repair-replay-flow",
    maxAttempts: 3,
    primaryRunner: async (req: CodexRunRequest): Promise<CodexRunResult> => {
      codexInvocations++;
      const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, `---\n---\n<h1>Roof Repair attempt ${codexInvocations}</h1>\n`);
      return { exitCode: 0, timedOut: false, version: "codex-mock", stdout: "", stderr: "" };
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: true, exitCode: 0, timedOut: false }),
    verifyFn: async () => ({ passed: true, details: "mock verification passed" }),
    verifyReplayFn: async () => {
      replayInvocations++;
      if (replayInvocations === 1) {
        return { passed: false, details: "replay build failed: missing import" };
      }
      return { passed: true, details: "replay build succeeded" };
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.successfulAttempt, 2);
  assert.equal(codexInvocations, 2);
  assert.equal(replayInvocations, 2);
  assert.equal(result.attempts?.[0]?.stage, "replay");
  assert.equal(result.attempts?.[0]?.classification, "repairable");
  assert.equal(result.attempts?.[1]?.stage, "complete");
});

test("scrubSecrets redacts model-gateway credentials in failure excerpts", async () => {
  const { scrubSecrets } = await import("../src/executor/classify.js");
  const dirty = "error: api key sk-or-v1-abc123def456 rejected; auth Bearer sk-or-v1-abc123def456; db postgresql://u:secret@h/db";
  const clean = scrubSecrets(dirty);
  assert.ok(!clean.includes("sk-or-v1-abc123def456"));
  assert.ok(!clean.includes("secret@"));
  assert.match(clean, /\[redacted-key\]/);
  assert.match(clean, /Bearer \[redacted/);
});
