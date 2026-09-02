import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SiteTask, TaskResult } from "@factory/contracts";
import { setupMigratedTestDatabase, TEST_DATABASE_URL } from "./helpers.js";
import { runPersistedSiteTask } from "../../src/persistence/driver.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { FactoryError } from "../../src/executor/errors.js";
import type { CodexRunRequest, CodexRunResult } from "../../src/executor/codex.js";
import { makeTempRepo } from "../helpers.js";

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

function mockCodex(
  behave: (req: CodexRunRequest) => Promise<void>,
  result: Partial<CodexRunResult> = {},
) {
  return async (req: CodexRunRequest): Promise<CodexRunResult> => {
    await behave(req);
    return {
      exitCode: 0,
      timedOut: false,
      version: "codex-cli 0.150.1 (mock)",
      stdout: '{"event":"mock"}',
      stderr: "",
      ...result,
    };
  };
}

const noopDeps = async () => {};
const passQa = async () => ({ passed: true, exitCode: 0, timedOut: false });
const passVerify = async () => ({ passed: true, details: "mock verification passed" });
const passReplay = async () => ({ passed: true, details: "mock replay passed" });

function assertDbMatchesTaskResult(dbDetails: NonNullable<Awaited<ReturnType<FactoryStore["getRunDetails"]>>>, taskResult: TaskResult): void {
  assert.equal(dbDetails.run.id, taskResult.runId);
  assert.equal(dbDetails.run.status, taskResult.status);
  assert.equal(dbDetails.run.baseCommit, taskResult.baseCommit);
  assert.equal(dbDetails.attempts.length, taskResult.totalAttempts);

  const resAttempts = taskResult.attempts ?? [];
  for (let i = 0; i < resAttempts.length; i++) {
    const resAtt = resAttempts[i]!;
    const dbAtt = dbDetails.attempts[i]!;
    assert.equal(dbAtt.attemptNumber, resAtt.attemptNumber);
    assert.equal(dbAtt.kind, resAtt.kind);
    assert.equal(dbAtt.stage, resAtt.stage);
    if (resAtt.classification) {
      assert.equal(dbAtt.classification, resAtt.classification);
    }
    if (resAtt.error) {
      assert.equal(dbAtt.errorCode, resAtt.error.code);
    }
  }

  if (taskResult.error) {
    assert.equal(dbDetails.run.errorCode, taskResult.error.code);
  }
}

test("execution integration: happy path persists Run, Task, Attempt, QualityResults, ModelInvocation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-exec", name: "Exec Project" });
    await store.registerSite({
      projectKey: "p-exec",
      key: "demo",
      name: "Demo Site",
    });

    const repo = await makeTempRepo();
    const result = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      databaseUrl: TEST_DATABASE_URL,
      primaryRunner: mockCodex(async (req) => {
        const page = path.join(
          req.worktreePath,
          "sites",
          "starter",
          "src",
          "pages",
          "services",
          "roof-repair.astro",
        );
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

    const details = await store.getRunDetails(result.runId);
    assert.ok(details);
    assert.equal(details.run.status, "succeeded");
    assert.equal(details.project.key, "p-exec");
    assert.equal(details.site.key, "demo");
    assert.equal(details.tasks.length, 1);
    assert.equal(details.tasks[0]?.status, "succeeded");
    assert.equal(details.attempts.length, 1);

    const att1 = details.attempts[0]!;
    assert.equal(att1.attemptNumber, 1);
    assert.equal(att1.status, "succeeded");

    // Check QualityResults
    const gates = att1.qualityResults.map((qr) => qr.gate);
    assert.ok(gates.includes("scope"), "scope gate recorded");
    assert.ok(gates.includes("integrity"), "integrity gate recorded");
    assert.ok(gates.includes("foundation_qa"), "QA gate recorded");
    assert.ok(gates.includes("semantic_verification"), "semantic verification gate recorded");
    assert.ok(gates.includes("patch_replay"), "patch replay gate recorded");

    // Check ModelInvocations
    assert.equal(att1.modelInvocations.length, 1);
    assert.equal(att1.modelInvocations[0]?.provider, "openai");
    assert.equal(att1.modelInvocations[0]?.runtime, "codex-cli");
    assert.equal(att1.modelInvocations[0]?.status, "succeeded");

    // Compare DB against TaskResult
    assertDbMatchesTaskResult(details, result);
  } finally {
    await dbInst.close();
  }
});

