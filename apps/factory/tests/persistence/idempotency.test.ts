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
import { FactoryError } from "../../src/executor/errors.js";

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

test("idempotency: explicit caller key is site-scoped, isolates across sites, and dedupes within site", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const p1 = await store.createProject({ key: "p-austin", name: "Austin Project" });
    const s1 = await store.registerSite({
      projectKey: "p-austin",
      key: "roofing-austin",
      name: "Roofing Austin",
    });

    const p2 = await store.createProject({ key: "p-dallas", name: "Dallas Project" });
    const s2 = await store.registerSite({
      projectKey: "p-dallas",
      key: "roofing-dallas",
      name: "Roofing Dallas",
    });

    const callerToken = "launch-001";
    const commit = "abcdef123456";
    const payload = { type: "create_page", page: { slug: "/services/repair" } };

    const key1 = computeIdempotencyKey(s1.key, payload, commit, callerToken);
    const key2 = computeIdempotencyKey(s2.key, payload, commit, callerToken);

    // Assert keys are distinct across sites even with identical caller tokens
    assert.notEqual(key1, key2, "Caller key must be site-scoped and distinct across sites");

    // 1. Create run for Site A with caller key
    const runA = await store.createRunAndTask({
      runId: "run-site-a",
      projectId: p1.id,
      siteId: s1.id,
      idempotencyKey: key1,
      baseCommit: commit,
      startedAt: new Date(),
      taskType: "create_page",
      payload,
    });
    assert.equal(runA.isExisting, false);
    assert.equal(runA.run.siteId, s1.id);

    // 2. Create run for Site B with same caller token
    const runB = await store.createRunAndTask({
      runId: "run-site-b",
      projectId: p2.id,
      siteId: s2.id,
      idempotencyKey: key2,
      baseCommit: commit,
      startedAt: new Date(),
      taskType: "create_page",
      payload,
    });
    assert.equal(runB.isExisting, false);
    assert.equal(runB.run.siteId, s2.id);
    assert.notEqual(runA.run.id, runB.run.id, "Site B must NOT reuse Site A's run");

    // 3. Repeat Site A with same caller token -> dedupes within same site
    const runA2 = await store.createRunAndTask({
      runId: "run-site-a-2",
      projectId: p1.id,
      siteId: s1.id,
      idempotencyKey: key1,
      baseCommit: commit,
      startedAt: new Date(),
      taskType: "create_page",
      payload,
    });
    assert.equal(runA2.isExisting, true);
    assert.equal(runA2.run.id, "run-site-a");
  } finally {
    await dbInst.close();
  }
});

