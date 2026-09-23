import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  type VisualProviderRequest,
  type VisualProviderResult,
  type VisualAssetProvider,
  type VisualAssetProviderPreflight,
} from "@factory/contracts";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { DesignService } from "../../src/design/service.js";
import { FixtureDesignProvider } from "../../src/design/fixture-provider.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import { AssetService } from "../../src/assets/service.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { VisualStore } from "../../src/visual/store.js";
import { VisualService } from "../../src/visual/service.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { createVisualCandidateStorage } from "../../src/visual/candidate-storage.js";
import { setupMigratedTestDatabase, createTestDatabase } from "../persistence/helpers.js";
import { assignmentPage, acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";
import {
  acceptedVisualAssetSets,
  acceptedVisualAssetSlots,
  assetPageAssignments,
  assetVersions,
  visualAssetCandidates,
  visualAssetPlans,
  visualSlotResolutions,
} from "../../src/persistence/schema.js";

let dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>> | null = null;
let storageRoot: string | null = null;

async function createHarness(customDb?: any) {
  const dbHandle = customDb ?? (dbInst = dbInst ?? (await setupMigratedTestDatabase()));
  storageRoot = storageRoot ?? (await mkdtemp(`${tmpdir()}/remediation-p1p2-`));

  const store = new FactoryStore(dbHandle.db);
  const intake = new ProjectIntakeStore(dbHandle.db);
  const designStore = new DesignStore(dbHandle.db);
  const design = await DesignService.create({ store: designStore, provider: new FixtureDesignProvider() });
  const assets = new AssetService({
    store: new AssetStore(dbHandle.db),
    storage: createAssetStorage(storageRoot),
  });
  const visualStore = new VisualStore(dbHandle.db);
  const budget = new VisualBudgetStore(dbHandle.db);

  const provider: VisualAssetProvider = {
    id: "google-genai",
    providerMode: "fixture",
    async preflight(): Promise<VisualAssetProviderPreflight> {
      return { configured: true, provider: "google-genai", reachable: true, configuredModels: ["fixture"] };
    },
    async generateImage(req: VisualProviderRequest): Promise<VisualProviderResult> {
      const bytes = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .png()
        .toBuffer();
      return {
        candidates: [{ bytes: new Uint8Array(bytes), mediaType: "image/png", index: 0 }],
        providerRequestRef: `fixture-${req.requestDigest.slice(0, 16)}`,
        providerUsage: { fixture: true, model: "fixture" },
      };
    },
    async editImage(): Promise<VisualProviderResult> {
      const bytes = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: { r: 50, g: 60, b: 70 } },
      })
        .png()
        .toBuffer();
      return {
        candidates: [{ bytes: new Uint8Array(bytes), mediaType: "image/png", index: 0 }],
        providerRequestRef: `fixture-edit-${Date.now()}`,
        providerUsage: { fixture: true, model: "fixture" },
      };
    },
  };

  const visual = new VisualService({
    store: visualStore,
    designStore,
    designService: design,
    assets,
    budget,
    provider,
    repoRoot: storageRoot,
    storage: createVisualCandidateStorage(storageRoot),
    dailyLimitUsd: 1_000_000,
  });

  return { store, intake, designStore, design, assets, visualStore, budget, visual, provider, dbHandle };
}

/** Seed project with pre-bound home/hero asset. */
async function seedPreBoundProject(h: Awaited<ReturnType<typeof createHarness>>, key: string): Promise<string> {
  const { projectId } = await seedProjectWithAcceptedInputs(h.dbHandle, key);
  await acceptFixturePage(h.dbHandle, projectId, "home");
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 60, g: 60, b: 60 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  await h.assets.assignVersion(projectId, {
    ...await assignmentPage(h.dbHandle, projectId, "home", approved.governanceDigest!),
    assetId: upload.asset.id,
    versionId: approved.id,
    pageSlug: "home",
    role: "hero",
    expectedBinaryDigest: approved.binaryDigest,
  });
  await h.design.deriveInputSnapshotDraft(projectId, { schemaVersion: "design-v1" });
  const cand = await h.design.generateCandidate({ projectId });
  await h.design.acceptCandidate({
    projectId,
    candidateId: cand.id,
    expectedCandidateDigest: cand.candidateDigest,
    reviewNotes: "fixture acceptance",
  });
  return projectId;
}

// ---------------------------------------------------------------------------
// P1-01 / P1-02: Durable Slot Resolution Authority Tests
// ---------------------------------------------------------------------------

