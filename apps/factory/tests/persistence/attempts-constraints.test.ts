import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { attempts, modelInvocations } from "../../src/persistence/schema.js";

test("attempts & constraints: attempt limit (1..3), unique attempts, and transaction rollback", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    const project = await store.createProject({ key: "p-att", name: "Attempts Project" });
    const site = await store.registerSite({
      projectKey: "p-att",
      key: "s-att",
      name: "Attempts Site",
    });

    const { run, task } = await store.createRunAndTask({
      runId: "run-att-1",
      projectId: project.id,
      siteId: site.id,
      idempotencyKey: "idem-att-1",
      baseCommit: "sha-att-1",
      startedAt: new Date(),
      taskType: "create_page",
      payload: { test: true },
    });

    // 1. Attempts 1, 2, 3 accepted
    const a1 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 1,
      kind: "initial",
      stage: "codex",
      startedAt: new Date(),
    });
    assert.equal(a1.attemptNumber, 1);

    const a2 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 2,
      kind: "repair",
      stage: "codex",
      startedAt: new Date(),
    });
    assert.equal(a2.attemptNumber, 2);

    const a3 = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 3,
      kind: "repair",
      stage: "codex",
      startedAt: new Date(),
    });
    assert.equal(a3.attemptNumber, 3);

    // 2. Attempt 4 must be rejected by PostgreSQL CHECK constraint
    await assert.rejects(
      async () => {
        await store.beginAttempt({
          runId: run.id,
          taskId: task.id,
          attemptNumber: 4,
          kind: "repair",
          stage: "codex",
          startedAt: new Date(),
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return (
          code === "23514" ||
          err.message.includes("attempts_attempt_number_bounds") ||
          err.message.includes("check constraint")
        );
      },
    );

    // 3. Attempt 0 must also be rejected by PostgreSQL CHECK constraint
    await assert.rejects(
      async () => {
        await store.beginAttempt({
          runId: run.id,
          taskId: task.id,
          attemptNumber: 0,
          kind: "repair",
          stage: "codex",
          startedAt: new Date(),
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23514" || err.message.includes("check constraint");
      },
    );

    // 4. Duplicate attempt number (e.g. duplicate attempt 1 on same task) rejected by unique constraint
    await assert.rejects(
      async () => {
        await store.beginAttempt({
          runId: run.id,
          taskId: task.id,
          attemptNumber: 1,
          kind: "initial",
          stage: "codex",
          startedAt: new Date(),
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23505" || err.message.includes("unique");
      },
    );

    // 5. Negative duration/tokens rejected by check constraint
    await assert.rejects(
      async () => {
        await dbInst.db.insert(modelInvocations).values({
          id: "mi-neg",
          runId: run.id,
          taskId: task.id,
          attemptId: a1.id,
          taskKind: "create_page",
          provider: "openai",
          runtime: "codex-cli",
          status: "failed",
          startedAt: new Date(),
          durationMs: -500, // Invalid negative duration
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23514" || err.message.includes("check constraint");
      },
    );

    // 6. Transaction rollback: failure inside transaction rolls back all writes in that transaction
    let attemptIdBeforeRollback = "att-rollback-test";
    await assert.rejects(
      async () => {
        await dbInst.db.transaction(async (tx) => {
          // Write valid attempt in transaction
          await tx.insert(attempts).values({
            id: attemptIdBeforeRollback,
            runId: run.id,
            taskId: task.id,
            attemptNumber: 2, // Will fail because attempt 2 already exists
            kind: "repair",
            stage: "codex",
            status: "running",
            startedAt: new Date(),
          });
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23505";
      },
    );

    // Confirm that attemptIdBeforeRollback does NOT exist
    const [shouldNotExist] = await dbInst.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptIdBeforeRollback));
    assert.equal(shouldNotExist, undefined, "Rolled back transaction must leave no half-written attempt");
  } finally {
    await dbInst.close();
  }
});
