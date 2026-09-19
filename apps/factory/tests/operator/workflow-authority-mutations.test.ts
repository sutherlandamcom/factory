import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import {
  deriveProjectWorkflow,
  deriveProjectVersions,
} from "../../src/operator/workflow.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import {
  acceptedDesignArtifacts,
  acceptedVisualAssetSets,
  assets,
  assetVersions,
  assetPageAssignments,
  productionPageInputs,
  productionCandidates,
  productionQaRuns,
  visualAssetPlans,
} from "../../src/persistence/schema.js";
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";

/**
 * Macro Run 11 — authority mutation and staleness cascade verification.
 *
 * Proves that starting from a valid READY_FOR_DEPLOYMENT state, every
 * upstream authority mutation cascades deterministically to downstream
 * production and deployment readiness, and that DeploymentReadiness.candidate.id
 * strictly reflects the actual production candidate primary key.
 */

async function setup() {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const deps = { db: dbInst.db, intake };
  return { dbInst, store, intake, deps };
}

function candidateData(boundSlot?: {
  boundAssetVersionId: string;
  boundBinaryDigest: string;
  boundGovernanceDigest: string;
}): DesignCandidateData {
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
          boundSlot
            ? {
                slot: "hero.primary",
                requirement: "Hero photography",
                pageSlug: "home",
                role: "hero",
                requiredRole: "hero",
                boundAssetVersionId: boundSlot.boundAssetVersionId,
                boundBinaryDigest: boundSlot.boundBinaryDigest,
                boundGovernanceDigest: boundSlot.boundGovernanceDigest,
                providerConsumed: false,
                placeholder: false,
                designProviderReferencedFinalAsset: true,
                designProviderConsumedFinalAsset: false,
              }
            : {
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

async function insertVisualSet(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  version: number,
  design: { id: string; version: number; digest: string },
) {
  const [plan] = await db
    .insert(visualAssetPlans)
    .values({
      id: `vpln-${randomUUID()}`,
      projectId,
      version,
      designArtifactId: design.id,
      designArtifactVersion: design.version,
      designCandidateDigest: design.digest,
      designInputDigest: deterministicDigest({ dsnap: projectId, version: design.version }),
      designProviderMode: "fixture",
      slots: [],
      planDigest: deterministicDigest({ vplan: projectId, version }),
    })
    .returning();
  const [row] = await db
    .insert(acceptedVisualAssetSets)
    .values({
      id: `aset-${randomUUID()}`,
      projectId,
      version,
      planId: plan!.id,
      providerMode: "fixture",
      designArtifactId: design.id,
      designArtifactVersion: design.version,
      designCandidateDigest: design.digest,
      designInputDigest: deterministicDigest({ dsnap: projectId, version: design.version }),
      setDigest: deterministicDigest({ vset: projectId, version }),
    })
    .returning();
  return row!;
}

type DigestRef = { id: string; version: number; digest: string };
function ref(row: { id: string; version: number; contentDigest?: string; candidateDigest?: string; setDigest?: string; inputDigest?: string } & { digest?: string }): DigestRef {
  return {
    id: row.id,
    version: row.version,
    digest: row.digest ?? row.contentDigest ?? row.candidateDigest ?? row.setDigest ?? row.inputDigest ?? "",
  };
}

async function insertProductionInput(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  pageIdentity: string,
  version: number,
  content: DigestRef,
  design: DigestRef,
  visualSet: DigestRef,
) {
  const [row] = await db
    .insert(productionPageInputs)
    .values({
      id: `pinp-${randomUUID()}`,
      projectId,
      version,
      pageIdentity,
      pageType: "service",
      route: `/${pageIdentity}`,
      canonicalOrigin: "https://example.com",
      acceptedContentId: content.id,
      acceptedContentVersion: content.version,
      acceptedContentDigest: content.digest,
      acceptedDesignId: design.id,
      acceptedDesignVersion: design.version,
      acceptedDesignDigest: design.digest,
      acceptedVisualSetId: visualSet.id,
      acceptedVisualSetVersion: visualSet.version,
      acceptedVisualSetDigest: visualSet.digest,
      rendererId: "astro-static",
      rendererVersion: "5.0.0",
      rendererPolicyVersion: "v1",
      data: {},
      inputDigest: deterministicDigest({ pinput: pageIdentity, version }),
    })
    .returning();
  return { ...row!, digest: row!.inputDigest };
}

async function insertCandidate(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  pageIdentity: string,
  input: { id: string; version: number; digest: string },
  state: string,
  artifactDigest: string | null,
) {
  const [row] = await db
    .insert(productionCandidates)
    .values({
      id: `pcan-${randomUUID()}`,
      projectId,
      productionInputId: input.id,
      productionInputVersion: input.version,
      productionInputDigest: input.digest,
      pageIdentity,
      route: `/${pageIdentity}`,
      canonicalUrl: `https://example.com/${pageIdentity}`,
      artifactDigest,
      state,
    })
    .returning();
  return row!;
}

async function insertQaRun(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  candidateId: string,
  overall: string,
  artifactDigest: string | null,
) {
  const [row] = await db
    .insert(productionQaRuns)
    .values({
      id: `pqar-${randomUUID()}`,
      projectId,
      candidateId,
      candidateArtifactDigest: artifactDigest,
      overall,
      data: { overall },
    })
    .returning();
  return row!;
}

/**
 * Creates a fully valid READY_FOR_DEPLOYMENT state and verifies the base invariants.
 * Lineage is strictly rooted in real accepted ProjectInputSnapshot and ContentGap reports.
 */
async function setupValidReadyChain(key: string, opts?: { withAsset?: boolean }) {
  const { dbInst, store, intake, deps } = await setup();
  const seeded = await seedProjectWithAcceptedInputs(dbInst, key);
  const project = (await store.getProjectById(seeded.projectId))!;
  const snapshot = (await intake.listSnapshots(project.id))[0]!;

  const content = await acceptFixturePage(dbInst, project.id, "home");

  let assetInfo: {
    assetId: string;
    versionId: string;
    assignmentId: string;
    binDigest: string;
    govDigest: string;
  } | undefined;

  if (opts?.withAsset) {
    const assetId = `ast-${randomUUID()}`;
    const versionId = `asv-${randomUUID()}`;
    const assignmentId = `apa-${randomUUID()}`;
    const binDigest = "1".repeat(64);
    const govDigest = "2".repeat(64);

    await dbInst.db.insert(assets).values({
      id: assetId,
      projectId: project.id,
      kind: "photo",
      title: "Hero Photo",
    });

    await dbInst.db.insert(assetVersions).values({
      id: versionId,
      assetId,
      projectId: project.id,
      version: 1,
      mediaType: "image/jpeg",
      byteSize: 1024,
      binaryDigest: binDigest,
      storageKey: `fixtures/${assetId}`,
      originalFilename: "hero.jpg",
      provenance: { source: "operator" },
      rightsStatus: "operator_owned",
      approvalState: "approved",
      approvedAt: new Date(),
      governanceDigest: govDigest,
    });

    await dbInst.db.insert(assetPageAssignments).values({
      id: assignmentId,
      projectId: project.id,
      assetId,
      versionId,
      versionDigest: govDigest,
      binaryDigest: binDigest,
      acceptedPageContentId: content.id,
      acceptedPageContentVersion: content.version,
      acceptedPageContentDigest: content.contentDigest,
      pageSlug: "home",
      role: "hero",
      assignedAt: new Date(),
    });

    assetInfo = { assetId, versionId, assignmentId, binDigest, govDigest };
  }

  const designStore = new DesignStore(dbInst.db);
  const designSnapshot = await designStore.deriveInputSnapshotDraft({ projectId: project.id });
  const cData = candidateData(
    assetInfo
      ? {
          boundAssetVersionId: assetInfo.versionId,
          boundBinaryDigest: assetInfo.binDigest,
          boundGovernanceDigest: assetInfo.govDigest,
        }
      : undefined,
  );
  const designCandidate = await designStore.createCandidate({
    projectId: project.id,
    inputSnapshot: designSnapshot,
    data: cData,
  });
  const design = await designStore.acceptCandidate({
    projectId: project.id,
    candidateId: designCandidate.id,
    expectedCandidateDigest: designCandidate.candidateDigest,
    reviewNotes: "fixture acceptance for operator testing",
  });

  const visualSet = await insertVisualSet(dbInst.db, project.id, 1, {
    id: design.id,
    version: design.version,
    digest: design.candidateDigest,
  });

  const input = await insertProductionInput(
    dbInst.db,
    project.id,
    "home",
    1,
    ref(content),
    { id: design.id, version: design.version, digest: design.candidateDigest },
    { id: visualSet.id, version: visualSet.version, digest: visualSet.setDigest },
  );

  const candidate = await insertCandidate(
    dbInst.db,
    project.id,
    "home",
    input,
    "qa_passed",
    deterministicDigest({ artifact: "home", v: 1 }),
  );

  await insertQaRun(dbInst.db, project.id, candidate.id, "PASS", candidate.artifactDigest);

  const initialWf = (await deriveProjectWorkflow(deps, project.id))!;
  assert.equal(initialWf.overall, "READY_FOR_DEPLOYMENT");
  assert.equal(initialWf.deployment.state, "READY_FOR_DEPLOYMENT");
  assert.equal(initialWf.deployment.candidate?.kind, "ProductionCandidate");
  assert.equal(
    initialWf.deployment.candidate?.id,
    candidate.id,
    "DeploymentReadiness.candidate.id MUST strictly match productionCandidates.id",
  );
  assert.notEqual(
    initialWf.deployment.candidate?.id,
    candidate.artifactDigest,
    "candidate.id must NOT be the candidate artifact digest",
  );
  assert.equal(initialWf.deployment.qaCurrent, true);

  return {
    dbInst,
    store,
    intake,
    deps,
    project,
    snapshot,
    content,
    design,
    visualSet,
    input,
    candidate,
    assetInfo,
    designStore,
    designSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Mutation A: New content version
// ---------------------------------------------------------------------------

test("Mutation A: New AcceptedPageContent (v2) makes production STALE, QA HISTORICAL, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-a");
  try {
    const contentV2 = await acceptFixturePage(env.dbInst, env.project.id, "home");

    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    const versions = (await deriveProjectVersions(env.deps, env.project.id))!;

    const homeContentV2 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedPageContent" && a.id === contentV2.id,
    );
    assert.equal(homeContentV2?.relation, "CURRENT");
    const homeContentV1 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedPageContent" && a.id === env.content.id,
    );
    assert.equal(homeContentV1?.relation, "HISTORICAL");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.content.version, 2);
    assert.equal(homePage.content.freshness, "CURRENT");
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.production.relation, "HISTORICAL");
    assert.equal(homePage.production.freshness, "STALE");

    assert.equal(homePage.qa.state, "ACCEPTED");
    assert.equal(homePage.qa.relation, "HISTORICAL");
    assert.equal(homePage.qa.freshness, "STALE");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "PRODUCTION_NOT_CURRENT"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "QA_HISTORICAL_NOT_CURRENT"));
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation B: New design artifact
// ---------------------------------------------------------------------------

