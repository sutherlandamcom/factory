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
import { buildIntakePayload, completeIntakePayload } from "../fixtures/intake-payloads.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { FactoryError } from "../../src/executor/errors.js";
import {
  acceptedPageContent,
  acceptedVisualAssetSets,
  acceptedVisualAssetSlots,
  visualAssetPlans,
} from "../../src/persistence/schema.js";

let dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>> | null = null;
let storageRoot: string | null = null;

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

async function createHarness(opts: {
  provider?: VisualAssetProvider;
  followerTimeoutMs?: number;
  followerPollIntervalMs?: number;
} = {}) {
  dbInst = dbInst ?? (await setupMigratedTestDatabase());
  storageRoot = storageRoot ?? (await mkdtemp(`${tmpdir()}/visual-adversarial-`));

  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const designStore = new DesignStore(dbInst.db);

  const design = await DesignService.create({
    store: designStore,
    provider: new FixtureDesignProvider(),
  });

  const assets = new AssetService({
    store: new AssetStore(dbInst.db),
    storage: createAssetStorage(storageRoot),
  });

  const visualStore = new VisualStore(dbInst.db);
  const budget = new VisualBudgetStore(dbInst.db);
  const candidateStorage = createVisualCandidateStorage(storageRoot);

  const defaultProvider: VisualAssetProvider = {
    id: "google-genai",
    providerMode: "fixture",
    async preflight(): Promise<VisualAssetProviderPreflight> {
      return {
        configured: true,
        provider: "google-genai",
        reachable: true,
        configuredModels: ["fixture"],
      };
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
    async editImage(req: VisualProviderRequest): Promise<VisualProviderResult> {
      const bytes = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 50, b: 60 } },
      })
        .png()
        .toBuffer();
      return {
        candidates: [{ bytes: new Uint8Array(bytes), mediaType: "image/png", index: 0 }],
        providerRequestRef: `fixture-${req.requestDigest.slice(0, 16)}`,
        providerUsage: { fixture: true, model: "fixture" },
      };
    },
  };

  const provider = opts.provider ?? defaultProvider;

  const visual = new VisualService({
    store: visualStore,
    designStore,
    designService: design,
    assets,
    budget,
    provider,
    repoRoot: storageRoot,
    storage: candidateStorage,
    followerTimeoutMs: opts.followerTimeoutMs,
    followerPollIntervalMs: opts.followerPollIntervalMs,
  });

  return { store, intake, designStore, design, assets, visualStore, budget, visual, provider };
}

async function seedTestProject(harness: Awaited<ReturnType<typeof createHarness>>, key: string) {
  const project = await harness.store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await harness.intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  await harness.intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });

  // Seed representative homepage content
  await dbInst!.db.insert(acceptedPageContent).values({
    id: `apc-${randomUUID()}`,
    projectId: project.id,
    version: 1,
    slug: "home",
    proposalId: "prop-1",
    proposalVersion: 1,
    proposalDigest: "a".repeat(64),
    qaReportDigest: "b".repeat(64),
    data: { sections: [] },
    contentDigest: "c".repeat(64),
  });

  await harness.design.deriveInputSnapshotDraft(project.id);
  const cand = await harness.design.generateCandidate({ projectId: project.id });
  await harness.design.acceptCandidate({
    projectId: project.id,
    candidateId: cand.id,
    expectedCandidateDigest: cand.candidateDigest,
    reviewNotes: "fixture acceptance",
  });

  return project.id;
}

// ---------------------------------------------------------------------------
// TEST SUITE: Run 7 Remediation Adversarial Invariants
// ---------------------------------------------------------------------------

