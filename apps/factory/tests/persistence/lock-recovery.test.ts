import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { acquireControlPlaneLock, withControlPlaneLock } from "../../src/persistence/lock.js";
import { recoverStaleExecutionState } from "../../src/persistence/recovery.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { FactoryError } from "../../src/executor/errors.js";

test("advisory lock: single-writer session lock blocks concurrent writer and releases cleanly", async () => {
  const dbInst = await setupMigratedTestDatabase();

  try {
    // 1. First writer acquires session lock
    const lock1 = await acquireControlPlaneLock(dbInst.pool);

    // 2. Second writer attempting to acquire lock must fail immediately with control_plane_busy
    await assert.rejects(
      async () => {
        await acquireControlPlaneLock(dbInst.pool);
      },
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "control_plane_busy");
        return true;
      },
    );

    // 3. First writer releases lock
    await lock1.release();

    // 4. Second writer can now acquire lock successfully
    const lock2 = await acquireControlPlaneLock(dbInst.pool);
    assert.ok(lock2);
    await lock2.release();
  } finally {
    await dbInst.close();
  }
});

test("recovery: stale running Run/Task/Attempt marked interrupted on restart without auto-attempt-2", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-rec", name: "Recovery Project" });
    const site = await store.registerSite({
      projectKey: "p-rec",
      key: "s-rec",
      name: "Recovery Site",
    });

    // 1. Create Run = running, Task = running
    const { run, task } = await store.createRunAndTask({
      runId: "run-stale-1",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey: "idem-stale-1",
      baseCommit: "sha-stale-1",
      startedAt: new Date(),
      taskType: "create_page",
      payload: { simulatedCrash: true },
    });
    assert.equal(run.status, "running");
    assert.equal(task.status, "running");

    // 2. Create Attempt 1 = running
    const attempt1 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 1,
      kind: "initial",
      stage: "codex",
      startedAt: new Date(),
    });
    assert.equal(attempt1.status, "running");

    // 3. Simulate process crash and restart recovery
    const report = await recoverStaleExecutionState(dbInst.db);
    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.recoveredTasks, 1);
    assert.equal(report.recoveredAttempts, 1);

    // 4. Verify durable database state
    const details = await store.getRunDetails(run.id);
    assert.ok(details);
    assert.equal(details.run.status, "interrupted");
    assert.equal(details.run.errorMessage, "control_plane_restart");
    assert.equal(details.tasks[0]?.status, "interrupted");

    assert.equal(details.attempts.length, 1, "No Attempt 2 must be automatically created");
    assert.equal(details.attempts[0]?.attemptNumber, 1);
    assert.equal(details.attempts[0]?.status, "interrupted");
    assert.equal(details.attempts[0]?.errorMessage, "control_plane_restart");
  } finally {
    await dbInst.close();
  }
});