test("Mutation B: New AcceptedDesignArtifact (v2) makes visual set STALE, production STALE, QA HISTORICAL, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-b");
  try {
    const cData2 = candidateData();
    cData2.rationale = "Candidate v2 rationale";
    const candV2 = await env.designStore.createCandidate({
      projectId: env.project.id,
      inputSnapshot: env.designSnapshot,
      data: cData2,
    });
    const designV2 = await env.designStore.acceptCandidate({
      projectId: env.project.id,
      candidateId: candV2.id,
      expectedCandidateDigest: candV2.candidateDigest,
      reviewNotes: "fixture acceptance for v2",
    });
    assert.equal(designV2.version, 2);

    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    const versions = (await deriveProjectVersions(env.deps, env.project.id))!;

    const desV2 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedDesignArtifact" && a.id === designV2.id,
    );
    assert.equal(desV2?.relation, "CURRENT");
    const desV1 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedDesignArtifact" && a.id === env.design.id,
    );
    assert.equal(desV1?.relation, "HISTORICAL");

    // Visual set binds design v1, so it is now STALE against design v2
    assert.equal(wf.areas.find((a) => a.area === "assets")?.state, "STALE");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.design.version, 2);
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.qa.relation, "HISTORICAL");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "VISUAL_STALE"));
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation C: New visual asset set
// ---------------------------------------------------------------------------

