import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";

test("intake: draft revision increment and stale rejection", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip1", name: "P1" });
    const s1 = await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: buildIntakePayload() });
    assert.equal(s1.revision, 1);
    await assert.rejects(() => intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: buildIntakePayload() }),
      (e: any) => e.code === "intake_stale_revision");
  } finally { await dbInst.close(); }
});

test("intake: accept v1 -> edit -> accept v2, v1 immutable", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip2", name: "P2" });
    const pay1 = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: pay1 });
    const v1 = await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(pay1) });
    assert.equal(v1.version, 1);

    const pay2 = buildIntakePayload({ business: { name: "Acme Roofing", description: "Changed." } });
    await intake.saveDraft({ projectId: p.id, baseRevision: 1, payload: pay2 });
    const v2 = await intake.accept({ projectId: p.id, expectedRevision: 2, expectedDigest: deterministicDigest(pay2) });
    assert.equal(v2.version, 2);

    const old1 = await intake.getSnapshot(p.id, 1);
    assert.equal(old1?.digest, v1.digest);
    assert.deepEqual(old1?.payload, pay1);
    assert.equal((await intake.listSnapshots(p.id)).length, 2);
  } finally { await dbInst.close(); }
});

test("intake: acceptance of blocked draft fails closed", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip3", name: "P3" });
    const pay = buildIntakePayload({ business: { name: "" } });
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: pay });
    await assert.rejects(() => intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(pay) }),
      (e: any) => e.code === "intake_blocked");
  } finally { await dbInst.close(); }
});
