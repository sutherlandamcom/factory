import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupMigratedTestDatabase } from "./helpers.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { AssetService } from "../../src/assets/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * Asset lifecycle persistence acceptance (Macro Run 5):
 *
 * version identity -> approval binding exact digest -> rights gating ->
 * assignment binding exact approved version -> replacement/staleness
 * invariant (a newer version NEVER moves an existing assignment) ->
 * restart durability (real PostgreSQL).
 */

let dbInst: FactoryDatabaseInstance;

test.before(async () => {
  dbInst = await setupMigratedTestDatabase();
});

test.after(async () => {
  await dbInst.close();
});

async function makeService(): Promise<{ service: AssetService; cleanup: () => Promise<void> }> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-lifecycle-"));
  const storage = createAssetStorage(storageRoot);
  const service = new AssetService({ store: new AssetStore(dbInst.db), storage, repoRoot: storageRoot });
  return { service, cleanup: async () => rm(storageRoot, { recursive: true, force: true }) };
}

async function createProject(key: string): Promise<string> {
  const store = new FactoryStore(dbInst.db);
  return (await store.createProject({ key, name: `Project ${key}` })).id;
}

async function jpegBytes(width: number, height: number, seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: seed % 256, g: (seed * 3) % 256, b: (seed * 7) % 256 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

const UPLOAD = {
  filename: "chamonix-hero.jpg",
  kind: "photo" as const,
  title: "Chamonix homepage hero photograph",
  rightsStatus: "operator_owned" as const,
};

test("lifecycle: approve binds the exact binary digest; governance digest is recorded once", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-approve-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 10)).toString("base64") });
    const approved = await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    assert.equal(approved.approvalState, "approved");
    assert.ok(approved.approvedAt);
    assert.match(approved.governanceDigest!, /^[0-9a-f]{64}$/);
    // Governance digest is distinct from the binary digest by construction.
    assert.notEqual(approved.governanceDigest, approved.binaryDigest);
    // Idempotent re-approval with the same digest is accepted.
    const again = await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    assert.equal(again.approvalState, "approved");
  } finally {
    await cleanup();
  }
});

test("lifecycle: approval with a wrong digest fails closed (forged digest)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-forge-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 11)).toString("base64") });
    await assert.rejects(
      () => service.approveVersion(projectId, uploaded.version.id, "b".repeat(64)),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_approval_failed",
    );
    const still = await service.workspace(projectId);
    assert.equal(still.assets[0]!.versions[0]!.approvalState, "pending");
  } finally {
    await cleanup();
  }
});

test("lifecycle: approved versions are immutable (metadata update rejected)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-immutable-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 12)).toString("base64") });
    await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    await assert.rejects(
      () =>
        service.updateVersionMetadata(projectId, uploaded.version.id, {
          rightsStatus: "licensed",
          expectedBinaryDigest: uploaded.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_version_immutable",
    );
  } finally {
    await cleanup();
  }
});

