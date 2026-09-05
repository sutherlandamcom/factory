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

test("intake: digest depends on content, not key insertion order", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-order", name: "Order" });
    const a = buildIntakePayload();
    const b = buildIntakePayload();
    // Re-insert keys in reverse order at top level.
    const reordered: any = {};
    for (const k of Object.keys(a).reverse()) reordered[k] = (a as any)[k];
    const d1 = deterministicDigest(a);
    const d2 = deterministicDigest(reordered);
    assert.equal(d1, d2, "digest must be independent of key insertion order");

    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: reordered });
    const draft = await intake.getDraft(p.id);
    assert.equal(draft?.digest, d1, "stored digest must equal digest of logically-equal payload");
    assert.equal(draft?.digest, d2);
  } finally { await dbInst.close(); }
});

test("intake: duplicate acceptance returns alreadyAccepted snapshot (idempotent)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-idem2", name: "Idem2" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload });
    const digest = deterministicDigest(payload);
    const first = await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: digest });
    const second = await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: digest });
    assert.equal(second.alreadyAccepted, true, "second accept must be flagged as already accepted");
    assert.equal(second.id, first.id);
    assert.equal(second.version, first.version);
    const history = await intake.listSnapshots(p.id);
    assert.equal(history.length, 1);
  } finally { await dbInst.close(); }
});

test("intake: saveDraft with wrong expected digest chain still computes own digest", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-chain", name: "Chain" });
    const payload = buildIntakePayload();
    const s1 = await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload });
    // Tamper: a save from baseRevision 0 must now fail even with a fresh payload digest
    await assert.rejects(
      () => intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload }),
      (e: any) => e.code === "intake_stale_revision",
    );
    // and a save from revision 1 succeeds
    const s2 = await intake.saveDraft({ projectId: p.id, baseRevision: 1, payload: payload });
    assert.equal(s2.revision, 2);
    assert.equal(s2.digest, s1.digest, "identical payload yields identical digest");
  } finally { await dbInst.close(); }
});

test("intake: snapshot payload is deep-frozen (immutability enforced)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-frozen", name: "Frozen" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload });
    const snap = await intake.accept({
      projectId: p.id,
      expectedRevision: 1,
      expectedDigest: deterministicDigest(payload),
    });
    // Attempt to mutate the returned snapshot payload
    const before = deterministicDigest(snap.payload);
    assert.throws(() => {
      (snap.payload as any).business.name = "Tampered";
    }, TypeError, "frozen object must throw on mutation");
    const after = deterministicDigest(snap.payload);
    assert.equal(before, after, "snapshot payload must not be mutable");
  } finally { await dbInst.close(); }
});

test("intake: forged digest is rejected with intake_digest_mismatch and creates no snapshot", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-mismatch-d", name: "MismatchD" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    const realDigest = deterministicDigest(payload);
    const forgedDigest = "0".repeat(64);

    // 1. current draft revision 1 + forged digest -> rejected with intake_digest_mismatch
    await assert.rejects(
      () => intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: forgedDigest }),
      (e: any) => e.code === "intake_digest_mismatch",
    );

    // 3. failure creates NO snapshot
    const snapshotsAfterFail = await intake.listSnapshots(p.id);
    assert.equal(snapshotsAfterFail.length, 0, "mismatch must create no snapshot");

    // 4. valid current revision + valid current digest still accepts normally
    const accepted = await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: realDigest });
    assert.equal(accepted.version, 1);
    assert.equal(accepted.digest, realDigest);

    const snapshotsAfterOk = await intake.listSnapshots(p.id);
    assert.equal(snapshotsAfterOk.length, 1);
  } finally {
    await dbInst.close();
  }
});

test("intake: stale acceptance revision is rejected with intake_revision_mismatch and creates no snapshot", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-mismatch-r", name: "MismatchR" });
    const pay1 = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: pay1 });
    const digest1 = deterministicDigest(pay1);

    // Draft advances to revision 2
    const pay2 = buildIntakePayload({ business: { name: "Advance Co" } });
    await intake.saveDraft({ projectId: p.id, baseRevision: 1, payload: pay2 });
    const digest2 = deterministicDigest(pay2);

    // 2. current draft at revision 2 + caller attempts accept revision 1
    await assert.rejects(
      () => intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: digest1 }),
      (e: any) => e.code === "intake_revision_mismatch",
    );

    // 3. failure creates NO snapshot
    const snapshotsAfterFail = await intake.listSnapshots(p.id);
    assert.equal(snapshotsAfterFail.length, 0, "revision mismatch must create no snapshot");

    // 4. valid current revision (2) + valid current digest (digest2) accepts normally
    const accepted = await intake.accept({ projectId: p.id, expectedRevision: 2, expectedDigest: digest2 });
    assert.equal(accepted.version, 1);
    assert.equal(accepted.digest, digest2);
    assert.equal(accepted.sourceRevision, 2);

    const snapshotsAfterOk = await intake.listSnapshots(p.id);
    assert.equal(snapshotsAfterOk.length, 1);
  } finally {
    await dbInst.close();
  }
});

test("intake: server authoritative recomputation detects payload/digest tampering", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-tamper", name: "Tamper" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });

    // Directly tamper the stored draft record's digest column to a forged value
    const { projectInputDrafts } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    const forged = "f".repeat(64);
    await dbInst.db.update(projectInputDrafts).set({ digest: forged }).where(eq(projectInputDrafts.projectId, p.id));

    // Even if caller supplies the forged digest that matches the corrupted column,
    // server recomputes digest from payload and rejects with intake_digest_mismatch
    await assert.rejects(
      () => intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: forged }),
      (e: any) => e.code === "intake_digest_mismatch",
    );

    const snapshots = await intake.listSnapshots(p.id);
    assert.equal(snapshots.length, 0, "tampered payload/digest must not create snapshot");
  } finally {
    await dbInst.close();
  }
});