test("Mutation C: New AcceptedVisualAssetSet (v2) makes production STALE, candidate/QA non-current, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-c");
  try {
    const visualSetV2 = await insertVisualSet(env.dbInst.db, env.project.id, 2, {
      id: env.design.id,
      version: env.design.version,
      digest: env.design.candidateDigest,
    });

    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    const versions = (await deriveProjectVersions(env.deps, env.project.id))!;

    const vsetV2 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedVisualAssetSet" && a.id === visualSetV2.id,
    );
    assert.equal(vsetV2?.relation, "CURRENT");
    const vsetV1 = versions?.artifacts.find(
      (a) => a.artifactKind === "AcceptedVisualAssetSet" && a.id === env.visualSet.id,
    );
    assert.equal(vsetV1?.relation, "HISTORICAL");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.qa.relation, "HISTORICAL");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "PRODUCTION_NOT_CURRENT"));
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation D: New ProductionPageInput without candidate -> candidate becomes HISTORICAL
// ---------------------------------------------------------------------------

test("Mutation D: New ProductionPageInput (v2) without candidate makes Candidate v1 HISTORICAL, production READY, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-d");
  try {
    // Insert new production input v2
    const inputV2 = await insertProductionInput(
      env.dbInst.db,
      env.project.id,
      "home",
      2,
      ref(env.content),
      { id: env.design.id, version: env.design.version, digest: env.design.candidateDigest },
      { id: env.visualSet.id, version: env.visualSet.version, digest: env.visualSet.setDigest },
    );

    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    const versions = (await deriveProjectVersions(env.deps, env.project.id))!;

    // Candidate v1 was built for input v1; since input v2 is now authoritative, Candidate v1 is HISTORICAL
    const candV1 = versions?.artifacts.find(
      (a) => a.artifactKind === "ProductionCandidate" && a.id === env.candidate.id,
    );
    assert.equal(candV1?.relation, "HISTORICAL");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.production.state, "READY");
    assert.equal(homePage.production.version, 2);
    assert.equal(homePage.qa.relation, "HISTORICAL");
    assert.equal(homePage.qa.freshness, "STALE");

    assert.equal(wf.deployment.state, "BLOCKED");

    // Next: build Candidate v2 for input v2 and pass QA
    const candidateV2 = await insertCandidate(
      env.dbInst.db,
      env.project.id,
      "home",
      inputV2,
      "qa_passed",
      deterministicDigest({ artifact: "home", v: 2 }),
    );
    await insertQaRun(env.dbInst.db, env.project.id, candidateV2.id, "PASS", candidateV2.artifactDigest);

    const wfAfter = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    const versionsAfter = (await deriveProjectVersions(env.deps, env.project.id))!;

    const candV2After = versionsAfter?.artifacts.find(
      (a) => a.artifactKind === "ProductionCandidate" && a.id === candidateV2.id,
    );
    assert.equal(candV2After?.relation, "CURRENT");
    const candV1After = versionsAfter?.artifacts.find(
      (a) => a.artifactKind === "ProductionCandidate" && a.id === env.candidate.id,
    );
    assert.equal(candV1After?.relation, "HISTORICAL");

    assert.equal(wfAfter.overall, "READY_FOR_DEPLOYMENT");
    assert.equal(wfAfter.deployment.state, "READY_FOR_DEPLOYMENT");
    assert.equal(
      wfAfter.deployment.candidate?.id,
      candidateV2.id,
      "DeploymentReadiness.candidate.id must match the new candidate primary key",
    );
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation E1: Upstream ProjectInputSnapshot changes -> design becomes STALE
// ---------------------------------------------------------------------------

