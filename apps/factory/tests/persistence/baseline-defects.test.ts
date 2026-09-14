/** Portable regressions: these also execute against the original fa05538 code/schema. */
import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { WriterStore, WriterSnapshotStore } from "../../src/writer/writer-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { acceptedContentGapSnapshots, serpSnapshots, searchRuns } from "../../src/persistence/schema.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";

test("P1-E: newer SERP propagates through accepted gap into Writer", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "before-e");
    await acceptFixturePage(db, seed.projectId, "home");
    const writer = new WriterStore(db.db);
    const [serp] = await db.db.select().from(serpSnapshots).where(eq(serpSnapshots.projectId, seed.projectId));
    const [run] = await db.db.select().from(searchRuns).where(eq(searchRuns.id, serp!.runId));
    await db.db.insert(searchRuns).values({ ...run!, id: "serp-v2-run" });
    await db.db.insert(serpSnapshots).values({ ...serp!, id: "serp-v2", runId: "serp-v2-run", observedAt: new Date(serp!.observedAt.getTime() + 1000) });
    assert.equal((await writer.briefStaleness(seed.projectId, (await writer.latestBrief(seed.projectId))!)).stale, true);
  } finally { await db.close(); }
});

test("P1-F: no-gap accepted copy cannot enter full Design authority", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "before-f");
    await db.db.delete(acceptedContentGapSnapshots).where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));
    await acceptFixturePage(db, seed.projectId, "home", true);
    await assert.rejects(new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId }), /no-gap/);
  } finally { await db.close(); }
});

test("P1-G: a second accepted proposal for one slug creates an immutable version", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "before-g");
    const v1 = await acceptFixturePage(db, seed.projectId, "home");
    const v2 = await acceptFixturePage(db, seed.projectId, "home");
    assert.ok(v2.version > v1.version);
  } finally { await db.close(); }
});

test("P1-I: Intake v2 cannot be combined with content accepted under v1", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "before-i");
    await acceptFixturePage(db, seed.projectId, "home");
    const intake = new ProjectIntakeStore(db.db), draft = (await intake.getDraft(seed.projectId))!;
    const payload = structuredClone(draft.payload) as any;
    payload.business.description += " New scope.";
    const saved = await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload });
    await intake.accept({ projectId: seed.projectId, expectedRevision: saved.revision, expectedDigest: deterministicDigest(payload) });
    await assert.rejects(new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId }), /ProjectInput|project input/);
  } finally { await db.close(); }
});

test("P1-H/J: asset assignment cannot invent a content page", async () => {
  const db = await setupMigratedTestDatabase();
  const { AssetStore } = await import("../../src/assets/asset-store.js");
  const { AssetService } = await import("../../src/assets/service.js");
  const { createAssetStorage } = await import("../../src/assets/storage.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const sharp = (await import("sharp")).default;
  const root = await mkdtemp("/tmp/before-assignment-");
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "before-h");
    const assets = new AssetService({ store: new AssetStore(db.db), storage: createAssetStorage(root) });
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#669988" } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(seed.projectId, { filename: "test.jpg", kind: "photo", title: "Test pixels", rightsStatus: "operator_owned", dataBase64: bytes.toString("base64") });
    const approved = await assets.approveVersion(seed.projectId, upload.version.id, upload.version.binaryDigest);
    await assert.rejects(assets.assignVersion(seed.projectId, { assetId: upload.asset.id, versionId: approved.id, pageSlug: "invented-page", role: "hero", expectedBinaryDigest: approved.binaryDigest,
      acceptedPageContentId: "missing", acceptedPageContentVersion: 1, acceptedPageContentDigest: "a".repeat(64), expectedGovernanceDigest: approved.governanceDigest! }), /page/i);
  } finally { await rm(root, { recursive: true, force: true }); await db.close(); }
});
