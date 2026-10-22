import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./helpers.js";
import {
  projects,
  sites,
  productionCandidates,
  productionCandidateInputs,
  productionPageInputs,
  productionQaRuns,
  deployments,
  projectReviewerMemberships,
  productionEffectiveTransitions,
  releaseApprovals,
} from "../../src/persistence/schema.js";
import { FactoryStore } from "../../src/persistence/store.js";
import {
  AuditSealKeyring,
  computeReleaseApprovalSeal,
  PostgreSqlSessionRevocationStore,
  ReleaseApprovalBoundary,
  ReleaseIdentityProvider,
} from "../../src/trust/release-approval-boundary.js";
import { GovernedDeliveryService } from "../../src/delivery/governed-service.js";
import { MonitoringService } from "../../src/monitoring/service.js";
import { ProductionStore } from "../../src/production/store.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { loadProductionBuildIdentity } from "../../src/production/identity.js";
import { SimulatedWrangler } from "../../src/delivery/simulated-wrangler.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { computeArtifactDigest } from "../../src/production/build-service.js";

const SUTHERLAND_SIX_ROUTES = [
  "/",
  "/about",
  "/contact",
  "/insights",
  "/services",
  "/services/executive-search",
];

test("P0-01 & P0-02 Fault-injection and crash recovery matrix", async () => {
  const dbInst = await createTestDatabase();
  const db = dbInst.db;
  const store = new FactoryStore(db);
  const repoRoot = await resolveRepositoryRoot();
  const prodStore = new ProductionStore(db, { repoRoot });

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-fault-${suffix}`;
  const siteId = `site-fault-${suffix}`;
  const workerName = `worker-fault-${suffix}`;
  const productionUrl = "https://fault-test.pages.dev";

  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: "b".repeat(64) },
  });
  const revocationStore = new PostgreSqlSessionRevocationStore(db);
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-fault-idp", db);
  const releaseBoundary = new ReleaseApprovalBoundary(db, { keyring, idp, revocationStore });

  const simulatedWrangler = new SimulatedWrangler();
  const wranglerFactory = () => simulatedWrangler;

  const worktreeProvider = {
    async prepare(_root: string, _commit: string, id: string) {
      const wtDir = path.join(tmpdir(), `test-fault-wt-${id}-${randomUUID()}`);
      await mkdir(path.join(wtDir, "sites", "starter"), { recursive: true });
      return wtDir;
    },
    async remove(_root: string, wt: string) {
      await rm(wt, { recursive: true, force: true }).catch(() => {});
    },
  };

  let mockQaPassed = true;
  const qaRunner = async () => ({
    passed: mockQaPassed,
    exitCode: mockQaPassed ? 0 : 1,
    timedOut: false,
  });

  let currentInputIds: string[] = [];
  const mockProdStore = {
    inputStaleness: async () => ({ stale: false, reason: null }),
    candidateStaleness: async () => ({ stale: false, reason: null }),
    getCandidate: (...args: [string, string]) => prodStore.getCandidate(...args),
    latestQaRun: (...args: [string, string]) => prodStore.latestQaRun(...args),
    getQaRun: (...args: [string]) => prodStore.getQaRun(...args),
    listCandidateInputs: (...args: [string, string]) => prodStore.listCandidateInputs(...args),
    listProductionInputs: async (pId: string) => {
      const all = await prodStore.listProductionInputs(pId);
      return currentInputIds.length ? all.filter((i) => currentInputIds.includes(i.id)) : all;
    },
    listCandidateRedirects: (...args: [string, string]) => prodStore.listCandidateRedirects(...args),
    getProductionInputById: (...args: [string]) => prodStore.getProductionInputById(...args),
  } as unknown as ProductionStore;

  const governedDelivery = new GovernedDeliveryService({
    db,
    repoRoot,
    store,
    productionStore: mockProdStore,
    releaseBoundary,
    wranglerFactory,
    worktreeProvider,
    qaRunner,
  });

  // Seed project, site, membership
  await db.insert(projects).values({ id: projectId, key: projectId, name: "Fault Test" });
  await db.insert(sites).values({
    id: siteId,
    projectId,
    key: `fault-site-${suffix}`,
    name: "Fault Site",
    cloudflareWorkerName: workerName,
    productionUrl,
  });

  await db.insert(projectReviewerMemberships).values({
    id: `mem-${suffix}`,
    projectId,
    actorId: "actor-1",
    actorRole: "DEPLOYMENT_ADMIN",
    permissions: ["DEPLOYMENT:PREVIEW", "DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH", "DEPLOYMENT:MONITOR"],
  });

  const sessionToken = signAssertion({
    actorId: "actor-1",
    actorName: "Test Actor",
    actorRole: "DEPLOYMENT_ADMIN",
  });

  const buildIdentity = await loadProductionBuildIdentity(repoRoot);
  const shaA = buildIdentity.repositorySha;
  const candidateIdA = `cand-fault-A-${suffix}`;

  const candidateDistA = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdA, "dist");
  await mkdir(candidateDistA, { recursive: true });
  await writeFile(path.join(candidateDistA, "index.html"), "<html><body>Fault Test A</body></html>", "utf8");
  const digestA = await computeArtifactDigest(candidateDistA);

  // Seed inputs for candidate A
  const inputIdsA: string[] = [];
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    const inputId = `input-A-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
    inputIdsA.push(inputId);
    await db.insert(productionPageInputs).values({
      id: inputId,
      projectId,
      version: idx + 1,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      pageType: route === "/" ? "homepage" : "service",
      route,
      canonicalOrigin: productionUrl,
      acceptedContentId: `c-${inputId}`,
      acceptedContentVersion: 1,
      acceptedContentDigest: digestA,
      acceptedDesignId: `d-${inputId}`,
      acceptedDesignVersion: 1,
      acceptedDesignDigest: digestA,
      acceptedVisualSetId: `v-${inputId}`,
      acceptedVisualSetVersion: 1,
      acceptedVisualSetDigest: digestA,
      rendererId: "astro-static",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {},
      inputDigest: digestA,
    });
  }
  currentInputIds = inputIdsA;

  await db.insert(productionCandidates).values({
    id: candidateIdA,
    projectId,
    productionInputId: inputIdsA[0]!,
    productionInputVersion: 1,
    productionInputDigest: digestA,
    pageIdentity: "sutherland-multi",
    route: "/",
    canonicalUrl: productionUrl + "/",
    artifactDigest: digestA,
    artifactRef: candidateDistA,
    manifestSetDigest: digestA,
    redirectSnapshotDigest: digestA,
    siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
    lockfileDigest: buildIdentity.lockfileDigest,
    rendererVersion: buildIdentity.rendererVersion,
    repositorySha: shaA,
    state: "qa_passed",
  });

  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    await db.insert(productionCandidateInputs).values({
      candidateId: candidateIdA,
      projectId,
      productionInputId: inputIdsA[idx]!,
      productionInputVersion: idx + 1,
      productionInputDigest: digestA,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      route,
      manifestDigest: digestA,
    });
  }

  const qaRunIdA = `qa-a-${suffix}`;
  await db.insert(productionQaRuns).values({
    id: qaRunIdA,
    projectId,
    candidateId: candidateIdA,
    candidateArtifactDigest: digestA,
    overall: "PASS",
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdA,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  });

  // Prepare preview & approve Release A
  const previewA = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candidateIdA,
    sessionToken,
  });
  const approvalA = await governedDelivery.approveRelease({
    projectId,
    candidateId: candidateIdA,
    previewVersionId: previewA.versionId!,
    sessionToken,
  });

  // Set Cloudflare active version to previewA.versionId
  await simulatedWrangler.promote(workerName, previewA.versionId!);

  // ---------------------------------------------------------------------------
  // Case 1 (P0-01): Matching provider version + failed QA -> NEEDS_REVIEW
  // ---------------------------------------------------------------------------
  mockQaPassed = false; // Simulate failing production QA
  const stuckDepId1 = `dep-fail-qa-${suffix}`;
  await store.createDeployment({
    id: stuckDepId1,
    operationId: `pub-${stuckDepId1}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId1}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: approvalA.id,
    versionId: previewA.versionId!,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const recon1 = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(recon1.reconciled, true);
  const dep1 = await store.getDeployment(stuckDepId1);
  assert.equal(dep1?.status, "needs_review", "Must be needs_review when post-crash QA fails");
  assert.equal(dep1?.productionVerified, false, "Must not mark productionVerified true when QA fails");

  // ---------------------------------------------------------------------------
  // Case 2 (P0-01): Matching provider version + missing approval -> NEEDS_REVIEW
  // ---------------------------------------------------------------------------
  mockQaPassed = true;
  const stuckDepId2 = `dep-no-appr-${suffix}`;
  await store.createDeployment({
    id: stuckDepId2,
    operationId: `pub-${stuckDepId2}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId2}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    versionId: previewA.versionId!,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const recon2 = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(recon2.reconciled, true);
  const dep2 = await store.getDeployment(stuckDepId2);
  assert.equal(dep2?.status, "needs_review", "Must be needs_review when release approval is missing");
  assert.equal(dep2?.productionVerified, false);

  // ---------------------------------------------------------------------------
  // Case 3 (P0-01): Matching provider version + missing artifact digest -> NEEDS_REVIEW
  // ---------------------------------------------------------------------------
  const stuckDepId3 = `dep-no-digest-${suffix}`;
  await store.createDeployment({
    id: stuckDepId3,
    operationId: `pub-${stuckDepId3}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId3}`,
    candidateId: candidateIdA,
    releaseApprovalId: approvalA.id,
    versionId: previewA.versionId!,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const recon3 = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(recon3.reconciled, true);
  const dep3 = await store.getDeployment(stuckDepId3);
  assert.equal(dep3?.status, "needs_review", "Must be needs_review when artifact digest is missing");

  // ---------------------------------------------------------------------------
  // Case 4 (P0-01): Matching provider version + missing route manifest -> NEEDS_REVIEW
  // ---------------------------------------------------------------------------
  const stuckDepId4 = `dep-no-routes-${suffix}`;
  await store.createDeployment({
    id: stuckDepId4,
    operationId: `pub-${stuckDepId4}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId4}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: approvalA.id,
    versionId: previewA.versionId!,
    status: "promoting",
  });

  const recon4 = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(recon4.reconciled, true);
  const dep4 = await store.getDeployment(stuckDepId4);
  assert.equal(dep4?.status, "needs_review", "Must be needs_review when candidate routes are missing");

  // ---------------------------------------------------------------------------
  // Case 5 (P0-01): Matching provider version + valid proof + passed QA -> VERIFIED
  // ---------------------------------------------------------------------------
  const stuckDepId5 = `dep-valid-${suffix}`;
  await store.createDeployment({
    id: stuckDepId5,
    operationId: `pub-${stuckDepId5}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId5}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: approvalA.id,
    qaRunId: qaRunIdA,
    versionId: previewA.versionId!,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const recon5 = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(recon5.reconciled, true);
  const dep5 = await store.getDeployment(stuckDepId5);
  assert.equal(dep5?.status, "verified", "Must be verified when all evidence valid and QA passed");
  assert.equal(dep5?.productionVerified, true);

  // ---------------------------------------------------------------------------
  // Case 6 (P0-02): Idempotent retry of finalization returns existing result without duplicating rows
  // ---------------------------------------------------------------------------
  const retryResult = await store.finalizeDeploymentAndTransitionAtomic({
    deploymentId: stuckDepId5,
    status: "verified",
    transition: {
      id: `trans-duplicate-attempt-${suffix}`,
      projectId,
      siteId,
      deploymentId: stuckDepId5,
      versionId: previewA.versionId!,
      candidateId: candidateIdA,
      eventType: "PUBLISH",
      effectiveAt: new Date(),
      fromVersionId: null,
      toVersionId: previewA.versionId!,
      actorId: "actor-1",
      actorName: "Test Actor",
      actorRole: "DEPLOYMENT_ADMIN",
    },
  });
  assert.equal(retryResult.alreadyFinalized, true, "Retry must recognize already finalized status");

  // Verify DB uniqueness constraint: exactly 1 transition exists for this deployment
  const transitions = await store.listEffectiveTransitions(siteId, 50);
  const dep5Transitions = transitions.filter((t) => t.deploymentId === stuckDepId5);
  assert.equal(dep5Transitions.length, 1, "Must never have more than 1 transition for the same deployment");

  // ---------------------------------------------------------------------------
  // Case 7 (P1-01): Rollback preserves target release's exact qaRunId
  // ---------------------------------------------------------------------------
  // Build and publish candidate B
  const candidateIdB = `cand-fault-B-${suffix}`;
  const shaB = buildIdentity.repositorySha;
  const candidateDistB = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdB, "dist");
  await mkdir(candidateDistB, { recursive: true });
  await writeFile(path.join(candidateDistB, "index.html"), "<html><body>Fault Test B</body></html>", "utf8");
  const digestB = await computeArtifactDigest(candidateDistB);

  const inputIdsB: string[] = [];
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    const inputId = `input-B-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
    inputIdsB.push(inputId);
    await db.insert(productionPageInputs).values({
      id: inputId,
      projectId,
      version: idx + 10,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      pageType: route === "/" ? "homepage" : "service",
      route,
      canonicalOrigin: productionUrl,
      acceptedContentId: `c-${inputId}`,
      acceptedContentVersion: 1,
      acceptedContentDigest: digestB,
      acceptedDesignId: `d-${inputId}`,
      acceptedDesignVersion: 1,
      acceptedDesignDigest: digestB,
      acceptedVisualSetId: `v-${inputId}`,
      acceptedVisualSetVersion: 1,
      acceptedVisualSetDigest: digestB,
      rendererId: "astro-static",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {},
      inputDigest: digestB,
    });
  }
  currentInputIds = inputIdsB;

  await db.insert(productionCandidates).values({
    id: candidateIdB,
    projectId,
    productionInputId: inputIdsB[0]!,
    productionInputVersion: 10,
    productionInputDigest: digestB,
    pageIdentity: "sutherland-multi",
    route: "/",
    canonicalUrl: productionUrl + "/",
    artifactDigest: digestB,
    artifactRef: candidateDistB,
    manifestSetDigest: digestB,
    redirectSnapshotDigest: digestB,
    siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
    lockfileDigest: buildIdentity.lockfileDigest,
    rendererVersion: buildIdentity.rendererVersion,
    repositorySha: shaB,
    state: "qa_passed",
  });

  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    await db.insert(productionCandidateInputs).values({
      candidateId: candidateIdB,
      projectId,
      productionInputId: inputIdsB[idx]!,
      productionInputVersion: idx + 10,
      productionInputDigest: digestB,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      route,
      manifestDigest: digestB,
    });
  }

  const qaRunIdB = `qa-b-${suffix}`;
  await db.insert(productionQaRuns).values({
    id: qaRunIdB,
    projectId,
    candidateId: candidateIdB,
    candidateArtifactDigest: digestB,
    overall: "PASS",
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdB,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  });

  const previewB = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candidateIdB,
    sessionToken,
  });
  const approvalB = await governedDelivery.approveRelease({
    projectId,
    candidateId: candidateIdB,
    previewVersionId: previewB.versionId!,
    sessionToken,
  });
  await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candidateIdB,
    previewVersionId: previewB.versionId!,
    approvalId: approvalB.id,
    sessionToken,
  });

  // Rollback to Release A (stuckDepId5 which has qaRunIdA)
  const rolledBack = await governedDelivery.rollbackExplicit({
    projectId,
    targetVersionId: previewA.versionId!,
    sessionToken,
  });

  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.versionId, previewA.versionId);
  assert.equal(rolledBack.qaRunId, qaRunIdA, "Rollback MUST preserve target release's exact qaRunId (P1-01)");

  // ---------------------------------------------------------------------------
  // Case 8 (P1-05): Monitoring and release resolvers do not guess active release without a transition
  // ---------------------------------------------------------------------------
  const unlinkedSiteId = `site-unlinked-${suffix}`;
  await db.insert(sites).values({
    id: unlinkedSiteId,
    projectId,
    key: `unlinked-${suffix}`,
    name: "Unlinked Site",
    cloudflareWorkerName: `worker-unlinked-${suffix}`,
    productionUrl: "https://unlinked.pages.dev",
  });

  // Insert a deployment with status 'verified', but NO transition in production_effective_transitions
  await store.createDeployment({
    id: `dep-unlinked-${suffix}`,
    siteId: unlinkedSiteId,
    sourceCommit: shaA,
    workerName: `worker-unlinked-${suffix}`,
    productionUrl: "https://unlinked.pages.dev",
    artifactDirectory: `.factory/deployments/dep-unlinked-${suffix}`,
    versionId: "ver-unlinked-fake",
    status: "verified",
  });

  const unlinkedEffective = await governedDelivery.resolveCurrentEffectiveProduction(unlinkedSiteId);
  assert.equal(unlinkedEffective.activeVersionId, null, "Must NOT infer active version when transition is absent (P1-05)");
  assert.equal(unlinkedEffective.executionOrigin, "UNKNOWN");

  // ---------------------------------------------------------------------------
  // Case 9 (P0-01): Atomic Publish Finalization — DB transition failure leaves deployment in promoted, NOT verified
  // ---------------------------------------------------------------------------
  const candidateIdC = `cand-c-${suffix}`;
  const shaC = buildIdentity.repositorySha;
  const candidateDistC = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdC, "dist");
  await mkdir(candidateDistC, { recursive: true });
  await writeFile(path.join(candidateDistC, "index.html"), "<html><body>Fault Test C</body></html>", "utf8");
  const digestC = await computeArtifactDigest(candidateDistC);
  const inputIdsC: string[] = [];
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    const inputId = `input-C-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
    inputIdsC.push(inputId);
    await db.insert(productionPageInputs).values({
      id: inputId,
      projectId,
      version: idx + 20,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      pageType: route === "/" ? "homepage" : "service",
      route,
      canonicalOrigin: productionUrl,
      acceptedContentId: `c-${inputId}`,
      acceptedContentVersion: 1,
      acceptedContentDigest: digestC,
      acceptedDesignId: `d-${inputId}`,
      acceptedDesignVersion: 1,
      acceptedDesignDigest: digestC,
      acceptedVisualSetId: `v-${inputId}`,
      acceptedVisualSetVersion: 1,
      acceptedVisualSetDigest: digestC,
      rendererId: "astro-static",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {},
      inputDigest: digestC,
    });
  }
  currentInputIds = inputIdsC;

  await db.insert(productionCandidates).values({
    id: candidateIdC,
    projectId,
    productionInputId: inputIdsC[0]!,
    productionInputVersion: 20,
    productionInputDigest: digestC,
    pageIdentity: "sutherland-multi",
    route: "/",
    canonicalUrl: productionUrl + "/",
    artifactDigest: digestC,
    artifactRef: candidateDistC,
    manifestSetDigest: digestC,
    redirectSnapshotDigest: digestC,
    siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
    lockfileDigest: buildIdentity.lockfileDigest,
    rendererVersion: buildIdentity.rendererVersion,
    repositorySha: shaA,
    state: "qa_passed",
  });
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    await db.insert(productionCandidateInputs).values({
      candidateId: candidateIdC,
      projectId,
      productionInputId: inputIdsC[idx]!,
      productionInputVersion: idx + 20,
      productionInputDigest: digestC,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      route,
      manifestDigest: digestC,
    });
  }
  const qaRunIdC = `qa-c-${suffix}`;
  await db.insert(productionQaRuns).values({
    id: qaRunIdC,
    projectId,
    candidateId: candidateIdC,
    candidateArtifactDigest: digestC,
    overall: "PASS",
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdC,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  });
  const previewC = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candidateIdC,
    sessionToken,
  });
  const approvalC = await governedDelivery.approveRelease({
    projectId,
    candidateId: candidateIdC,
    previewVersionId: previewC.versionId!,
    sessionToken,
  });

  // Inject a failure into finalizeDeploymentAndTransitionAtomic
  const originalFinalize = store.finalizeDeploymentAndTransitionAtomic.bind(store);
  store.finalizeDeploymentAndTransitionAtomic = async () => {
    throw new Error("Simulated database failure during publish atomic finalization");
  };

  const pubResult = await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candidateIdC,
    previewVersionId: previewC.versionId!,
    approvalId: approvalC.id,
    sessionToken,
  }).catch((err) => ({ threw: true, err }));

  // Assert deployment in PostgreSQL is NOT verified (it must remain in promoted!)
  const depAfterFailedPublish = await store.getDeployment(previewC.id);
  assert.equal(depAfterFailedPublish?.status, "promoted", "Publish failure MUST leave deployment in promoted, NOT verified (P0-01)");
  assert.equal(depAfterFailedPublish?.productionVerified, false, "DB must not be marked productionVerified until atomic finalization succeeds");

  // Restore store.finalizeDeploymentAndTransitionAtomic
  store.finalizeDeploymentAndTransitionAtomic = originalFinalize;

  // ---------------------------------------------------------------------------
  // Case 10 (P0-01): Atomic Rollback Finalization — DB transition failure leaves deployment in promoted, NOT rolled_back
  // ---------------------------------------------------------------------------
  // Now finalize Release C so we can test rollback
  await store.finalizeDeploymentAndTransitionAtomic({
    deploymentId: previewC.id,
    expectedStatus: ["promoting", "promoted", "verified"],
    status: "verified",
    operationId: `pub-${previewC.id}`,
    transition: {
      id: `trans-pub-${previewC.id}`,
      projectId,
      siteId,
      deploymentId: previewC.id,
      versionId: previewC.versionId!,
      candidateId: candidateIdC,
      eventType: "PUBLISH",
      fromVersionId: previewB.versionId!,
      toVersionId: previewC.versionId!,
      actorId: "actor-1",
      actorName: "Test Actor",
      actorRole: "DEPLOYMENT_ADMIN",
      effectiveAt: new Date(),
    },
  });

  // Inject failure for rollback
  let rollbackDepIdCaptured: string | null = null;
  const originalCreateDeployment = store.createDeployment.bind(store);
  store.createDeployment = async (input: any) => {
    const created = await originalCreateDeployment(input);
    if (created.id.startsWith("dep-rb-")) {
      rollbackDepIdCaptured = created.id;
    }
    return created;
  };

  store.finalizeDeploymentAndTransitionAtomic = async () => {
    throw new Error("Simulated database failure during rollback atomic finalization");
  };

  await assert.rejects(
    governedDelivery.rollbackExplicit({
      projectId,
      targetVersionId: previewA.versionId!,
      sessionToken,
    }),
    /Simulated database failure during rollback atomic finalization/,
  );

  assert.ok(rollbackDepIdCaptured, "Expected a rollback deployment record to be created");
  const depAfterFailedRollback = await store.getDeployment(rollbackDepIdCaptured!);
  assert.equal(depAfterFailedRollback?.status, "promoted", "Rollback failure MUST leave deployment in promoted, NOT rolled_back (P0-01)");

  // Restore methods
  store.createDeployment = originalCreateDeployment;
  store.finalizeDeploymentAndTransitionAtomic = originalFinalize;

  // ---------------------------------------------------------------------------
  // Case 11 (P0-02): Tampered HMAC seal blocks crash recovery
  // ---------------------------------------------------------------------------
  const tamperedVersionId = `ver-tampered-${suffix}`;
  const tamperedApprovalId = `appr-tampered-${suffix}`;
  await db.insert(releaseApprovals).values({
    ...approvalA,
    id: tamperedApprovalId,
    previewVersionId: tamperedVersionId,
    verificationSeal: "f".repeat(64),
  });

  const stuckDepIdTampered = `dep-tampered-seal-${suffix}`;
  await store.createDeployment({
    id: stuckDepIdTampered,
    operationId: `pub-${stuckDepIdTampered}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepIdTampered}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: tamperedApprovalId,
    qaRunId: qaRunIdA,
    versionId: tamperedVersionId,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const reconTampered = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconTampered.reconciled, true);
  const depTampered = await store.getDeployment(stuckDepIdTampered);
  assert.equal(depTampered?.status, "needs_review", "Tampered HMAC seal MUST move recovery to needs_review (P0-02)");
  assert.equal(depTampered?.errorCode, "release_approval_seal_invalid", "Error code must indicate invalid seal");

  // ---------------------------------------------------------------------------
  // Case 12 (P0-02): Revoked approval session blocks crash recovery
  // ---------------------------------------------------------------------------
  const revokedSessionId = `jti-revoked-${suffix}`;
  const revokedApprovalId = `appr-revoked-${suffix}`;
  const revokedVersionId = `ver-revoked-${suffix}`;
  const { seal: revokedSeal, sealKeyId: revokedSealKeyId } = computeReleaseApprovalSeal(
    {
      approvalId: revokedApprovalId,
      projectId,
      siteId,
      candidateId: candidateIdA,
      qaRunId: qaRunIdA,
      artifactDigest: digestA,
      previewVersionId: revokedVersionId,
      targetWorkerName: workerName,
      targetProductionUrl: productionUrl,
      actorId: "actor-1",
      isSynthetic: false,
    },
    keyring,
  );

  await db.insert(releaseApprovals).values({
    ...approvalA,
    id: revokedApprovalId,
    previewVersionId: revokedVersionId,
    sessionId: revokedSessionId,
    verificationSeal: revokedSeal,
    sealKeyId: revokedSealKeyId,
    sealStatus: "SEALED",
    revoked: false,
  });

  // Now revoke that session
  await revocationStore.revokeSession(revokedSessionId, "session_compromised_test");

  const stuckDepIdRevoked = `dep-revoked-sess-${suffix}`;
  await store.createDeployment({
    id: stuckDepIdRevoked,
    operationId: `pub-${stuckDepIdRevoked}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepIdRevoked}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: revokedApprovalId,
    qaRunId: qaRunIdA,
    versionId: revokedVersionId,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const reconRevoked = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconRevoked.reconciled, true);
  const depRevoked = await store.getDeployment(stuckDepIdRevoked);
  assert.equal(depRevoked?.status, "needs_review", "Revoked approval session MUST move recovery to needs_review (P0-02)");
  assert.equal(depRevoked?.errorCode, "release_approval_revoked");

  // ---------------------------------------------------------------------------
  // Case 13 (P1-01): Recovery strictly verifies approved QA run, rejecting mismatched qaRunId
  // ---------------------------------------------------------------------------
  const otherQaRunId = `qa-other-${suffix}`;
  await db.insert(productionQaRuns).values({
    id: otherQaRunId,
    projectId,
    candidateId: candidateIdA,
    candidateArtifactDigest: digestA,
    overall: "PASS",
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdA,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  });

  const stuckDepIdMismatchedQa = `dep-mismatched-qa-${suffix}`;
  await store.createDeployment({
    id: stuckDepIdMismatchedQa,
    operationId: `pub-${stuckDepIdMismatchedQa}`,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepIdMismatchedQa}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: approvalA.id,
    qaRunId: otherQaRunId, // Deployment has mismatched qaRunId relative to approvalA.qaRunId!
    versionId: previewA.versionId!,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const reconMismatchedQa = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconMismatchedQa.reconciled, true);
  const depMismatchedQa = await store.getDeployment(stuckDepIdMismatchedQa);
  assert.equal(depMismatchedQa?.status, "needs_review", "Mismatched qaRunId MUST move recovery to needs_review (P1-01)");
  assert.equal(depMismatchedQa?.errorCode, "recovery_qa_mismatch");

  await rm(path.resolve(repoRoot, ".factory", "production", "projects", projectId), { recursive: true, force: true }).catch(() => {});
  await dbInst.close();
});