test("Mutation E1: Mutate upstream ProjectInputSnapshot -> design becomes STALE, downstream production STALE, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-e1");
  try {
    const base = buildIntakePayload();
    const updatedPayload = {
      ...base,
      siteIdentity: {
        ...base.siteIdentity,
        candidateDomain: "updated-example.com",
      },
    };
    await env.intake.saveDraft({
      projectId: env.project.id,
      baseRevision: 1,
      payload: updatedPayload,
    });
    await env.intake.accept({
      projectId: env.project.id,
      expectedRevision: 2,
      expectedDigest: deterministicDigest(updatedPayload),
    });

    // 1. Direct canonical DesignStore assertion: reports stale with INPUT_CHANGED
    const canonicalDesign = await env.designStore.latestAcceptedDesign(env.project.id);
    assert.ok(canonicalDesign);
    assert.equal(canonicalDesign.staleness.stale, true);
    assert.equal(canonicalDesign.staleness.code, "INPUT_CHANGED");
    assert.match(canonicalDesign.staleness.reason ?? "", /accepted project inputs changed/i);

    // 2. Full workflow projection assertion: cascades downstream
    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;

    const designArea = wf.areas.find((a) => a.area === "design");
    assert.equal(designArea?.state, "STALE");
    assert.equal(designArea?.staleReasons[0]?.code, "INPUT_CHANGED");

    const assetsArea = wf.areas.find((a) => a.area === "assets");
    assert.equal(assetsArea?.state, "STALE");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.design.freshness, "STALE");
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.qa.relation, "HISTORICAL");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "DESIGN_STALE"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "VISUAL_STALE"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "PRODUCTION_NOT_CURRENT"));
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation E2: Upstream AcceptedPageContent changes -> design becomes STALE
// ---------------------------------------------------------------------------

