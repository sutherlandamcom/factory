import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { assignmentPage, acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";
import {
  acceptedPageContent,
  acceptedVisualAssetSlots,
  acceptedVisualAssetSets,
  assetPageAssignments,
} from "../../src/persistence/schema.js";

/**
 * Run 6/7 final seam remediation acceptance:
 *
 * A. Replacement authority matrix — RUN7_EXACT_ASSET_REPLACED is granted
 *    ONLY for the exact accepted Run 7 resolution; wrong page/role/digest
 *    external mutations stay ASSET_ASSIGNMENT_CHANGED.
 * B. Final-freeze TOCTOU — upstream authority mutated between final
 *    generation and acceptance fails closed at acceptance.
 * C. Final exact reconciliation — AcceptedVisualAssetSet slot rows ==
 *    current Run 5 assignments == final DesignInputSnapshot assetRefs.
 * D. Provider consumption truthfulness — fixture provider capable of
 *    consuming exact bytes reports providerConsumed=true; the text-only
 *    seam path never claims consumption.
 */

let dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>> | null = null;
let storageRoot: string | null = null;

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

async function createHarness() {
  dbInst = dbInst ?? (await setupMigratedTestDatabase());
  storageRoot = storageRoot ?? (await mkdtemp(`${tmpdir()}/seam-authority-`));

  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const designStore = new DesignStore(dbInst.db);
  const design = await DesignService.create({ store: designStore, provider: new FixtureDesignProvider() });
  const assets = new AssetService({
    store: new AssetStore(dbInst.db),
    storage: createAssetStorage(storageRoot),
  });
  const visualStore = new VisualStore(dbInst.db);
  const budget = new VisualBudgetStore(dbInst.db);

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
      throw new Error("not implemented");
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
    // The visual budget ledger is project-agnostic (shared DB state); a high
    // per-test ceiling keeps these authority tests independent of how many
    // fixture generations ran earlier in the same database.
    dailyLimitUsd: 1_000_000,
  });

  return { store, intake, designStore, design, assets, visualStore, budget, visual, provider };
}

async function seedTestProject(h: Awaited<ReturnType<typeof createHarness>>, key: string): Promise<string> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst!, key);
  await acceptFixturePage(dbInst!, projectId, "home");
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


/** Project whose design input snapshot already binds a home/hero asset. */
async function seedPreBoundProject(h: Awaited<ReturnType<typeof createHarness>>, key: string): Promise<string> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst!, key);
  await acceptFixturePage(dbInst!, projectId, "home");
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
    ...await assignmentPage(dbInst!, projectId, "home", approved.governanceDigest!),
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

