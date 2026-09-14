import { assignmentPage, acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { DesignStore } from "../../src/design/design-store.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { FactoryError } from "../../src/executor/errors.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";

/**
 * Run 6 persistence suite — real PostgreSQL (dedicated factory_test DB).
 * Covers: input snapshot derivation/idempotency, staleness across upstream
 * mutation, candidate immutability, human-acceptance digest binding,
 * rejection immutability, accepted-version allocation, cross-project
 * isolation, and restart durability (fresh store instance over same DB).
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

test("PG: design input snapshot derives from accepted inputs and is idempotent on identical upstream", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn1");
    const v1 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(v1.version, 1);
    assert.match(v1.inputDigest, /^[0-9a-f]{64}$/);
    // Re-derivation with unchanged upstream returns the same snapshot.
    const again = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(again.id, v1.id);
    assert.equal(again.version, 1);
    // No accepted inputs -> fail closed.
    const empty = await seedProject(dbInst, "dsn1b");
    void empty;
    await assert.rejects(
      designStore.deriveInputSnapshotDraft({ projectId: "no-such-project" }),
      (e: unknown) => isCode(e, "design_input_not_accepted"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted-input mutation creates a new input snapshot version", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn2");
    const v1 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    // Mutate accepted inputs: edit draft + accept v2.
    const payload = buildIntakePayload();
    const draft = await intake.getDraft(seed.projectId);
    assert.ok(draft);
    const mutated = structuredClone(payload);
    (mutated as { brand: { positioning: string } }).brand.positioning = "Changed positioning";
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload: mutated });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: draft.revision + 1,
      expectedDigest: deterministicDigest(mutated),
    });
    const v2 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(v2.version, 2);
    assert.notEqual(v2.inputDigest, v1.inputDigest);
    // v1 is now stale.
    const staleness = await designStore.inputSnapshotStaleness(seed.projectId, v1);
    assert.equal(staleness.stale, true);
    assert.match(staleness.reason ?? "", /changed/i);
    // v2 is current.
    const staleness2 = await designStore.inputSnapshotStaleness(seed.projectId, v2);
    assert.equal(staleness2.stale, false);
  } finally {
    await dbInst.close();
  }
});

test("PG: candidate persists immutably and acceptance binds exact digest", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn3");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const data = candidateData();
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data,
    });
    assert.equal(candidate.approvalState, "pending");
    assert.equal(candidate.candidateDigest, deterministicDigest(data));

    // Wrong digest fails closed.
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: "f".repeat(64),
        reviewNotes: "fixture acceptance",
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );

    const accepted = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "fixture acceptance — approved in review",
    });
    assert.equal(accepted.version, 1);
    assert.equal(accepted.candidateDigest, candidate.candidateDigest);
    assert.equal(accepted.inputDigest, snapshot.inputDigest);
    assert.equal(accepted.designMdDigest, data.designMdDigest);

    // Idempotent same-digest acceptance returns the same artifact.
    const again = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "fixture acceptance — idempotent re-acceptance",
    });
    assert.equal(again.id, accepted.id);

    // Accepted candidate cannot be rejected (immutable).
    await assert.rejects(
      designStore.rejectCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: rejected candidate can never become accepted; cross-project access fails", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seedA = await seedProject(dbInst, "dsn4a");
    const seedB = await seedProject(dbInst, "dsn4b");
    const snapshotA = await designStore.deriveInputSnapshotDraft({ projectId: seedA.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seedA.projectId,
      inputSnapshot: snapshotA,
      data: candidateData(),
    });
    const rejected = await designStore.rejectCandidate({
      projectId: seedA.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "Does not meet quality floor",
    });
    assert.equal(rejected.approvalState, "rejected");
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seedA.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "fixture acceptance",
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );
    // Cross-project candidate access fails closed.
    assert.equal(await designStore.getCandidate(seedB.projectId, candidate.id), null);
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seedB.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "fixture acceptance",
      }),
      (e: unknown) => isCode(e, "design_not_found"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: stale candidate acceptance is rejected when upstream inputs moved", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn5");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    // Mutate accepted inputs AFTER candidate creation.
    const payload = buildIntakePayload();
    const draft = await intake.getDraft(seed.projectId);
    assert.ok(draft);
    const mutated = structuredClone(payload);
    (mutated as { brand: { tone: string } }).brand.tone = "New tone";
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload: mutated });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: draft.revision + 1,
      expectedDigest: deterministicDigest(mutated),
    });
    // Acceptance must fail closed on the stale input digest.
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "fixture acceptance",
      }),
      (e: unknown) => isCode(e, "design_input_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted design staleness tracks upstream content mutation; restart durability", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const seed = await seedProject(dbInst, "dsn6");
    let designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "fixture acceptance",
    });
    const latest1 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest1);
    assert.equal(latest1.staleness.stale, false);

    // RESTART: fresh store instance over the same DB (no reset).
    designStore = new DesignStore(dbInst.db);
    const latest2 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest2);
    assert.equal(latest2.artifact.id, latest1.artifact.id);
    assert.equal(latest2.staleness.stale, false);

    // Mutate upstream authority behind the design -> design becomes stale.
    // The seed has no accepted page content, so staleness is proven through
    // the "new accepted content exists" path (an upstream addition the
    // design's bound snapshot does not know about).
    await dbInst.db.execute(
      `INSERT INTO accepted_page_content (id, project_id, version, slug, proposal_id, proposal_version, proposal_digest, qa_report_digest, data, content_digest)
       VALUES ('wacc-dbg-stale', '${seed.projectId}', 1, 'fixture-page', 'p1', 1, '${"a".repeat(64)}', '${"b".repeat(64)}', '{}', '${"c".repeat(64)}')`,
    );
    const latest3 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest3);
    assert.equal(latest3.staleness.stale, true);
    assert.match(latest3.staleness.reason ?? "", /accepted content/i);
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted design version allocation increments per project", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn7");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const c1 = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    const a1 = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: c1.id,
      expectedCandidateDigest: c1.candidateDigest,
      reviewNotes: "fixture acceptance",
    });
    assert.equal(a1.version, 1);
    // New candidate (different rationale) after a NEW input snapshot version.
    const snapshot2 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(snapshot2.version, 1); // idempotent — unchanged upstream
    const data2 = parseDesignCandidateData({
      ...JSON.parse(JSON.stringify(candidateData())),
      rationale: "Revised rationale",
    });
    const c2 = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot2,
      data: data2,
    });
    const a2 = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: c2.id,
      expectedCandidateDigest: c2.candidateDigest,
      reviewNotes: "fixture acceptance",
    });
    assert.equal(a2.version, 2);
    const all = await designStore.listAcceptedDesigns(seed.projectId);
    assert.equal(all.length, 2);
  } finally {
    await dbInst.close();
  }
});

test("PG: Run 5 governance lineage survives candidate/acceptance, rejects forgery, and stales on replacement", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { eq } = await import("drizzle-orm");
  const { acceptedPageContent, assetPageAssignments } = await import("../../src/persistence/schema.js");
  const { AssetStore } = await import("../../src/assets/asset-store.js");
  const { AssetService } = await import("../../src/assets/service.js");
  const { createAssetStorage } = await import("../../src/assets/storage.js");
  const { DesignService } = await import("../../src/design/service.js");
  const { FixtureDesignProvider } = await import("../../src/design/fixture-provider.js");
  const sharp = (await import("sharp")).default;
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "design-lineage-"));
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "design-exact-lineage");
    const acceptedPages = [];
    for (const slug of ["home", "services/foo"]) acceptedPages.push(await acceptFixturePage(dbInst, projectId, slug));
    // Deliberately shared digest proves routing depends on page identity too.
    await dbInst.db.update(acceptedPageContent).set({ contentDigest: "c".repeat(64) }).where(eq(acceptedPageContent.projectId, projectId));
    const assets = new AssetService({ store: new AssetStore(dbInst.db), storage: createAssetStorage(root) });
    async function upload(seed: number) {
      const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: seed, g: 70, b: 90 } } }).jpeg().toBuffer();
      const result = await assets.uploadAsset(projectId, { filename: "fixture.jpg", kind: "photo", title: "Synthetic test pixels", rightsStatus: "operator_owned", dataBase64: bytes.toString("base64") });
      const approved = await assets.approveVersion(projectId, result.version.id, result.version.binaryDigest);
      return { ...result, approved };
    }
    const first = await upload(30);
    const assignment = await assets.assignVersion(projectId, {
      ...await assignmentPage(dbInst, projectId, "services/foo", first.approved.governanceDigest!),
      assetId: first.asset.id, versionId: first.version.id, pageSlug: "services/foo", role: "supporting", expectedBinaryDigest: first.version.binaryDigest,
    });
    const store = new DesignStore(dbInst.db);
    const snapshot = await store.deriveInputSnapshotDraft({ projectId });
    const snapshotData = snapshot.data as import("@factory/contracts").DesignInputSnapshotData;
    assert.equal(snapshotData.assetRefs[0]!.governanceDigest, first.approved.governanceDigest);
    assert.equal(snapshotData.assetRefs[0]!.governanceDigest, assignment.versionDigest);
    assert.equal(snapshotData.assetRefs[0]!.binaryDigest, first.version.binaryDigest);
    assert.notEqual(snapshotData.assetRefs[0]!.binaryDigest, snapshotData.assetRefs[0]!.governanceDigest);
    const fixture = new FixtureDesignProvider();
    let corrupt = false;
    let received: import("@factory/contracts").DesignGenerationRequest | undefined;
    const service = await DesignService.create({ store, repoRoot: root, provider: {
      id: fixture.id, preflight: () => fixture.preflight(),
      async generateDesignSystem(request) {
        received = request;
        const result = await fixture.generateDesignSystem(request);
        if (corrupt) result.candidate.archetypes.find((a) => a.kind === "service")!.assetSlots[0]!.boundGovernanceDigest = "f".repeat(64);
        return result;
      },
    } });
    const candidate = await service.generateCandidate({ projectId });
    assert.equal(received!.acceptedCopyByArchetype.homepage!.introduction, (acceptedPages[0]!.data as any).introduction);
    assert.equal(received!.acceptedCopyByArchetype.service!.introduction, (acceptedPages[1]!.data as any).introduction);
    const slot = candidate.data.archetypes.find((a) => a.kind === "service")!.assetSlots[0]!;
    assert.equal(slot.boundGovernanceDigest, assignment.versionDigest);
    assert.equal(slot.boundBinaryDigest, first.version.binaryDigest);
    const forged = structuredClone(candidate.data);
    forged.archetypes.find((a) => a.kind === "service")!.assetSlots[0]!.boundGovernanceDigest = "f".repeat(64);
    assert.notEqual(deterministicDigest(forged), candidate.candidateDigest);
    const countBefore = (await store.listCandidates(projectId)).length;
    corrupt = true;
    await assert.rejects(service.generateCandidate({ projectId }), (e) => isCode(e, "design_approval_failed"));
    assert.equal((await store.listCandidates(projectId)).length, countBefore, "forged lineage never persists");
    const accepted = await service.acceptCandidate({ projectId, candidateId: candidate.id, expectedCandidateDigest: candidate.candidateDigest, reviewNotes: "fixture only; deterministic authority test" });
    assert.equal(accepted.data.archetypes.find((a) => a.kind === "service")!.assetSlots[0]!.boundGovernanceDigest, assignment.versionDigest);
    const restarted = new DesignStore(dbInst.db);
    assert.equal((await restarted.latestAcceptedDesign(projectId))!.artifact.providerMode, "fixture");
    await assert.rejects(restarted.requireProductionDesign(projectId, accepted.id, accepted.candidateDigest), (e) => isCode(e, "design_approval_failed"));
    // Forged assignment governance cannot be accepted as current upstream.
    await dbInst.db.update(assetPageAssignments).set({ versionDigest: "f".repeat(64) }).where(eq(assetPageAssignments.id, assignment.id));
    assert.equal((await restarted.inputSnapshotStaleness(projectId, snapshot)).stale, true);
    await assert.rejects(restarted.deriveInputSnapshotDraft({ projectId }), (e) => isCode(e, "design_input_stale"));
    await dbInst.db.update(assetPageAssignments).set({ versionDigest: assignment.versionDigest }).where(eq(assetPageAssignments.id, assignment.id));
    assert.equal((await restarted.inputSnapshotStaleness(projectId, snapshot)).stale, false);
    const second = await upload(50);
    await assets.replaceAssignment(projectId, assignment.id, { toVersionId: second.version.id, expectedBinaryDigest: second.version.binaryDigest });
    assert.equal((await restarted.inputSnapshotStaleness(projectId, snapshot)).stale, true);
    const stale = (await restarted.latestAcceptedDesign(projectId))!;
    assert.equal(stale.staleness.stale, true);
    assert.deepEqual(stale.artifact.data, accepted.data, "upstream replacement never mutates accepted design");
  } finally { await dbInst.close(); await rm(root, { recursive: true, force: true }); }
});

test("PG: exact production authority gate rejects fixtures, wrong project/digest and stale live-classified test records", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProject(dbInst, "design-production-gate");
    const store = new DesignStore(dbInst.db);
    const snapshot = await store.deriveInputSnapshotDraft({ projectId });
    // Synthetic record tests the gate only; NOT live provider/human evidence.
    const data = { ...candidateData(), providerMode: "live" as const };
    const candidate = await store.createCandidate({ projectId, inputSnapshot: snapshot, data });
    const accepted = await store.acceptCandidate({ projectId, candidateId: candidate.id, expectedCandidateDigest: candidate.candidateDigest, reviewNotes: "Synthetic gate test, not live evidence" });
    assert.equal((await new DesignStore(dbInst.db).requireProductionDesign(projectId, accepted.id, accepted.candidateDigest)).id, accepted.id);
    await assert.rejects(store.requireProductionDesign("other-project", accepted.id, accepted.candidateDigest), (e) => isCode(e, "design_not_found"));
    await assert.rejects(store.requireProductionDesign(projectId, accepted.id, "f".repeat(64)), (e) => isCode(e, "design_approval_failed"));
    const intake = new ProjectIntakeStore(dbInst.db);
    const draft = (await intake.getDraft(projectId))!;
    const payload = buildIntakePayload();
    payload.brand.positioning = "Updated accepted input";
    await intake.saveDraft({ projectId, baseRevision: draft.revision, payload });
    await intake.accept({ projectId, expectedRevision: draft.revision + 1, expectedDigest: deterministicDigest(payload) });
    await assert.rejects(store.requireProductionDesign(projectId, accepted.id, accepted.candidateDigest), (e) => isCode(e, "design_input_stale"));
  } finally { await dbInst.close(); }
});