test("Mutation E2: Mutate upstream AcceptedPageContent -> design becomes STALE, downstream production STALE, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-e2");
  try {
    // Add a new accepted page without updating design input snapshot
    await acceptFixturePage(env.dbInst, env.project.id, "services/test");

    // 1. Direct canonical DesignStore assertion: reports stale with CONTENT_ADDED
    const canonicalDesign = await env.designStore.latestAcceptedDesign(env.project.id);
    assert.ok(canonicalDesign);
    assert.equal(canonicalDesign.staleness.stale, true);
    assert.equal(canonicalDesign.staleness.code, "CONTENT_ADDED");
    assert.match(canonicalDesign.staleness.reason ?? "", /new accepted content exists/i);

    // 2. Full workflow projection assertion: cascades downstream
    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;

    const designArea = wf.areas.find((a) => a.area === "design");
    assert.equal(designArea?.state, "STALE");
    assert.equal(designArea?.staleReasons[0]?.code, "CONTENT_ADDED");

    const assetsArea = wf.areas.find((a) => a.area === "assets");
    assert.equal(assetsArea?.state, "STALE");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.design.freshness, "STALE");
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.qa.relation, "HISTORICAL");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "DESIGN_STALE"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "VISUAL_STALE"));
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Mutation E3: Upstream asset assignment changes -> design becomes STALE
// ---------------------------------------------------------------------------

test("Mutation E3: Mutate asset assignment -> design becomes STALE, downstream production STALE, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-e3", { withAsset: true });
  try {
    assert.ok(env.assetInfo);

    // Initial check: canonical design is fresh with the bound asset
    const initialCanonical = await env.designStore.latestAcceptedDesign(env.project.id);
    assert.ok(initialCanonical);
    assert.equal(initialCanonical.staleness.stale, false);

    // Mutate the assignment's governance digest without updating design input snapshot
    await env.dbInst.db
      .update(assetPageAssignments)
      .set({ versionDigest: "f".repeat(64) })
      .where(eq(assetPageAssignments.id, env.assetInfo.assignmentId));

    // 1. Direct canonical DesignStore assertion: reports stale with ASSET_ASSIGNMENT_CHANGED
    const canonicalDesign = await env.designStore.latestAcceptedDesign(env.project.id);
    assert.ok(canonicalDesign);
    assert.equal(canonicalDesign.staleness.stale, true);
    assert.equal(canonicalDesign.staleness.code, "ASSET_ASSIGNMENT_CHANGED");
    assert.match(canonicalDesign.staleness.reason ?? "", /asset assignment.*changed/i);

    // 2. Full workflow projection assertion: cascades downstream
    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;

    const designArea = wf.areas.find((a) => a.area === "design");
    assert.equal(designArea?.state, "STALE");
    assert.equal(designArea?.staleReasons[0]?.code, "ASSET_ASSIGNMENT_CHANGED");

    const assetsArea = wf.areas.find((a) => a.area === "assets");
    assert.equal(assetsArea?.state, "STALE");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.design.freshness, "STALE");
    assert.equal(homePage.production.state, "STALE");
    assert.equal(homePage.qa.relation, "HISTORICAL");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "DESIGN_STALE"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "VISUAL_STALE"));
    assert.ok(wf.deployment.blockers.some((b) => b.code === "PRODUCTION_NOT_CURRENT"));

    // Also test asset assignment removal:
    await env.dbInst.db
      .delete(assetPageAssignments)
      .where(eq(assetPageAssignments.id, env.assetInfo.assignmentId));

    const removedCanonical = await env.designStore.latestAcceptedDesign(env.project.id);
    assert.ok(removedCanonical);
    assert.equal(removedCanonical.staleness.stale, true);
    assert.equal(removedCanonical.staleness.code, "ASSET_ASSIGNMENT_REMOVED");
    assert.match(removedCanonical.staleness.reason ?? "", /asset assignment.*removed/i);
  } finally {
    await env.dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Candidate identity projection integrity & Cross-project isolation
// ---------------------------------------------------------------------------

test("Candidate identity projection: candidate.id strictly equals productionCandidate primary key", async () => {
  const env = await setupValidReadyChain("mut-id-check");
  try {
    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;
    assert.equal(wf.deployment.state, "READY_FOR_DEPLOYMENT");
    assert.equal(wf.deployment.candidate?.id, env.candidate.id);
    assert.equal(wf.deployment.candidate?.digest, env.candidate.artifactDigest ?? undefined);
    assert.equal(wf.deployment.candidate?.version, 1);
    assert.equal(wf.deployment.candidate?.pageIdentity, "home");

    // Query non-existent project returns null
    const missingWf = await deriveProjectWorkflow(env.deps, "non-existent-id");
    assert.equal(missingWf, null);
  } finally {
    await env.dbInst.close();
  }
});
