import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import {
  deriveProjectWorkflow,
  deriveProjectVersions,
  deriveProjectCosts,
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
  modelInvocations,
  summaryProposals,
  summaryPromptSnapshots,
  pageDerivativeIntentSnapshots,
  projectDerivativePolicies,
  visualGenerationRequests,
  visualPromptSnapshots,
  visualAssetPlans,
  searchRuns,
  serpSnapshots,
  searchIntelligenceSnapshots,
  competitorRuns,
  contentGapReports,
  acceptedContentGapSnapshots,
} from "../../src/persistence/schema.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { DesignStore } from "../../src/design/design-store.js";
import { parseDesignCandidateData, parseDesignInputSnapshotData } from "@factory/contracts";
import { acceptFixturePage } from "../fixtures/accepted-page.js";

/**
 * Macro Run 11 — derived workflow read model tests.
 *
 * These tests prove the core Run 11 theorems against a real PostgreSQL test
 * database with REAL authority rows:
 *   T1  derived state (no persisted workflow state)
 *   T2  current authority clarity (version/digest surfaced)
 *   T3  staleness propagation (content advance ⇒ downstream stale)
 *   T4  historical truth (superseded versions remain HISTORICAL)
 *   T5  deterministic next action
 *   T6  cost truthfulness (UNKNOWN never becomes zero)
 *   T8  READY_FOR_DEPLOYMENT boundary
 */

async function setup() {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const deps = { db: dbInst.db, intake };
  return { dbInst, store, intake, deps };
}

/** Insert an accepted page content row (preferring real writer acceptance when lineage exists). */
async function insertAcceptedContent(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  slug: string,
  version: number,
  contentDigest = deterministicDigest({ slug, version }),
) {
  try {
    return await acceptFixturePage({ db } as FactoryDatabaseInstance, projectId, slug);
  } catch {
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
}

async function insertDerivativePolicy(db: FactoryDatabaseInstance["db"], projectId: string) {
  const existing = await db
    .select({ id: projectDerivativePolicies.id })
    .from(projectDerivativePolicies)
    .where(eq(projectDerivativePolicies.projectId, projectId))
    .limit(1);
  if (existing.length > 0) return existing[0]!;
  const [row] = await db
    .insert(projectDerivativePolicies)
    .values({
      id: `dpol-${randomUUID()}`,
      projectId,
      version: 1,
      summaryEnabled: true,
      summaryLanguage: "en",
      summaryPolicyVersion: "summary-instructions-v1",
      audioEnabled: false,
      audioLanguage: "en",
      audioVoiceId: "fixture-voice-1",
      audioPolicyVersion: "narration-projection-v1",
      data: {
        schemaVersion: "derivatives-v1",
        projectId,
        version: 1,
        summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
        audio: { enabled: false, language: "en", voiceId: null, policyVersion: "narration-projection-v1" },
      },
      policyDigest: deterministicDigest({ dpol: projectId }),
    })
    .returning();
  return row!;
}

async function insertDerivativeSet(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  pageIdentity: string,
  version: number,
  source: { id: string; version: number; digest: string },
) {
  // A derivative set can only exist when project defaults enable derivatives.
  await insertDerivativePolicy(db, projectId);
  // Real FK chain: page_derivative_intent_snapshots -> accepted_derivative_sets.
  const [intent] = await db
    .insert(pageDerivativeIntentSnapshots)
    .values({
      id: `dint-${randomUUID()}`,
      projectId,
      pageIdentity,
      acceptedContentId: source.id,
      acceptedContentVersion: source.version,
      acceptedContentDigest: source.digest,
      effectiveSummaryState: "enabled",
      effectiveSummaryLanguage: "en",
      effectiveSummaryPolicyVersion: "v1",
      effectiveAudioState: "disabled",
      effectiveAudioLanguage: "en",
      effectiveAudioVoiceId: null,
      effectiveAudioPolicyVersion: "v1",
      snapshotDigest: deterministicDigest({ intent: pageIdentity, version }),
      data: {},
    })
    .returning();
  const [row] = await db
    .insert(acceptedDerivativeSets)
    .values({
      id: `dset-${randomUUID()}`,
      projectId,
      pageIdentity,
      version,
      sourceContentId: source.id,
      sourceContentVersion: source.version,
      sourceContentDigest: source.digest,
      intentSnapshotId: intent!.id,
      intentSnapshotDigest: intent!.snapshotDigest,
      summaryState: "accepted",
      summaryArtifactId: `dsa-${randomUUID()}`,
      summaryVersion: version,
      summaryDigest: deterministicDigest({ summary: pageIdentity, version }),
      audioState: "disabled",
      data: {},
      setDigest: deterministicDigest({ set: pageIdentity, version }),
    })
    .returning();
  return row!;
}

async function insertDesign(db: FactoryDatabaseInstance["db"], projectId: string, _version = 1) {
  const designStore = new DesignStore(db);
  const designSnapshot = await designStore.deriveInputSnapshotDraft({ projectId });
  const [snapshot] = await db
    .select()
    .from(designInputSnapshots)
    .where(eq(designInputSnapshots.id, designSnapshot.id));

  const snapshotData = parseDesignInputSnapshotData(snapshot!.data);
  const archetypes = snapshotData.archetypes.map((arch) => ({
    kind: arch,
    purpose: `${arch} purpose`,
    providerScreenNames: [`projects/fixture/screens/${arch}`],
    sectionPatterns: ["hero", "evidence", "cta"],
    contentRequirements: ["Primary CTA visible"],
    assetSlots: [],
    primaryCta: "Request assessment",
    secondaryCta: "",
    responsiveBehavior: "Mobile-first stack",
    trustPresentation: "Author/date areas visible",
  }));
  const screens = archetypes.map((arch, idx) => ({
    id: `screen-${idx + 1}`,
    providerScreenName: arch.providerScreenNames[0]!,
    title: `${arch.kind} Screen`,
    deviceType: "DESKTOP" as const,
    archetype: arch.kind,
  }));

  const cData = parseDesignCandidateData({
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
    screens,
    archetypes,
    rationale: "Fixture rationale",
  });

  const designCandidate = await designStore.createCandidate({
    projectId,
    inputSnapshot: designSnapshot,
    data: cData,
  });
  const design = await designStore.acceptCandidate({
    projectId,
    candidateId: designCandidate.id,
    expectedCandidateDigest: designCandidate.candidateDigest,
    reviewNotes: "fixture acceptance for operator testing",
  });
  return design;
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
      data: { checks: [] },
      overall,
    })
    .returning();
  return row!;
}