test("idempotency: foreign-run collision fails closed with idempotency_scope_conflict", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const p1 = await store.createProject({ key: "p-foreign-1", name: "P1" });
    const s1 = await store.registerSite({
      projectKey: "p-foreign-1",
      key: "site-alpha",
      name: "Alpha",
    });

    const p2 = await store.createProject({ key: "p-foreign-2", name: "P2" });
    const s2 = await store.registerSite({
      projectKey: "p-foreign-2",
      key: "site-beta",
      name: "Beta",
    });

    const repo = await makeTempRepo();

    // 1. Persist a terminal run under Site Alpha with a fixed idempotency key
    const fixedIdemKey = "shared-collision-key-12345";
    await store.createRunAndTask({
      runId: "run-alpha-owner",
      projectId: p1.id,
      siteId: s1.id,
      idempotencyKey: fixedIdemKey,
      baseCommit: "sha123",
      startedAt: new Date(),
      taskType: "create_page",
      payload: TASK,
    });
    await store.completeRun({
      runId: "run-alpha-owner",
      status: "succeeded",
      finishedAt: new Date(),
    });

    // 2. In createRunAndTask directly, attempting to match fixedIdemKey under Site Beta must throw idempotency_scope_conflict
    await assert.rejects(
      async () => {
        await store.createRunAndTask({
          runId: "run-beta-attempt",
          projectId: p2.id,
          siteId: s2.id,
          idempotencyKey: fixedIdemKey,
          baseCommit: "sha123",
          startedAt: new Date(),
          taskType: "create_page",
          payload: TASK,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "idempotency_scope_conflict");
        return true;
      },
    );

    // 3. In runPersistedSiteTask, inject a collision where a foreign run exists with the key Site Beta computes
    const taskForBeta: SiteTask = {
      ...TASK,
      siteId: "site-beta",
    };

    const pre = await (await import("../../src/executor/preflight.js")).preflight(repo);
    const betaKey = computeIdempotencyKey("site-beta", taskForBeta, pre.baseCommit, "caller-key-beta");

    // Insert foreign run for Site Alpha with betaKey
    await store.createRunAndTask({
      runId: "run-alpha-collision",
      projectId: p1.id,
      siteId: s1.id,
      idempotencyKey: betaKey,
      baseCommit: pre.baseCommit,
      startedAt: new Date(),
      taskType: "create_page",
      payload: taskForBeta,
    });

    let codexCalled = false;
    await assert.rejects(
      async () => {
        await runPersistedSiteTask(taskForBeta, {
          repoRoot: repo,
          isTest: true,
          idempotencyKey: "caller-key-beta",
          primaryRunner: mockCodex(async () => {
            codexCalled = true;
          }),
          prepareDependenciesFn: noopDeps,
          runQaFn: passQa,
          verifyFn: passVerify,
          verifyReplayFn: passReplay,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "idempotency_scope_conflict");
        return true;
      },
    );

    assert.equal(codexCalled, false, "Codex must not be called on foreign run conflict");
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
      primaryRunner: mockCodex(async (req) => {
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
      primaryRunner: mockCodex(async () => {
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
      primaryRunner: mockCodex(async (req) => {
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

    // Case C: Malformed JSON in artifact -> DB truth wins
    await writeFile(taskResultFile, "{ this is invalid json !!!", "utf8");
    const resFromMalformed = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromMalformed.status, "succeeded");
    assert.equal(resFromMalformed.totalAttempts, 2);

    // Case D: Schema-invalid JSON in artifact -> DB truth wins
    await writeFile(taskResultFile, JSON.stringify({ status: "bogus_status", totalAttempts: -5 }), "utf8");
    const resFromSchemaInvalid = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromSchemaInvalid.status, "succeeded");
    assert.equal(resFromSchemaInvalid.totalAttempts, 2);

    // Case E: Stale artifact with wrong attempt count -> DB truth wins
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
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromContradiction.totalAttempts, 2, "DB truth (2 attempts) must win over stale artifact (1 attempt)");

    // Case F: Stale artifact with wrong attempt kind -> DB truth wins
    const staleKindArtifact = {
      ...initialResult,
      attempts: [
        { ...initialResult.attempts![0]!, kind: "repair" }, // Wrong kind on attempt 1
        initialResult.attempts![1]!,
      ],
    };
    await writeFile(taskResultFile, JSON.stringify(staleKindArtifact), "utf8");
    const resFromWrongKind = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromWrongKind.attempts?.[0]?.kind, "initial", "DB truth (initial) must win over artifact (repair)");

    // Case G: Stale artifact with wrong classification -> DB truth wins
    const staleClassArtifact = {
      ...initialResult,
      attempts: [
        { ...initialResult.attempts![0]!, classification: "non_repairable" }, // Wrong classification
        initialResult.attempts![1]!,
      ],
    };
    await writeFile(taskResultFile, JSON.stringify(staleClassArtifact), "utf8");
    const resFromWrongClass = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromWrongClass.attempts?.[0]?.classification, "repairable", "DB truth (repairable) must win over artifact");

    // Case H: Stale artifact with wrong siteId -> DB truth wins
    const staleSiteArtifact = {
      ...initialResult,
      siteId: "foreign-site-id",
    };
    await writeFile(taskResultFile, JSON.stringify(staleSiteArtifact), "utf8");
    const resFromWrongSite = await runPersistedSiteTask(TASK, {
      repoRoot: repo,
      isTest: true,
      primaryRunner: mockCodex(async () => {
        throw new Error("Codex must NOT rerun");
      }),
      prepareDependenciesFn: noopDeps,
      runQaFn: passQa,
      verifyFn: passVerify,
      verifyReplayFn: passReplay,
    });
    assert.equal(resFromWrongSite.siteId, "s-idem", "DB truth (s-idem) must win over wrong artifact siteId");
  } finally {
    await dbInst.close();
  }
});

test("reconstruction consistency: succeeded run without succeeded attempt throws persistence_state_invalid", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-inconsistent", name: "Inconsistent" });
    const site = await store.registerSite({
      projectKey: "p-inconsistent",
      key: "s-inconsistent",
      name: "Inconsistent Site",
    });

    // 1. Create run marked succeeded in DB
    const { run, task } = await store.createRunAndTask({
      runId: "run-inconsistent-1",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey: "idem-inconsistent-1",
      baseCommit: "sha-1",
      startedAt: new Date(),
      taskType: "create_page",
      payload: TASK,
    });

    // 2. Record Attempt 1 with status 'failed'
    const attempt1 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 1,
      kind: "initial",
      stage: "codex",
      startedAt: new Date(),
    });
    await store.completeAttempt({
      attemptId: attempt1.id,
      stage: "codex",
      status: "failed",
      durationMs: 1000,
      classification: "non_repairable",
      finishedAt: new Date(),
    });

    // Mark run succeeded (inconsistent DB state)
    await store.completeRun({
      runId: run.id,
      taskId: task.id,
      status: "succeeded",
      finishedAt: new Date(),
    });

    const details = await store.getRunDetails(run.id);
    assert.ok(details);

    // 3. reconstructTaskResultFromPersistence must reject this inconsistent state
    assert.throws(
      () => {
        reconstructTaskResultFromPersistence(details, "/mock/root");
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "persistence_state_invalid");
        return true;
      },
    );
  } finally {
    await dbInst.close();
  }
});