/** Drive the full Run 7 resolution for the seeded hero.primary slot. */
async function resolveHeroSlot(
  h: Awaited<ReturnType<typeof createHarness>>,
  projectId: string,
): Promise<{ planId: string; versionId: string; binaryDigest: string; governanceDigest: string | null }> {
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({ projectId, planId: plan.id, slot: "hero.primary", truthClass: "illustrative" });
  const prompt = await h.visual.compilePromptSnapshot({ projectId, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({ projectId, snapshotId: prompt.id, expectedPromptDigest: prompt.promptDigest });
  const gen = await h.visual.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" });
  const accepted = await h.visual.acceptCandidate({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    candidateId: gen.candidates[0]!.id,
    expectedBinaryDigest: gen.candidates[0]!.binaryDigest,
  });
  return {
    planId: plan.id,
    versionId: accepted.version.id,
    binaryDigest: accepted.version.binaryDigest,
    governanceDigest: accepted.version.governanceDigest,
  };
}

// ---------------------------------------------------------------------------
// A. Replacement authority matrix
// ---------------------------------------------------------------------------

test("AUTHORITY 1: exact accepted Run 7 resolution classifies RUN7_EXACT_ASSET_REPLACED", async () => {
  const h = await createHarness();
  const projectId = await seedPreBoundProject(h, `auth1-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  await h.visual.acceptSet({ projectId, planId: (await h.visualStore.latestPlan(projectId))!.id });
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design, "design must exist");
  assert.equal(design.staleness.code, "RUN7_EXACT_ASSET_REPLACED");
});

test("AUTHORITY 2: same slot changed externally to another approved asset (no Run 7 record) -> ASSET_ASSIGNMENT_CHANGED", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `auth2-${randomUUID().slice(0, 8)}`);
  // No Run 7 resolution at all: upload a second asset and swap the slot.
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero2.jpg",
    kind: "photo",
    title: "Hero 2",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  const assignments = await h.assets.workspace(projectId);
  assert.equal(assignments.assignments.length, 0, "seeded project has no bound slot to replace");
  // The design input snapshot has no assetRefs yet; adding an assignment is
  // RUN7_ASSET_ASSIGNMENTS_ADDED, so to test CHANGED we must first bind the
  // slot into a snapshot. Bind upload -> derive design v1 -> swap -> check.
  await h.assets.assignVersion(projectId, {
    ...await assignmentPage(dbInst!, projectId, "home", approved.governanceDigest!),
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
  // External swap to yet another approved version of the same asset.
  const raw3 = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 120, g: 30, b: 30 } } }).jpeg().toBuffer();
  const upload3 = await h.assets.uploadAsset(projectId, {
    filename: "hero3.jpg",
    kind: "photo",
    title: "Hero 2",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw3).toString("base64"),
  });
  const approved3 = await h.assets.approveVersion(projectId, upload3.version.id, upload3.version.binaryDigest);
  const ws = await h.assets.workspace(projectId);
  const assignment = ws.assignments.find((a) => a.pageSlug === "home" && a.role === "hero")!;
  await h.assets.replaceAssignment(projectId, assignment.id, {
    toVersionId: approved3.id,
    expectedBinaryDigest: approved3.binaryDigest,
  });
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design, "design must exist");
  assert.equal(design.staleness.code, "ASSET_ASSIGNMENT_CHANGED", "external swap with no Run 7 record is never Run7-authorized");
});

test("AUTHORITY 3: wrong page slot mutation -> ASSET_ASSIGNMENT_CHANGED (Run 7 record exists for a different page)", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `auth3-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  await h.visual.acceptSet({ projectId, planId: (await h.visualStore.latestPlan(projectId))!.id });

  // Bind a DIFFERENT page slot (about/hero) into the design snapshot via a
  // direct design v2: derive snapshot with an extra assignment on another
  // page, accept design, then externally mutate THAT slot.
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 15, g: 75, b: 15 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "about.jpg",
    kind: "photo",
    title: "About hero",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  await h.assets.assignVersion(projectId, {
    ...await assignmentPage(dbInst!, projectId, "about", approved.governanceDigest!),
    assetId: upload.asset.id,
    versionId: approved.id,
    pageSlug: "about",
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

  // External mutation of the about/hero slot (no Run 7 record covers it).
  const raw2 = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 15, g: 95, b: 15 } } }).jpeg().toBuffer();
  const upload2 = await h.assets.uploadAsset(projectId, {
    filename: "about2.jpg",
    kind: "photo",
    title: "About hero",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw2).toString("base64"),
  });
  const approved2 = await h.assets.approveVersion(projectId, upload2.version.id, upload2.version.binaryDigest);
  const ws = await h.assets.workspace(projectId);
  const aboutAssignment = ws.assignments.find((a) => a.pageSlug === "about" && a.role === "hero")!;
  await h.assets.replaceAssignment(projectId, aboutAssignment.id, {
    toVersionId: approved2.id,
    expectedBinaryDigest: approved2.binaryDigest,
  });
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design, "design must exist");
  assert.equal(design.staleness.code, "ASSET_ASSIGNMENT_CHANGED", "wrong page is never Run7-authorized");
});