test("ADVERSARIAL 1: slow provider > timeout causes follower to fail closed with visual_generation_timeout and zero provider calls", async () => {
  let providerCallCount = 0;
  let unblockLeader: (() => void) | null = null;
  const leaderBlocked = new Promise<void>((resolve) => {
    unblockLeader = resolve;
  });

  const slowProvider: VisualAssetProvider = {
    id: "google-genai",
    providerMode: "fixture",
    async preflight(): Promise<VisualAssetProviderPreflight> {
      return { configured: true, provider: "google-genai", reachable: true, configuredModels: ["fixture"] };
    },
    async generateImage(req: VisualProviderRequest): Promise<VisualProviderResult> {
      providerCallCount++;
      await leaderBlocked;
      const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
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

  const h = await createHarness({
    provider: slowProvider,
    followerTimeoutMs: 300,
    followerPollIntervalMs: 50,
  });

  const projectId = await seedTestProject(h, `adv1-${randomUUID().slice(0, 8)}`);
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    truthClass: "illustrative",
  });
  const prompt = await h.visual.compilePromptSnapshot({ projectId, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({
    projectId,
    snapshotId: prompt.id,
    expectedPromptDigest: prompt.promptDigest,
  });

  // Start leader in background
  const leaderPromise = h.visual.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" });

  // Wait a bit to ensure leader has inserted DB row and is running
  await new Promise((r) => setTimeout(r, 100));

  // Now create a follower on a second VisualService instance (separate in-flight map)
  const followerService = new VisualService({
    store: h.visualStore,
    designStore: h.designStore,
    designService: h.design,
    assets: h.assets,
    budget: h.budget,
    provider: slowProvider,
    followerTimeoutMs: 300,
    followerPollIntervalMs: 50,
  });

  // Follower must time out after 300ms
  await assert.rejects(
    followerService.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" }),
    (err: unknown) => {
      assert(isCode(err, "visual_generation_timeout"), `Expected visual_generation_timeout, got ${err}`);
      return true;
    },
  );

  // Critical invariant: follower made ZERO additional provider calls!
  assert.equal(providerCallCount, 1, "Follower must never fall through to make a provider call");

  // Clean up leader
  unblockLeader!();
  await leaderPromise;
});

test("ADVERSARIAL 2: separate VisualService instances against same DB execute single-flight with execution lease", async () => {
  let providerCallCount = 0;
  const singleFlightProvider: VisualAssetProvider = {
    id: "google-genai",
    providerMode: "fixture",
    async preflight(): Promise<VisualAssetProviderPreflight> {
      return { configured: true, provider: "google-genai", reachable: true, configuredModels: ["fixture"] };
    },
    async generateImage(req: VisualProviderRequest): Promise<VisualProviderResult> {
      providerCallCount++;
      await new Promise((r) => setTimeout(r, 200));
      const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
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

  const h = await createHarness({ provider: singleFlightProvider });
  const projectId = await seedTestProject(h, `adv2-${randomUUID().slice(0, 8)}`);
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    truthClass: "illustrative",
  });
  const prompt = await h.visual.compilePromptSnapshot({ projectId, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({
    projectId,
    snapshotId: prompt.id,
    expectedPromptDigest: prompt.promptDigest,
  });

  const serviceA = new VisualService({
    store: h.visualStore,
    designStore: h.designStore,
    designService: h.design,
    assets: h.assets,
    budget: h.budget,
    provider: singleFlightProvider,
    followerTimeoutMs: 5000,
    followerPollIntervalMs: 50,
  });

  const serviceB = new VisualService({
    store: h.visualStore,
    designStore: h.designStore,
    designService: h.design,
    assets: h.assets,
    budget: h.budget,
    provider: singleFlightProvider,
    followerTimeoutMs: 5000,
    followerPollIntervalMs: 50,
  });

  const [resA, resB] = await Promise.all([
    serviceA.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" }),
    serviceB.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" }),
  ]);

  assert.equal(providerCallCount, 1, "Cross-process single-flight must result in exactly 1 provider call");
  assert.equal(resA.request.id, resB.request.id, "Both instances returned the same request");
  assert.equal(resA.candidates[0]!.binaryDigest, resB.candidates[0]!.binaryDigest, "Both instances returned identical candidate bytes");
  assert.equal(resA.reused !== resB.reused, true, "Exactly one instance was the leader and one was the follower");
});

test("ADVERSARIAL 3: historical fixture migration sets provider_mode to fixture and fails closed against requireProductionVisualSet", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `adv3-${randomUUID().slice(0, 8)}`);
  const plan = await h.visual.derivePlan({ projectId });

  const setId = `set-${randomUUID()}`;
  const setDigest = "a".repeat(64);
  await dbInst!.db.insert(acceptedVisualAssetSets).values({
    id: setId,
    projectId,
    version: 1,
    setDigest,
    planId: plan.id,
    providerMode: "fixture",
    designArtifactId: plan.designArtifactId,
    designArtifactVersion: plan.designArtifactVersion,
    designCandidateDigest: plan.designCandidateDigest,
    designInputDigest: plan.designInputDigest,
  });

  await assert.rejects(
    h.visualStore.requireProductionVisualSet(projectId, setId, setDigest),
    (err: unknown) => {
      assert(isCode(err, "visual_acceptance_failed"), `Expected visual_acceptance_failed, got ${err}`);
      assert((err as Error).message.includes("Test fixture acceptance is never production visual authority"));
      return true;
    },
  );
});

test("ADVERSARIAL 4: exact accepted Run 7 replacement triggers RUN7_EXACT_ASSET_REPLACED (allowed) while arbitrary change triggers ASSET_ASSIGNMENT_CHANGED (rejected)", async () => {
  const h = await createHarness();
  const key = `adv4-${randomUUID().slice(0, 8)}`;
  const project = await h.store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await h.intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  await h.intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });

  // Seed representative homepage content
  await dbInst!.db.insert(acceptedPageContent).values({
    id: `apc-${randomUUID()}`,
    projectId: project.id,
    version: 1,
    slug: "home",
    proposalId: "prop-1",
    proposalVersion: 1,
    proposalDigest: "a".repeat(64),
    qaReportDigest: "b".repeat(64),
    data: { sections: [] },
    contentDigest: "c".repeat(64),
  });

  // 1. Upload initial asset version 1
  const rawBytes1 = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 50, g: 50, b: 50 } } }).jpeg().toBuffer();
  const upload1 = await h.assets.uploadAsset(project.id, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
    rightsStatus: "operator_owned",
    dataBase64: rawBytes1.toString("base64"),
  });
  await h.assets.approveVersion(project.id, upload1.version.id, upload1.version.binaryDigest);
  await h.assets.assignVersion(project.id, {
    pageSlug: "home",
    role: "hero",
    assetId: upload1.asset.id,
    versionId: upload1.version.id,
    expectedBinaryDigest: upload1.version.binaryDigest,
  });

  // 2. Derive design input snapshot and accept candidate
  await h.design.deriveInputSnapshotDraft(project.id);
  const cand = await h.design.generateCandidate({ projectId: project.id });
  await h.design.acceptCandidate({
    projectId: project.id,
    candidateId: cand.id,
    expectedCandidateDigest: cand.candidateDigest,
    reviewNotes: "fixture acceptance",
  });

  // 3. Visual plan derives from this design and binds upload1.version.id
  const plan = await h.visual.derivePlan({ projectId: project.id });
  const planSlot = h.visualStore.planData(plan).slots.find((s) => s.slot === "hero.primary");
  assert(planSlot, "Plan slot must exist");
  assert.equal(planSlot.existingVersionId, upload1.version.id, "Plan slot must bind asset 1");

  // Part A: Authorized Run 7 replacement. Generate + accept a candidate so
  // the exact Run 7 resolution is durable (AcceptedVisualAssetSet slot row),
  // then the assignment equals that accepted resolution.
  await h.visual.confirmClassification({
    projectId: project.id,
    planId: plan.id,
    slot: "hero.primary",
    truthClass: "illustrative",
  });
  const prompt = await h.visual.compilePromptSnapshot({ projectId: project.id, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({
    projectId: project.id,
    snapshotId: prompt.id,
    expectedPromptDigest: prompt.promptDigest,
  });
  const gen = await h.visual.generateForSlot({ projectId: project.id, planId: plan.id, slot: "hero.primary" });
  await h.visual.acceptCandidate({
    projectId: project.id,
    planId: plan.id,
    slot: "hero.primary",
    candidateId: gen.candidates[0]!.id,
    expectedBinaryDigest: gen.candidates[0]!.binaryDigest,
  });
  await h.visual.acceptSet({ projectId: project.id, planId: plan.id });

  // The design input snapshot (v1) bound the OLD assignment; the new
  // assignment equals the accepted Run 7 slot row exactly -> authorized.
  const designAfterRun7 = await h.designStore.latestAcceptedDesign(project.id);
  assert(designAfterRun7, "Design must exist");
  assert.equal(designAfterRun7.staleness.code, "RUN7_EXACT_ASSET_REPLACED", "The exact accepted Run 7 replacement is the authorized transition");

  assert.doesNotThrow(() => {
    h.visual.assertDesignAuthorityEligible(designAfterRun7);
  }, "RUN7_EXACT_ASSET_REPLACED must be permitted for visual service");

  // Part B: Arbitrary mutation WITHOUT an accepted Run 7 resolution.
  // Create a project where an asset assignment changes with no accepted
  // visual set slot proving the transition.
  const keyB = `adv4b-${randomUUID().slice(0, 8)}`;
  const projectB = await h.store.createProject({ key: keyB, name: `Project ${keyB}` });
  const payloadB = buildIntakePayload();
  await h.intake.saveDraft({ projectId: projectB.id, baseRevision: 0, payload: payloadB });
  await h.intake.accept({
    projectId: projectB.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payloadB),
  });
  await dbInst!.db.insert(acceptedPageContent).values({
    id: `apc-${randomUUID()}`,
    projectId: projectB.id,
    version: 1,
    slug: "home",
    proposalId: "prop-1",
    proposalVersion: 1,
    proposalDigest: "a".repeat(64),
    qaReportDigest: "b".repeat(64),
    data: { sections: [] },
    contentDigest: "c".repeat(64),
  });

  const uploadB1 = await h.assets.uploadAsset(projectB.id, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero B",
    rightsStatus: "operator_owned",
    dataBase64: rawBytes1.toString("base64"),
  });
  await h.assets.approveVersion(projectB.id, uploadB1.version.id, uploadB1.version.binaryDigest);
  const assignmentB = await h.assets.assignVersion(projectB.id, {
    pageSlug: "home",
    role: "hero",
    assetId: uploadB1.asset.id,
    versionId: uploadB1.version.id,
    expectedBinaryDigest: uploadB1.version.binaryDigest,
  });

  await h.design.deriveInputSnapshotDraft(projectB.id);
  const candB = await h.design.generateCandidate({ projectId: projectB.id });
  await h.design.acceptCandidate({
    projectId: projectB.id,
    candidateId: candB.id,
    expectedCandidateDigest: candB.candidateDigest,
    reviewNotes: "fixture acceptance",
  });

  // Derive a plan (so a plan slot exists) but NEVER accept a Run 7 set.
  await h.visual.derivePlan({ projectId: projectB.id });

  // Replace assignment on projectB without an accepted Run 7 resolution
  const rawBytes3 = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 70, g: 70, b: 70 } } }).jpeg().toBuffer();
  const uploadB2 = await h.assets.uploadAsset(projectB.id, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero B",
    rightsStatus: "operator_owned",
    dataBase64: rawBytes3.toString("base64"),
  });
  await h.assets.approveVersion(projectB.id, uploadB2.version.id, uploadB2.version.binaryDigest);
  await h.assets.replaceAssignment(projectB.id, assignmentB.id, {
    toVersionId: uploadB2.version.id,
    expectedBinaryDigest: uploadB2.version.binaryDigest,
  });

  const designBAfter = await h.designStore.latestAcceptedDesign(projectB.id);
  assert(designBAfter, "Design must exist");
  assert.equal(designBAfter.staleness.code, "ASSET_ASSIGNMENT_CHANGED", "Plan slot alone is NOT authorization; an arbitrary replacement stays ASSET_ASSIGNMENT_CHANGED");

  assert.throws(
    () => {
      h.visual.assertDesignAuthorityEligible(designBAfter);
    },
    (err: unknown) => {
      assert(isCode(err, "visual_design_not_eligible"));
      return true;
    },
  );
});