test("reconstruction consistency: succeeded run with multiple succeeded attempts throws persistence_state_invalid", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-multi-succ", name: "Multi Succ" });
    const site = await store.registerSite({
      projectKey: "p-multi-succ",
      key: "s-multi-succ",
      name: "Multi Succ Site",
    });

    const { run, task } = await store.createRunAndTask({
      runId: "run-multi-succ",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey: "idem-multi-succ",
      baseCommit: "sha-1",
      startedAt: new Date(),
      taskType: "create_page",
      payload: TASK,
    });

    // Attempt 1 succeeded
    const attempt1 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 1,
      kind: "initial",
      stage: "complete",
      startedAt: new Date(),
    });
    await store.completeAttempt({
      attemptId: attempt1.id,
      stage: "complete",
      status: "succeeded",
      durationMs: 1000,
      finishedAt: new Date(),
    });

    // Attempt 2 ALSO succeeded (impossible state)
    const attempt2 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 2,
      kind: "repair",
      stage: "complete",
      startedAt: new Date(),
    });
    await store.completeAttempt({
      attemptId: attempt2.id,
      stage: "complete",
      status: "succeeded",
      durationMs: 1000,
      finishedAt: new Date(),
    });

    await store.completeRun({
      runId: run.id,
      taskId: task.id,
      status: "succeeded",
      finishedAt: new Date(),
    });

    const details = await store.getRunDetails(run.id);
    assert.ok(details);

    assert.throws(
      () => {
        reconstructTaskResultFromPersistence(details, "/mock/root");
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "persistence_state_invalid");
        return true;
      },
    );
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
      primaryRunner: mockCodex(async (req) => {
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
      primaryRunner: mockCodex(async () => {
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