test("P0 & P1 Rollback Crash Recovery Matrix (Separate Semantics, Pre-Mutation Intent, Idempotent Transitions)", async (t) => {
  const dbInst = await createTestDatabase();
  t.after(() => dbInst.close());
  const db = dbInst.db;
  const store = new FactoryStore(db);
  const repoRoot = await resolveRepositoryRoot();
  const prodStore = new ProductionStore(db, { repoRoot });

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-rb-rec-${suffix}`;
  const siteId = `site-rb-rec-${suffix}`;
  const workerName = `worker-rb-rec-${suffix}`;
  const productionUrl = "https://rollback-recovery-test.pages.dev";

  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: "c".repeat(64) },
  });
  const revocationStore = new PostgreSqlSessionRevocationStore(db);
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-rb-recovery-idp", db);
  const releaseBoundary = new ReleaseApprovalBoundary(db, { keyring, idp, revocationStore });

  const simulatedWrangler = new SimulatedWrangler();
  const wranglerFactory = () => simulatedWrangler;

  const worktreeProvider = {
    async prepare(_root: string, _commit: string, id: string) {
      const wtDir = path.join(tmpdir(), `test-rb-rec-wt-${id}-${randomUUID()}`);
      await mkdir(path.join(wtDir, "sites", "starter"), { recursive: true });
      return wtDir;
    },
    async remove(_root: string, wt: string) {
      await rm(wt, { recursive: true, force: true }).catch(() => {});
    },
  };

  let mockQaPassed = true;
  const recoveryQaCalls: Array<{ phase: string; candidateRoutes?: readonly string[] }> = [];
  const qaRunner = async (input: { phase: string; candidateRoutes?: readonly string[] }) => {
    recoveryQaCalls.push(input);
    return { passed: mockQaPassed, exitCode: mockQaPassed ? 0 : 1, timedOut: false };
  };

  let currentInputIds: string[] = [];
  const mockProdStore = {
    inputStaleness: async () => ({ stale: false, reason: null }),
    candidateStaleness: async () => ({ stale: false, reason: null }),
    getCandidate: (...args: [string, string]) => prodStore.getCandidate(...args),
    latestQaRun: (...args: [string, string]) => prodStore.latestQaRun(...args),
    getQaRun: (...args: [string]) => prodStore.getQaRun(...args),
    listCandidateInputs: (...args: [string, string]) => prodStore.listCandidateInputs(...args),
    listProductionInputs: async (pId: string) => {
      const all = await prodStore.listProductionInputs(pId);
      return currentInputIds.length ? all.filter((i) => currentInputIds.includes(i.id)) : all;
    },
    listCandidateRedirects: (...args: [string, string]) => prodStore.listCandidateRedirects(...args),
    getProductionInputById: (...args: [string]) => prodStore.getProductionInputById(...args),
  } as unknown as ProductionStore;

  const governedDelivery = new GovernedDeliveryService({
    db,
    repoRoot,
    store,
    productionStore: mockProdStore,
    releaseBoundary,
    wranglerFactory,
    worktreeProvider,
    qaRunner,
  });

  // Seed project, site, and two distinct operators
  await db.insert(projects).values({ id: projectId, key: projectId, name: "Rollback Recovery Test" });
  await db.insert(sites).values({
    id: siteId,
    projectId,
    key: `rb-rec-site-${suffix}`,
    name: "Rollback Recovery Site",
    cloudflareWorkerName: workerName,
    productionUrl,
  });

  await db.insert(projectReviewerMemberships).values([
    {
      id: `mem-pub-${suffix}`,
      projectId,
      actorId: "operator-publisher",
      actorRole: "DEPLOYMENT_ADMIN",
      permissions: ["DEPLOYMENT:PREVIEW", "DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH", "DEPLOYMENT:MONITOR"],
    },
    {
      id: `mem-rb-${suffix}`,
      projectId,
      actorId: "operator-rollback",
      actorRole: "DEPLOYMENT_ADMIN",
      permissions: ["DEPLOYMENT:PREVIEW", "DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH", "DEPLOYMENT:MONITOR"],
    },
  ]);

  const publisherSessionToken = signAssertion({
    actorId: "operator-publisher",
    actorName: "Original Publisher",
    actorRole: "DEPLOYMENT_ADMIN",
  });

  const rollbackSessionToken = signAssertion({
    actorId: "operator-rollback",
    actorName: "Rollback Operator",
    actorRole: "DEPLOYMENT_ADMIN",
  });

  const buildIdentity = await loadProductionBuildIdentity(repoRoot);
  const sha = buildIdentity.repositorySha;

  // Helper to create and seed a verified candidate
  async function createCandidate(candId: string, versionOffset: number, routes = SUTHERLAND_SIX_ROUTES) {
    const candidateDist = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candId, "dist");
    await mkdir(candidateDist, { recursive: true });
    await writeFile(path.join(candidateDist, "index.html"), `<html><body>Candidate ${candId}</body></html>`, "utf8");
    const digest = await computeArtifactDigest(candidateDist);

    const inputIds: string[] = [];
    for (let idx = 0; idx < routes.length; idx++) {
      const route = routes[idx]!;
      const inputId = `input-${candId}-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
      inputIds.push(inputId);
      await db.insert(productionPageInputs).values({
        id: inputId,
        projectId,
        version: idx + versionOffset,
        pageIdentity: route === "/" ? "home" : route.slice(1),
        pageType: route === "/" ? "homepage" : "service",
        route,
        canonicalOrigin: productionUrl,
        acceptedContentId: `c-${inputId}`,
        acceptedContentVersion: 1,
        acceptedContentDigest: digest,
        acceptedDesignId: `d-${inputId}`,
        acceptedDesignVersion: 1,
        acceptedDesignDigest: digest,
        acceptedVisualSetId: `v-${inputId}`,
        acceptedVisualSetVersion: 1,
        acceptedVisualSetDigest: digest,
        rendererId: "astro-static",
        rendererVersion: buildIdentity.rendererVersion,
        rendererPolicyVersion: "production-policy-v3",
        data: {},
        inputDigest: digest,
      });
    }

    await db.insert(productionCandidates).values({
      id: candId,
      projectId,
      productionInputId: inputIds[0]!,
      productionInputVersion: versionOffset,
      productionInputDigest: digest,
      pageIdentity: "sutherland-multi",
      route: "/",
      canonicalUrl: productionUrl + "/",
      artifactDigest: digest,
      artifactRef: candidateDist,
      manifestSetDigest: digest,
      redirectSnapshotDigest: digest,
      siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
      lockfileDigest: buildIdentity.lockfileDigest,
      rendererVersion: buildIdentity.rendererVersion,
      repositorySha: sha,
      state: "qa_passed",
    });

    for (let idx = 0; idx < routes.length; idx++) {
      const route = routes[idx]!;
      await db.insert(productionCandidateInputs).values({
        candidateId: candId,
        projectId,
        productionInputId: inputIds[idx]!,
        productionInputVersion: idx + versionOffset,
        productionInputDigest: digest,
        pageIdentity: route === "/" ? "home" : route.slice(1),
        route,
        manifestDigest: digest,
      });
    }

    const qaRunId = `qa-${candId}-${suffix}`;
    await db.insert(productionQaRuns).values({
      id: qaRunId,
      projectId,
      candidateId: candId,
      candidateArtifactDigest: digest,
      overall: "PASS",
      data: {
        schemaVersion: "production-v1",
        candidateId: candId,
        checks: [],
        overall: "PASS",
        provenance: {
          trustMode: "STRICT_PRODUCTION",
          publicationEligible: true,
          reviewAuthorityMode: "VERIFIED_HUMAN",
        },
      },
    });

    return { candId, digest, inputIds, qaRunId };
  }

  // 1. Publish Release A
  const candA = await createCandidate(`cand-A-${suffix}`, 100);
  currentInputIds = candA.inputIds;
  const previewA = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candA.candId,
    sessionToken: publisherSessionToken,
  });
  const approvalA = await governedDelivery.approveRelease({
    projectId,
    candidateId: candA.candId,
    previewVersionId: previewA.versionId!,
    sessionToken: publisherSessionToken,
  });
  const publishedA = await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candA.candId,
    previewVersionId: previewA.versionId!,
    approvalId: approvalA.id,
    sessionToken: publisherSessionToken,
  });
  assert.equal(publishedA.status, "verified");

  // 2. Publish Release B
  const candB = await createCandidate(`cand-B-${suffix}`, 200);
  currentInputIds = candB.inputIds;
  const previewB = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candB.candId,
    sessionToken: publisherSessionToken,
  });
  const approvalB = await governedDelivery.approveRelease({
    projectId,
    candidateId: candB.candId,
    previewVersionId: previewB.versionId!,
    sessionToken: publisherSessionToken,
  });
  const publishedB = await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candB.candId,
    previewVersionId: previewB.versionId!,
    approvalId: approvalB.id,
    sessionToken: publisherSessionToken,
  });
  assert.equal(publishedB.status, "verified");

  // Initial timeline check: PUBLISH A followed by PUBLISH B
  const initialTransitions = await store.listEffectiveTransitions(siteId, 10);
  assert.equal(initialTransitions.length, 2);
  assert.equal(initialTransitions[0]!.eventType, "PUBLISH");
  assert.equal(initialTransitions[0]!.toVersionId, previewB.versionId);
  assert.equal(initialTransitions[1]!.eventType, "PUBLISH");
  assert.equal(initialTransitions[1]!.toVersionId, previewA.versionId);

  // ---------------------------------------------------------------------------
  // Case 1 (P0 Core): A -> B -> interrupted rollback A -> recovery
  // Assert: eventType === "ROLLBACK" (NEVER "PUBLISH"), actor is rollback operator
  // ---------------------------------------------------------------------------
  let capturedRollbackDepId: string | null = null;
  const origCreateDeployment = store.createDeployment.bind(store);
  store.createDeployment = async (input: any) => {
    const created = await origCreateDeployment(input);
    if (created.id.startsWith("dep-rb-")) {
      capturedRollbackDepId = created.id;
    }
    return created;
  };

  const origFinalize = store.finalizeDeploymentAndTransitionAtomic.bind(store);
  store.finalizeDeploymentAndTransitionAtomic = async () => {
    throw new Error("Simulated database crash during rollback atomic finalization");
  };

  // Rollback operator initiates rollback B -> A
  await assert.rejects(
    governedDelivery.rollbackExplicit({
      projectId,
      targetVersionId: previewA.versionId!,
      sessionToken: rollbackSessionToken,
    }),
    /Simulated database crash during rollback atomic finalization/,
  );

  // Verify: Rollback intent was persisted before failure
  assert.ok(capturedRollbackDepId, "Rollback deployment must be persisted");
  const stuckRollbackDep = await store.getDeployment(capturedRollbackDepId!);
  assert.equal(stuckRollbackDep?.status, "promoted", "Stuck rollback must remain in promoted, NOT prematurely rolled_back");
  assert.equal(stuckRollbackDep?.versionId, previewA.versionId);
  assert.equal(stuckRollbackDep?.previousVersionId, previewB.versionId);
  assert.equal((stuckRollbackDep?.snapshotData as any)?.operationType, "ROLLBACK");

  // Restore atomic finalization
  store.createDeployment = origCreateDeployment;
  store.finalizeDeploymentAndTransitionAtomic = origFinalize;

  // Run crash recovery
  const reconRollback = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconRollback.reconciled, true);

  // Assert: Recovered deployment is now rolled_back
  const recoveredDep = await store.getDeployment(capturedRollbackDepId!);
  assert.equal(recoveredDep?.status, "rolled_back", "Interrupted rollback must recover to rolled_back");
  assert.equal(recoveredDep?.productionVerified, true);
  assert.equal(recoveredDep?.rolledBack, true);

  // P0 Core Assertions: Effective transition MUST be ROLLBACK, NOT PUBLISH
  const transitionsAfterRecovery = await store.listEffectiveTransitions(siteId, 10);
  assert.equal(transitionsAfterRecovery.length, 3, "Exactly 3 transitions must exist");

  const latestTransition = transitionsAfterRecovery[0]!;
  assert.equal(latestTransition.eventType, "ROLLBACK", "Recovered event MUST be ROLLBACK, never PUBLISH (P0)");
  assert.equal(latestTransition.fromVersionId, previewB.versionId, "fromVersionId must be Version B");
  assert.equal(latestTransition.toVersionId, previewA.versionId, "toVersionId must be Version A");
  assert.equal(latestTransition.candidateId, candA.candId, "Restored candidate must match Release A");
  assert.equal(latestTransition.artifactDigest, candA.digest, "Restored artifactDigest must match Release A");
  assert.equal(latestTransition.actorId, "operator-rollback", "Actor MUST be the actual rollback operator (P0)");
  assert.equal(latestTransition.actorName, "Rollback Operator");
  assert.equal(latestTransition.actorRole, "DEPLOYMENT_ADMIN");

  // Timeline integrity: PUBLISH A -> PUBLISH B -> ROLLBACK A
  assert.deepEqual(
    transitionsAfterRecovery.map((t) => ({ eventType: t.eventType, to: t.toVersionId, actor: t.actorId })),
    [
      { eventType: "ROLLBACK", to: previewA.versionId, actor: "operator-rollback" },
      { eventType: "PUBLISH", to: previewB.versionId, actor: "operator-publisher" },
      { eventType: "PUBLISH", to: previewA.versionId, actor: "operator-publisher" },
    ],
  );

  // ---------------------------------------------------------------------------
  // Case 2 (P1 Core): Crash immediately after Cloudflare rollback (persisted intent allows recovery)
  // ---------------------------------------------------------------------------
  // First publish Release C so we can test another rollback
  const candC = await createCandidate(`cand-C-${suffix}`, 300);
  currentInputIds = candC.inputIds;
  const previewC = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candC.candId,
    sessionToken: publisherSessionToken,
  });
  const approvalC = await governedDelivery.approveRelease({
    projectId,
    candidateId: candC.candId,
    previewVersionId: previewC.versionId!,
    sessionToken: publisherSessionToken,
  });
  await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candC.candId,
    previewVersionId: previewC.versionId!,
    approvalId: approvalC.id,
    sessionToken: publisherSessionToken,
  });

  // Now initiate rollback C -> B, crashing immediately after Cloudflare rollback
  let intentDeploymentCreated: any = null;
  store.createDeployment = async (input: any) => {
    const created = await origCreateDeployment(input);
    if (created.id.startsWith("dep-rb-")) {
      intentDeploymentCreated = created;
    }
    return created;
  };

  const origRollback = simulatedWrangler.rollback.bind(simulatedWrangler);
  const origUpdateDeployment = store.updateDeployment.bind(store);
  simulatedWrangler.rollback = async (worker: string, ver: string) => {
    await origRollback(worker, ver);
    // Persisted intent already exists before mutation!
    assert.ok(intentDeploymentCreated, "Rollback intent MUST be persisted in PostgreSQL BEFORE Cloudflare mutation (P1)");
    assert.equal(intentDeploymentCreated.status, "promoting", "Pre-mutation rollback intent must be in promoting status");
    // Simulate process crash: DB updates fail / process halts immediately after Cloudflare mutation
    store.updateDeployment = async () => {
      throw new Error("Simulated process crash immediately after Cloudflare rollback");
    };
    throw new Error("Simulated process crash immediately after Cloudflare rollback");
  };

  await assert.rejects(
    governedDelivery.rollbackExplicit({
      projectId,
      targetVersionId: previewB.versionId!,
      sessionToken: rollbackSessionToken,
    }),
    /Simulated process crash immediately after Cloudflare rollback/,
  );

  // Restore simulated wrangler and store
  simulatedWrangler.rollback = origRollback;
  store.createDeployment = origCreateDeployment;
  store.updateDeployment = origUpdateDeployment;

  // Cloudflare is running target version B, but Factory process was interrupted
  const cfActive = await simulatedWrangler.currentProductionVersion(workerName);
  assert.equal(cfActive, previewB.versionId, "Cloudflare switched to target version B before crash");

  // Reconcile: Pending intent in PostgreSQL allows complete, accurate recovery!
  const reconCrashPostMutation = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconCrashPostMutation.reconciled, true);

  const depPostMutation = await store.getDeployment(intentDeploymentCreated.id);
  assert.equal(depPostMutation?.status, "rolled_back", "Interrupted post-mutation rollback must recover to rolled_back");

  const transitionsAfterPostMutation = await store.listEffectiveTransitions(siteId, 10);
  assert.equal(transitionsAfterPostMutation[0]!.eventType, "ROLLBACK");
  assert.equal(transitionsAfterPostMutation[0]!.toVersionId, previewB.versionId);
  assert.equal(transitionsAfterPostMutation[0]!.fromVersionId, previewC.versionId);
  assert.equal(transitionsAfterPostMutation[0]!.actorId, "operator-rollback");

  // ---------------------------------------------------------------------------
  // Case 3 & 4: Recovery retried twice (Idempotence)
  // Assert: Exactly one logical ROLLBACK transition
  // ---------------------------------------------------------------------------
  const countBeforeSecondRecon = (await store.listEffectiveTransitions(siteId, 50)).length;
  const secondRecon = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(secondRecon.reconciled, false, "Second reconciliation must be a no-op");
  assert.equal(secondRecon.details, "No pending or unverified deployment found.");

  const countAfterSecondRecon = (await store.listEffectiveTransitions(siteId, 50)).length;
  assert.equal(countAfterSecondRecon, countBeforeSecondRecon, "Duplicate recovery MUST NOT create duplicate transitions");

  // ---------------------------------------------------------------------------
  // Case 5: Missing target or operator evidence -> NEEDS_REVIEW, zero fabricated events
  // ---------------------------------------------------------------------------
  const stuckDepMissingActor = `dep-rb-missing-actor-${suffix}`;
  await store.createDeployment({
    id: stuckDepMissingActor,
    siteId,
    sourceCommit: sha,
    workerName,
    productionUrl,
    versionId: previewA.versionId!,
    previousVersionId: previewB.versionId!,
    status: "promoting",
    rolledBack: true,
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
    operationId: `rb-${stuckDepMissingActor}`,
    snapshotData: {
      operationType: "ROLLBACK",
      targetDeploymentId: publishedA.id,
      // initiatingActor is intentionally omitted!
    },
  });

  const reconMissingActor = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconMissingActor.reconciled, true);
  const depMissingActor = await store.getDeployment(stuckDepMissingActor);
  assert.equal(depMissingActor?.status, "needs_review", "Missing actor evidence MUST move to needs_review (P0)");
  assert.equal(depMissingActor?.errorCode, "recovery_rollback_evidence_missing");

  // Verify: No transition was fabricated
  const countAfterMissingActor = (await store.listEffectiveTransitions(siteId, 50)).length;
  assert.equal(countAfterMissingActor, countAfterSecondRecon, "No transition may be fabricated when actor is missing");

  // Missing target deployment
  const stuckDepMissingTarget = `dep-rb-missing-target-${suffix}`;
  await store.createDeployment({
    id: stuckDepMissingTarget,
    siteId,
    sourceCommit: sha,
    workerName,
    productionUrl,
    versionId: previewA.versionId!,
    previousVersionId: previewB.versionId!,
    status: "promoting",
    rolledBack: true,
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
    operationId: `rb-${stuckDepMissingTarget}`,
    snapshotData: {
      operationType: "ROLLBACK",
      targetDeploymentId: "dep-non-existent-target",
      initiatingActor: {
        actorId: "operator-rollback",
        actorName: "Rollback Operator",
        actorRole: "DEPLOYMENT_ADMIN",
      },
    },
  });

  const reconMissingTarget = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconMissingTarget.reconciled, true);
  const depMissingTarget = await store.getDeployment(stuckDepMissingTarget);
  assert.equal(depMissingTarget?.status, "needs_review", "Missing target deployment MUST move to needs_review");
  assert.equal(depMissingTarget?.errorCode, "recovery_target_not_found");

  // ---------------------------------------------------------------------------
  // Case 6: Ambiguous pending record (neither publish nor rollback metadata)
  // ---------------------------------------------------------------------------
  const stuckAmbiguous = `dep-ambiguous-${suffix}`;
  await store.createDeployment({
    id: stuckAmbiguous,
    siteId,
    sourceCommit: sha,
    workerName,
    productionUrl,
    versionId: "ver-unknown",
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
    // No operationId prefix, no snapshotData, no releaseApprovalId, rolledBack=false
  });

  const reconAmbiguous = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconAmbiguous.reconciled, true);
  const depAmbiguous = await store.getDeployment(stuckAmbiguous);
  assert.equal(depAmbiguous?.status, "needs_review", "Ambiguous pending record MUST fail closed with needs_review");
  assert.equal(depAmbiguous?.errorCode, "recovery_ambiguous_operation");

  // ---------------------------------------------------------------------------
  // Case 7: Normal interrupted PUBLISH (Existing publish recovery remains correct)
  // ---------------------------------------------------------------------------
  const candD = await createCandidate(`cand-D-${suffix}`, 400);
  currentInputIds = candD.inputIds;
  const previewD = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candD.candId,
    sessionToken: publisherSessionToken,
  });
  const approvalD = await governedDelivery.approveRelease({
    projectId,
    candidateId: candD.candId,
    previewVersionId: previewD.versionId!,
    sessionToken: publisherSessionToken,
  });

  // Inject failure during publish DB finalization
  store.finalizeDeploymentAndTransitionAtomic = async () => {
    throw new Error("Simulated database failure during publish atomic finalization");
  };

  await assert.rejects(
    governedDelivery.publishApprovedRelease({
      projectId,
      candidateId: candD.candId,
      previewVersionId: previewD.versionId!,
      approvalId: approvalD.id,
      sessionToken: publisherSessionToken,
    }),
    /Simulated database failure during publish atomic finalization/,
  );

  // Restore finalization
  store.finalizeDeploymentAndTransitionAtomic = origFinalize;

  // Cloudflare is on Version D, deployment in promoted
  const reconPublish = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconPublish.reconciled, true);

  const depD = await store.getDeployment(previewD.id);
  assert.equal(depD?.status, "verified", "Interrupted publish must recover to verified");

  const latestPublishTransition = (await store.listEffectiveTransitions(siteId, 1))[0]!;
  assert.equal(latestPublishTransition.eventType, "PUBLISH", "Interrupted publish MUST recover as PUBLISH (Case A)");
  assert.equal(latestPublishTransition.toVersionId, previewD.versionId);
  assert.equal(latestPublishTransition.candidateId, candD.candId);
  assert.equal(latestPublishTransition.actorId, "operator-publisher");

  // Recovery must reject damaged historical evidence before provider QA or finalization.
  await simulatedWrangler.promote(workerName, previewA.versionId!);
  async function pendingRollback(id: string, overrides: Record<string, unknown> = {}) {
    return store.createDeployment({
      siteId,
      sourceCommit: sha,
      workerName,
      productionUrl,
      versionId: previewA.versionId!,
      previousVersionId: previewB.versionId!,
      candidateId: candA.candId,
      artifactDigest: candA.digest,
      qaRunId: candA.qaRunId,
      releaseApprovalId: approvalA.id,
      candidateRoutes: SUTHERLAND_SIX_ROUTES,
      rolledBack: true,
      executionOrigin: "TEST_SIMULATION",
      snapshotData: stuckRollbackDep!.snapshotData,
      id,
      status: "promoted",
      operationId: `rb-${id}`,
      productionVerified: false,
      ...overrides,
    });
  }

  const badManifests = [
    { name: "missing", routes: null, code: "recovery_routes_missing" },
    { name: "empty", routes: [], code: "recovery_routes_missing" },
    { name: "incomplete", routes: ["/"], code: "recovery_routes_mismatch" },
    { name: "wrong-route", routes: ["/", "/about", "/contact", "/insights", "/services", "/other"], code: "recovery_routes_mismatch" },
    { name: "extra-route", routes: [...SUTHERLAND_SIX_ROUTES, "/other"], code: "recovery_routes_mismatch" },
    { name: "duplicate", routes: [...SUTHERLAND_SIX_ROUTES, "/"], code: "recovery_routes_mismatch" },
    { name: "not-array", routes: "/", code: "recovery_routes_mismatch" },
    { name: "not-string", routes: ["/", 42], code: "recovery_routes_mismatch" },
    { name: "invalid-path", routes: ["/", "//about"], code: "recovery_routes_mismatch" },
  ];
  for (const manifest of badManifests) {
    for (const source of ["operation", "target"] as const) {
      await t.test(`P0 rejects ${manifest.name} ${source} route manifest`, async () => {
        const id = `dep-routes-${source}-${manifest.name}-${suffix}`;
        let targetId = publishedA.id;
        if (source === "target") {
          targetId = `target-${id}`;
          await store.createDeployment({ ...publishedA, id: targetId, status: "verified", executionOrigin: "TEST_SIMULATION", candidateRoutes: manifest.routes });
        }
        await pendingRollback(id, source === "operation"
          ? { candidateRoutes: manifest.routes }
          : { snapshotData: { ...(stuckRollbackDep!.snapshotData as object), targetDeploymentId: targetId } });
        const before = (await store.listEffectiveTransitions(siteId, 100)).length;
        const qaBefore = recoveryQaCalls.length;
        await governedDelivery.reconcilePendingDeployments(siteId);
        const recovered = await store.getDeployment(id);
        assert.equal(recovered?.status, "needs_review");
        assert.equal(recovered?.errorCode, manifest.code);
        assert.equal(recovered?.productionVerified, false);
        assert.equal(recoveryQaCalls.length, qaBefore, "Invalid routes must never reach QA");
        assert.equal((await store.listEffectiveTransitions(siteId, 100)).length, before);
      });
    }
  }

  const identityCases = [
    { name: "publish-type-rollback-id", type: "PUBLISH", prefix: "rb", flag: true, code: "recovery_operation_conflict" },
    { name: "rollback-type-publish-id", type: "ROLLBACK", prefix: "pub", flag: true, code: "recovery_operation_conflict" },
    { name: "publish-with-rollback-flag", type: "PUBLISH", prefix: "pub", flag: true, code: "recovery_operation_conflict" },
    { name: "rollback-with-publish-flag", type: "ROLLBACK", prefix: "rb", flag: false, code: "recovery_operation_conflict" },
    { name: "unknown-type", type: "UNKNOWN", prefix: "rb", flag: true, code: "recovery_ambiguous_operation" },
    { name: "unknown-prefix", type: "ROLLBACK", prefix: "unknown", flag: true, code: "recovery_ambiguous_operation" },
    { name: "approval-alone", type: null, prefix: null, flag: false, code: "recovery_ambiguous_operation" },
    { name: "flag-alone", type: null, prefix: null, flag: true, code: "recovery_ambiguous_operation" },
  ];
  for (const identity of identityCases) {
    await t.test(`P1 rejects ${identity.name}`, async () => {
      const id = `dep-identity-${identity.name}-${suffix}`;
      await pendingRollback(id, {
        operationId: identity.prefix ? `${identity.prefix}-${id}` : null,
        rolledBack: identity.flag,
        snapshotData: { ...(stuckRollbackDep!.snapshotData as object), operationType: identity.type },
      });
      const before = (await store.listEffectiveTransitions(siteId, 100)).length;
      const qaBefore = recoveryQaCalls.length;
      await governedDelivery.reconcilePendingDeployments(siteId);
      const recovered = await store.getDeployment(id);
      assert.equal(recovered?.status, "needs_review");
      assert.equal(recovered?.errorCode, identity.code);
      assert.equal(recovered?.productionVerified, false);
      assert.equal(recoveryQaCalls.length, qaBefore);
      assert.equal((await store.listEffectiveTransitions(siteId, 100)).length, before);
    });
  }

  await t.test("P0 complete historical routes reach rollback QA and finalize exactly once", async () => {
    const id = `dep-complete-routes-${suffix}`;
    await pendingRollback(id, { candidateRoutes: [...SUTHERLAND_SIX_ROUTES].reverse() });
    const before = (await store.listEffectiveTransitions(siteId, 100)).length;
    const qaBefore = recoveryQaCalls.length;
    await governedDelivery.reconcilePendingDeployments(siteId);
    assert.equal((await store.getDeployment(id))?.status, "rolled_back");
    assert.equal(recoveryQaCalls.length, qaBefore + 1);
    assert.equal(recoveryQaCalls.at(-1)?.phase, "rollback");
    assert.deepEqual(recoveryQaCalls.at(-1)?.candidateRoutes, SUTHERLAND_SIX_ROUTES);
    const transitions = await store.listEffectiveTransitions(siteId, 100);
    assert.equal(transitions.length, before + 1);
    assert.deepEqual(transitions[0]!.candidateRoutes, SUTHERLAND_SIX_ROUTES);
    assert.equal(transitions[0]!.eventType, "ROLLBACK");
    await governedDelivery.reconcilePendingDeployments(siteId);
    assert.equal((await store.listEffectiveTransitions(siteId, 100)).length, before + 1);
  });

  await t.test("P0 complete routes with failed rollback QA create no transition", async () => {
    const id = `dep-complete-failed-qa-${suffix}`;
    await pendingRollback(id);
    const before = (await store.listEffectiveTransitions(siteId, 100)).length;
    mockQaPassed = false;
    try {
      await governedDelivery.reconcilePendingDeployments(siteId);
    } finally {
      mockQaPassed = true;
    }
    assert.equal((await store.getDeployment(id))?.status, "needs_review");
    assert.equal((await store.getDeployment(id))?.errorCode, "recovery_qa_failed");
    assert.equal((await store.listEffectiveTransitions(siteId, 100)).length, before);
  });

  await t.test("P0 genuinely one-page historical release remains recoverable", async () => {
    const one = await createCandidate(`cand-one-${suffix}`, 500, ["/"]);
    currentInputIds = one.inputIds;
    const preview = await governedDelivery.prepareCandidatePreview({ projectId, candidateId: one.candId, sessionToken: publisherSessionToken });
    const approval = await governedDelivery.approveRelease({ projectId, candidateId: one.candId, previewVersionId: preview.versionId!, sessionToken: publisherSessionToken });
    const target = await governedDelivery.publishApprovedRelease({ projectId, candidateId: one.candId, previewVersionId: preview.versionId!, approvalId: approval.id, sessionToken: publisherSessionToken });
    const id = `dep-one-page-${suffix}`;
    await pendingRollback(id, {
      versionId: target.versionId,
      candidateId: one.candId,
      artifactDigest: one.digest,
      qaRunId: target.qaRunId,
      releaseApprovalId: approval.id,
      candidateRoutes: ["/"],
      snapshotData: {
        ...(stuckRollbackDep!.snapshotData as object),
        targetDeploymentId: target.id,
        toVersionId: target.versionId,
        targetQaRunId: target.qaRunId,
        targetCandidateId: one.candId,
        targetArtifactDigest: one.digest,
      },
    });
    await governedDelivery.reconcilePendingDeployments(siteId);
    assert.equal((await store.getDeployment(id))?.status, "rolled_back");
    assert.deepEqual(recoveryQaCalls.at(-1)?.candidateRoutes, ["/"]);
  });

  await rm(path.resolve(repoRoot, ".factory", "production", "projects", projectId), { recursive: true, force: true }).catch(() => {});
});