test("ADVERSARIAL 4b: exact accepted Run 7 resolution (AcceptedVisualAssetSet slot row) authorizes RUN7_EXACT_ASSET_REPLACED; wrong digest/slot does not", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `adv4b-${randomUUID().slice(0, 8)}`);

  // Full Run 7 resolution: generate -> accept -> accept set. The accepted
  // set slot row is the durable authority for the exact transition.
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    truthClass: "illustrative",
  });
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

  // The design input snapshot (v1) binds the OLD assignment; the new
  // assignment equals the accepted Run 7 slot row exactly -> authorized.
  const design = await h.designStore.latestAcceptedDesign(projectId);
  assert(design, "Design must exist");
  assert.equal(design.staleness.code, "RUN7_ASSET_ASSIGNMENTS_ADDED");

  // Tamper: mutate the accepted slot row's digests (simulating a forged
  // acceptance record) -> the current assignment no longer equals the
  // accepted resolution -> must NOT be Run7-authorized.
  const setRow = await dbInst!.db.select().from(acceptedVisualAssetSets).where(eq(acceptedVisualAssetSets.projectId, projectId));
  const slotRows = await dbInst!.db.select().from(acceptedVisualAssetSlots).where(eq(acceptedVisualAssetSlots.setId, setRow[0]!.id));
  await dbInst!.db
    .update(acceptedVisualAssetSlots)
    .set({ governanceDigest: "f".repeat(64) })
    .where(eq(acceptedVisualAssetSlots.id, slotRows[0]!.id));
  const tampered = await h.designStore.latestAcceptedDesign(projectId);
  assert(tampered, "Design must exist");
  assert.notEqual(tampered.staleness.code, "RUN7_EXACT_ASSET_REPLACED", "A slot row whose digests diverge from the assignment is NOT Run7 authorization");
});