test("AUTHORITY 4: right slot but assignment digest differs from the accepted Run 7 resolution -> ASSET_ASSIGNMENT_CHANGED", async () => {
  const h = await createHarness();
  const projectId = await seedPreBoundProject(h, `auth4-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });
  // Design is now RUN7_EXACT_ASSET_REPLACED (exact accepted resolution).
  const before = await h.designStore.latestAcceptedDesign(projectId);
  assert.equal(before!.staleness.code, "RUN7_EXACT_ASSET_REPLACED");

  // Now swap the SAME slot to a different approved version AFTER set
  // acceptance: the set slot row no longer matches the assignment.
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero-after.jpg",
    kind: "photo",
    title: "Hero after",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  const ws = await h.assets.workspace(projectId);
  const assignment = ws.assignments.find((a) => a.pageSlug === "home" && a.role === "hero")!;
  await h.assets.casReplaceAssignment(projectId, assignment.id, {
    expectedCurrentAssetId: assignment.assetId,
    expectedCurrentVersionId: assignment.versionId,
    expectedCurrentGovernanceDigest: assignment.versionDigest,
    toAssetId: upload.asset.id,
    toVersionId: approved.id,
    expectedTargetBinaryDigest: approved.binaryDigest,
  });
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design, "design must exist");
  assert.equal(
    design.staleness.code,
    "ASSET_ASSIGNMENT_CHANGED",
    "post-acceptance external swap diverges from the accepted resolution; the strongest authority wins and fails closed",
  );
});

// ---------------------------------------------------------------------------
// B. Final-freeze TOCTOU
// ---------------------------------------------------------------------------

test("TOCTOU 1: asset assignment mutated between final generation and acceptance -> acceptFinalDesign fails closed", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `toctou1-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });

  // Generate the final candidate.
  const candidate = await h.visual.runFinalDesignPass({ projectId });

  // Mutate the assignment BEFORE acceptance (external swap).
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 220, g: 20, b: 20 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero-toctou.jpg",
    kind: "photo",
    title: "Hero toctou",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  const ws = await h.assets.workspace(projectId);
  const assignment = ws.assignments.find((a) => a.pageSlug === "home" && a.role === "hero")!;
  await h.assets.casReplaceAssignment(projectId, assignment.id, {
    expectedCurrentAssetId: assignment.assetId,
    expectedCurrentVersionId: assignment.versionId,
    expectedCurrentGovernanceDigest: assignment.versionDigest,
    toAssetId: upload.asset.id,
    toVersionId: approved.id,
    expectedTargetBinaryDigest: approved.binaryDigest,
  });

  // Acceptance MUST fail closed.
  await assert.rejects(
    () =>
      h.visual.acceptFinalDesign({
        projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "fixture acceptance — final design freeze",
      }),
    (err: unknown) => {
      assert(isCode(err, "visual_acceptance_failed"), `expected visual_acceptance_failed, got ${err}`);
      assert((err as Error).message.includes("no longer matches the accepted visual asset set"));
      return true;
    },
  );
});

test("TOCTOU 2: accepted visual set slot row mutated between generation and acceptance -> acceptance fails closed", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `toctou2-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });
  const candidate = await h.visual.runFinalDesignPass({ projectId });

  // Tamper with the durable set slot row (authority drift).
  const set = (await dbInst!.db.select().from(acceptedVisualAssetSets).where(eq(acceptedVisualAssetSets.projectId, projectId)))[0]!;
  const slotRow = (await dbInst!.db.select().from(acceptedVisualAssetSlots).where(eq(acceptedVisualAssetSlots.setId, set.id)))[0]!;
  await dbInst!.db
    .update(acceptedVisualAssetSlots)
    .set({ binaryDigest: "d".repeat(64) })
    .where(eq(acceptedVisualAssetSlots.id, slotRow.id));

  await assert.rejects(
    () =>
      h.visual.acceptFinalDesign({
        projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "fixture acceptance — final design freeze",
      }),
    (err: unknown) => isCode(err, "visual_acceptance_failed"),
  );
});

test("TOCTOU 3: runFinalDesignPass fails closed when the set no longer matches assignments", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `toctou3-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });

  // External assignment swap before the final pass.
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 5, g: 200, b: 5 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero-pre.jpg",
    kind: "photo",
    title: "Hero pre",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  const ws = await h.assets.workspace(projectId);
  const assignment = ws.assignments.find((a) => a.pageSlug === "home" && a.role === "hero")!;
  await h.assets.casReplaceAssignment(projectId, assignment.id, {
    expectedCurrentAssetId: assignment.assetId,
    expectedCurrentVersionId: assignment.versionId,
    expectedCurrentGovernanceDigest: assignment.versionDigest,
    toAssetId: upload.asset.id,
    toVersionId: approved.id,
    expectedTargetBinaryDigest: approved.binaryDigest,
  });

  await assert.rejects(
    () => h.visual.runFinalDesignPass({ projectId }),
    (err: unknown) => isCode(err, "visual_acceptance_failed"),
  );
});

// ---------------------------------------------------------------------------
// C. Final exact reconciliation
// ---------------------------------------------------------------------------