test("ZERO-RESOLUTION 1: Mutating assignment without durable slot resolution fails closed to ASSET_ASSIGNMENT_CHANGED", async () => {
  const h = await createHarness();
  const projectId = await seedPreBoundProject(h, `zero-res-1-${randomUUID().slice(0, 8)}`);

  // Plan 1 plans replacing home/hero
  const plan = await h.visual.derivePlan({ projectId });
  const planData = h.visualStore.planData(plan);
  assert.equal(planData.slots.length, 1);
  assert.equal(planData.slots[0]!.slot, "hero.primary");

  // Ingest and assign a new asset version directly WITHOUT recording any slot resolution
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 99, g: 99, b: 99 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "rogue.jpg",
    kind: "photo",
    title: "Rogue",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  const [existingAssignment] = await h.dbHandle.db
    .select()
    .from(assetPageAssignments)
    .where(and(eq(assetPageAssignments.projectId, projectId), eq(assetPageAssignments.pageSlug, "home"), eq(assetPageAssignments.role, "hero")));

  await h.assets.casReplaceAssignment(projectId, existingAssignment!.id, {
    expectedCurrentAssetId: existingAssignment!.assetId,
    expectedCurrentVersionId: existingAssignment!.versionId,
    expectedCurrentGovernanceDigest: existingAssignment!.versionDigest,
    toAssetId: upload.asset.id,
    toVersionId: approved.id,
    expectedTargetBinaryDigest: approved.binaryDigest,
  });

  // Verify that NO resolution exists in visual_slot_resolutions
  const resolutions = await h.visualStore.listSlotResolutions(plan.id);
  assert.equal(resolutions.length, 0);

  // Check design staleness: because no durable resolution was recorded, it must NOT be RUN7_EXACT_ASSET_REPLACED
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design);
  assert.equal(design.staleness.stale, true);
  assert.equal(
    design.staleness.code,
    "ASSET_ASSIGNMENT_CHANGED",
    "Without durable visual_slot_resolutions record, replacement is not Run7-authorized",
  );
});

test("ZERO-RESOLUTION 2: acceptSet fails closed if any slot has no durable resolution record", async () => {
  const h = await createHarness();
  const { projectId } = await seedProjectWithAcceptedInputs(h.dbHandle, `zero-res-2-${randomUUID().slice(0, 8)}`);
  await acceptFixturePage(h.dbHandle, projectId, "home");
  await h.design.deriveInputSnapshotDraft(projectId, { schemaVersion: "design-v1" });
  const cand = await h.design.generateCandidate({ projectId });
  await h.design.acceptCandidate({
    projectId,
    candidateId: cand.id,
    expectedCandidateDigest: cand.candidateDigest,
    reviewNotes: "fixture acceptance",
  });

  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({ projectId, planId: plan.id, slot: "hero.primary", truthClass: "illustrative" });

  // Synthesize an assignment in Run 5 directly without going through visual resolution
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "h.jpg",
    kind: "photo",
    title: "H",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  await h.assets.assignVersion(projectId, {
    ...await assignmentPage(h.dbHandle, projectId, "home", approved.governanceDigest!),
    assetId: upload.asset.id,
    versionId: approved.id,
    pageSlug: "home",
    role: "hero",
    expectedBinaryDigest: approved.binaryDigest,
  });

  // Attempt to accept set: must fail closed with visual_slot_unresolved
  await assert.rejects(
    h.visual.acceptSet({ projectId, planId: plan.id }),
    (err: any) => err instanceof FactoryError && err.code === "visual_slot_unresolved",
    "acceptSet must reject when slot has no durable visual_slot_resolutions record",
  );

  // Now record durable resolution for the slot
  await h.visualStore.recordSlotResolution({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    pageSlug: "home",
    role: "hero",
    fromAssetId: null,
    fromVersionId: null,
    fromBinaryDigest: null,
    fromGovernanceDigest: null,
    toAssetId: upload.asset.id,
    toVersionId: approved.id,
    toBinaryDigest: approved.binaryDigest,
    toGovernanceDigest: approved.governanceDigest!,
    resolutionMode: "reuse_real",
    visualProviderConsumedSourceAsset: false,
    visualProviderProducedAsset: false,
  });

  // Now acceptSet succeeds
  const set = await h.visual.acceptSet({ projectId, planId: plan.id });
  assert.ok(set.id.startsWith("avs-"));
  assert.equal(set.version, 1);
});