test("execution integration: scope violation terminal failure persists failed state without retry", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-scope", name: "Scope Project" });
    await store.registerSite({
      projectKey: "p-scope",
      key: "demo",
      name: "Demo Site",
    });

    const repo = await makeTempRepo();
    const result = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      databaseUrl: TEST_DATABASE_URL,
      primaryRunner: mockCodex(async (req) => {
        // Attempt to modify unauthorized file (package.json)
        await writeFile(path.join(req.worktreePath, "package.json"), '{"hacked": true}');
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "scope_violation");
    assert.equal(result.totalAttempts, 1);

    const details = await store.getRunDetails(result.runId);
    assert.ok(details);
    assert.equal(details.run.status, "failed");
    assert.equal(details.run.errorCode, "scope_violation");
    assert.equal(details.tasks[0]?.status, "failed");
    assert.equal(details.attempts.length, 1, "Attempt 2 must not be run for scope violation");

    const att1 = details.attempts[0]!;
    assert.equal(att1.status, "failed");
    assert.equal(att1.classification, "non_repairable");
    assert.equal(att1.errorCode, "scope_violation");

    assertDbMatchesTaskResult(details, result);
  } finally {
    await dbInst.close();
  }
});

test("execution integration: bounded repair loop (Attempt 1 QA failure -> Attempt 2 success)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-repair", name: "Repair Project" });
    await store.registerSite({
      projectKey: "p-repair",
      key: "demo",
      name: "Demo Site",
    });

    const repo = await makeTempRepo();
    let attemptCount = 0;

    const result = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      databaseUrl: TEST_DATABASE_URL,
      primaryRunner: mockCodex(async (req) => {
        attemptCount++;
        const page = path.join(
          req.worktreePath,
          "sites",
          "starter",
          "src",
          "pages",
          "services",
          "roof-repair.astro",
        );
        await mkdir(path.dirname(page), { recursive: true });
        await writeFile(page, `---\n---\n<h1>Roof Repair Attempt ${attemptCount}</h1>\n`);
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: async (_worktreePath, _runDir, _timeout, _task) => {
        if (attemptCount === 1) {
          return { passed: false, exitCode: 1, timedOut: false, failureGate: "dynamic" };
        }
        return { passed: true, exitCode: 0, timedOut: false };
      },
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.totalAttempts, 2);
    assert.equal(result.successfulAttempt, 2);

    const details = await store.getRunDetails(result.runId);
    assert.ok(details);
    assert.equal(details.run.status, "succeeded");
    assert.equal(details.attempts.length, 2);

    const [att1, att2] = details.attempts;
    assert.equal(att1?.attemptNumber, 1);
    assert.equal(att1?.kind, "initial");
    assert.equal(att1?.status, "failed");
    assert.equal(att1?.classification, "repairable");

    assert.equal(att2?.attemptNumber, 2);
    assert.equal(att2?.kind, "repair");
    assert.equal(att2?.status, "succeeded");

    assertDbMatchesTaskResult(details, result);
  } finally {
    await dbInst.close();
  }
});

test("execution integration: unregistered site fails closed before Codex", async () => {
  const dbInst = await setupMigratedTestDatabase();

  try {
    const repo = await makeTempRepo();
    await assert.rejects(
      async () => {
        await runPersistedSiteTask(
          { ...TASK, siteId: "non-existent-site-id" },
          { repoRoot: repo, isTest: true, databaseUrl: TEST_DATABASE_URL },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "unknown_site");
        return true;
      },
    );
  } finally {
    await dbInst.close();
  }
});
