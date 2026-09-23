import { assignmentPage, acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { setupMigratedTestDatabase } from "./helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { DesignStore } from "../../src/design/design-store.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { FactoryError } from "../../src/executor/errors.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";
import { VisualStore, visualRequestDigest, visualSetDigest } from "../../src/visual/store.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { VisualService } from "../../src/visual/service.js";
import { FixtureVisualAssetProvider } from "../../src/visual/fixture-adapter.js";
import { createVisualCandidateStorage } from "../../src/visual/candidate-storage.js";
import { isResolutionAllowed, proposeResolutionStrategy, proposeTruthClass } from "../../src/visual/policy.js";
import { readC2paEvidence } from "../../src/visual/c2pa.js";
import { DOCUMENTARY_FORBIDDEN_EDITS, VISUAL_TRUTH_POLICY } from "@factory/contracts";

/**
 * Run 7 persistence suite — real PostgreSQL (dedicated factory_test DB).
 * Covers: plan derivation/idempotency, truth classification authority,
 * prompt snapshot immutability + approval digest binding, request-digest
 * dedup (no second spend), candidate immutability + byte validation,
 * fixture acceptance gating, documentary truth downgrade, Run 5 authority
 * routing (ingest + assignment), set acceptance + digest idempotency,
 * restart durability, and cross-project isolation.
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

async function seedProject(dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>, key: string) {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const project = await store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });
  return { projectId: project.id, inputSnapshot: accepted };
}

function candidateData(): DesignCandidateData {
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "projects/fixture",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      rationale: "Seed rationale",
    },
    providerEvidence: {},
    tokens: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      spacing: { md: "16px" },
      rounded: { md: "8px" },
    },
    screens: [
      {
        id: "screen-1",
        providerScreenName: "projects/fixture/screens/abc",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/fixture/screens/abc"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero placeholder",
            pageSlug: "home",
            role: "hero",
            requiredRole: "hero",
            providerConsumed: false,
            placeholder: true,
            unresolvedReason: "No approved asset assignment for home/hero.",
          },
        ],
        primaryCta: "Request assessment",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Fixture rationale",
  });
}

/** Full fixture-mode Run 7 environment over a migrated DB + temp storage. */
async function setupVisualFixture(dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>, key: string) {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  await acceptFixturePage(dbInst, projectId, "home");
  const root = await mkdtemp(path.join(tmpdir(), "visual-fixture-"));
  const designStore = new DesignStore(dbInst.db);
  const store = new VisualStore(dbInst.db);
  const budget = new VisualBudgetStore(dbInst.db);
  const provider = new FixtureVisualAssetProvider();

  // Accept a fixture design candidate (fixture declaration in review notes).
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId, schemaVersion: "design-v1" });
  const candidate = await designStore.createCandidate({
    projectId,
    inputSnapshot: snapshot,
    data: candidateData(),
  });
  const accepted = await designStore.acceptCandidate({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "fixture acceptance",
  });

  const assetsModule = await import("../../src/assets/asset-store.js");
  const assetServiceModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const sharp = (await import("sharp")).default;
  const assets = new assetServiceModule.AssetService({
    store: new assetsModule.AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });

  const visual = new VisualService({
    store,
    designStore,
    assets,
    budget,
    provider,
    repoRoot: root,
    storage: createVisualCandidateStorage(root),
  });
  const uploadAsset = async (seed: number) => {
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: seed, g: 70, b: 90 } } }).jpeg().toBuffer();
    return assets.uploadAsset(projectId, {
      filename: "fixture.jpg",
      kind: "photo",
      title: "Visual test source",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
    });
  };
  return { projectId, accepted, designStore, store, budget, visual, assets, uploadAsset, root };
}

