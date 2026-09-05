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

test("intake: digest depends on content, not key insertion order", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-order", name: "Order" });
    const a = buildIntakePayload();
    const b = buildIntakePayload();
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

test("intake: saveDraft stale-then-fresh revision flow", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const p = await store.createProject({ key: "ip-chain", name: "Chain" });
    const payload = buildIntakePayload();
    const s1 = await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload });
    await assert.rejects(
      () => intake.saveDraft({ projectId: p.id, baseRevision: 0, payload: payload }),
      (e: any) => e.code === "intake_stale_revision",
    );
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
    const before = deterministicDigest(snap.payload);
    assert.throws(() => {
      (snap.payload as any).business.name = "Tampered";
    }, TypeError, "frozen object must throw on mutation");
    const after = deterministicDigest(snap.payload);
    assert.equal(before, after, "snapshot payload must not be mutable");
  } finally { await dbInst.close(); }
});