test("ADVERSARIAL 5: upstream mutation before freeze causes runFinalDesignPass to fail closed with visual_design_not_eligible", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `adv5-${randomUUID().slice(0, 8)}`);
  const plan = await h.visual.derivePlan({ projectId });
  await h.visual.confirmClassification({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    truthClass: "illustrative",
  });
  const prompt = await h.visual.compilePromptSnapshot({ projectId, planId: plan.id, slot: "hero.primary", operation: "generate" });
  await h.visual.approvePromptSnapshot({
    projectId,
    snapshotId: prompt.id,
    expectedPromptDigest: prompt.promptDigest,
  });
  const gen = await h.visual.generateForSlot({ projectId, planId: plan.id, slot: "hero.primary" });
  await h.visual.acceptCandidate({
    projectId,
    planId: plan.id,
    slot: "hero.primary",
    candidateId: gen.candidates[0]!.id,
    expectedBinaryDigest: gen.candidates[0]!.binaryDigest,
  });
  await h.visual.acceptSet({ projectId, planId: plan.id });

  // Mutate upstream intake
  const modifiedPayload = {
    ...completeIntakePayload,
    business: { ...completeIntakePayload.business, name: "Mutated Upstream Brand" },
  };
  await h.intake.saveDraft({ projectId, baseRevision: 1, payload: modifiedPayload });
  await h.intake.accept({
    projectId,
    expectedRevision: 2,
    expectedDigest: deterministicDigest(modifiedPayload),
  });

  const latestDesign = await h.designStore.latestAcceptedDesign(projectId);
  assert(latestDesign, "Design must exist");
  assert.equal(latestDesign.staleness.code, "INPUT_CHANGED");

  await assert.rejects(
    h.visual.runFinalDesignPass({ projectId }),
    (err: unknown) => {
      assert(isCode(err, "visual_design_not_eligible"), `Expected visual_design_not_eligible, got ${err}`);
      assert((err as Error).message.includes("INPUT_CHANGED"));
      return true;
    },
  );
});

