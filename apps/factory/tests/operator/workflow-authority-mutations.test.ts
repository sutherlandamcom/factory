import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import {
  deriveProjectWorkflow,
  deriveProjectVersions,
} from "../../src/operator/workflow.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import {
  acceptedPageContent,
  acceptedDerivativeSets,
  acceptedDesignArtifacts,
  acceptedVisualAssetSets,
  designCandidates,
  designInputSnapshots,
  productionPageInputs,
  productionCandidates,
  productionQaRuns,
  pageDerivativeIntentSnapshots,
  projectDerivativePolicies,
  visualAssetPlans,
  serpSnapshots,
  searchRuns,
  searchIntelligenceSnapshots,
  competitorRuns,
  contentGapReports,
  acceptedContentGapSnapshots,
  projectInputSnapshots,
} from "../../src/persistence/schema.js";
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import type { DesignInputSnapshotData } from "@factory/contracts";

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

async function insertResearch(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  snapshot: { id: string; version: number; digest: string },
) {
  const digest = (n: string) => deterministicDigest({ r: n, projectId, version: snapshot.version });
  const runId = `sr-${randomUUID()}`;
  await db.insert(searchRuns).values({
    id: runId,
    projectId,
    acceptedInputSnapshotId: snapshot.id,
    acceptedInputVersion: snapshot.version,
    acceptedInputDigest: snapshot.digest,
    query: "factory test",
    device: "desktop",
    provider: "fixture",
    requestDigest: digest("req"),
    status: "succeeded",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  const serpId = `serp-${randomUUID()}`;
  await db.insert(serpSnapshots).values({
    id: serpId,
    runId,
    projectId,
    acceptedInputSnapshotId: snapshot.id,
    acceptedInputVersion: snapshot.version,
    acceptedInputDigest: snapshot.digest,
    query: "factory test",
    device: "desktop",
    provider: "fixture",
    observedAt: new Date(),
    requestDigest: digest("req2"),
    snapshotDigest: digest("serp"),
    rawDigest: digest("raw"),
    organic: [],
  });
  const intelligenceId = `sis-${randomUUID()}`;
  await db.insert(searchIntelligenceSnapshots).values({
    id: intelligenceId,
    runId,
    projectId,
    acceptedInputSnapshotId: snapshot.id,
    acceptedInputVersion: snapshot.version,
    acceptedInputDigest: snapshot.digest,
    query: "factory test",
    model: "fixture",
    provider: "fixture",
    promptVersion: "v1",
    promptDigest: digest("iprompt"),
    serpSnapshotId: serpId,
    evidenceDigests: [],
    data: {},
    snapshotDigest: digest("intel"),
  });
  const competitorRunId = `cr-${randomUUID()}`;
  await db.insert(competitorRuns).values({
    id: competitorRunId,
    projectId,
    acceptedInputSnapshotId: snapshot.id,
    acceptedInputVersion: snapshot.version,
    acceptedInputDigest: snapshot.digest,
    serpSnapshotId: serpId,
    serpSnapshotDigest: digest("serp"),
    intelligenceSnapshotId: intelligenceId,
    intelligenceSnapshotDigest: digest("intel"),
    pipelineVersion: "v1",
    status: "succeeded",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  const [report] = await db
    .insert(contentGapReports)
    .values({
      id: `cgr-${randomUUID()}`,
      runId: competitorRunId,
      projectId,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      serpSnapshotId: serpId,
      serpSnapshotDigest: digest("serp"),
      intelligenceSnapshotId: intelligenceId,
      intelligenceSnapshotDigest: digest("intel"),
      model: "fixture",
      provider: "fixture",
      promptVersion: "v1",
      data: {},
      snapshotDigest: digest("report"),
      reviewState: "accepted",
    })
    .returning();
  await db.insert(acceptedContentGapSnapshots).values({
    id: `acgs-${randomUUID()}`,
    projectId,
    version: snapshot.version,
    reportId: report!.id,
    reportDigest: report!.snapshotDigest,
    decisionsDigest: digest("decisions"),
    acceptedInputSnapshotId: snapshot.id,
    acceptedInputVersion: snapshot.version,
    acceptedInputDigest: snapshot.digest,
    serpSnapshotId: "serp-x",
    serpSnapshotDigest: digest("serp"),
    intelligenceSnapshotId: "sis-x",
    intelligenceSnapshotDigest: digest("intel"),
    pageSnapshotRefs: [],
    analysisRefs: [],
    data: {},
    snapshotDigest: digest("accepted"),
  });
}

async function insertAcceptedContent(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  slug: string,
  version: number,
  contentDigest = deterministicDigest({ slug, version }),
) {
  const [row] = await db
    .insert(acceptedPageContent)
    .values({
      id: `wac-${randomUUID()}`,
      projectId,
      version,
      slug,
      proposalId: `wprp-${randomUUID()}`,
      proposalVersion: version,
      proposalDigest: deterministicDigest({ proposal: slug, version }),
      qaReportDigest: deterministicDigest({ qa: slug, version }),
      data: { title: `Page ${slug} v${version}` },
      contentDigest,
    })
    .returning();
  return row!;
}

async function insertDesignWithCanonicalLineage(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  version: number,
) {
  const [inputSnapshot] = await db
    .select()
    .from(projectInputSnapshots)
    .where(eq(projectInputSnapshots.projectId, projectId))
    .orderBy(desc(projectInputSnapshots.version))
    .limit(1);

  const contentRows = await db
    .select()
    .from(acceptedPageContent)
    .where(eq(acceptedPageContent.projectId, projectId))
    .orderBy(desc(acceptedPageContent.version));

  const data: DesignInputSnapshotData = {
    schemaVersion: "design-v1",
    acceptedInputSnapshotId: inputSnapshot?.id ?? `psnp-${projectId}`,
    acceptedInputSnapshotVersion: inputSnapshot?.version ?? 1,
    acceptedInputDigest: inputSnapshot?.digest ?? deterministicDigest({ project: projectId }),
    brand: {
      facts: ["Fact 1"],
      positioning: "Positioning",
      tone: "Professional",
      visualIdentityNotes: "",
    },
    audience: {
      segments: ["Audience 1"],
      needs: ["Need 1"],
      decisionContext: "",
    },
    references: {
      referenceUrls: [],
      antiReferenceUrls: [],
      learn: [],
      avoid: [],
      preferredPerception: "",
    },
    uxRequirements: [],
    representativePages: [],
    archetypes: ["homepage"],
    contentRefs: contentRows.map((c) => ({
      id: c.id,
      slug: c.slug,
      version: c.version,
      contentDigest: c.contentDigest,
    })),
    assetRefs: [],
  };

  const inputDigest = deterministicDigest(data);

  const [snapshot] = await db
    .insert(designInputSnapshots)
    .values({
      id: `dsnp-${randomUUID()}`,
      projectId,
      version,
      data,
      inputDigest,
    })
    .returning();

  const [candidate] = await db
    .insert(designCandidates)
    .values({
      id: `dcan-${randomUUID()}`,
      projectId,
      inputSnapshotId: snapshot!.id,
      inputSnapshotVersion: version,
      inputDigest: snapshot!.inputDigest,
      provider: "google-stitch",
      providerMode: "fixture",
      providerProjectName: "fixture",
      data: {},
      candidateDigest: deterministicDigest({ design: projectId, version }),
      approvalState: "accepted",
      acceptedAt: new Date(),
    })
    .returning();

  const [row] = await db
    .insert(acceptedDesignArtifacts)
    .values({
      id: `ades-${randomUUID()}`,
      projectId,
      version,
      candidateId: candidate!.id,
      candidateDigest: candidate!.candidateDigest,
      inputSnapshotId: snapshot!.id,
      inputSnapshotVersion: version,
      inputDigest: snapshot!.inputDigest,
      provider: "google-stitch",
      providerMode: "fixture",
      providerProjectName: "fixture",
      designMdDigest: deterministicDigest({ md: projectId, version }),
      data: {},
    })
    .returning();

  return row!;
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
 */
async function setupValidReadyChain(key: string) {
  const { dbInst, store, intake, deps } = await setup();
  const project = await store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });
  const snapshot = (await intake.listSnapshots(project.id))[0]!;
  await insertResearch(dbInst.db, project.id, {
    id: snapshot.id,
    version: snapshot.version,
    digest: snapshot.digest,
  });

  const content = await insertAcceptedContent(dbInst.db, project.id, "home", 1);
  const design = await insertDesignWithCanonicalLineage(dbInst.db, project.id, 1);
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

  return { dbInst, store, intake, deps, project, snapshot, content, design, visualSet, input, candidate };
}

// ---------------------------------------------------------------------------
// Mutation A: New content version
// ---------------------------------------------------------------------------

test("Mutation A: New AcceptedPageContent (v2) makes production STALE, QA HISTORICAL, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-a");
  try {
    const contentV2 = await insertAcceptedContent(env.dbInst.db, env.project.id, "home", 2);

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
    const designV2 = await insertDesignWithCanonicalLineage(env.dbInst.db, env.project.id, 2);

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
// Mutation E: Upstream ProjectInputSnapshot changes -> design becomes STALE
// ---------------------------------------------------------------------------

test("Mutation E: Mutate upstream ProjectInputSnapshot -> design becomes STALE, downstream production STALE, deployment BLOCKED", async () => {
  const env = await setupValidReadyChain("mut-e");
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

    const wf = (await deriveProjectWorkflow(env.deps, env.project.id))!;

    const designArea = wf.areas.find((a) => a.area === "design");
    assert.equal(designArea?.state, "STALE");

    const homePage = wf.pages.find((p) => p.pageIdentity === "home")!;
    assert.equal(homePage.design.freshness, "STALE");
    assert.equal(homePage.production.state, "STALE");

    assert.equal(wf.deployment.state, "BLOCKED");
    assert.ok(wf.deployment.blockers.some((b) => b.code === "DESIGN_STALE"));
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
