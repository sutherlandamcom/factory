import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetService } from "../../src/assets/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import type { AssignmentRow } from "../../src/assets/asset-store.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { FactoryError } from "../../src/executor/errors.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import { assignmentPage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";

/**
 * Run 5 cross-asset CAS replacement acceptance (Run 5 -> Run 7 authority
 * seam). Real PostgreSQL required: every test exercises the single
 * transaction invariant (LOCK assignment -> verify exact expected old
 * authority -> LOCK target version -> verify -> atomic update -> commit).
 *
 * Covered adversarial matrix:
 *  1. cross-asset replacement success (Asset A/v1 -> Asset B/v1);
 *  2. stale expected old version fails;
 *  3. forged expected governance digest fails;
 *  4. wrong expected current asset fails;
 *  5. cross-project target fails;
 *  6. pending/rejected/unknown-rights target fails;
 *  7. same-asset v1 -> v2 still works;
 *  8. concurrent CAS race yields one deterministic winner / typed conflict.
 */

let dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>;

test.before(async () => {
  dbInst = await setupMigratedTestDatabase();
});

test.after(async () => {
  await dbInst.close();
});

async function makeService(): Promise<{ service: AssetService; cleanup: () => Promise<void> }> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-cas-"));
  const storage = createAssetStorage(storageRoot);
  const service = new AssetService({ store: new AssetStore(dbInst.db), storage, repoRoot: storageRoot });
  return { service, cleanup: async () => rm(storageRoot, { recursive: true, force: true }) };
}

async function createProject(key: string): Promise<string> {
  return (await seedProjectWithAcceptedInputs(dbInst, key)).projectId;
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
  filename: "cas-asset.jpg",
  kind: "photo" as const,
  title: "CAS test asset",
  rightsStatus: "operator_owned" as const,
};

interface SeededSlot {
  projectId: string;
  assignment: AssignmentRow;
  assetAVersion: Awaited<ReturnType<AssetService["approveVersion"]>>;
  assetBVersion: Awaited<ReturnType<AssetService["approveVersion"]>>;
  assetBId: string;
}

/** Seed: Asset A/v1 assigned to home/hero, plus a separate approved Asset B/v1. */
async function seedSlot(service: AssetService, key: string): Promise<SeededSlot> {
  const projectId = await createProject(key);
  const uploadA = await service.uploadAsset(projectId, {
    ...UPLOAD,
    title: "Asset A",
    dataBase64: Buffer.from(await jpegBytes(80, 60, 101)).toString("base64"),
  });
  const assetAVersion = await service.approveVersion(projectId, uploadA.version.id, uploadA.version.binaryDigest);
  const assignment = await service.assignVersion(projectId, {
    ...await assignmentPage(dbInst, projectId, "home", assetAVersion.governanceDigest!),
    assetId: uploadA.asset.id,
    versionId: assetAVersion.id,
    pageSlug: "home",
    role: "hero",
    expectedBinaryDigest: assetAVersion.binaryDigest,
  });
  const uploadB = await service.uploadAsset(projectId, {
    ...UPLOAD,
    title: "Asset B",
    dataBase64: Buffer.from(await jpegBytes(80, 60, 102)).toString("base64"),
  });
  const assetBVersion = await service.approveVersion(projectId, uploadB.version.id, uploadB.version.binaryDigest);
  return { projectId, assignment, assetAVersion, assetBVersion, assetBId: uploadB.asset.id };
}

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