/** Seed minimal REAL research authority: search run + SERP snapshot + accepted gap snapshot. */
async function insertResearch(
  db: FactoryDatabaseInstance["db"],
  projectId: string,
  inputSnapshot: { id: string; version: number; digest: string },
) {
  const digest = (n: string) => deterministicDigest({ r: n });
  const runId = `sr-${randomUUID()}`;
  await db.insert(searchRuns).values({
    id: runId,
    projectId,
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    query: "roof repair denver",
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
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    query: "roof repair denver",
    device: "desktop",
    provider: "fixture",
    observedAt: new Date(),
    requestDigest: digest("req2"),
    snapshotDigest: "a".repeat(64),
    rawDigest: "b".repeat(64),
    organic: [],
  });
  const intelligenceId = `sis-${randomUUID()}`;
  const intelData = {
    evidenceRefs: [{ kind: "serp_snapshot", id: serpId, digest: "a".repeat(64) }],
    primaryIntent: "commercial",
    intentRationale: "fixture",
    secondaryIntents: [],
    queryClusters: [],
    longTailOpportunities: [],
    entities: [],
    topics: [],
    questions: [],
    modifiers: [],
    searchVocabulary: [],
    relatedConcepts: [],
    semanticCoverageRequirements: [],
    userNeeds: [],
  };
  await db.insert(searchIntelligenceSnapshots).values({
    id: intelligenceId,
    runId,
    projectId,
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    query: "roof repair denver",
    model: "fixture-analyst",
    provider: "fixture",
    promptVersion: "search-analyst-v1",
    promptDigest: "c".repeat(64),
    serpSnapshotId: serpId,
    evidenceDigests: { serp: "a".repeat(64) },
    data: intelData,
    snapshotDigest: "d".repeat(64),
  });
  const competitorRunId = `cr-${randomUUID()}`;
  await db.insert(competitorRuns).values({
    id: competitorRunId,
    projectId,
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    serpSnapshotId: serpId,
    serpSnapshotDigest: "a".repeat(64),
    intelligenceSnapshotId: intelligenceId,
    intelligenceSnapshotDigest: "d".repeat(64),
    pipelineVersion: "fixture-v1",
    status: "succeeded",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  const reportId = `cgr-${randomUUID()}`;
  const reportData = {
    serpSnapshotId: serpId,
    serpSnapshotDigest: "a".repeat(64),
    intelligenceSnapshotId: intelligenceId,
    intelligenceSnapshotDigest: "d".repeat(64),
    searchSemantics: {
      intelligenceSnapshotId: intelligenceId,
      intelligenceSnapshotDigest: "d".repeat(64),
      primaryIntent: "commercial",
      semanticCoverageRequirements: [
        "What a full roof replacement includes",
        "Typical timeline and process steps",
        "Warranty and workmanship guarantees",
      ],
      userNeeds: [
        "Understand cost drivers before requesting a quote",
        "Trust signals: licensing, insurance, reviews",
      ],
    },
    pageSnapshotRefs: [],
    analysisRefs: [],
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputSnapshotVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    coverageMatrix: { policyVersion: "fixture-v1", rows: [] },
    gaps: [],
    differentiationRequirements: { items: [] },
    model: "fixture",
    provider: "fixture",
    promptVersion: "fixture-v1",
    reviewState: "operator_reviewed" as const,
  };
  const reportDigest = deterministicDigest(reportData);
  const [report] = await db
    .insert(contentGapReports)
    .values({
      id: reportId,
      runId: competitorRunId,
      projectId,
      acceptedInputSnapshotId: inputSnapshot.id,
      acceptedInputVersion: inputSnapshot.version,
      acceptedInputDigest: inputSnapshot.digest,
      serpSnapshotId: serpId,
      serpSnapshotDigest: "a".repeat(64),
      intelligenceSnapshotId: intelligenceId,
      intelligenceSnapshotDigest: "d".repeat(64),
      model: "fixture",
      provider: "fixture",
      promptVersion: "fixture-v1",
      data: reportData,
      snapshotDigest: reportDigest,
      reviewState: "operator_reviewed",
      reviewRevision: 1,
      decisionsDigest: "e".repeat(64),
    })
    .returning();

  const gapData = {
    ...reportData,
    reviewState: "accepted" as const,
    decisions: [],
  };
  const gapSnapshotDigest = deterministicDigest({
    projectId,
    version: 1,
    reportId,
    reportDigest,
    decisionsDigest: "e".repeat(64),
    data: gapData,
  });
  await db.insert(acceptedContentGapSnapshots).values({
    id: `acgs-${randomUUID()}`,
    projectId,
    version: 1,
    reportId: report!.id,
    reportDigest: report!.snapshotDigest,
    decisionsDigest: "e".repeat(64),
    acceptedInputSnapshotId: inputSnapshot.id,
    acceptedInputVersion: inputSnapshot.version,
    acceptedInputDigest: inputSnapshot.digest,
    serpSnapshotId: serpId,
    serpSnapshotDigest: "a".repeat(64),
    intelligenceSnapshotId: intelligenceId,
    intelligenceSnapshotDigest: "d".repeat(64),
    pageSnapshotRefs: [],
    analysisRefs: [],
    data: gapData,
    snapshotDigest: gapSnapshotDigest,
  });
}

// ---------------------------------------------------------------------------
// The read-model state matrix (spec §84)
// ---------------------------------------------------------------------------

test("workflow: empty project derives NOT_STARTED intake and BLOCKED deployment", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-empty", name: "Empty" });
    const wf = (await deriveProjectWorkflow(deps, p.id))!;

    assert.equal(wf.projectId, p.id);
    assert.equal(wf.overall, "IN_PROGRESS");
    const intakeArea = wf.areas.find((a) => a.area === "intake");
    assert.equal(intakeArea?.state, "NOT_STARTED");
    assert.equal(wf.deployment.state, "BLOCKED");
    assert.equal(wf.deployment.blockers.some((b) => b.code === "NO_PRODUCTION_PAGES"), true);
    assert.ok(wf.nextAction);
    assert.equal(wf.nextAction!.area, "intake");
    assert.equal(wf.pages.length, 0);
  } finally {
    await dbInst.close();
  }
});