test("PLAN-PROVENANCE: Cross-plan candidate isolation prevents candidate from Plan 1 leaking into Plan 2", async () => {
  const h = await createHarness();
  const projectId = await seedPreBoundProject(h, `plan-prov-${randomUUID().slice(0, 8)}`);

  // Plan 1: generate an AI candidate for hero.primary
  const plan1 = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({ projectId, planId: plan1.id, slot: "hero.primary", truthClass: "illustrative" });
  const prompt1 = await h.visual.compilePromptSnapshot({ projectId, planId: plan1.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({ projectId, snapshotId: prompt1.id, expectedPromptDigest: prompt1.promptDigest });
  const gen1 = await h.visual.generateForSlot({ projectId, planId: plan1.id, slot: "hero.primary" });
  const c1 = gen1.candidates[0]!;

  // Accept candidate C1 into Plan 1
  await h.visual.acceptCandidate({
    projectId,
    planId: plan1.id,
    slot: "hero.primary",
    candidateId: c1.id,
    expectedBinaryDigest: c1.binaryDigest,
  });

  // Verify Plan 1 slot resolution recorded candidateId
  const res1 = await h.visualStore.getSlotResolution(plan1.id, "hero.primary");
  assert(res1);
  assert.equal(res1.candidateId, c1.id);
  assert.equal(res1.resolutionMode, "ai_generate");

  // Accept set for Plan 1
  const set1 = await h.visual.acceptSet({ projectId, planId: plan1.id });
  assert.equal(set1.version, 1);

  // Now run Final Design Pass to incorporate Plan 1 assets
  const fdp = await h.visual.runFinalDesignPass({ projectId });
  await h.visual.acceptFinalDesign({
    projectId,
    candidateId: fdp.id,
    expectedCandidateDigest: fdp.candidateDigest,
    reviewNotes: "fixture acceptance — freeze v2",
  });

  // Derive Plan 2 from the new accepted design
  const plan2 = await h.visual.derivePlan({ projectId });
  assert.notEqual(plan2.id, plan1.id);

  // In Plan 2, resolve hero.primary via reuse_real (reusing current assignment)
  await h.visual.confirmClassification({ projectId, planId: plan2.id, slot: "hero.primary", truthClass: "illustrative" });
  const reuseRes = await h.visual.resolveReuse({ projectId, planId: plan2.id, slot: "hero.primary" });
  assert(reuseRes.assignmentId);

  // Check Plan 2 slot resolution: must be reuse_real, candidateId must be null
  const res2 = await h.visualStore.getSlotResolution(plan2.id, "hero.primary");
  assert(res2);
  assert.equal(res2.resolutionMode, "reuse_real");
  assert.equal(res2.candidateId, null, "Candidate C1 from Plan 1 must NOT be copied into Plan 2 resolution");
  assert.equal(res2.visualProviderProducedAsset, false);
  assert.equal(res2.visualProviderConsumedSourceAsset, false);

  // Accept set for Plan 2
  const set2 = await h.visual.acceptSet({ projectId, planId: plan2.id });
  assert.equal(set2.version, 2);

  // Verify accepted slot rows for Plan 2: resolutionMode must be reuse_real, candidateId null
  const set2Slots = await h.visualStore.listAcceptedSlots(set2.id);
  const heroSlot2 = set2Slots.find((s) => s.slot === "hero.primary")!;
  assert.equal(heroSlot2.resolutionMode, "reuse_real");
  assert.equal(heroSlot2.candidateId, null);
  assert.equal(heroSlot2.visualProviderProducedAsset, false);
  assert.equal(heroSlot2.visualProviderConsumedSourceAsset, false);
});

/** Seed project with design v1, resolve slot via ai_generate, and accept set. */
async function seedAndResolveProject(h: Awaited<ReturnType<typeof createHarness>>, key: string): Promise<{ projectId: string; planId: string }> {
  const { projectId } = await seedProjectWithAcceptedInputs(h.dbHandle, key);
  await acceptFixturePage(h.dbHandle, projectId, "home");
  await h.design.deriveInputSnapshotDraft(projectId, { schemaVersion: "design-v1" });
  const cand = await h.design.generateCandidate({ projectId });
  await h.design.acceptCandidate({
    projectId,
    candidateId: cand.id,
    expectedCandidateDigest: cand.candidateDigest,
    reviewNotes: "fixture acceptance",
  });
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({ projectId, planId: plan.id, slot: "hero.primary", truthClass: "illustrative" });
  const prompt = await h.visual.compilePromptSnapshot({ projectId, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({ projectId, snapshotId: prompt.id, expectedPromptDigest: prompt.promptDigest });
  const gen = await h.visual.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" });
  await h.visual.acceptCandidate({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    candidateId: gen.candidates[0]!.id,
    expectedBinaryDigest: gen.candidates[0]!.binaryDigest,
  });
  await h.visual.acceptSet({ projectId, planId: plan.id });
  return { projectId, planId: plan.id };
}

// ---------------------------------------------------------------------------
// P1-03: Atomic Advisory Lock & Concurrency Tests
// ---------------------------------------------------------------------------

test("FREEZE-CONCURRENCY: Advisory lock serializes final design freeze with concurrent authority mutations", async () => {
  // Use two separate DB pool instances
  const db1 = await createTestDatabase();
  const db2 = await createTestDatabase();

  const h1 = await createHarness(db1);
  const h2 = await createHarness(db2);

  const { projectId, planId } = await seedAndResolveProject(h1, `freeze-conc-${randomUUID().slice(0, 8)}`);

  // Prepare final design pass candidate
  const fdp = await h1.visual.runFinalDesignPass({ projectId });

  // Connection 1 begins a transaction and acquires the project advisory lock
  let lockAcquired = false;
  let connection2Blocked = true;
  let connection2Finished = false;

  const barrierPromise = new Promise<void>((resolve) => {
    // Poll until Connection 1 has the lock
    const interval = setInterval(() => {
      if (lockAcquired) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });

  // Run Connection 1 transaction holding lock for 250ms
  const tx1Promise = db1.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 104))`);
    lockAcquired = true;
    await new Promise((r) => setTimeout(r, 250));
  });

  // Once Connection 1 has lock, Connection 2 tries to record a slot resolution (which takes advisory lock)
  const tx2Promise = barrierPromise.then(async () => {
    // Record start time
    const start = Date.now();
    // This should block until Connection 1 transaction finishes!
    await h2.visualStore.recordSlotResolution({
      projectId,
      planId,
      slot: "hero.primary",
      pageSlug: "home",
      role: "hero",
      fromAssetId: null,
      fromVersionId: null,
      fromBinaryDigest: null,
      fromGovernanceDigest: null,
      toAssetId: "ast-dummy",
      toVersionId: "asv-dummy",
      toBinaryDigest: "a".repeat(64),
      toGovernanceDigest: "b".repeat(64),
      resolutionMode: "reuse_real",
      visualProviderConsumedSourceAsset: false,
      visualProviderProducedAsset: false,
    }).catch(() => {});
    const elapsed = Date.now() - start;
    connection2Blocked = elapsed >= 180; // Must have waited at least 180ms
    connection2Finished = true;
  });

  await Promise.all([tx1Promise, tx2Promise]);
  assert.equal(connection2Blocked, true, "Connection 2 was blocked by advisory lock held by Connection 1");
  assert.equal(connection2Finished, true);

  await db1.close();
  await db2.close();
});

// ---------------------------------------------------------------------------
// P2: Explicit Evidence Dimensions Truthfulness
// ---------------------------------------------------------------------------

test("EVIDENCE-DIMENSIONS: Workspace and AcceptedVisualAssetSet reflect explicit truthfulness dimensions across modes", async () => {
  const h = await createHarness();
  const { projectId, planId } = await seedAndResolveProject(h, `ev-dim-${randomUUID().slice(0, 8)}`);

  // Check workspace for ai_generate slot
  const ws = await h.visual.workspace(projectId);
  assert(ws.acceptedSet);
  const slot = ws.acceptedSet.slots.find((s) => s.slot === "hero.primary")!;
  assert.equal(slot.resolutionMode, "ai_generate");
  assert.equal(slot.visualProviderProducedAsset, true);
  assert.equal(slot.visualProviderConsumedSourceAsset, false);
  assert.equal(slot.designProviderReferencedFinalAsset, true);
  assert.equal(slot.designProviderConsumedFinalAsset, false);
  assert.equal(slot.providerConsumed, true);

  // Run final design pass and freeze
  const fdp = await h.visual.runFinalDesignPass({ projectId });
  await h.visual.acceptFinalDesign({
    projectId,
    candidateId: fdp.id,
    expectedCandidateDigest: fdp.candidateDigest,
    reviewNotes: "fixture acceptance — freeze v2",
  });

  const finalWs = await h.visual.workspace(projectId);
  assert(finalWs.finalDesignPass);
  assert.equal(finalWs.finalDesignPass.frozen, true);
  assert.equal(finalWs.finalDesignPass.visualProviderProducedAsset, true);
  assert.equal(finalWs.finalDesignPass.visualProviderConsumedSourceAsset, false);
  assert.equal(finalWs.finalDesignPass.designProviderReferencedFinalAsset, true);
  assert.equal(finalWs.finalDesignPass.designProviderConsumedFinalAsset, false);
});