test("CAS 1: cross-asset replacement succeeds (Asset A/v1 -> Asset B/v1, same slot)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas1-${Date.now()}`);
    const replaced = await service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
      expectedCurrentAssetId: seeded.assignment.assetId,
      expectedCurrentVersionId: seeded.assignment.versionId,
      expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
      toAssetId: seeded.assetBId,
      toVersionId: seeded.assetBVersion.id,
      expectedTargetBinaryDigest: seeded.assetBVersion.binaryDigest,
    });
    assert.equal(replaced.assetId, seeded.assetBId, "assignment now binds Asset B");
    assert.equal(replaced.versionId, seeded.assetBVersion.id);
    assert.equal(replaced.binaryDigest, seeded.assetBVersion.binaryDigest);
    assert.equal(replaced.versionDigest, seeded.assetBVersion.governanceDigest);
    assert.equal(replaced.pageSlug, "home");
    assert.equal(replaced.role, "hero");
    // Same assignment row identity: the slot moved, it was not recreated.
    assert.equal(replaced.id, seeded.assignment.id);
  } finally {
    await cleanup();
  }
});

test("CAS 2: stale expected old version fails closed", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas2-${Date.now()}`);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: "asv-00000000-0000-0000-0000-000000000000",
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: seeded.assetBId,
          toVersionId: seeded.assetBVersion.id,
          expectedTargetBinaryDigest: seeded.assetBVersion.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_assignment_conflict"),
    );
    // The assignment is untouched.
    const current = await service.getAssignment(seeded.projectId, seeded.assignment.id);
    assert.equal(current!.versionId, seeded.assignment.versionId);
  } finally {
    await cleanup();
  }
});

test("CAS 3: forged expected governance digest fails closed", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas3-${Date.now()}`);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: "f".repeat(64),
          toAssetId: seeded.assetBId,
          toVersionId: seeded.assetBVersion.id,
          expectedTargetBinaryDigest: seeded.assetBVersion.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_assignment_conflict"),
    );
  } finally {
    await cleanup();
  }
});

test("CAS 4: wrong expected current asset fails closed", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas4-${Date.now()}`);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assetBId, // wrong: slot binds Asset A
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: seeded.assetBId,
          toVersionId: seeded.assetBVersion.id,
          expectedTargetBinaryDigest: seeded.assetBVersion.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_assignment_conflict"),
    );
  } finally {
    await cleanup();
  }
});

test("CAS 5: cross-project target fails closed (not found)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas5-${Date.now()}`);
    const otherProject = await createProject(`cas5-other-${Date.now()}`);
    const otherUpload = await service.uploadAsset(otherProject, {
      ...UPLOAD,
      title: "Other project asset",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 103)).toString("base64"),
    });
    const otherApproved = await service.approveVersion(otherProject, otherUpload.version.id, otherUpload.version.binaryDigest);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: otherUpload.asset.id,
          toVersionId: otherApproved.id,
          expectedTargetBinaryDigest: otherApproved.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_not_found"),
    );
  } finally {
    await cleanup();
  }
});

test("CAS 6: pending / rejected / unknown-rights target fails closed", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas6-${Date.now()}`);

    // Pending target.
    const pending = await service.uploadAsset(seeded.projectId, {
      ...UPLOAD,
      title: "Pending target",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 104)).toString("base64"),
    });
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: pending.asset.id,
          toVersionId: pending.version.id,
          expectedTargetBinaryDigest: pending.version.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_rights_blocked"),
    );

    // Rejected target.
    await service.rejectVersion(seeded.projectId, pending.version.id, pending.version.binaryDigest);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: pending.asset.id,
          toVersionId: pending.version.id,
          expectedTargetBinaryDigest: pending.version.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_rights_blocked"),
    );

    // Unknown-rights target (approved but rights unresolved).
    const unknownRights = await service.uploadAsset(seeded.projectId, {
      ...UPLOAD,
      title: "Unknown rights target",
      rightsStatus: "unknown",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 105)).toString("base64"),
    });
    const unknownApproved = await service.approveVersion(seeded.projectId, unknownRights.version.id, unknownRights.version.binaryDigest);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: unknownRights.asset.id,
          toVersionId: unknownApproved.id,
          expectedTargetBinaryDigest: unknownApproved.binaryDigest,
        }),
      (err: unknown) => isCode(err, "asset_rights_blocked"),
    );
  } finally {
    await cleanup();
  }
});

test("CAS 7: same-asset v1 -> v2 still works through the CAS path", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas7-${Date.now()}`);
    const v2Upload = await service.uploadAsset(seeded.projectId, {
      ...UPLOAD,
      title: "Asset A", // same title -> same logical asset
      dataBase64: Buffer.from(await jpegBytes(80, 60, 106)).toString("base64"),
    });
    const v2 = await service.approveVersion(seeded.projectId, v2Upload.version.id, v2Upload.version.binaryDigest);
    assert.equal(v2.assetId, seeded.assignment.assetId, "v2 belongs to the same logical asset");
    const replaced = await service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
      expectedCurrentAssetId: seeded.assignment.assetId,
      expectedCurrentVersionId: seeded.assignment.versionId,
      expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
      toAssetId: seeded.assignment.assetId,
      toVersionId: v2.id,
      expectedTargetBinaryDigest: v2.binaryDigest,
    });
    assert.equal(replaced.assetId, seeded.assignment.assetId);
    assert.equal(replaced.versionId, v2.id);
  } finally {
    await cleanup();
  }
});

