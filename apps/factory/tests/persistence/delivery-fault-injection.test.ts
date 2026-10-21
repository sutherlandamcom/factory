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