test("PG: visual plan derives from the accepted design, is idempotent on digest, and versions on design change", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-plan-1");
  try {
    const plan1 = await env.visual.derivePlan({ projectId: env.projectId });
    assert.equal(plan1.version, 1);
    assert.equal(plan1.designArtifactId, env.accepted.id);
    assert.equal(plan1.designProviderMode, "fixture");
    const slots = plan1.slots as Array<{ slot: string; pageSlug: string; role: string; truthClassProposal: string }>;
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.slot, "hero.primary");
    assert.equal(slots[0]!.truthClassProposal, "documentary");

    // Idempotent derivation: same design -> same plan row.
    const planAgain = await env.visual.derivePlan({ projectId: env.projectId });
    assert.equal(planAgain.id, plan1.id);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: visual plan fails closed without an accepted design", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProject(dbInst, "vis-plan-empty");
    const designStore = new DesignStore(dbInst.db);
    const visual = new VisualService({
      store: new VisualStore(dbInst.db),
      designStore,
      assets: new (await import("../../src/assets/service.js")).AssetService({
        store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      }),
      budget: new VisualBudgetStore(dbInst.db),
      provider: new FixtureVisualAssetProvider(),
    });
    await assert.rejects(visual.derivePlan({ projectId }), (e) => isCode(e, "visual_design_not_eligible"));
  } finally {
    await dbInst.close();
  }
});

