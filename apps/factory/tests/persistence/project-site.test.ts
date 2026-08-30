import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore, computeIdempotencyKey } from "../../src/persistence/store.js";
import { sites } from "../../src/persistence/schema.js";
import { FactoryError } from "../../src/executor/errors.js";

test("project & site: global site key uniqueness across projects and deterministic resolution", async () => {
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

    // 4. (A) Duplicate site key in same project must be rejected
    await assert.rejects(
      async () => {
        await store.registerSite({
          projectKey: "proj-alpha",
          key: "starter",
          name: "Duplicate Starter Same Project",
        });
      },
      (err: unknown) => {
        if (err instanceof FactoryError) {
          return err.code === "site_already_exists";
        }
        const code = (err as any)?.code ?? (err as any)?.cause?.code;
        return code === "23505" || (err as Error).message.includes("unique");
      },
    );

    // 5. (B) Same site key in DIFFERENT project must ALSO be rejected (global site key uniqueness)
    const p2 = await store.createProject({ key: "proj-beta", name: "Beta Project" });
    await assert.rejects(
      async () => {
        await store.registerSite({
          projectKey: "proj-beta",
          key: "starter",
          name: "Duplicate Starter Across Projects",
        });
      },
      (err: unknown) => {
        if (err instanceof FactoryError) {
          return err.code === "site_already_exists";
        }
        const code = (err as any)?.code ?? (err as any)?.cause?.code;
        return code === "23505" || (err as Error).message.includes("unique");
      },
    );

    // Also verify direct database insert of duplicate key across projects is rejected by PostgreSQL constraint
    await assert.rejects(
      async () => {
        await dbInst.db.insert(sites).values({
          id: "site-direct-dup",
          projectId: p2.id,
          key: "starter",
          name: "Direct Duplicate Key",
        });
      },
      (err: any) => {
        const code = err.code ?? err.cause?.code;
        return code === "23505" || err.message.includes("unique") || err.message.includes("sites_key_unique");
      },
    );

    // 6. (C) Different site keys in different projects are accepted
    const s2 = await store.registerSite({
      projectKey: "proj-beta",
      key: "roofing-dallas",
      name: "Roofing Dallas",
    });
    assert.equal(s2.key, "roofing-dallas");
    assert.equal(s2.projectId, p2.id);

    // 7. (D & E) Deterministic lookup via findSiteByGlobalKey
    const res1 = await store.findSiteByGlobalKey("starter");
    assert.ok(res1);
    assert.equal(res1.site.key, "starter");
    assert.equal(res1.project.key, "proj-alpha");

    const res2 = await store.findSiteByGlobalKey("roofing-dallas");
    assert.ok(res2);
    assert.equal(res2.site.key, "roofing-dallas");
    assert.equal(res2.project.key, "proj-beta");

    const resMissing = await store.findSiteByGlobalKey("non-existent-site");
    assert.equal(resMissing, null);

    // 8. (F) Distinct sites produce distinct idempotency keys for identical task payload and commit
    const taskPayload = { type: "create_page", page: { slug: "/services/roof-repair" } };
    const commit = "abcdef123456";
    const idemKey1 = computeIdempotencyKey("starter", taskPayload, commit);
    const idemKey2 = computeIdempotencyKey("roofing-dallas", taskPayload, commit);
    assert.notEqual(idemKey1, idemKey2, "Idempotency keys for distinct sites must be distinct");

    // 9. Non-existent project rejected by FK
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