test("CAS 8: concurrent CAS race yields one deterministic winner and one typed conflict", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas8-${Date.now()}`);
    // Two competing targets, both approved.
    const uploadC = await service.uploadAsset(seeded.projectId, {
      ...UPLOAD,
      title: "Asset C",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 107)).toString("base64"),
    });
    const assetC = await service.approveVersion(seeded.projectId, uploadC.version.id, uploadC.version.binaryDigest);
    const uploadD = await service.uploadAsset(seeded.projectId, {
      ...UPLOAD,
      title: "Asset D",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 108)).toString("base64"),
    });
    const assetD = await service.approveVersion(seeded.projectId, uploadD.version.id, uploadD.version.binaryDigest);

    const expectedOld = {
      expectedCurrentAssetId: seeded.assignment.assetId,
      expectedCurrentVersionId: seeded.assignment.versionId,
      expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
    };
    const results = await Promise.allSettled([
      service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
        ...expectedOld,
        toAssetId: uploadC.asset.id,
        toVersionId: assetC.id,
        expectedTargetBinaryDigest: assetC.binaryDigest,
      }),
      service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
        ...expectedOld,
        toAssetId: uploadD.asset.id,
        toVersionId: assetD.id,
        expectedTargetBinaryDigest: assetD.binaryDigest,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one CAS winner");
    assert.equal(rejected.length, 1, "the loser is rejected");
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(isCode(reason, "asset_assignment_conflict"), "typed CAS conflict, not a raw 500");
    // The winner's state is exactly what it claimed: the final row matches
    // the winning transition (deterministic outcome, never mixed).
    const winner = (fulfilled[0] as PromiseFulfilledResult<AssignmentRow>).value;
    const current = await service.getAssignment(seeded.projectId, seeded.assignment.id);
    assert.equal(current!.versionId, winner.versionId);
    assert.equal(current!.assetId, winner.assetId);
    assert.equal(current!.versionDigest, winner.versionDigest);
  } finally {
    await cleanup();
  }
});

test("CAS 9: wrong expected target binary digest fails closed (target authority)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const seeded = await seedSlot(service, `cas9-${Date.now()}`);
    await assert.rejects(
      () =>
        service.casReplaceAssignment(seeded.projectId, seeded.assignment.id, {
          expectedCurrentAssetId: seeded.assignment.assetId,
          expectedCurrentVersionId: seeded.assignment.versionId,
          expectedCurrentGovernanceDigest: seeded.assignment.versionDigest,
          toAssetId: seeded.assetBId,
          toVersionId: seeded.assetBVersion.id,
          expectedTargetBinaryDigest: "e".repeat(64),
        }),
      (err: unknown) => isCode(err, "asset_approval_failed"),
    );
  } finally {
    await cleanup();
  }
});