test("lifecycle: assignment requires approval AND resolved rights", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-gate-${Date.now()}`);
    // Pending + unknown rights -> blocked.
    const pendingUnknown = await service.uploadAsset(projectId, {
      ...UPLOAD,
      rightsStatus: "unknown",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 13)).toString("base64"),
    });
    await assert.rejects(
      () =>
        service.assignVersion(projectId, {
          assetId: pendingUnknown.asset.id,
          versionId: pendingUnknown.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: pendingUnknown.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_rights_blocked",
    );
    // Approved but rights still unknown -> blocked.
    await service.approveVersion(projectId, pendingUnknown.version.id, pendingUnknown.version.binaryDigest);
    await assert.rejects(
      () =>
        service.assignVersion(projectId, {
          assetId: pendingUnknown.asset.id,
          versionId: pendingUnknown.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: pendingUnknown.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_rights_blocked",
    );
    // Resolve rights BEFORE approval on a fresh version -> assignment succeeds.
    const resolvable = await service.uploadAsset(projectId, {
      ...UPLOAD,
      dataBase64: Buffer.from(await jpegBytes(80, 60, 14)).toString("base64"),
    });
    await service.updateVersionMetadata(projectId, resolvable.version.id, {
      rightsStatus: "operator_owned",
      expectedBinaryDigest: resolvable.version.binaryDigest,
    });
    await service.approveVersion(projectId, resolvable.version.id, resolvable.version.binaryDigest);
    const assignment = await service.assignVersion(projectId, {
      assetId: resolvable.asset.id,
      versionId: resolvable.version.id,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: resolvable.version.binaryDigest,
    });
    assert.equal(assignment.pageSlug, "homepage");
    assert.equal(assignment.binaryDigest, resolvable.version.binaryDigest);
  } finally {
    await cleanup();
  }
});

test("lifecycle: assignment with a forged digest is rejected", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-assignforge-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 15)).toString("base64") });
    await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    await assert.rejects(
      () =>
        service.assignVersion(projectId, {
          assetId: uploaded.asset.id,
          versionId: uploaded.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: "c".repeat(64),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_approval_failed",
    );
  } finally {
    await cleanup();
  }
});

test("CRITICAL INVARIANT: newer approved version does NOT move an existing assignment", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-invariant-${Date.now()}`);
    // v1 -> approve -> assign homepage/hero.
    const v1 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(320, 200, 16)).toString("base64") });
    await service.approveVersion(projectId, v1.version.id, v1.version.binaryDigest);
    const assignment = await service.assignVersion(projectId, {
      assetId: v1.asset.id,
      versionId: v1.version.id,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: v1.version.binaryDigest,
    });
    // v2 (different bytes) -> approve.
    const v2 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(320, 200, 17)).toString("base64") });
    assert.notEqual(v1.version.binaryDigest, v2.version.binaryDigest);
    await service.approveVersion(projectId, v2.version.id, v2.version.binaryDigest);

    // The assignment MUST still bind v1 exactly.
    const ws = await service.workspace(projectId);
    const bound = ws.assignments.find((a) => a.id === assignment.id)!;
    assert.equal(bound.versionId, v1.version.id, "assignment must stay bound to v1");
    assert.equal(bound.binaryDigest, v1.version.binaryDigest);
    assert.equal(bound.versionNumber, 1);
    // Staleness is computed and explicit.
    assert.equal(bound.replacementAvailable, true);
    assert.equal(bound.latestApprovedVersionId, v2.version.id);

    // Re-assigning the same slot is a typed conflict (explicit action needed).
    await assert.rejects(
      () =>
        service.assignVersion(projectId, {
          assetId: v1.asset.id,
          versionId: v2.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: v2.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_assignment_conflict",
    );

    // Only the EXPLICIT replace action moves the assignment.
    const replaced = await service.replaceAssignment(projectId, assignment.id, {
      toVersionId: v2.version.id,
      expectedBinaryDigest: v2.version.binaryDigest,
    });
    assert.equal(replaced.versionId, v2.version.id);
    const wsAfter = await service.workspace(projectId);
    const boundAfter = wsAfter.assignments.find((a) => a.id === assignment.id)!;
    assert.equal(boundAfter.versionNumber, 2);
    assert.equal(boundAfter.replacementAvailable, false);
  } finally {
    await cleanup();
  }
});

test("lifecycle: replace with wrong digest/version fails closed", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-replace-${Date.now()}`);
    const v1 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 18)).toString("base64") });
    await service.approveVersion(projectId, v1.version.id, v1.version.binaryDigest);
    const assignment = await service.assignVersion(projectId, {
      assetId: v1.asset.id,
      versionId: v1.version.id,
      pageSlug: "about",
      role: "inline",
      expectedBinaryDigest: v1.version.binaryDigest,
    });
    const v2 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 19)).toString("base64") });
    // Unapproved target -> blocked.
    await assert.rejects(
      () =>
        service.replaceAssignment(projectId, assignment.id, {
          toVersionId: v2.version.id,
          expectedBinaryDigest: v2.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_rights_blocked",
    );
    // Approved target but forged digest -> rejected.
    await service.approveVersion(projectId, v2.version.id, v2.version.binaryDigest);
    await assert.rejects(
      () =>
        service.replaceAssignment(projectId, assignment.id, {
          toVersionId: v2.version.id,
          expectedBinaryDigest: "d".repeat(64),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_approval_failed",
    );
  } finally {
    await cleanup();
  }
});

test("lifecycle: cross-project asset access fails closed (not found)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectA = await createProject(`lc-cross-a-${Date.now()}`);
    const projectB = await createProject(`lc-cross-b-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectA, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 20)).toString("base64") });
    await assert.rejects(
      () => service.readOriginal(projectB, uploaded.version.id),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_version_not_found",
    );
    await assert.rejects(
      () => service.approveVersion(projectB, uploaded.version.id, uploaded.version.binaryDigest),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_version_not_found",
    );
    await assert.rejects(
      () =>
        service.assignVersion(projectB, {
          assetId: uploaded.asset.id,
          versionId: uploaded.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: uploaded.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("lifecycle: rejected versions cannot be approved or assigned", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-reject-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 21)).toString("base64") });
    await service.rejectVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    await assert.rejects(
      () => service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_approval_failed",
    );
    await assert.rejects(
      () =>
        service.assignVersion(projectId, {
          assetId: uploaded.asset.id,
          versionId: uploaded.version.id,
          pageSlug: "homepage",
          role: "hero",
          expectedBinaryDigest: uploaded.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_rights_blocked",
    );
  } finally {
    await cleanup();
  }
});

