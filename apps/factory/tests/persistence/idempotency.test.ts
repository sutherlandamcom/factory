import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore, computeIdempotencyKey } from "../../src/persistence/store.js";

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

    const taskPayload = {
      type: "create_page",
      siteId: "s-idem",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "Roof Repair",
        description: "Expert roof repair",
        sections: ["hero", "content", "cta"],
      },
    };

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

    // Exactly one must be new (isExisting: false) and one must be existing (isExisting: true)
    const newCount = (resA.isExisting ? 0 : 1) + (resB.isExisting ? 0 : 1);
    const existingCount = (resA.isExisting ? 1 : 0) + (resB.isExisting ? 1 : 0);

    assert.equal(newCount, 1, "Exactly one concurrent call creates the run");
    assert.equal(existingCount, 1, "Exactly one concurrent call discovers existing run");
    assert.equal(resA.run.id, resB.run.id, "Both concurrent calls resolve to the same run ID");
  } finally {
    await dbInst.close();
  }
});
