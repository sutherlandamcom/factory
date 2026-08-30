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
const passReplay = async () => ({ passed: true, details: "mock replay passed" });

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
    verifyReplayFn: passReplay,
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
    verifyReplayFn: passReplay,
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
    verifyReplayFn: passReplay,
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
    verifyReplayFn: passReplay,
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
      await mkdir(path.join(req.worktreePath, "sites", "starter", "src", "pages", "services"), { recursive: true });
      await writeFile(
        path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro"),
        "<h1>ok</h1>\n",
      );
    }),
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: false, exitCode: 1, timedOut: false }),
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
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
    verifyReplayFn: passReplay,
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
    verifyReplayFn: passReplay,
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

test("strong isolation preflight fails closed for a repository outside the dedicated mounts", async () => {
  const repo = await makeTempRepo();
  const { assertStrongExecutionIsolationAvailable } = await import("../src/executor/isolation.js");
  await assert.rejects(
    () => assertStrongExecutionIsolationAvailable(repo),
    (err: unknown) => err instanceof FactoryError && err.code === "strong_execution_isolation_unavailable",
  );
});

test("CLI execution records isolation blocker before invoking Codex", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "isolation-unavailable",
    prepareDependenciesFn: noopDeps,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "isolation");
  assert.equal(result.error?.code, "strong_execution_isolation_unavailable");
  assert.match(result.error!.message, /STRONG_EXECUTION_ISOLATION_UNAVAILABLE/);
  assert.equal(result.totalAttempts, 0);
});

test("ignored input mutation is terminal and never reaches QA or repair", async () => {
  const repo = await makeTempRepo();
  let codexCalls = 0;
  let qaCalls = 0;
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "integrity-violation",
    codexRunner: mockCodex(async (request) => {
      codexCalls++;
      const target = path.join(request.worktreePath, "sites/starter/src/pages/services/roof-repair.astro");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "<h1>Roof Repair</h1>\n");
      await writeFile(path.join(request.worktreePath, ".env"), "PUBLIC_SITE_URL=https://evil.invalid\n");
    }),
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      qaCalls++;
      return { passed: true, exitCode: 0, timedOut: false };
    },
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "integrity");
  assert.equal(result.error?.code, "integrity_violation");
  assert.equal(result.attempts?.[0]?.classification, "non_repairable");
  assert.equal(codexCalls, 1);
  assert.equal(qaCalls, 0);
});

test("programmatic maxAttempts > 3 is rejected before Codex with 0 invocations", async () => {
  const repo = await makeTempRepo();
  let codexInvocations = 0;
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "attempt-bound-programmatic",
    maxAttempts: 4,
    codexRunner: mockCodex(async () => {
      codexInvocations++;
    }),
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "validation");
  assert.equal(result.error?.code, "invalid_configuration");
  assert.match(result.error!.message, /maxAttempts must be an integer between 1 and 3/);
  assert.equal(codexInvocations, 0);
  assert.equal(result.totalAttempts, 0);
});

test("FACTORY_MAX_ATTEMPTS=4 env is rejected before Codex with 0 invocations", async () => {
  const repo = await makeTempRepo();
  const oldEnv = process.env.FACTORY_MAX_ATTEMPTS;
  process.env.FACTORY_MAX_ATTEMPTS = "4";
  let codexInvocations = 0;

  try {
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: "attempt-bound-env-4",
      codexRunner: mockCodex(async () => {
        codexInvocations++;
      }),
      prepareDependenciesFn: noopDeps,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.finalStage, "validation");
    assert.equal(result.error?.code, "invalid_configuration");
    assert.match(result.error!.message, /FACTORY_MAX_ATTEMPTS cannot exceed hard ceiling of 3/);
    assert.equal(codexInvocations, 0);
    assert.equal(result.totalAttempts, 0);
  } finally {
    if (oldEnv === undefined) delete process.env.FACTORY_MAX_ATTEMPTS;
    else process.env.FACTORY_MAX_ATTEMPTS = oldEnv;
  }
});

test("FACTORY_MAX_ATTEMPTS=1000 env is rejected before Codex with 0 invocations", async () => {
  const repo = await makeTempRepo();
  const oldEnv = process.env.FACTORY_MAX_ATTEMPTS;
  process.env.FACTORY_MAX_ATTEMPTS = "1000";
  let codexInvocations = 0;

  try {
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: "attempt-bound-env-1000",
      codexRunner: mockCodex(async () => {
        codexInvocations++;
      }),
      prepareDependenciesFn: noopDeps,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.finalStage, "validation");
    assert.equal(result.error?.code, "invalid_configuration");
    assert.equal(codexInvocations, 0);
    assert.equal(result.totalAttempts, 0);
  } finally {
    if (oldEnv === undefined) delete process.env.FACTORY_MAX_ATTEMPTS;
    else process.env.FACTORY_MAX_ATTEMPTS = oldEnv;
  }
});