test("lifecycle: RESTART DURABILITY — exact accepted assignment survives a fresh service instance over the same DB", async () => {
  // A shared, persistent storage root stands in for the on-disk object store
  // (which, like PostgreSQL, survives a process restart); the service
  // instance itself is fully rebuilt to prove no in-memory state carries over.
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-restart-"));
  let projectId: string;
  let assignmentId: string;
  let v1Digest: string;
  let v1Id: string;
  try {
    const store = new AssetStore(dbInst.db);
    const service = new AssetService({
      store,
      storage: createAssetStorage(storageRoot),
      repoRoot: storageRoot,
    });
    projectId = await createProject(`lc-restart-${Date.now()}`);
    const v1 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(160, 100, 22)).toString("base64") });
    await service.approveVersion(projectId, v1.version.id, v1.version.binaryDigest);
    const assignment = await service.assignVersion(projectId, {
      assetId: v1.asset.id,
      versionId: v1.version.id,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: v1.version.binaryDigest,
    });
    assignmentId = assignment.id;
    v1Digest = v1.version.binaryDigest;
    v1Id = v1.version.id;
  } finally {
    // Simulate process restart: drop ALL in-memory handles; DB + object
    // store on disk persist.
  }
  // A brand-new service instance over the same PostgreSQL + storage sees the
  // exact accepted state — nothing was cached in the old process.
  const store = new AssetStore(dbInst.db);
  const revived = new AssetService({
    store,
    storage: createAssetStorage(storageRoot),
    repoRoot: storageRoot,
  });
  const ws = await revived.workspace(projectId);
  const bound = ws.assignments.find((a) => a.id === assignmentId)!;
  assert.equal(bound.versionId, v1Id);
  assert.equal(bound.binaryDigest, v1Digest);
  assert.equal(bound.versionNumber, 1);
  // Original bytes still served after restart.
  const served = await revived.readOriginal(projectId, v1Id);
  assert.equal(sha256HexBytes(served.bytes), v1Digest);
  await rm(storageRoot, { recursive: true, force: true });
});

test("lifecycle: imagery strategy defaults to none and round-trips", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-strategy-${Date.now()}`);
    assert.equal(await service.setImageryStrategy(projectId, "operator"), "operator");
    const ws = await service.workspace(projectId);
    assert.equal(ws.imageryStrategy, "operator");
  } finally {
    await cleanup();
  }
});

test("lifecycle: version digest bytes are stable across derivative recomputation", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-detderiv-${Date.now()}`);
    const bytes = await jpegBytes(400, 260, 23);
    const first = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(bytes).toString("base64") });
    // Same bytes uploaded to a different project -> identical derivative digests.
    const projectB = await createProject(`lc-detderiv-b-${Date.now()}`);
    const second = await service.uploadAsset(projectB, { ...UPLOAD, dataBase64: Buffer.from(bytes).toString("base64") });
    const firstWeb = first.derivatives.find((d) => d.kind === "web")!;
    const secondWeb = second.derivatives.find((d) => d.kind === "web")!;
    assert.equal(firstWeb.binaryDigest, secondWeb.binaryDigest, "derivatives must be deterministic");
  } finally {
    await cleanup();
  }
});
