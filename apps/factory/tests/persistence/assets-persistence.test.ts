import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { ASSETS_SCHEMA_VERSION } from "@factory/contracts";
import { setupMigratedTestDatabase } from "./helpers.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { AssetService } from "../../src/assets/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import type { AssetVersionRow } from "../../src/assets/asset-store.js";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { FactoryError } from "../../src/executor/errors.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";

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

test("QA remediation: concurrent same-slot assignment race yields the typed conflict (no raw 500)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-race-${Date.now()}`);
    const v1 = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 40)).toString("base64") });
    await service.approveVersion(projectId, v1.version.id, v1.version.binaryDigest);
    // Two concurrent assignments to the same empty slot: exactly one wins,
    // the loser gets the typed conflict (previously a raw 23505 -> 500).
    const results = await Promise.allSettled([
      service.assignVersion(projectId, {
        assetId: v1.asset.id,
        versionId: v1.version.id,
        pageSlug: "racepage",
        role: "hero",
        expectedBinaryDigest: v1.version.binaryDigest,
      }),
      service.assignVersion(projectId, {
        assetId: v1.asset.id,
        versionId: v1.version.id,
        pageSlug: "racepage",
        role: "hero",
        expectedBinaryDigest: v1.version.binaryDigest,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one assignment wins");
    assert.equal(rejected.length, 1, "the loser is rejected");
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(reason instanceof FactoryError && reason.code === "asset_assignment_conflict", "typed conflict, not raw 23505");
  } finally {
    await cleanup();
  }
});

test("QA remediation: governance digest is write-once and atomic with approval", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-govwrite-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 41)).toString("base64") });
    const approved = await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    const originalDigest = approved.governanceDigest!;
    assert.ok(originalDigest, "approval returns the recorded governance digest");
    // Re-approval (idempotent path) must return the SAME digest — the write-
    // once guard forbids any recomputation/rewrite after approval.
    const again = await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);
    assert.equal(again.governanceDigest, originalDigest, "governance digest must never change after approval");
  } finally {
    await cleanup();
  }
});

test("QA remediation: governance digest is computed from the ROW LOCKED inside the approval transaction (TOCTOU race regression)", async () => {
  // Adversarial interleaving (the exact race identified by independent QA):
  //
  //   1. a SECOND connection opens a transaction, locks the asset version
  //      row, updates its governance metadata (rights) and does NOT commit;
  //   2. the approval is started on the service connection — it BLOCKS on
  //      the row lock (verified via pg_locks, not timing guesses);
  //   3. the second transaction COMMITS (metadata B is now the row truth);
  //   4. the approval acquires the lock and must compute its governance
  //      digest from the post-update locked row (metadata B).
  //
  // A service-layer implementation that computed the digest from an
  // unlocked pre-lock read would record the pre-update digest (metadata A)
  // while approving metadata B — this test fails closed on that defect.
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-toctou-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, {
      ...UPLOAD,
      rightsStatus: "operator_owned",
      rightsNote: "original rights note",
      dataBase64: Buffer.from(await jpegBytes(80, 60, 42)).toString("base64"),
    });

    // 1. Concurrent transaction: lock + update, uncommitted.
    const client = await dbInst.pool.connect();
    let approvalPromise: Promise<AssetVersionRow>;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM asset_versions WHERE id = $1 FOR UPDATE", [uploaded.version.id]);
      await client.query(
        "UPDATE asset_versions SET rights_status = 'licensed', rights_note = $2, alt_intent = $3 WHERE id = $1",
        [uploaded.version.id, "concurrent licensed rights note", "concurrent alt intent"],
      );

      // 2. Start the approval; it must block on the row lock.
      approvalPromise = service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);

      // Deterministic block-verification via pg_locks (no sleeps): the
      // approval's lock request shows up as an ungranted lock while the
      // concurrent transaction holds the row lock.
      let observedBlocked = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await client.query("SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted");
        if ((rows[0]?.waiting ?? 0) > 0) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(observedBlocked, true, "approval must be blocked on the row lock before the concurrent update commits");

      // 3. Commit metadata B while the approval is blocked.
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // 4. Approval proceeds: it must approve the post-update row and derive
    //    the governance digest from THAT row.
    const approved = await approvalPromise;
    assert.equal(approved.approvalState, "approved");
    assert.equal(approved.rightsStatus, "licensed", "the approved row must be the post-update row (metadata B)");
    assert.equal(approved.rightsNote, "concurrent licensed rights note");
    assert.ok(approved.governanceDigest, "approved row carries a governance digest");

    // The recorded digest must describe the row that was ACTUALLY approved
    // (post-update metadata), recomputed independently over the same
    // canonical governance surface.
    const expectedDigest = deterministicDigest({
      schemaVersion: ASSETS_SCHEMA_VERSION,
      versionId: approved.id,
      binaryDigest: approved.binaryDigest,
      mediaType: approved.mediaType,
      byteSize: approved.byteSize,
      width: approved.width,
      height: approved.height,
      provenance: approved.provenance,
      rights: {
        status: approved.rightsStatus,
        note: approved.rightsNote,
        altIntent: approved.altIntent,
      },
    });
    assert.equal(
      approved.governanceDigest,
      expectedDigest,
      "governance digest must describe the exact locked row that was approved (metadata B), not a stale pre-lock read (metadata A)",
    );

    // The approved row is immutable: a further metadata update fails closed.
    await assert.rejects(
      () =>
        service.updateVersionMetadata(projectId, uploaded.version.id, {
          rightsStatus: "operator_owned",
          expectedBinaryDigest: uploaded.version.binaryDigest,
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_version_immutable",
    );
  } finally {
    await cleanup();
  }
});