test("invalid FACTORY_MAX_ATTEMPTS (0, -1, abc) are rejected before Codex", async () => {
  const repo = await makeTempRepo();
  const oldEnv = process.env.FACTORY_MAX_ATTEMPTS;

  for (const badValue of ["0", "-1", "abc", "3.5"]) {
    process.env.FACTORY_MAX_ATTEMPTS = badValue;
    let codexInvocations = 0;

    try {
      const result = await runSiteTask(TASK, {
        repoRoot: repo,
        runId: `attempt-bound-invalid-${badValue}`,
        codexRunner: mockCodex(async () => {
          codexInvocations++;
        }),
        prepareDependenciesFn: noopDeps,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.finalStage, "validation");
      assert.equal(result.error?.code, "invalid_configuration");
      assert.equal(codexInvocations, 0);
    } finally {
      if (oldEnv === undefined) delete process.env.FACTORY_MAX_ATTEMPTS;
      else process.env.FACTORY_MAX_ATTEMPTS = oldEnv;
    }
  }
});

test("valid maxAttempts values 1, 2, and 3 are accepted and behave correctly", async () => {
  const repo = await makeTempRepo();
  for (const validVal of [1, 2, 3]) {
    let codexInvocations = 0;
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: `valid-attempts-${validVal}`,
      maxAttempts: validVal,
      codexRunner: mockCodex(async (req) => {
        codexInvocations++;
        const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
        await mkdir(path.dirname(page), { recursive: true });
        await writeFile(page, "---\n---\n<h1>Roof Repair</h1>\n");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.totalAttempts, 1);
    assert.equal(codexInvocations, 1);
  }
});

test("taskResultSchema rejects impossible attempt histories", () => {
  const validBase = {
    runId: "run-test",
    status: "succeeded",
    finalStage: "complete",
    taskType: "create_page",
    siteId: "demo",
    baseCommit: "a".repeat(40),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1000,
    totalAttempts: 1,
    successfulAttempt: 1,
    attempts: [
      {
        attemptNumber: 1,
        kind: "initial",
        stage: "complete",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1000,
        artifacts: { attemptDirectory: ".factory/runs/run-test/attempts/1" },
      },
    ],
    artifacts: { runDirectory: ".factory/runs/run-test" },
  };

  // Valid parses cleanly
  assert.doesNotThrow(() => taskResultSchema.parse(validBase));

  // totalAttempts: 4 rejected
  assert.throws(() => taskResultSchema.parse({ ...validBase, totalAttempts: 4 }));

  // successfulAttempt: 4 rejected
  assert.throws(() => taskResultSchema.parse({ ...validBase, successfulAttempt: 4 }));

  // attempt with attemptNumber: 4 rejected
  assert.throws(() =>
    taskResultSchema.parse({
      ...validBase,
      attempts: [{ ...validBase.attempts[0], attemptNumber: 4 }],
    }),
  );

  // four-item attempts array rejected
  const attemptItem = (n: number) => ({
    attemptNumber: n,
    kind: n === 1 ? ("initial" as const) : ("repair" as const),
    stage: "qa" as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    artifacts: { attemptDirectory: `.factory/runs/run-test/attempts/${n}` },
  });

  assert.throws(() =>
    taskResultSchema.parse({
      ...validBase,
      totalAttempts: 4,
      attempts: [attemptItem(1), attemptItem(2), attemptItem(3), attemptItem(4)],
    }),
  );

  // successfulAttempt > totalAttempts rejected
  assert.throws(() =>
    taskResultSchema.parse({
      ...validBase,
      totalAttempts: 1,
      successfulAttempt: 2,
    }),
  );

  // Attempt kind mismatch (attempt 1 must be initial, attempt 2 must be repair)
  assert.throws(() =>
    taskResultSchema.parse({
      ...validBase,
      totalAttempts: 2,
      successfulAttempt: 2,
      attempts: [
        { ...attemptItem(1), kind: "repair" },
        { ...attemptItem(2), kind: "repair" },
      ],
    }),
  );
});

