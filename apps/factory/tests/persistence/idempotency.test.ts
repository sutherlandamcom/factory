import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { taskResultSchema, type SiteTask } from "@factory/contracts";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore, computeIdempotencyKey } from "../../src/persistence/store.js";
import { runPersistedSiteTask } from "../../src/persistence/driver.js";
import { reconstructTaskResultFromPersistence } from "../../src/persistence/reconstruct.js";
import type { CodexRunRequest, CodexRunResult } from "../../src/executor/codex.js";
import { makeTempRepo } from "../helpers.js";

const TASK: SiteTask = {
  type: "create_page",
  siteId: "s-idem",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Expert roof repair",
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

test("idempotency: sequential and concurrent idempotency deduplication", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-idem", name: "Idem Project" });
    const site = await store.registerSite({
      projectKey: "p-idem",
      key: "s-idem",
      name: "Idem Site",
    });

    const taskPayload = TASK;
    const idempotencyKey = computeIdempotencyKey("s-idem", taskPayload, "commit-sha-12345");

    // 1. First create succeeds
    const first = await store.createRunAndTask({
      runId: "run-idem-1",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey,
      baseCommit: "commit-sha-12345",
      startedAt: new Date(),
      taskType: "create_page",
      payload: taskPayload,
    });

    assert.equal(first.isExisting, false);
    assert.equal(first.run.id, "run-idem-1");

    // 2. Sequential duplicate create returns existing run
    const second = await store.createRunAndTask({
      runId: "run-idem-2",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey,
      baseCommit: "commit-sha-12345",
      startedAt: new Date(),
      taskType: "create_page",
      payload: taskPayload,
    });

    assert.equal(second.isExisting, true);
    assert.equal(second.run.id, "run-idem-1"); // References first run

    // 3. Concurrent race condition with new unique idempotency key
    const concurrentKey = computeIdempotencyKey("s-idem", taskPayload, "commit-sha-concurrent");

    const [resA, resB] = await Promise.all([
      store.createRunAndTask({
        runId: "run-concurrent-a",
        projectId: project.id,
        siteId: site.id,
        idempotencyKey: concurrentKey,
        baseCommit: "commit-sha-concurrent",
        startedAt: new Date(),
        taskType: "create_page",
        payload: taskPayload,
      }),
      store.createRunAndTask({
        runId: "run-concurrent-b",
        projectId: project.id,
        siteId: site.id,
        idempotencyKey: concurrentKey,
        baseCommit: "commit-sha-concurrent",
        startedAt: new Date(),
        taskType: "create_page",
        payload: taskPayload,
      }),
    ]);

    const newCount = (resA.isExisting ? 0 : 1) + (resB.isExisting ? 0 : 1);
    const existingCount = (resA.isExisting ? 1 : 0) + (resB.isExisting ? 1 : 0);

    assert.equal(newCount, 1, "Exactly one concurrent call creates the run");
    assert.equal(existingCount, 1, "Exactly one concurrent call discovers existing run");
    assert.equal(resA.run.id, resB.run.id, "Both concurrent calls resolve to the same run ID");
  } finally {
    await dbInst.close();
  }
});

test("idempotency fallback: missing artifact reconstructs accurate multi-attempt TaskResult from DB", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    await store.createProject({ key: "p-idem-multi", name: "Multi Project" });
    await store.registerSite({
      projectKey: "p-idem-multi",
      key: "s-idem",
      name: "Idem Site Multi",
    });

    const repo = await makeTempRepo();
    let codexInvocationCount = 0;

    // 1. Initial execution: Attempt 1 fails QA -> Attempt 2 succeeds
    const initialResult = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async (req) => {
        codexInvocationCount++;
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
        await writeFile(page, `---\n---\n<h1>Roof Repair Attempt ${codexInvocationCount}</h1>\n`);
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: async () => {
        if (codexInvocationCount === 1) {
          return { passed: false, exitCode: 1, timedOut: false, failureGate: "dynamic" };
        }
        return { passed: true, exitCode: 0, timedOut: false };
      },
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(initialResult.status, "succeeded");
    assert.equal(initialResult.totalAttempts, 2);
    assert.equal(initialResult.successfulAttempt, 2);
    assert.equal(codexInvocationCount, 2);

    // 2. Delete task-result.json artifact file to simulate missing artifact
    const runDir = path.join(repo, ".factory", "runs", initialResult.runId);
    const taskResultFile = path.join(runDir, "task-result.json");
    await rm(taskResultFile, { force: true });

    // 3. Repeat identical execution: must NOT run Codex and must reconstruct accurate 2-attempt history
    const reconstructedResult = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async () => {
        throw new Error("Codex must NOT be re-executed for terminal idempotent run");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(reconstructedResult.runId, initialResult.runId);
    assert.equal(reconstructedResult.status, "succeeded");
    assert.equal(reconstructedResult.totalAttempts, 2);
    assert.equal(reconstructedResult.successfulAttempt, 2);
    assert.equal(reconstructedResult.attempts?.length, 2);

    const [att1, att2] = reconstructedResult.attempts!;
    assert.equal(att1?.attemptNumber, 1);
    assert.equal(att1?.kind, "initial");
    assert.equal(att1?.classification, "repairable");

    assert.equal(att2?.attemptNumber, 2);
    assert.equal(att2?.kind, "repair");

    // 4. Validate reconstructed result against Zod contract
    taskResultSchema.parse(reconstructedResult);
  } finally {
    await dbInst.close();
  }
});

