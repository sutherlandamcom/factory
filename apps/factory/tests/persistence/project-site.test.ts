import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { sites } from "../../src/persistence/schema.js";

test("project & site: unique keys, composite constraints, and foreign keys", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);

  try {
    // 1. Create project
    const p1 = await store.createProject({ key: "proj-alpha", name: "Alpha Project" });
    assert.equal(p1.key, "proj-alpha");

    // 2. Duplicate project key must be rejected by PostgreSQL unique constraint
    await assert.rejects(
      async () => {
        await store.createProject({ key: "proj-alpha", name: "Duplicate Alpha" });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23505" || err.message.includes("unique");
      },
    );

    // 3. Register site in project
    const s1 = await store.registerSite({
      projectKey: "proj-alpha",
      key: "starter",
      name: "Starter Site Alpha",
    });
    assert.equal(s1.key, "starter");
    assert.equal(s1.projectId, p1.id);

    // 4. Duplicate site key in same project must be rejected
    await assert.rejects(
      async () => {
        await store.registerSite({
          projectKey: "proj-alpha",
          key: "starter",
          name: "Duplicate Starter",
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23505" || err.message.includes("unique");
      },
    );

    // 5. Same site key in DIFFERENT project is allowed
    const p2 = await store.createProject({ key: "proj-beta", name: "Beta Project" });
    const s2 = await store.registerSite({
      projectKey: "proj-beta",
      key: "starter",
      name: "Starter Site Beta",
    });
    assert.equal(s2.key, "starter");
    assert.equal(s2.projectId, p2.id);

    // 6. Non-existent project rejected by FK
    await assert.rejects(
      async () => {
        await dbInst.db.insert(sites).values({
          id: "site-invalid-fk",
          projectId: "non-existent-project-id",
          key: "orphan",
          name: "Orphan Site",
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23503" || err.message.includes("foreign key");
      },
    );
  } finally {
    await dbInst.close();
  }
});