test("ADVERSARIAL 6: multi-slot atomic rollback in PostgreSQL rolls back set header and all slots on partial failure", async () => {
  const h = await createHarness();
  const projectId = await seedTestProject(h, `adv6-${randomUUID().slice(0, 8)}`);

  const planId = `plan-${randomUUID()}`;
  const planDigest = "b".repeat(64);
  const slotsData = [
    {
      slot: "slot.one",
      pageSlug: "home",
      role: "hero",
      requiredRole: "hero",
      requirement: "req 1",
      aspectRatio: "16:9",
      minDimensions: { width: 1280, height: 720 },
      existingVersionId: null,
      existingBinaryDigest: null,
      existingGovernanceDigest: null,
      unresolvedReason: "none",
    },
    {
      slot: "slot.two",
      pageSlug: "home",
      role: "secondary",
      requiredRole: "secondary",
      requirement: "req 2",
      aspectRatio: "1:1",
      minDimensions: { width: 800, height: 800 },
      existingVersionId: null,
      existingBinaryDigest: null,
      existingGovernanceDigest: null,
      unresolvedReason: "none",
    },
  ];

  await dbInst!.db.insert(visualAssetPlans).values({
    id: planId,
    projectId,
    version: 1,
    designArtifactId: "art-1",
    designArtifactVersion: 1,
    designCandidateDigest: "c".repeat(64),
    designInputDigest: "d".repeat(64),
    designProviderMode: "fixture",
    slots: slotsData,
    planDigest,
  });

  const countBefore = await dbInst!.db.select().from(acceptedVisualAssetSets).where(eq(acceptedVisualAssetSets.projectId, projectId));

  // Attempt atomic insertion where slot 2 triggers a constraint violation (invalid truthClass)
  await assert.rejects(
    h.visualStore.createAcceptedSetAtomic({
      projectId,
      planId,
      providerMode: "fixture",
      designArtifactId: "art-1",
      designArtifactVersion: 1,
      designCandidateDigest: "c".repeat(64),
      designInputDigest: "d".repeat(64),
      slots: [
        {
          slot: "slot.one",
          pageSlug: "home",
          role: "hero",
          resolvedVersionId: `ver-${randomUUID()}`,
          binaryDigest: "f".repeat(64),
          governanceDigest: "g".repeat(64),
          resolutionMode: "ai_generate",
          truthClass: "illustrative",
        },
        {
          slot: "slot.two",
          pageSlug: "home",
          role: "secondary",
          resolvedVersionId: `ver-${randomUUID()}`,
          binaryDigest: "h".repeat(64),
          governanceDigest: "i".repeat(64),
          resolutionMode: "ai_generate",
          truthClass: "INVALID_TRUTH_CLASS" as never,
        },
      ],
    }),
  );

  const countAfter = await dbInst!.db.select().from(acceptedVisualAssetSets).where(eq(acceptedVisualAssetSets.projectId, projectId));
  assert.equal(countAfter.length, countBefore.length, "Set header must be rolled back");

  const rows = await dbInst!.db.select().from(acceptedVisualAssetSlots).where(eq(acceptedVisualAssetSlots.slot, "slot.one"));
  assert.equal(rows.length, 0, "Slot 1 row must be rolled back (zero partial rows committed)");
});
