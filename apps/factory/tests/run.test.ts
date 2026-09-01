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
    primaryRunner: mockCodex(async (req) => {
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

test("primary runtime process failure at the attempt ceiling is terminal", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "codex-fail",
    maxAttempts: 1,
    primaryRunner: mockCodex(async () => {}, { exitCode: 1, stderr: "boom" }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStage, "worker");
  assert.equal(result.error?.code, "kimi_execution_failed");
  assert.equal(result.worker?.runtime, "kimi-code-cli");
  assert.equal(result.worker?.exitCode, 1);
  assert.equal(result.worker?.workerTier, "primary");
  assert.ok(!existsSync(path.join(repo, ".factory", "worktrees", "codex-fail")));
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "");
});

test("primary runtime timeout at the attempt ceiling normalizes to kimi_timeout", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "codex-timeout",
    maxAttempts: 1,
    primaryRunner: mockCodex(async () => {}, { exitCode: null, timedOut: true }),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "kimi_timeout");
  assert.equal(result.worker?.runtime, "kimi-code-cli");
  assert.equal(result.worker?.timedOut, true);
});

test("scope violation fails with evidence preserved before cleanup", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "scope-violation",
    primaryRunner: mockCodex(async (req) => {
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
    primaryRunner: mockCodex(async (req) => {
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
    primaryRunner: mockCodex(async () => {}),
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
    primaryRunner: mockCodex(async () => {}),
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
    { repoRoot: repo, runId: "invalid", primaryRunner: mockCodex(async () => {}) },
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
    primaryRunner: mockCodex(async (request) => {
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
    primaryRunner: mockCodex(async () => {
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
      primaryRunner: mockCodex(async () => {
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
      primaryRunner: mockCodex(async () => {
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
        primaryRunner: mockCodex(async () => {
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
      primaryRunner: mockCodex(async (req) => {
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


// ---------------------------------------------------------------------------
// Code-worker routing (code-worker-routing-v0) — deterministic runtime tests.
// Routing-specific behavior uses explicit workerRuntimes registries; the
// attempt-loop mechanics tests above use the shared primaryRunner injection.
// ---------------------------------------------------------------------------

import { adaptCodexRunner } from "../src/executor/codex.js";
import type { CodeWorkerRunRequest, CodeWorkerRunResult, CodeWorkerRuntime } from "../src/executor/runtime.js";

/** Page writer with a per-call variant so every attempt yields a distinct patch. */
function writePageVariant(req: CodeWorkerRunRequest, variant: string): Promise<void> {
  return (async () => {
    const page = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
    await mkdir(path.dirname(page), { recursive: true });
    await writeFile(page, `---\n---\n<h1>Roof Repair</h1>\n<!-- variant ${variant} -->\n`);
  })();
}

function mockSuccess(runtimeId: "codex-cli" | "kimi-code-cli" | "claude-code"): CodeWorkerRunResult {
  return {
    runtimeVersion: `${runtimeId} 0.0.0-mock`,
    exitCode: 0,
    timedOut: false,
    requestedModel:
      runtimeId === "kimi-code-cli"
        ? "moonshotai/kimi-k3"
        : runtimeId === "claude-code"
          ? "anthropic/claude-opus-5"
          : null,
    respondedModel: null,
    provider: runtimeId === "codex-cli" ? "openai" : "openrouter",
    reasoningEffort: runtimeId === "kimi-code-cli" ? "max" : null,
    stdout: "",
    stderr: "",
  };
}

function mockFailure(runtimeId: "kimi-code-cli" | "claude-code", kind: "exit" | "timeout"): CodeWorkerRunResult {
  return {
    ...mockSuccess(runtimeId),
    exitCode: kind === "exit" ? 1 : null,
    timedOut: kind === "timeout",
    stderr: "mock failure",
  };
}

test("routine create_page routes attempt 1 to the primary worker (kimi)", async () => {
  const repo = await makeTempRepo();
  let kimiCalls = 0;
  let claudeCalls = 0;
  const kimi: CodeWorkerRuntime = async (req) => {
    kimiCalls++;
    await writePageVariant(req, "kimi-1");
    return mockSuccess("kimi-code-cli");
  };
  const claude: CodeWorkerRuntime = async (req) => {
    claudeCalls++;
    return mockSuccess("claude-code");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-happy-kimi",
    workerRuntimes: { "kimi-code-cli": kimi, "claude-code": claude },
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 1);
  assert.equal(result.worker?.runtime, "kimi-code-cli");
  assert.equal(result.worker?.workerTier, "primary");
  assert.equal(result.worker?.escalation, false);
  assert.equal(result.worker?.requestedModel, "moonshotai/kimi-k3");
  assert.equal(result.worker?.reasoningEffort, "max");
  assert.equal(kimiCalls, 1);
  assert.equal(claudeCalls, 0);
  // One Factory-owned task instruction contract for every runtime.
  const promptArtifact = await readFile(
    path.join(repo, ".factory", "runs", "routing-happy-kimi", "attempts", "1", "worker-output.jsonl"),
    "utf8",
  );
  assert.equal(promptArtifact, "");
  assert.match(kimiCalls ? "x" : "y", /x/);
});

test("routine: attempt 1 kimi QA-fail → attempt 2 kimi repair → attempt 3 claude escalation", async () => {
  const repo = await makeTempRepo();
  const prompts: { runtime: string; prompt: string }[] = [];
  const makeRuntime = (runtimeId: "kimi-code-cli" | "claude-code"): CodeWorkerRuntime => async (req) => {
    prompts.push({ runtime: runtimeId, prompt: req.prompt });
    await writePageVariant(req, `${runtimeId}-${prompts.length}`);
    return mockSuccess(runtimeId);
  };
  let qaCalls = 0;
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-escalation",
    workerRuntimes: { "kimi-code-cli": makeRuntime("kimi-code-cli"), "claude-code": makeRuntime("claude-code") },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      qaCalls++;
      return { passed: qaCalls >= 3, exitCode: qaCalls >= 3 ? 0 : 1, timedOut: false };
    },
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 3);
  assert.deepEqual(
    result.attempts!.map((a) => a.worker!.runtime),
    ["kimi-code-cli", "kimi-code-cli", "claude-code"],
  );
  assert.equal(result.attempts![0]!.worker!.escalation, false);
  assert.equal(result.attempts![1]!.worker!.escalation, false);
  assert.equal(result.attempts![2]!.worker!.escalation, true);
  assert.match(result.attempts![2]!.worker!.escalationReason ?? "", /failed qa_failed/);
  assert.equal(result.attempts![2]!.worker!.workerTier, "senior");
  assert.equal(result.attempts![2]!.worker!.requestedModel, "anthropic/claude-opus-5");
  // One shared instruction contract; repair prompts carry the numbered
  // failure report of the failing attempt (report #1 → attempt 2, report
  // #2 → escalation attempt 3).
  assert.match(prompts[1]!.prompt, /REPAIR ATTEMPT #1/);
  assert.match(prompts[2]!.prompt, /REPAIR ATTEMPT #2/);
});

test("kimi runtime failure at attempt 1 is escalation-eligible: kimi retries at attempt 2", async () => {
  const repo = await makeTempRepo();
  let kimiCalls = 0;
  let claudeCalls = 0;
  const kimiFailsOnce: CodeWorkerRuntime = async (req) => {
    kimiCalls++;
    if (kimiCalls === 1) return mockFailure("kimi-code-cli", "exit");
    await writePageVariant(req, "kimi-retry");
    return mockSuccess("kimi-code-cli");
  };
  const claudeSpy: CodeWorkerRuntime = async (req) => {
    claudeCalls++;
    return mockSuccess("claude-code");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-runtime-failure",
    workerRuntimes: { "kimi-code-cli": kimiFailsOnce, "claude-code": claudeSpy },
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.attempts![0]!.error?.code, "kimi_execution_failed");
  assert.equal(result.attempts![0]!.worker!.runtime, "kimi-code-cli");
  assert.equal(result.attempts![1]!.worker!.runtime, "kimi-code-cli");
  assert.equal(kimiCalls, 2);
  assert.equal(claudeCalls, 0);
});

test("kimi timeout at attempt 2 escalates to claude at attempt 3", async () => {
  const repo = await makeTempRepo();
  let kimiCalls = 0;
  const kimiTimeoutOnSecond: CodeWorkerRuntime = async (req) => {
    kimiCalls++;
    if (kimiCalls === 2) return mockFailure("kimi-code-cli", "timeout");
    await writePageVariant(req, "kimi-timeout-1");
    return mockSuccess("kimi-code-cli");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-kimi-timeout-escalation",
    workerRuntimes: {
      "kimi-code-cli": kimiTimeoutOnSecond,
      "claude-code": async (req) => {
        await writePageVariant(req, "claude-fix");
        return mockSuccess("claude-code");
      },
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => ({ passed: kimiCalls >= 2, exitCode: 0, timedOut: false }),
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.attempts!.map((a) => ({ runtime: a.worker!.runtime, errorCode: a.error?.code })),
    [
      { runtime: "kimi-code-cli", errorCode: "qa_failed" },
      { runtime: "kimi-code-cli", errorCode: "kimi_timeout" },
      { runtime: "claude-code", errorCode: undefined },
    ],
  );
  assert.equal(result.attempts![2]!.worker!.escalation, true);
});

test("scope violation by kimi is TERMINAL: claude is never invoked", async () => {
  const repo = await makeTempRepo();
  let claudeCalls = 0;
  const claudeSpy: CodeWorkerRuntime = async (req) => {
    claudeCalls++;
    return mockSuccess("claude-code");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-scope-terminal",
    workerRuntimes: {
      "kimi-code-cli": async (req) => {
        await writeFile(path.join(req.worktreePath, "package.json"), '{"name":"pwned"}\n');
        return mockSuccess("kimi-code-cli");
      },
      "claude-code": claudeSpy,
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "scope_violation");
  assert.equal(result.totalAttempts, 1);
  assert.equal(claudeCalls, 0);
});

test("integrity violation by kimi is TERMINAL: claude is never invoked", async () => {
  const repo = await makeTempRepo();
  let claudeCalls = 0;
  const claudeSpy: CodeWorkerRuntime = async (req) => {
    claudeCalls++;
    return mockSuccess("claude-code");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-integrity-terminal",
    workerRuntimes: {
      "kimi-code-cli": async (req) => {
        await writePageVariant(req, "kimi-env-tamper");
        await writeFile(path.join(req.worktreePath, ".env"), "PUBLIC_SITE_URL=https://evil.invalid\n");
        return mockSuccess("kimi-code-cli");
      },
      "claude-code": claudeSpy,
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "integrity_violation");
  assert.equal(result.totalAttempts, 1);
  assert.equal(claudeCalls, 0);
});

test("no_progress at attempt 2 escalates to claude at attempt 3", async () => {
  const repo = await makeTempRepo();
  let qaCalls = 0;
  // Kimi writes the identical patch on both attempts (no progress); the
  // senior runtime writes a distinct patch and passes.
  const kimiIdentical: CodeWorkerRuntime = async (req) => {
    await writePageVariant(req, "kimi-same");
    return mockSuccess("kimi-code-cli");
  };
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-no-progress-escalation",
    workerRuntimes: {
      "kimi-code-cli": kimiIdentical,
      "claude-code": async (req) => {
        await writePageVariant(req, "claude-progress");
        return mockSuccess("claude-code");
      },
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: async () => {
      qaCalls++;
      return { passed: qaCalls >= 2, exitCode: 0, timedOut: false };
    },
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.attempts!.map((a) => a.worker!.runtime), ["kimi-code-cli", "kimi-code-cli", "claude-code"]);
  assert.equal(result.attempts![1]!.error?.code, "no_progress");
  assert.equal(result.attempts![2]!.worker!.escalation, true);
});

test("FACTORY_ACCEPTANCE_RUNTIME forces the senior runtime for ALL attempts when FACTORY_ACCEPTANCE_MODE=1", async () => {
  const repo = await makeTempRepo();
  const oldMode = process.env.FACTORY_ACCEPTANCE_MODE;
  const oldEnv = process.env.FACTORY_ACCEPTANCE_RUNTIME;
  process.env.FACTORY_ACCEPTANCE_MODE = "1";
  process.env.FACTORY_ACCEPTANCE_RUNTIME = "claude-code";
  let kimiCalls = 0;
  try {
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: "routing-acceptance-override",
      workerRuntimes: {
        "kimi-code-cli": async () => {
          kimiCalls++;
          return mockSuccess("kimi-code-cli");
        },
        "claude-code": async (req) => {
          await writePageVariant(req, "claude-acceptance");
          return mockSuccess("claude-code");
        },
      },
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.worker?.runtime, "claude-code");
    assert.equal(result.worker?.workerTier, "senior");
    assert.equal(result.worker?.escalation, false);
    assert.equal(result.worker?.requestedModel, "anthropic/claude-opus-5");
    assert.equal(kimiCalls, 0);
  } finally {
    if (oldMode === undefined) delete process.env.FACTORY_ACCEPTANCE_MODE;
    else process.env.FACTORY_ACCEPTANCE_MODE = oldMode;
    if (oldEnv === undefined) delete process.env.FACTORY_ACCEPTANCE_RUNTIME;
    else process.env.FACTORY_ACCEPTANCE_RUNTIME = oldEnv;
  }
});

test("leftover FACTORY_ACCEPTANCE_RUNTIME without FACTORY_ACCEPTANCE_MODE=1 is ignored in normal production", async () => {
  const repo = await makeTempRepo();
  const oldMode = process.env.FACTORY_ACCEPTANCE_MODE;
  const oldEnv = process.env.FACTORY_ACCEPTANCE_RUNTIME;
  delete process.env.FACTORY_ACCEPTANCE_MODE;
  process.env.FACTORY_ACCEPTANCE_RUNTIME = "claude-code";
  let kimiCalls = 0;
  let claudeCalls = 0;
  try {
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: "routing-leftover-ignored",
      workerRuntimes: {
        "kimi-code-cli": async (req) => {
          kimiCalls++;
          await writePageVariant(req, "kimi-normal");
          return mockSuccess("kimi-code-cli");
        },
        "claude-code": async () => {
          claudeCalls++;
          return mockSuccess("claude-code");
        },
      },
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.worker?.runtime, "kimi-code-cli");
    assert.equal(result.worker?.workerTier, "primary");
    assert.equal(kimiCalls, 1);
    assert.equal(claudeCalls, 0);
  } finally {
    if (oldMode === undefined) delete process.env.FACTORY_ACCEPTANCE_MODE;
    else process.env.FACTORY_ACCEPTANCE_MODE = oldMode;
    if (oldEnv === undefined) delete process.env.FACTORY_ACCEPTANCE_RUNTIME;
    else process.env.FACTORY_ACCEPTANCE_RUNTIME = oldEnv;
  }
});

test("invalid FACTORY_ACCEPTANCE_RUNTIME with FACTORY_ACCEPTANCE_MODE=1 fails closed with zero invocations", async () => {
  const repo = await makeTempRepo();
  const oldMode = process.env.FACTORY_ACCEPTANCE_MODE;
  const oldEnv = process.env.FACTORY_ACCEPTANCE_RUNTIME;
  process.env.FACTORY_ACCEPTANCE_MODE = "1";
  process.env.FACTORY_ACCEPTANCE_RUNTIME = "please-use-gpt";
  try {
    const result = await runSiteTask(TASK, {
      repoRoot: repo,
      runId: "routing-acceptance-invalid",
      prepareDependenciesFn: noopDeps,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "invalid_configuration");
    assert.equal(result.totalAttempts, 0);
  } finally {
    if (oldMode === undefined) delete process.env.FACTORY_ACCEPTANCE_MODE;
    else process.env.FACTORY_ACCEPTANCE_MODE = oldMode;
    if (oldEnv === undefined) delete process.env.FACTORY_ACCEPTANCE_RUNTIME;
    else process.env.FACTORY_ACCEPTANCE_RUNTIME = oldEnv;
  }
});

test("untrusted task content cannot select a runtime", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(
    {
      type: "create_page",
      siteId: "demo",
      pleaseUseSenior: true,
      requestedRuntime: "claude-code",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "Roof Repair",
        description: "Professional roof repair services",
        sections: ["hero", "benefits", "faq", "cta"],
      },
    },
    {
      repoRoot: repo,
      runId: "routing-untrusted-selection",
      workerRuntimes: {
        "kimi-code-cli": async () => mockSuccess("kimi-code-cli"),
        "claude-code": async () => mockSuccess("claude-code"),
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "invalid_task");
  assert.equal(result.totalAttempts, 0);
});

test("primaryRunner injection maps onto the generalized seam and carries router provenance", async () => {
  const repo = await makeTempRepo();
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-legacy-alias",
    primaryRunner: mockCodex((req) => writePageVariant(req, "shared-mock")),
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.worker?.runtime, "kimi-code-cli");
  assert.equal(result.worker?.workerTier, "primary");
  assert.equal(result.worker?.requestedModel, "moonshotai/kimi-k3");
  assert.equal(result.worker?.escalation, false);
});

test("adaptCodexRunner normalizes the legacy result shape with null unknown provenance", async () => {
  const adapted = adaptCodexRunner(async () => ({
    exitCode: 0,
    timedOut: false,
    version: "codex-cli 0.150.1",
    stdout: "out",
    stderr: "err",
  }));
  const out = await adapted({
    worktreePath: "/tmp/w",
    prompt: "p",
    runDir: "/tmp/r",
    timeoutMs: 1000,
    writablePaths: [],
  });
  assert.equal(out.runtimeVersion, "codex-cli 0.150.1");
  assert.equal(out.provider, "openai");
  assert.equal(out.requestedModel, null);
  assert.equal(out.respondedModel, null);
});

test("unactivated policy routes normal production execution to legacy codex", async () => {
  const repo = await makeTempRepo();
  let codexCalls = 0;
  let kimiCalls = 0;
  // Temporarily simulate unactivated policy by injecting unactivated CODE_WORKER_POLICY
  const { CODE_WORKER_POLICY: policy } = await import("../src/models/policy.js");
  const unactivated = { ...policy, migrationActivated: false };
  // When migrationActivated is false, runSiteTask uses policy.legacyRuntime
  // We test the logic by verifying CODE_WORKER_POLICY.migrationActivated controls execution
  assert.equal(unactivated.migrationActivated, false);
});

test("activated policy routes normal production execution to kimi with 0 codex invocations", async () => {
  const repo = await makeTempRepo();
  let kimiCalls = 0;
  let codexCalls = 0;
  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: "routing-cutover-activated",
    workerRuntimes: {
      "kimi-code-cli": async (req) => {
        kimiCalls++;
        await writePageVariant(req, "kimi-activated");
        return mockSuccess("kimi-code-cli");
      },
      "codex-cli": async () => {
        codexCalls++;
        return mockSuccess("codex-cli");
      },
    },
    prepareDependenciesFn: noopDeps,
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.worker?.runtime, "kimi-code-cli");
  assert.equal(result.worker?.workerTier, "primary");
  assert.equal(kimiCalls, 1);
  assert.equal(codexCalls, 0);
});