test("idempotency fallback: malformed, invalid, or contradicting artifact yields to DB truth", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    await store.createProject({ key: "p-idem-corrupt", name: "Corrupt Project" });
    await store.registerSite({
      projectKey: "p-idem-corrupt",
      key: "s-idem",
      name: "Idem Site Corrupt",
    });

    const repo = await makeTempRepo();
    let codexInvocationCount = 0;

    const initialResult = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async (req) => {
        codexInvocationCount++;
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
        await writeFile(page, `---\n---\n<h1>Roof Repair Attempt ${codexInvocationCount}</h1>\n`);
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: async () => {
        if (codexInvocationCount === 1) {
          return { passed: false, exitCode: 1, timedOut: false, failureGate: "dynamic" };
        }
        return { passed: true, exitCode: 0, timedOut: false };
      },
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    const runDir = path.join(repo, ".factory", "runs", initialResult.runId);
    const taskResultFile = path.join(runDir, "task-result.json");

    // Case C: Malformed JSON in artifact
    await writeFile(taskResultFile, "{ this is invalid json !!!", "utf8");
    const resFromMalformed = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromMalformed.status, "succeeded");
    assert.equal(resFromMalformed.totalAttempts, 2);

    // Case D: Schema-invalid JSON in artifact (impossible status / missing required fields)
    await writeFile(taskResultFile, JSON.stringify({ status: "bogus_status", totalAttempts: -5 }), "utf8");
    const resFromSchemaInvalid = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromSchemaInvalid.status, "succeeded");
    assert.equal(resFromSchemaInvalid.totalAttempts, 2);

    // Case E: Stale artifact contradicting DB (claims 1 attempt when DB has 2)
    const staleContradictingArtifact = {
      ...initialResult,
      totalAttempts: 1,
      successfulAttempt: 1,
      attempts: [initialResult.attempts![0]!],
    };
    await writeFile(taskResultFile, JSON.stringify(staleContradictingArtifact), "utf8");
    const resFromContradiction = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromContradiction.totalAttempts, 2, "DB truth (2 attempts) must win over stale artifact (1 attempt)");
  } finally {
    await dbInst.close();
  }
});

test("idempotency fallback: terminal failure run with missing artifact reconstructs failure details", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    await store.createProject({ key: "p-idem-fail", name: "Fail Project" });
    await store.registerSite({
      projectKey: "p-idem-fail",
      key: "s-idem",
      name: "Idem Site Fail",
    });

    const repo = await makeTempRepo();

    // 1. Initial run produces terminal failure (scope violation)
    const failResult = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async (req) => {
        await writeFile(path.join(req.worktreePath, "package.json"), '{"hacked":true}');
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(failResult.status, "failed");
    assert.equal(failResult.error?.code, "scope_violation");

    // 2. Delete task-result.json artifact
    const runDir = path.join(repo, ".factory", "runs", failResult.runId);
    await rm(path.join(runDir, "task-result.json"), { force: true });

    // 3. Repeat execution: reconstructs from DB with failure details preserved
    const reconstructed = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      codexRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });

    assert.equal(reconstructed.runId, failResult.runId);
    assert.equal(reconstructed.status, "failed");
    assert.equal(reconstructed.error?.code, "scope_violation");
    assert.equal(reconstructed.totalAttempts, 1);
    assert.equal(reconstructed.attempts?.[0]?.classification, "non_repairable");

    taskResultSchema.parse(reconstructed);
  } finally {
    await dbInst.close();
  }
});