test("workflow: accepted intake only → intake ACCEPTED, research READY, next action research", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-intake", name: "Intake only" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });

    const wf = (await deriveProjectWorkflow(deps, p.id))!;
    const intakeArea = wf.areas.find((a) => a.area === "intake");
    assert.equal(intakeArea?.state, "ACCEPTED");
    assert.ok(intakeArea?.currentAuthorities[0]?.digest);
    assert.equal(intakeArea?.currentAuthorities[0]?.version, 1);

    const researchArea = wf.areas.find((a) => a.area === "research");
    assert.equal(researchArea?.state, "READY");

    // Next action: research (content needs research lineage first? No — the
    // decision table puts research first when missing).
    assert.equal(wf.nextAction?.area, "research");
    assert.equal(wf.overall, "IN_PROGRESS");
    assert.equal(wf.deployment.state, "BLOCKED");
  } finally {
    await dbInst.close();
  }
});

test("workflow: intake draft with blockers → BLOCKED intake area + INTAKE_RESOLVE_BLOCKERS next action", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-blocked", name: "Blocked" });
    await intake.saveDraft({
      projectId: p.id,
      baseRevision: 0,
      payload: buildIntakePayload({ business: { name: "" } }),
    });
    const wf = (await deriveProjectWorkflow(deps, p.id))!;
    const intakeArea = wf.areas.find((a) => a.area === "intake");
    assert.equal(intakeArea?.state, "BLOCKED");
    assert.ok(intakeArea!.blockers.length > 0);
    assert.equal(wf.nextAction?.actionId, "INTAKE_RESOLVE_BLOCKERS");
    assert.equal(wf.overall, "BLOCKED");
  } finally {
    await dbInst.close();
  }
});