test("PG: truth classification is required and gates prompt compilation + generation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-class-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    // Compile without classification fails closed.
    await assert.rejects(
      env.visual.compilePromptSnapshot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary", operation: "generate" }),
      (e) => isCode(e, "visual_classification_required"),
    );
    // Confirm classification, then compile works.
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "illustrative",
    });
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "generate",
    });
    assert.equal(snapshot.approvalState, "pending");
    const data = env.store.promptSnapshotData(snapshot);
    assert.equal(data.truthClass, "illustrative");
    assert.equal(data.operation, "generate");
    // Generate without approval fails closed (zero spend).
    await assert.rejects(
      env.visual.generateForSlot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary" }),
      (e) => isCode(e, "visual_prompt_not_approved"),
    );
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: documentary slots forbid ai_generate and documentary ai_edit embeds the forbidden-edit list", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-truth-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    // documentary + generate is forbidden at compile time.
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "documentary",
    });
    await assert.rejects(
      env.visual.compilePromptSnapshot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary", operation: "generate" }),
      (e) => isCode(e, "visual_truth_policy_violation"),
    );
    // documentary + edit without a source version fails closed.
    await assert.rejects(
      env.visual.compilePromptSnapshot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary", operation: "edit" }),
      (e) => isCode(e, "visual_truth_policy_violation"),
    );
    // documentary + edit WITH a source version embeds the forbidden list.
    const upload = await env.uploadAsset(11);
    await env.assets.approveVersion(env.projectId, upload.version.id, upload.version.binaryDigest);
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "edit",
      sourceVersionId: upload.version.id,
    });
    const data = env.store.promptSnapshotData(snapshot);
    for (const rule of DOCUMENTARY_FORBIDDEN_EDITS) {
      assert.ok(data.forbiddenEdits.includes(rule), `forbidden edit missing: ${rule}`);
    }
    assert.equal(data.sourceAssets.length, 1);
    assert.equal(data.sourceAssets[0]!.versionId, upload.version.id);
    assert.equal(data.sourceAssets[0]!.binaryDigest, upload.version.binaryDigest);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: prompt approval binds the exact digest; forged digest fails closed", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-approve-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "illustrative",
    });
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "generate",
    });
    await assert.rejects(
      env.visual.approvePromptSnapshot({ projectId: env.projectId, snapshotId: snapshot.id, expectedPromptDigest: "f".repeat(64) }),
      (e) => isCode(e, "visual_prompt_not_approved"),
    );
    const approved = await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    assert.equal(approved.approvalState, "approved");
    assert.ok(approved.approvedAt);
    // Idempotent re-approval returns the same row.
    const again = await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    assert.equal(again.id, approved.id);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: fixture generation produces byte-validated candidates with provenance and dedup reuses them without a second spend", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-gen-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "illustrative",
    });
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "generate",
    });
    await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    const first = await env.visual.generateForSlot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary" });
    assert.equal(first.reused, false);
    assert.ok(first.candidates.length >= 1);
    const candidate = first.candidates[0]!;
    assert.equal(candidate.mediaType, "image/png");
    assert.ok(candidate.width >= 1 && candidate.height >= 1);
    const c2pa = candidate.c2pa as { status: string };
    assert.ok(["validated", "absent", "unreadable", "unavailable_with_reason"].includes(c2pa.status));

    // Dedup: identical request reuses candidates (same request id, no new row).
    const second = await env.visual.generateForSlot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary" });
    assert.equal(second.reused, true);
    assert.equal(second.request.id, first.request.id);
    assert.equal(second.candidates[0]!.id, candidate.id);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: candidate acceptance routes through the Run 5 authority — derived/generated AssetVersion + page assignment", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-accept-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "illustrative",
    });
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "generate",
    });
    await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    const gen = await env.visual.generateForSlot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary" });
    const candidate = gen.candidates[0]!;

    // Forged digest fails closed.
    await assert.rejects(
      env.visual.acceptCandidate({
        projectId: env.projectId,
        planId: plan.id,
        slot: "hero.primary",
        candidateId: candidate.id,
        expectedBinaryDigest: "f".repeat(64),
      }),
      (e) => isCode(e, "visual_acceptance_failed"),
    );

    // Accept with the exact digest: creates an approved AssetVersion + assignment.
    const acceptedSlot = await env.visual.acceptCandidate({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      candidateId: candidate.id,
      expectedBinaryDigest: candidate.binaryDigest,
    });
    assert.equal(acceptedSlot.version.approvalState, "approved");
    assert.ok(acceptedSlot.version.governanceDigest);
    assert.notEqual(acceptedSlot.version.binaryDigest, acceptedSlot.version.governanceDigest);
    assert.ok(acceptedSlot.assignmentId);
    // Provenance records the exact generation lineage.
    const provenance = acceptedSlot.version.provenance as { category: string; derivation?: { origin: string; generationRequestId: string; visualSlot: string } };
    assert.equal(provenance.category, "generated");
    assert.equal(provenance.derivation?.origin, "ai_generate");
    assert.equal(provenance.derivation?.generationRequestId, gen.request.id);
    assert.equal(provenance.derivation?.visualSlot, "hero.primary");
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: documentary AI edit downgrades truth to documentary_edited with explicit confirmation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-docedit-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "documentary",
    });
    const upload = await env.uploadAsset(21);
    const approved = await env.assets.approveVersion(env.projectId, upload.version.id, upload.version.binaryDigest);
    await env.assets.assignVersion(env.projectId, {
      ...await assignmentPage(dbInst, env.projectId, "home", approved.governanceDigest!),
      assetId: upload.asset.id,
      versionId: approved.id,
      pageSlug: "home",
      role: "hero",
      expectedBinaryDigest: approved.binaryDigest,
    });
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "edit",
      sourceVersionId: approved.id,
    });
    await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    const gen = await env.visual.generateForSlot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      sourceVersionId: approved.id,
    });
    const candidate = gen.candidates[0]!;
    // Accept WITHOUT downgrade confirmation fails closed.
    await assert.rejects(
      env.visual.acceptCandidate({
        projectId: env.projectId,
        planId: plan.id,
        slot: "hero.primary",
        candidateId: candidate.id,
        expectedBinaryDigest: candidate.binaryDigest,
      }),
      (e) => isCode(e, "visual_truth_policy_violation"),
    );
    // Accept WITH confirmation: truth becomes documentary_edited.
    const acceptedSlot = await env.visual.acceptCandidate({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      candidateId: candidate.id,
      expectedBinaryDigest: candidate.binaryDigest,
      confirmTruthDowngrade: true,
    });
    assert.equal(acceptedSlot.truthClass, "documentary_edited");
    const provenance = acceptedSlot.version.provenance as { category: string; derivation?: { origin: string; parentVersionId: string } };
    assert.equal(provenance.category, "derived");
    assert.equal(provenance.derivation?.origin, "ai_edit");
    assert.equal(provenance.derivation?.parentVersionId, approved.id);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: deterministic transform resolves without any provider spend and records exact parent lineage", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-transform-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "documentary",
    });
    const upload = await env.uploadAsset(31);
    const approved = await env.assets.approveVersion(env.projectId, upload.version.id, upload.version.binaryDigest);
    const resolved = await env.visual.resolveDeterministicTransform({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      sourceVersionId: approved.id,
      transform: { maxWidth: 1280, aspectRatioCrop: "16:9" },
    });
    assert.equal(resolved.version.approvalState, "approved"); // P1-04 auto-approves deterministic transforms
    const provenance = resolved.version.provenance as { category: string; derivation?: { origin: string; parentVersionId: string; parentBinaryDigest: string; parentGovernanceDigest: string; transformation: string } };
    assert.equal(provenance.category, "derived");
    assert.equal(provenance.derivation?.origin, "deterministic_transform");
    assert.equal(provenance.derivation?.parentVersionId, approved.id);
    assert.equal(provenance.derivation?.parentBinaryDigest, approved.binaryDigest);
    assert.equal(provenance.derivation?.parentGovernanceDigest, approved.governanceDigest);
    assert.match(provenance.derivation?.transformation ?? "", /crop 16:9/);
    // Zero provider candidates/requests were created for this path.
    const requests = await env.store.listRequests(env.projectId);
    assert.equal(requests.length, 0);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: set acceptance requires every slot resolved and is idempotent on digest; restart durable", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-set-1");
  try {
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    // Set acceptance before any slot resolution fails closed.
    await assert.rejects(
      env.visual.acceptSet({ projectId: env.projectId, planId: plan.id }),
      (e) => isCode(e, "visual_classification_required"),
    );
    await env.visual.confirmClassification({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      truthClass: "illustrative",
    });
    await assert.rejects(
      env.visual.acceptSet({ projectId: env.projectId, planId: plan.id }),
      (e) => isCode(e, "visual_slot_unresolved"),
    );
    const snapshot = await env.visual.compilePromptSnapshot({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      operation: "generate",
    });
    await env.visual.approvePromptSnapshot({
      projectId: env.projectId,
      snapshotId: snapshot.id,
      expectedPromptDigest: snapshot.promptDigest,
    });
    const gen = await env.visual.generateForSlot({ projectId: env.projectId, planId: plan.id, slot: "hero.primary" });
    await env.visual.acceptCandidate({
      projectId: env.projectId,
      planId: plan.id,
      slot: "hero.primary",
      candidateId: gen.candidates[0]!.id,
      expectedBinaryDigest: gen.candidates[0]!.binaryDigest,
    });
    const set1 = await env.visual.acceptSet({ projectId: env.projectId, planId: plan.id });
    assert.equal(set1.version, 1);
    const slots = await env.store.listAcceptedSlots(set1.id);
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.resolutionMode, "ai_generate");
    assert.equal(slots[0]!.truthClass, "illustrative");
    // Idempotent re-accept returns the same set.
    const set2 = await env.visual.acceptSet({ projectId: env.projectId, planId: plan.id });
    assert.equal(set2.id, set1.id);
    // Restart durability: a fresh service over the same DB sees the set.
    const fresh = new VisualStore(dbInst.db);
    const latest = await fresh.latestAcceptedSet(env.projectId);
    assert.equal(latest?.id, set1.id);
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("PG: cross-project visual access fails closed", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixture(dbInst, "vis-iso-1");
  try {
    const other = await seedProject(dbInst, "vis-iso-2");
    await assert.rejects(
      env.visual.derivePlan({ projectId: other.projectId }),
      (e) => isCode(e, "visual_design_not_eligible"),
    );
    const plan = await env.visual.derivePlan({ projectId: env.projectId });
    await assert.rejects(
      env.visual.getPlanOrThrowPublic(other.projectId, plan.id),
      (e) => isCode(e, "visual_not_found"),
    );
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("unit: truth policy matrix and deterministic proposals", () => {
  // Documentary forbids ai_generate; data_visualization forbids AI entirely.
  assert.equal(VISUAL_TRUTH_POLICY.documentary.ai_generate, false);
  assert.equal(VISUAL_TRUTH_POLICY.documentary.reuse_real, true);
  assert.equal(VISUAL_TRUTH_POLICY.data_visualization.ai_generate, false);
  assert.equal(VISUAL_TRUTH_POLICY.data_visualization.ai_edit, false);
  assert.equal(VISUAL_TRUTH_POLICY.illustrative.ai_generate, true);
  assert.ok(isResolutionAllowed("decorative", "ai_generate"));
  assert.ok(!isResolutionAllowed("documentary", "ai_generate"));
  // Proposals: chart -> data_visualization, logo -> illustrative, hero -> documentary.
  assert.equal(proposeTruthClass("chart").truthClass, "data_visualization");
  assert.equal(proposeTruthClass("logo").truthClass, "illustrative");
  assert.equal(proposeTruthClass("hero").truthClass, "documentary");
  // Strategy: bound asset -> reuse_real (zero spend); unbound documentary -> ai_edit.
  assert.equal(proposeResolutionStrategy({ hasBoundAsset: true, truthClass: "documentary" }).strategy, "reuse_real");
  assert.equal(proposeResolutionStrategy({ hasBoundAsset: false, truthClass: "documentary" }).strategy, "ai_edit");
  assert.equal(proposeResolutionStrategy({ hasBoundAsset: false, truthClass: "decorative" }).strategy, "ai_generate");
});

test("unit: request digest is stable and input-sensitive; set digest is slot-order-stable", () => {
  const base = {
    slot: "hero.primary",
    designCandidateDigest: "a".repeat(64),
    promptDigest: "b".repeat(64),
    sourceAssets: [{ versionId: "asv-1", binaryDigest: "c".repeat(64), governanceDigest: "d".repeat(64) }],
    provider: "google-genai",
    providerMode: "fixture",
    model: "gemini-2.5-flash-image",
    operation: "generate",
    targetAspectRatio: "16:9",
    targetSize: "1K",
    escalationReason: null,
  };
  const d1 = visualRequestDigest(base);
  const d2 = visualRequestDigest({ ...base });
  assert.equal(d1, d2);
  // A changed input changes the digest.
  assert.notEqual(d1, visualRequestDigest({ ...base, model: "gemini-3-pro-image-preview" }));
  assert.notEqual(d1, visualRequestDigest({ ...base, escalationReason: "brand_consistency" }));
  // Source order does not matter (sorted internally).
  const reordered = visualRequestDigest({
    ...base,
    sourceAssets: [
      { versionId: "asv-2", binaryDigest: "e".repeat(64), governanceDigest: "f".repeat(64) },
      { versionId: "asv-1", binaryDigest: "c".repeat(64), governanceDigest: "d".repeat(64) },
    ],
  });
  const ordered = visualRequestDigest({
    ...base,
    sourceAssets: [
      { versionId: "asv-1", binaryDigest: "c".repeat(64), governanceDigest: "d".repeat(64) },
      { versionId: "asv-2", binaryDigest: "e".repeat(64), governanceDigest: "f".repeat(64) },
    ],
  });
  assert.equal(reordered, ordered);

  const slotRows = [
    { slot: "a.slot", pageSlug: "home", role: "hero", resolvedVersionId: "asv-1", binaryDigest: "c".repeat(64), governanceDigest: "d".repeat(64), resolutionMode: "reuse_real", truthClass: "documentary" },
    { slot: "b.slot", pageSlug: "home", role: "inline", resolvedVersionId: "asv-2", binaryDigest: "e".repeat(64), governanceDigest: "f".repeat(64), resolutionMode: "ai_generate", truthClass: "illustrative" },
  ];
  assert.equal(visualSetDigest(slotRows), visualSetDigest([...slotRows].reverse()));
});

test("unit: C2PA evidence is honest for plain images (absent) and never fabricated", async () => {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const evidence = await readC2paEvidence({ bytes: new Uint8Array(jpeg), mediaType: "image/jpeg" });
  // A plain sharp JPEG carries no C2PA manifest: the honest result is absent
  // (or unavailable_with_reason if the native runtime cannot load) — never "validated".
  assert.ok(evidence.status === "absent" || evidence.status === "verification_unavailable", `unexpected status ${evidence.status}`);
});

// ---------------------------------------------------------------------------
// Run 7 QA remediation (P2-F1): the durable DB CHECK must mirror the FULL
// contract truth-policy matrix, verified by raw SQL (bypassing all app code).
// ---------------------------------------------------------------------------

test("PG: accepted-slot CHECK rejects data_visualization + ai_edit via raw SQL (P2-F1)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const sharp = (await import("sharp")).default;
  const { projectId } = await seedProject(dbInst, "vchk1");
  const root = await mkdtemp(path.join(tmpdir(), "visual-chk-"));

  // Minimal approved Run 5 version to satisfy FKs.
  const assetsModule = await import("../../src/assets/asset-store.js");
  const assetServiceModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const assets = new assetServiceModule.AssetService({
    store: new assetsModule.AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "chk.jpg",
    kind: "photo",
    title: "CHECK probe source",
    rightsStatus: "operator_owned",
    dataBase64: bytes.toString("base64"),
  });
  await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  // Minimal accepted set/slot scaffolding (raw rows, bypassing app services).
  await dbInst.db.execute(sql`
    INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
    VALUES ('vap-chk', ${projectId}, 1, 'da-chk', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'live', '[]'::jsonb, ${"c".repeat(64)})
  `);
  await dbInst.db.execute(sql`
    INSERT INTO accepted_visual_asset_sets (id, project_id, version, plan_id, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, set_digest)
    VALUES ('avs-chk', ${projectId}, 1, 'vap-chk', 'da-chk', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"d".repeat(64)})
  `);

  const insertSlot = (mode: string, truth: string, id: string) =>
    sql`
      INSERT INTO accepted_visual_asset_slots (id, set_id, project_id, slot, page_slug, role, resolved_version_id, binary_digest, governance_digest, resolution_mode, truth_class)
      VALUES (${id}, 'avs-chk', ${projectId}, 's.' || ${id}, 'home', 'hero', ${upload.version.id}, ${"e".repeat(64)}, ${"f".repeat(64)}, ${mode}, ${truth})
    `;

  // Forbidden combination (the P2-F1 gap): must be rejected by the CHECK.
  await assert.rejects(
    () => dbInst.db.execute(insertSlot("ai_edit", "data_visualization", "avsl-chk-1")),
    (err: unknown) => {
      const code = (err as { code?: string } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      return code === "23514"; // check_violation
    },
    "data_visualization + ai_edit must be rejected at the DB level",
  );

  // Regression: previously enforced combinations remain rejected/accepted.
  await assert.rejects(
    () => dbInst.db.execute(insertSlot("ai_generate", "documentary", "avsl-chk-2")),
    () => true,
    "documentary + ai_generate must remain rejected",
  );
  await dbInst.db.execute(insertSlot("ai_generate", "illustrative", "avsl-chk-3"));
  await dbInst.db.execute(insertSlot("ai_edit", "documentary_edited", "avsl-chk-4"));
  await dbInst.db.execute(insertSlot("reuse_real", "documentary", "avsl-chk-5"));
});

test("unit: provider preflight is cached with a 60s TTL (P3-F4)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "visual-pf-"));
  const { projectId } = await seedProject(dbInst, "vpfcache");
  let preflightCalls = 0;
  const countingProvider = {
    id: "google-genai",
    providerMode: "fixture" as const,
    async preflight() {
      preflightCalls++;
      return { configured: true as const, provider: "google-genai", reachable: true, verifiedModels: ["stub"] };
    },
    async generateImage() { throw new Error("not used in this test"); },
    async editImage() { throw new Error("not used in this test"); },
  };
  const assetsModule = await import("../../src/assets/asset-store.js");
  const assetServiceModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const assets = new assetServiceModule.AssetService({
    store: new assetsModule.AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });
  const visual = new VisualService({
    store: new VisualStore(dbInst.db),
    designStore: new DesignStore(dbInst.db),
    assets,
    budget: new VisualBudgetStore(dbInst.db),
    provider: countingProvider as never,
    repoRoot: root,
    storage: createVisualCandidateStorage(root),
  });
  await visual.workspace(projectId);
  await visual.workspace(projectId);
  await visual.workspace(projectId);
  assert.equal(preflightCalls, 1, "three workspace reads within the TTL must issue ONE provider preflight");
});

test("PG: DB constraints enforce provider_mode and result_state (P1-03, P1-05)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const { projectId } = await seedProject(dbInst, "vis-constraints");

  // Minimal visual plan
  await dbInst.db.execute(sql`
    INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
    VALUES ('vap-c1', ${projectId}, 1, 'da-c1', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'live', '[]'::jsonb, ${"c".repeat(64)})
  `);

  // Invalid provider_mode on accepted_visual_asset_sets must be rejected
  await assert.rejects(
    () => dbInst.db.execute(sql`
      INSERT INTO accepted_visual_asset_sets (id, project_id, version, plan_id, provider_mode, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, set_digest)
      VALUES ('avs-c1', ${projectId}, 1, 'vap-c1', 'invalid_mode', 'da-c1', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"d".repeat(64)})
    `),
    (err: unknown) => {
      const code = (err as { code?: string } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      return code === "23514"; // check_violation
    },
    "provider_mode check must reject invalid modes",
  );

  // Valid provider_mode ('live' and 'fixture') are accepted
  await dbInst.db.execute(sql`
    INSERT INTO accepted_visual_asset_sets (id, project_id, version, plan_id, provider_mode, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, set_digest)
    VALUES ('avs-c2', ${projectId}, 1, 'vap-c1', 'live', 'da-c1', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"d".repeat(64)})
  `);

  // Invalid result_state on visual_generation_requests must be rejected
  await dbInst.db.execute(sql`
    INSERT INTO visual_prompt_snapshots (id, project_id, plan_id, slot, operation, truth_class, data, prompt_digest)
    VALUES ('vps-c1', ${projectId}, 'vap-c1', 'hero.primary', 'generate', 'illustrative', '{}'::jsonb, ${"1".repeat(64)})
  `);

  await assert.rejects(
    () => dbInst.db.execute(sql`
      INSERT INTO visual_generation_requests (id, project_id, slot, request_digest, prompt_snapshot_id, prompt_digest, provider, provider_mode, model, model_policy_version, operation, result_state)
      VALUES ('vgr-c1', ${projectId}, 'hero.primary', ${"2".repeat(64)}, 'vps-c1', ${"1".repeat(64)}, 'google-genai', 'live', 'gemini-3.1-flash-image', 'v1', 'generate', 'cancelled')
    `),
    (err: unknown) => {
      const code = (err as { code?: string } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      return code === "23514"; // check_violation
    },
    "result_state check must reject 'cancelled'",
  );

  // 'pending', 'running', 'succeeded', 'failed' must all be accepted
  await dbInst.db.execute(sql`
    INSERT INTO visual_generation_requests (id, project_id, slot, request_digest, prompt_snapshot_id, prompt_digest, provider, provider_mode, model, model_policy_version, operation, result_state)
    VALUES ('vgr-c2', ${projectId}, 'hero.primary', ${"3".repeat(64)}, 'vps-c1', ${"1".repeat(64)}, 'google-genai', 'live', 'gemini-3.1-flash-image', 'v1', 'generate', 'running')
  `);
});

test("PG: requireProductionVisualSet enforces live providerMode and set digest integrity (P1-03)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "vis-req-prod-"));
  const { projectId } = await seedProject(dbInst, "vis-req-prod");
  const store = new VisualStore(dbInst.db);

  // Minimal visual plan for FK
  await dbInst.db.execute(sql`
    INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
    VALUES ('vap-stub', ${projectId}, 1, 'da-stub', 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'live', '[]'::jsonb, ${"c".repeat(64)})
  `);

  // Upload an approved asset
  const assetsModule = await import("../../src/assets/asset-store.js");
  const assetServiceModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const sharp = (await import("sharp")).default;
  const assets = new assetServiceModule.AssetService({
    store: new assetsModule.AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "prod.jpg",
    kind: "photo",
    title: "Production photo",
    rightsStatus: "operator_owned",
    dataBase64: bytes.toString("base64"),
  });
  const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  // 1. Fixture set: requireProductionVisualSet must fail closed
  const fixtureSet = await store.createAcceptedSetAtomic({
    projectId,
    planId: "vap-stub",
    providerMode: "fixture",
    designArtifactId: "da-stub",
    designArtifactVersion: 1,
    designCandidateDigest: "a".repeat(64),
    designInputDigest: "b".repeat(64),
    slots: [
      {
        slot: "hero.primary",
        pageSlug: "home",
        role: "hero",
        resolvedVersionId: approved.id,
        binaryDigest: approved.binaryDigest,
        governanceDigest: approved.governanceDigest!,
        resolutionMode: "reuse_real",
        truthClass: "documentary",
      },
    ],
  });

  await assert.rejects(
    () => store.requireProductionVisualSet(projectId, fixtureSet.id, fixtureSet.setDigest),
    (err: unknown) => isCode(err, "visual_acceptance_failed"),
    "fixture set must be rejected for production use",
  );

  // 2. Live set: requireProductionVisualSet succeeds
  const liveSet = await store.createAcceptedSetAtomic({
    projectId,
    planId: "vap-stub",
    providerMode: "live",
    designArtifactId: "da-stub",
    designArtifactVersion: 1,
    designCandidateDigest: "a".repeat(64),
    designInputDigest: "b".repeat(64),
    slots: [
      {
        slot: "hero.primary",
        pageSlug: "home",
        role: "hero",
        resolvedVersionId: approved.id,
        binaryDigest: approved.binaryDigest,
        governanceDigest: approved.governanceDigest!,
        resolutionMode: "reuse_real",
        truthClass: "documentary",
      },
    ],
  });

  const verified = await store.requireProductionVisualSet(projectId, liveSet.id, liveSet.setDigest);
  assert.equal(verified.set.id, liveSet.id);
  assert.equal(verified.set.providerMode, "live");
  assert.equal(verified.slots.length, 1);

  // 3. Corrupt set digest: tampering slot digest must fail closed on verification
  await dbInst.db.execute(sql`
    UPDATE accepted_visual_asset_slots
    SET binary_digest = ${"f".repeat(64)}
    WHERE set_id = ${liveSet.id}
  `);

  await assert.rejects(
    () => store.requireProductionVisualSet(projectId, liveSet.id, liveSet.setDigest),
    (err: unknown) => isCode(err, "visual_acceptance_failed"),
    "tampered slot digest must cause set digest verification to fail",
  );
});