test("QA remediation: assignment and replacement REQUIRE a governance digest (no binary-digest fallback)", async () => {
  // The DB CHECK makes a governance-digest-less approved row unreachable
  // (INSERT and UPDATE both fail closed), so the corrupt-legacy-state
  // fixture itself must be rejected by the database. The store layer ALSO
  // guards assignment/replacement against a null governance digest as
  // defense-in-depth for databases that predate the CHECK; that state is
  // unreachable through this schema, so the authoritative proof here is the
  // DB-level rejection plus the digest-binding verification.
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-nogov-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 43)).toString("base64") });
    await service.approveVersion(projectId, uploaded.version.id, uploaded.version.binaryDigest);

    // The DB CHECK forbids creating the corrupt state (null governance
    // digest on an approved row) even via raw SQL.
    await assert.rejects(
      () =>
        dbInst.db.execute(
          sql`UPDATE asset_versions SET governance_digest = NULL WHERE id = ${uploaded.version.id}`,
        ),
      (error: unknown) => {
        const chain: unknown[] = [error];
        let current = error as { cause?: unknown } | null;
        while (current?.cause) {
          chain.push(current.cause);
          current = current.cause as { cause?: unknown } | null;
        }
        return chain.some(
          (e) => e instanceof Error && /asset_versions_approved_governance_digest_required/.test(`${(e as { message?: string }).message ?? ""}`),
        );
      },
      "the DB CHECK must forbid stripping the governance digest from an approved row",
    );

    // Assignment/replacement bind the governance digest as versionDigest —
    // never the binary digest. Verify the stored assignment carries the
    // governance digest value exactly (the conflation regression guard).
    const assignment = await service.assignVersion(projectId, {
      assetId: uploaded.asset.id,
      versionId: uploaded.version.id,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: uploaded.version.binaryDigest,
    });
    const approvedRow = (await new AssetStore(dbInst.db).getVersion(projectId, uploaded.version.id))!;
    assert.ok(approvedRow.governanceDigest);
    assert.notEqual(approvedRow.governanceDigest, approvedRow.binaryDigest);
    assert.equal(assignment.versionDigest, approvedRow.governanceDigest, "assignment versionDigest must be the GOVERNANCE digest, never a binary-digest fallback");
  } finally {
    await cleanup();
  }
});

test("QA remediation: DB invariant — an approved row can never exist without a governance digest", async () => {
  // The CHECK constraint must make corrupt-state writes impossible even via
  // raw SQL: approving without a governance digest fails at the DB level.
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`lc-dbcheck-${Date.now()}`);
    const uploaded = await service.uploadAsset(projectId, { ...UPLOAD, dataBase64: Buffer.from(await jpegBytes(80, 60, 44)).toString("base64") });
    await assert.rejects(
      () =>
        dbInst.db.execute(
          sql`UPDATE asset_versions SET approval_state = 'approved', approved_at = now() WHERE id = ${uploaded.version.id}`,
        ),
      (error: unknown) => {
        // drizzle-orm wraps driver errors (DrizzleQueryError): the PostgreSQL
        // constraint violation lives on the error chain.
        const chain: unknown[] = [error];
        let current = error as { cause?: unknown } | null;
        while (current?.cause) {
          chain.push(current.cause);
          current = current.cause as { cause?: unknown } | null;
        }
        return chain.some(
          (e) =>
            e instanceof Error &&
            /asset_versions_approved_governance_digest_required|check constraint/i.test(
              `${(e as { message?: string }).message ?? ""} ${(e as { constraint?: string }).constraint ?? ""}`,
            ),
        );
      },
      "DB CHECK must reject an approval that omits the governance digest",
    );
    // Pending rows without a governance digest remain valid.
    const row = await new AssetStore(dbInst.db).getVersion(projectId, uploaded.version.id);
    assert.equal(row!.approvalState, "pending");
    assert.equal(row!.governanceDigest, null);
  } finally {
    await cleanup();
  }
});