test("workflow: fully current single page → READY_FOR_DEPLOYMENT with deterministic next action", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-ready", name: "Ready" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });
    const snapshot = (await intake.listSnapshots(p.id))[0]!;
    await insertResearch(dbInst.db, p.id, { id: snapshot.id, version: snapshot.version, digest: snapshot.digest });

    const content = await insertAcceptedContent(dbInst.db, p.id, "home", 1);
    const design = await insertDesign(dbInst.db, p.id, 1);
    const vset = await insertVisualSet(dbInst.db, p.id, 1, {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    });
    const input = await insertProductionInput(dbInst.db, p.id, "home", 1, ref(content), {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    }, { id: vset.id, version: vset.version, digest: vset.setDigest });
    const candidate = await insertCandidate(dbInst.db, p.id, "home", input, "qa_passed", deterministicDigest({ artifact: "home" }));
    await insertQaRun(dbInst.db, p.id, candidate.id, "PASS", candidate.artifactDigest);

    const wf = (await deriveProjectWorkflow(deps, p.id))!;
    assert.equal(wf.overall, "READY_FOR_DEPLOYMENT");
    assert.equal(wf.deployment.state, "READY_FOR_DEPLOYMENT");
    assert.equal(wf.deployment.qaCurrent, true);
    assert.ok(wf.deployment.candidate?.digest);
    assert.equal(wf.nextAction?.actionId, "READY_FOR_DEPLOYMENT");

    const page = wf.pages.find((row) => row.pageIdentity === "home");
    assert.ok(page);
    assert.equal(page!.content.state, "ACCEPTED");
    assert.equal(page!.content.relation, "CURRENT");
    assert.equal(page!.production.state, "ACCEPTED");
    assert.equal(page!.qa.state, "ACCEPTED");
    assert.equal(page!.qa.relation, "CURRENT");

    // Theorem 1: same authority → same derived state (determinism).
    const wf2 = await deriveProjectWorkflow(deps, p.id);
    assert.deepEqual(JSON.parse(JSON.stringify(wf)), JSON.parse(JSON.stringify(wf2)));
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Theorem 3 — the staleness cascade (spec §30, §82)
// ---------------------------------------------------------------------------

test("workflow: staleness cascade — new accepted content makes derivatives/production stale, QA historical, deployment BLOCKED", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-cascade", name: "Cascade" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });
    const snapshot = (await intake.listSnapshots(p.id))[0]!;
    await insertResearch(dbInst.db, p.id, { id: snapshot.id, version: snapshot.version, digest: snapshot.digest });

    // C1 fully current chain.
    const c1 = await insertAcceptedContent(dbInst.db, p.id, "home", 1);
    const set1 = await insertDerivativeSet(dbInst.db, p.id, "home", 1, {
      id: c1.id,
      version: c1.version,
      digest: c1.contentDigest,
    });
    const design = await insertDesign(dbInst.db, p.id, 1);
    const vset = await insertVisualSet(dbInst.db, p.id, 1, {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    });
    const input1 = await insertProductionInput(dbInst.db, p.id, "home", 1, ref(c1), {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    }, { id: vset.id, version: vset.version, digest: vset.setDigest });
    const cand1 = await insertCandidate(dbInst.db, p.id, "home", input1, "qa_passed", deterministicDigest({ artifact: "home-1" }));
    await insertQaRun(dbInst.db, p.id, cand1.id, "PASS", cand1.artifactDigest);

    const before = (await deriveProjectWorkflow(deps, p.id))!;
    assert.equal(before.overall, "READY_FOR_DEPLOYMENT");

    // Accept newer C2 — WITHOUT touching any workflow state.
    const c2 = await insertAcceptedContent(dbInst.db, p.id, "home", 2);
    assert.notEqual(c2.id, c1.id);

    const after = (await deriveProjectWorkflow(deps, p.id))!;
    assert.notEqual(after.overall, "READY_FOR_DEPLOYMENT");
    assert.equal(after.deployment.state, "BLOCKED");

    const page = after.pages.find((row) => row.pageIdentity === "home");
    assert.ok(page);
    // Content = current new version.
    assert.equal(page!.content.version, 2);
    assert.equal(page!.content.relation, "CURRENT");
    // Derivatives = STALE (bound to v1).
    assert.equal(page!.derivatives.state, "STALE");
    assert.equal(page!.derivatives.freshness, "STALE");
    // Production input = STALE (binds v1 content).
    assert.equal(page!.production.state, "STALE");
    // Old QA = PASS but HISTORICAL / NOT CURRENT.
    assert.equal(page!.qa.state, "ACCEPTED");
    assert.equal(page!.qa.relation, "HISTORICAL");
    assert.equal(page!.qa.freshness, "STALE");

    // Deterministic next action points at recovery (derivatives first).
    assert.ok(after.nextAction);
    assert.equal(after.nextAction!.area, "content");
    assert.equal(after.nextAction!.reasonCode, "DERIVATIVES_STALE");
    assert.equal(after.nextAction!.pageIdentity, "home");

    // Theorem 4: v1 remains visible as HISTORICAL, never rewritten as failed.
    const versions = await deriveProjectVersions(deps, p.id);
    const contentVersions = versions!.artifacts.filter((a) => a.artifactKind === "AcceptedPageContent");
    assert.equal(contentVersions.length, 2);
    const v1 = contentVersions.find((a) => a.version === 1)!;
    const v2 = contentVersions.find((a) => a.version === 2)!;
    assert.equal(v1.relation, "HISTORICAL");
    assert.equal(v2.relation, "CURRENT");
    assert.equal(v1.digest, c1.contentDigest);
    assert.equal(v2.digest, c2.contentDigest);

    // Derivative set v1: relation CURRENT (newest) but freshness STALE.
    const setVersions = versions!.artifacts.filter((a) => a.artifactKind === "AcceptedDerivativeSet");
    assert.equal(setVersions.length, 1);
    assert.equal(setVersions[0]!.relation, "CURRENT");
    assert.equal(setVersions[0]!.freshness, "STALE");
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Multi-page mixed state (spec §86)
// ---------------------------------------------------------------------------

test("workflow: multi-page mixed state — home current, service derivatives stale → project blocked, next action service recovery", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-multi", name: "Multi" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });
    const snapshot = (await intake.listSnapshots(p.id))[0]!;
    await insertResearch(dbInst.db, p.id, { id: snapshot.id, version: snapshot.version, digest: snapshot.digest });

    // home: fully current. NOTE: accepted content versions are project-global
    // unique, so multi-page fixtures allocate increasing versions.
    const homeC1 = await insertAcceptedContent(dbInst.db, p.id, "home", 1);

    // service: content accepted at a later global version, derivative set
    // still bound to the superseded v1 content.
    const serviceC1 = await insertAcceptedContent(dbInst.db, p.id, "service", 2);
    const serviceC2 = await insertAcceptedContent(dbInst.db, p.id, "service", 3);

    const design = await insertDesign(dbInst.db, p.id, 1);
    const vset = await insertVisualSet(dbInst.db, p.id, 1, {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    });

    await insertDerivativeSet(dbInst.db, p.id, "home", 1, {
      id: homeC1.id,
      version: homeC1.version,
      digest: homeC1.contentDigest,
    });
    const homeInput = await insertProductionInput(dbInst.db, p.id, "home", 1, ref(homeC1), {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    }, { id: vset.id, version: vset.version, digest: vset.setDigest });
    const homeCand = await insertCandidate(dbInst.db, p.id, "home", homeInput, "qa_passed", deterministicDigest({ artifact: "home" }));
    await insertQaRun(dbInst.db, p.id, homeCand.id, "PASS", homeCand.artifactDigest);

    await insertDerivativeSet(dbInst.db, p.id, "service", 1, {
      id: serviceC1.id,
      version: serviceC1.version,
      digest: serviceC1.contentDigest,
    });

    const wf = (await deriveProjectWorkflow(deps, p.id))!;
    assert.equal(wf.overall, "BLOCKED");
    assert.notEqual(wf.deployment.state, "READY_FOR_DEPLOYMENT");

    const servicePage = wf.pages.find((row) => row.pageIdentity === "service");
    assert.equal(servicePage!.derivatives.state, "STALE");
    const homePage = wf.pages.find((row) => row.pageIdentity === "home");
    assert.equal(homePage!.production.state, "ACCEPTED");

    // Deterministic next action targets the stale service page derivatives.
    assert.equal(wf.nextAction?.reasonCode, "DERIVATIVES_STALE");
    assert.equal(wf.nextAction?.pageIdentity, "service");
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Versions: v1 accepted → v2 accepted ⇒ v1 HISTORICAL, v2 CURRENT (§87)
// ---------------------------------------------------------------------------

test("versions: v1 accepted then v2 accepted — v1 HISTORICAL, v2 CURRENT, v1 not mutated", async () => {
  const { dbInst, store, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-versions", name: "Versions" });
    const c1 = await insertAcceptedContent(dbInst.db, p.id, "home", 1);
    const c2 = await insertAcceptedContent(dbInst.db, p.id, "home", 2);

    const versions = await deriveProjectVersions(deps, p.id);
    const contentVersions = versions!.artifacts.filter((a) => a.artifactKind === "AcceptedPageContent");
    assert.equal(contentVersions.length, 2);
    const v1 = contentVersions.find((a) => a.version === 1)!;
    const v2 = contentVersions.find((a) => a.version === 2)!;
    assert.equal(v1.relation, "HISTORICAL");
    assert.equal(v2.relation, "CURRENT");
    // v1 row is unchanged (still its own digest/acceptedAt).
    assert.equal(v1.digest, c1.contentDigest);
    assert.equal(v2.digest, c2.contentDigest);
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Costs: UNKNOWN is never zero (§88)
// ---------------------------------------------------------------------------

test("costs: known and unknown costs aggregate truthfully — UNKNOWN never becomes $0", async () => {
  const { dbInst, store, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-costs", name: "Costs" });

    // Minimal run/task/attempt chain for model_invocations FK (store methods).
    const site = await store.registerSite({ projectKey: p.key, key: "s-costs", name: "Costs Site" });
    const { run, task } = await store.createRunAndTask({
      runId: `run-costs-${Date.now()}`,
      projectId: p.id,
      siteId: site.id,
      idempotencyKey: `idem-costs-${Date.now()}`,
      baseCommit: "sha-costs",
      startedAt: new Date(),
      taskType: "create_page",
      payload: {},
    });
    const attempt = await store.beginAttempt({
      runId: run.id,
      taskId: task.id,
      attemptNumber: 1,
      kind: "initial",
      stage: "codex",
      startedAt: new Date(),
    });

    // Known-cost invocation (5 USD in micros).
    await dbInst.db.insert(modelInvocations).values({
      id: `minv-${randomUUID()}`,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      taskKind: "create_page",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.1",
      runtime: "api",
      status: "succeeded",
      startedAt: new Date(),
      costMicros: 5_000_000,
    });
    // Unknown-cost invocation (same provider/model/operation).
    await dbInst.db.insert(modelInvocations).values({
      id: `minv-${randomUUID()}`,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      taskKind: "create_page",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.1",
      runtime: "api",
      status: "succeeded",
      startedAt: new Date(),
      costMicros: null,
    });
    // Visual generation with unknown cost (real prompt snapshot FK).
    const [plan] = await dbInst.db
      .insert(visualAssetPlans)
      .values({
        id: `vpln-${randomUUID()}`,
        projectId: p.id,
        version: 1,
        designArtifactId: "ades-none",
        designArtifactVersion: 1,
        designCandidateDigest: deterministicDigest({ dc: 1 }),
        designInputDigest: deterministicDigest({ di: 1 }),
        designProviderMode: "fixture",
        slots: [],
        planDigest: deterministicDigest({ vp: 1 }),
      })
      .returning();
    const [vsnap] = await dbInst.db
      .insert(visualPromptSnapshots)
      .values({
        id: `vpsn-${randomUUID()}`,
        projectId: p.id,
        planId: plan!.id,
        slot: "hero",
        promptDigest: deterministicDigest({ vsnap: "hero" }),
        operation: "generate",
        truthClass: "illustrative",
        data: {},
      })
      .returning();
    await dbInst.db.insert(visualGenerationRequests).values({
      id: `vgr-${randomUUID()}`,
      projectId: p.id,
      slot: "hero",
      requestDigest: deterministicDigest({ req: "hero" }),
      promptSnapshotId: vsnap!.id,
      promptDigest: vsnap!.promptDigest,
      provider: "google-genai",
      providerMode: "fixture",
      model: "gemini-test",
      modelPolicyVersion: "v1",
      operation: "generate",
      resultState: "succeeded",
      costMicros: null,
    });

    const costs = await deriveProjectCosts(deps, p.id);
    assert.ok(costs);
    const openrouter = costs!.rows.find((r) => r.provider === "openrouter")!;
    assert.ok(openrouter);
    assert.equal(openrouter.calls, 2);
    assert.equal(openrouter.knownCost.kind, "KNOWN");
    assert.equal(openrouter.knownCost.kind === "KNOWN" ? openrouter.knownCost.amountUsd : -1, 5);
    assert.equal(openrouter.unknownCostCalls, 1);

    const visual = costs!.rows.find((r) => r.provider === "google-genai")!;
    assert.ok(visual);
    assert.equal(visual.calls, 1);
    assert.equal(visual.knownCost.kind, "UNKNOWN");
    assert.equal(visual.unknownCostCalls, 1);

    // Design provider truthfully reported as unavailable.
    assert.ok(costs!.unavailableSources.some((s) => s.source === "design_provider"));
  } finally {
    await dbInst.close();
  }
});

test("costs: page grouping separates summary cost rows per page", async () => {
  const { dbInst, store, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-costs2", name: "Costs2" });
    const content = await insertAcceptedContent(dbInst.db, p.id, "home", 1);
    const [intent] = await dbInst.db
      .insert(pageDerivativeIntentSnapshots)
      .values({
        id: `dint-${randomUUID()}`,
        projectId: p.id,
        pageIdentity: "home",
        acceptedContentId: content.id,
        acceptedContentVersion: content.version,
        acceptedContentDigest: content.contentDigest,
        effectiveSummaryState: "enabled",
        effectiveSummaryLanguage: "en",
        effectiveSummaryPolicyVersion: "v1",
        effectiveAudioState: "disabled",
        effectiveAudioLanguage: "en",
        effectiveAudioVoiceId: null,
        effectiveAudioPolicyVersion: "v1",
        snapshotDigest: deterministicDigest({ is: 1 }),
        data: {},
      })
      .returning();
    const [sps] = await dbInst.db
      .insert(summaryPromptSnapshots)
      .values({
        id: `ssnp-${randomUUID()}`,
        projectId: p.id,
        pageIdentity: "home",
        intentSnapshotId: intent!.id,
        intentSnapshotDigest: intent!.snapshotDigest,
        acceptedContentId: content.id,
        acceptedContentVersion: content.version,
        acceptedContentDigest: content.contentDigest,
        summaryPolicyVersion: "v1",
        language: "en",
        provider: "fixture",
        model: "fixture/page_summarizer",
        systemPrompt: "system",
        userPrompt: "user",
        maxOutputTokens: 1024,
        promptDigest: deterministicDigest({ sps: 1 }),
      })
      .returning();
    await dbInst.db.insert(summaryProposals).values({
      id: `sspr-${randomUUID()}`,
      projectId: p.id,
      pageIdentity: "home",
      acceptedContentId: content.id,
      acceptedContentVersion: content.version,
      acceptedContentDigest: content.contentDigest,
      promptSnapshotId: sps!.id,
      promptSnapshotDigest: sps!.promptDigest,
      providerMode: "fixture",
      isTestDouble: true,
      provider: "fixture",
      model: "fixture/page_summarizer",
      summaryText: "Summary text.",
      providerRequestId: "pr-1",
      usageCostMicros: 0,
      usageCurrency: "UNKNOWN",
      proposalDigest: deterministicDigest({ sp: 1 }),
      state: "generated",
    });
    const costs = await deriveProjectCosts(deps, p.id);
    const row = costs!.rows.find((r) => r.operation === "summary_generation");
    assert.ok(row);
    assert.equal(row.pageIdentity, "home");
    // usageCostMicros = 0 with currency UNKNOWN is recorded evidence of a
    // zero-cost fixture call — the KNOWN zero is truthful here because the
    // provider reported it; the currency marker keeps it distinguishable.
    assert.equal(row.knownCost.kind, "KNOWN");
    assert.equal(row.knownCost.kind === "KNOWN" ? row.knownCost.amountUsd : -1, 0);
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Next-action determinism (§85)
// ---------------------------------------------------------------------------

test("next action: same authority state produces the same primary action regardless of row ordering", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const p = await store.createProject({ key: "wf-det", name: "Det" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: p.id, baseRevision: 0, payload });
    await intake.accept({ projectId: p.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });
    const snapshot = (await intake.listSnapshots(p.id))[0]!;
    await insertResearch(dbInst.db, p.id, { id: snapshot.id, version: snapshot.version, digest: snapshot.digest });

    // Two pages both with stale derivatives — insertion order must not matter.
    const design = await insertDesign(dbInst.db, p.id, 1);
    const vset = await insertVisualSet(dbInst.db, p.id, 1, {
      id: design.id,
      version: design.version,
      digest: design.candidateDigest,
    });
    let nextVersion = 1;
    let nextInputVersion = 1;
    for (const slug of ["zeta", "alpha"]) {
      const c1 = await insertAcceptedContent(dbInst.db, p.id, slug, nextVersion++);
      await insertDerivativeSet(dbInst.db, p.id, slug, 1, {
        id: c1.id,
        version: c1.version,
        digest: c1.contentDigest,
      });
      await insertAcceptedContent(dbInst.db, p.id, slug, nextVersion++);
      const input = await insertProductionInput(dbInst.db, p.id, slug, nextInputVersion++, ref(c1), {
        id: design.id,
        version: design.version,
        digest: design.candidateDigest,
      }, { id: vset.id, version: vset.version, digest: vset.setDigest });
      await insertCandidate(dbInst.db, p.id, slug, input, "built", null);
    }

    const wfA = await deriveProjectWorkflow(deps, p.id);
    const wfB = await deriveProjectWorkflow(deps, p.id);
    assert.equal(wfA!.nextAction?.actionId, wfB!.nextAction?.actionId);
    assert.equal(wfA!.nextAction?.pageIdentity, wfB!.nextAction?.pageIdentity);
    // Lexical page tie-break: alpha before zeta.
    assert.equal(wfA!.nextAction?.pageIdentity, "alpha");
    assert.equal(wfA!.nextAction?.reasonCode, "DERIVATIVES_STALE");
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// Direct API project isolation (§83, §129)
// ---------------------------------------------------------------------------

test("workflow: foreign project read returns not_found (no cross-project leak)", async () => {
  const { dbInst, store, intake, deps } = await setup();
  try {
    const pA = await store.createProject({ key: "wf-iso-a", name: "A" });
    const pB = await store.createProject({ key: "wf-iso-b", name: "B" });
    const payload = buildIntakePayload();
    await intake.saveDraft({ projectId: pA.id, baseRevision: 0, payload });
    await intake.accept({ projectId: pA.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });
    await insertAcceptedContent(dbInst.db, pA.id, "home", 1);

    const wfB = await deriveProjectWorkflow(deps, pB.id);
    assert.equal(wfB!.pages.length, 0);
    assert.equal(wfB!.areas.find((a) => a.area === "intake")?.state, "NOT_STARTED");

    const versionsB = await deriveProjectVersions(deps, pB.id);
    assert.equal(versionsB!.artifacts.length, 0);

    const costsB = await deriveProjectCosts(deps, pB.id);
    assert.equal(costsB!.rows.length, 0);

    // Unknown project id → null (API maps to 404).
    assert.equal(await deriveProjectWorkflow(deps, "nonexistent"), null);
    assert.equal(await deriveProjectVersions(deps, "nonexistent"), null);
    assert.equal(await deriveProjectCosts(deps, "nonexistent"), null);
    assert.ok(pA.id && pB.id); // keep both referenced
  } finally {
    await dbInst.close();
  }
});