test("RECONCILIATION: after a successful freeze, set slots == Run 5 assignments == final DesignInputSnapshot assetRefs", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `recon-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });

  const candidate = await h.visual.runFinalDesignPass({ projectId });
  const accepted = await h.visual.acceptFinalDesign({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "fixture acceptance — final design freeze",
  });
  assert.equal(accepted.version, 2);
  assert.equal(accepted.stale, false, "frozen design is UP_TO_DATE");

  // Equality proof across all three authorities.
  const set = (await dbInst!.db.select().from(acceptedVisualAssetSets).where(eq(acceptedVisualAssetSets.projectId, projectId))).at(-1)!;
  const slotRows = await dbInst!.db.select().from(acceptedVisualAssetSlots).where(eq(acceptedVisualAssetSlots.setId, set.id));
  const assignments = await dbInst!.db.select().from(assetPageAssignments).where(eq(assetPageAssignments.projectId, projectId));
  const snapshot = await h.designStore.getInputSnapshot(projectId, accepted.inputSnapshotId);
  assert(snapshot, "frozen design binds an input snapshot");
  const snapshotData = snapshot!.data as { assetRefs: Array<{ pageSlug: string; role: string; versionId: string; binaryDigest: string; governanceDigest: string }> };

  assert.equal(slotRows.length, assignments.length, "every accepted slot has an assignment");
  for (const slotRow of slotRows) {
    const assignment = assignments.find((a) => a.pageSlug === slotRow.pageSlug && a.role === slotRow.role);
    assert(assignment, `assignment exists for ${slotRow.pageSlug}/${slotRow.role}`);
    assert.equal(assignment.versionId, slotRow.resolvedVersionId, "assignment versionId == set slot row");
    assert.equal(assignment.binaryDigest, slotRow.binaryDigest, "assignment binaryDigest == set slot row");
    assert.equal(assignment.versionDigest, slotRow.governanceDigest, "assignment governanceDigest == set slot row");
    const ref = snapshotData.assetRefs.find((r) => r.pageSlug === slotRow.pageSlug && r.role === slotRow.role);
    assert(ref, `final snapshot binds ${slotRow.pageSlug}/${slotRow.role}`);
    assert.equal(ref.versionId, slotRow.resolvedVersionId, "snapshot assetRef versionId == set slot row");
    assert.equal(ref.binaryDigest, slotRow.binaryDigest, "snapshot assetRef binaryDigest == set slot row");
    assert.equal(ref.governanceDigest, slotRow.governanceDigest, "snapshot assetRef governanceDigest == set slot row");
  }
});

// ---------------------------------------------------------------------------
// D. Provider consumption truthfulness
// ---------------------------------------------------------------------------

test("TRUTHFULNESS 1: ai_generate slot reports providerConsumed=true; workspace finalDesignPass exposes providerConsumed evidence", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `truth1-${randomUUID().slice(0, 8)}`);
  await resolveHeroSlot(h, projectId);
  const planId = (await h.visualStore.latestPlan(projectId))!.id;
  await h.visual.acceptSet({ projectId, planId });

  const ws = await h.visual.workspace(projectId);
  assert(ws.acceptedSet, "accepted set exists");
  const slot = ws.acceptedSet.slots.find((s) => s.slot === "hero.primary")!;
  assert.equal(slot.resolutionMode, "ai_generate");
  assert.equal(slot.providerConsumed, true, "ai_generate actually delivered bytes to the provider");
  assert.equal(slot.visualProviderProducedAsset, true, "ai_generate produced asset bytes");
  assert.equal(slot.visualProviderConsumedSourceAsset, false, "ai_generate did not consume source asset");
  assert.equal(slot.designProviderReferencedFinalAsset, true, "design references final asset");
  assert.equal(slot.designProviderConsumedFinalAsset, false, "design provider is text-only seam");
});

test("TRUTHFULNESS 2: reuse_real slot reports providerConsumed=false (provider never saw the bytes)", async () => {
  const h = await createHarness();
  // Project with a pre-bound asset: the plan slot proposes reuse_real.
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst!, `truth2-${randomUUID().slice(0, 8)}`);
  await acceptFixturePage(dbInst!, projectId, "home");
  const raw = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 30, b: 200 } } }).jpeg().toBuffer();
  const upload = await h.assets.uploadAsset(projectId, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
    rightsStatus: "operator_owned",
    dataBase64: Buffer.from(raw).toString("base64"),
  });
  const approved = await h.assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
  await h.assets.assignVersion(projectId, {
    ...await assignmentPage(dbInst!, projectId, "home", approved.governanceDigest!),
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
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({ projectId, planId: plan.id, slot: "hero.primary", truthClass: "illustrative" });
  const resolved = await h.visual.resolveReuse({ projectId, planId: plan.id, slot: "hero.primary" });
  assert.equal(resolved.assignmentId != null, true);
  await h.visual.acceptSet({ projectId, planId: plan.id });

  const ws = await h.visual.workspace(projectId);
  const slot = ws.acceptedSet!.slots.find((s) => s.slot === "hero.primary")!;
  assert.equal(slot.resolutionMode, "reuse_real");
  assert.equal(slot.providerConsumed, false, "reuse never involves the provider");
  assert.equal(slot.visualProviderProducedAsset, false, "reuse does not produce asset bytes");
  assert.equal(slot.visualProviderConsumedSourceAsset, false, "reuse does not consume source asset");
  assert.equal(slot.designProviderReferencedFinalAsset, true, "design references final asset");
  assert.equal(slot.designProviderConsumedFinalAsset, false, "design provider is text-only seam");
});
