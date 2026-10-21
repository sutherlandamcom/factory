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
} from "../../src/persistence/schema.js";
import { FactoryStore } from "../../src/persistence/store.js";
import {
  AuditSealKeyring,
  ReleaseApprovalBoundary,
  ReleaseIdentityProvider,
} from "../../src/trust/release-approval-boundary.js";
import { GovernedDeliveryService } from "../../src/delivery/governed-service.js";
import { ProductionStore } from "../../src/production/store.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { loadProductionBuildIdentity } from "../../src/production/identity.js";
import { assertCandidateReleaseQaProof } from "../../src/delivery/release-preflight.js";
import { SimulatedWrangler } from "../../src/delivery/simulated-wrangler.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { FactoryError } from "../../src/executor/errors.js";
import { computeArtifactDigest } from "../../src/production/build-service.js";

const SUTHERLAND_SIX_ROUTES = [
  "/",
  "/about",
  "/contact",
  "/insights",
  "/services",
  "/services/executive-search",
];

test("Run 13 Sutherland 6-page governed delivery, rollback and historical lineage lifecycle", async () => {
  const dbInst = await createTestDatabase();
  const db = dbInst.db;
  const store = new FactoryStore(db);
  const repoRoot = await resolveRepositoryRoot();
  const prodStore = new ProductionStore(db, { repoRoot });

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-suth-${suffix}`;
  const siteId = `site-suth-${suffix}`;
  const workerName = `worker-suth-${suffix}`;
  const productionUrl = "https://sutherland-advisory.pages.dev";

  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: "a".repeat(64) },
  });
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-suth-idp", db);
  const releaseBoundary = new ReleaseApprovalBoundary(db, { keyring, idp });

  const simulatedWrangler = new SimulatedWrangler();
  const wranglerFactory = () => simulatedWrangler;

  const worktreeProvider = {
    async prepare(_root: string, _commit: string, id: string) {
      const wtDir = path.join(tmpdir(), `test-suth-wt-${id}-${randomUUID()}`);
      await mkdir(path.join(wtDir, "sites", "starter"), { recursive: true });
      return wtDir;
    },
    async remove(_root: string, wt: string) {
      await rm(wt, { recursive: true, force: true }).catch(() => {});
    },
  };

  const qaRunner = async () => ({ passed: true, exitCode: 0, timedOut: false });

  let currentInputIds: string[] = [];
  const mockProdStore = {
    inputStaleness: async () => ({ stale: false, reason: null }),
    candidateStaleness: async () => ({ stale: false, reason: null }),
    getCandidate: (...args: [string, string]) => prodStore.getCandidate(...args),
    latestQaRun: (...args: [string, string]) => prodStore.latestQaRun(...args),
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

  // 1. Seed Sutherland project and site
  await db.insert(projects).values({
    id: projectId,
    key: `sutherland-${suffix}`,
    name: "Sutherland Advisory",
  });

  await db.insert(sites).values({
    id: siteId,
    projectId,
    key: `sutherland-site-${suffix}`,
    name: "Sutherland Advisory Site",
    cloudflareWorkerName: workerName,
    productionUrl,
  });

  const buildIdentity = await loadProductionBuildIdentity(repoRoot);
  const shaA = buildIdentity.repositorySha;
  const candidateIdA = `cand-suth-A-${suffix}`;

  const candidateDistA = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdA, "dist");
  await mkdir(candidateDistA, { recursive: true });
  await writeFile(path.join(candidateDistA, "index.html"), "<html><body>Sutherland Advisory A</body></html>", "utf8");
  const digestA = await computeArtifactDigest(candidateDistA);

  // 2. Seed all 6 ProductionPageInputs for Sutherland
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

  // 3. Seed Candidate A covering all 6 routes
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

  await db.insert(productionQaRuns).values({
    id: `qa-run-A-${suffix}`,
    projectId,
    candidateId: candidateIdA,
    candidateArtifactDigest: digestA,
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
    overall: "PASS",
  });

  // 3b. Memberships and signed tokens
  await db.insert(projectReviewerMemberships).values({
    id: `mem-alice-${suffix}`,
    projectId,
    actorId: "actor-alice",
    actorRole: "DEPLOYER",
    permissions: ["DEPLOYMENT:PREVIEW", "DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH", "DEPLOYMENT:MONITOR"],
  });

  await db.insert(projectReviewerMemberships).values({
    id: `mem-mallory-${suffix}`,
    projectId,
    actorId: "actor-mallory",
    actorRole: "VIEWER",
    permissions: [],
  });

  const aliceToken = signAssertion({
    actorId: "actor-alice",
    actorName: "Alice ReleaseManager",
    actorRole: "DEPLOYER",
  });

  const malloryToken = signAssertion({
    actorId: "actor-mallory",
    actorName: "Mallory Unauthorized",
    actorRole: "VIEWER",
  });

  // 4. Prepare Candidate Preview for Candidate A (all 6 routes)
  const previewA = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candidateIdA,
    sessionToken: aliceToken,
  });
  assert.equal(previewA.status, "preview_verified");
  assert.equal(previewA.previewVerified, true);
  assert.deepEqual(previewA.candidateRoutes, SUTHERLAND_SIX_ROUTES);

  // Negative: Mallory cannot approve release
  await assert.rejects(
    () => governedDelivery.approveRelease({
      projectId,
      candidateId: candidateIdA,
      previewVersionId: previewA.versionId!,
      sessionToken: malloryToken,
    }),
    (err: any) => err instanceof FactoryError && (err.code === "permission_denied" || err.code === "operator_permission_denied"),
  );

  // 5. Alice approves release A
  const approvalA = await governedDelivery.approveRelease({
    projectId,
    candidateId: candidateIdA,
    previewVersionId: previewA.versionId!,
    sessionToken: aliceToken,
  });
  assert.equal(approvalA.sealStatus, "SEALED");
  assert.ok(approvalA.verificationSeal && approvalA.verificationSeal.length >= 64);

  // 6. Publish release A to production
  const beforePublishTime = new Date();
  await new Promise((r) => setTimeout(r, 50));
  const publishedA = await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candidateIdA,
    previewVersionId: previewA.versionId!,
    approvalId: approvalA.id,
    sessionToken: aliceToken,
  });
  const timeA = publishedA.verifiedAt ?? new Date();
  assert.equal(publishedA.status, "verified");
  assert.equal(publishedA.productionVerified, true);
  assert.deepEqual(publishedA.candidateRoutes, SUTHERLAND_SIX_ROUTES);

  // 7. Verify P1-02: Monitoring authorization
  // Negative: Mallory cannot trigger monitoring
  await assert.rejects(
    () => governedDelivery.runMonitoringCheck(projectId, malloryToken),
    (err: any) => err instanceof FactoryError && (err.code === "permission_denied" || err.code === "operator_permission_denied"),
  );

  // Positive: Alice triggers operational check
  const monitoringRes = await governedDelivery.runMonitoringCheck(projectId, aliceToken);
  assert.equal(monitoringRes.projectId, projectId);
  assert.equal(monitoringRes.technicalVerification.status, "PASS");

  // 8. Prepare Candidate B (new version) covering all 6 routes
  const shaB = buildIdentity.repositorySha;
  const candidateIdB = `cand-suth-B-${suffix}`;

  const candidateDistB = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdB, "dist");
  await mkdir(candidateDistB, { recursive: true });
  await writeFile(path.join(candidateDistB, "index.html"), "<html><body>Sutherland Advisory B</body></html>", "utf8");
  const digestB = await computeArtifactDigest(candidateDistB);

  const inputIdsB: string[] = [];
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    const inputId = `input-B-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
    inputIdsB.push(inputId);
    await db.insert(productionPageInputs).values({
      id: inputId,
      projectId,
      version: SUTHERLAND_SIX_ROUTES.length + idx + 1,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      pageType: route === "/" ? "homepage" : "service",
      route,
      canonicalOrigin: productionUrl,
      acceptedContentId: `c-${inputId}`,
      acceptedContentVersion: 2,
      acceptedContentDigest: digestB,
      acceptedDesignId: `d-${inputId}`,
      acceptedDesignVersion: 2,
      acceptedDesignDigest: digestB,
      acceptedVisualSetId: `v-${inputId}`,
      acceptedVisualSetVersion: 2,
      acceptedVisualSetDigest: digestB,
      rendererId: "astro-static",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {},
      inputDigest: digestB,
    });
  }

  await db.insert(productionCandidates).values({
    id: candidateIdB,
    projectId,
    productionInputId: inputIdsB[0]!,
    productionInputVersion: 2,
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
      productionInputVersion: SUTHERLAND_SIX_ROUTES.length + idx + 1,
      productionInputDigest: digestB,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      route,
      manifestDigest: digestB,
    });
  }

  await db.insert(productionQaRuns).values({
    id: `qa-run-B-${suffix}`,
    projectId,
    candidateId: candidateIdB,
    candidateArtifactDigest: digestB,
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
    overall: "PASS",
  });

  currentInputIds = inputIdsB;

  const previewB = await governedDelivery.prepareCandidatePreview({
    projectId,
    candidateId: candidateIdB,
    sessionToken: aliceToken,
  });
  const approvalB = await governedDelivery.approveRelease({
    projectId,
    candidateId: candidateIdB,
    previewVersionId: previewB.versionId!,
    sessionToken: aliceToken,
  });
  await new Promise((r) => setTimeout(r, 50));
  const publishedB = await governedDelivery.publishApprovedRelease({
    projectId,
    candidateId: candidateIdB,
    previewVersionId: previewB.versionId!,
    approvalId: approvalB.id,
    sessionToken: aliceToken,
  });
  const timeB = publishedB.verifiedAt ?? new Date();
  assert.equal(publishedB.status, "verified");
  assert.equal(publishedB.versionId, previewB.versionId);
  assert.deepEqual(publishedB.candidateRoutes, SUTHERLAND_SIX_ROUTES);

  // 9. Rollback to Version A (P0-02 target release identity preservation)
  await new Promise((r) => setTimeout(r, 50));
  const rolledBack = await governedDelivery.rollbackExplicit({
    projectId,
    targetVersionId: publishedA.versionId!,
    sessionToken: aliceToken,
  });
  const timeRollback = rolledBack.verifiedAt ?? new Date();
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.versionId, publishedA.versionId);
  assert.equal(rolledBack.candidateId, candidateIdA);
  assert.equal(rolledBack.sourceCommit, shaA);
  assert.equal(rolledBack.artifactDigest, digestA);
  assert.deepEqual(rolledBack.candidateRoutes, SUTHERLAND_SIX_ROUTES);

  // 10. Historical lineage across all 6 routes (P0-03 & P1-05)
  // Before any publish:
  const beforePublish = await governedDelivery.getEffectiveReleaseAsOf({
    siteId,
    route: "/services/executive-search",
    asOf: beforePublishTime,
  });
  assert.equal(beforePublish.effectiveDeployment, null);

  // During Release A: every route maps to Candidate A
  for (const route of SUTHERLAND_SIX_ROUTES) {
    const asOfA = await governedDelivery.getEffectiveReleaseAsOf({
      siteId,
      route,
      asOf: timeA,
    });
    assert.ok(asOfA.effectiveDeployment, `Effective deployment must exist for ${route} during release A`);
    assert.equal(asOfA.effectiveDeployment?.versionId, publishedA.versionId);
    assert.equal(asOfA.effectiveDeployment?.artifactDigest, digestA);
    assert.equal(asOfA.candidate?.id, candidateIdA);
    assert.ok(asOfA.pageAuthority, `Page authority must exist for ${route} during release A`);
    assert.equal(asOfA.pageAuthority?.pageIdentity, route === "/" ? "home" : route.slice(1));
  }

  // During Release B: every route maps to Candidate B
  for (const route of SUTHERLAND_SIX_ROUTES) {
    const asOfB = await governedDelivery.getEffectiveReleaseAsOf({
      siteId,
      route,
      asOf: timeB,
    });
    assert.ok(asOfB.effectiveDeployment, `Effective deployment must exist for ${route} during release B`);
    assert.equal(asOfB.effectiveDeployment?.versionId, publishedB.versionId);
    assert.equal(asOfB.effectiveDeployment?.artifactDigest, digestB);
    assert.equal(asOfB.candidate?.id, candidateIdB);
    assert.ok(asOfB.pageAuthority, `Page authority must exist for ${route} during release B`);
    assert.equal(asOfB.pageAuthority?.pageIdentity, route === "/" ? "home" : route.slice(1));
  }

  // After Rollback: every route maps back to Candidate A
  for (const route of SUTHERLAND_SIX_ROUTES) {
    const asOfRb = await governedDelivery.getEffectiveReleaseAsOf({
      siteId,
      route,
      asOf: timeRollback,
    });
    assert.ok(asOfRb.effectiveDeployment, `Effective deployment must exist for ${route} after rollback`);
    assert.equal(asOfRb.effectiveDeployment?.versionId, publishedA.versionId);
    assert.equal(asOfRb.effectiveDeployment?.artifactDigest, digestA);
    assert.equal(asOfRb.candidate?.id, candidateIdA);
    assert.ok(asOfRb.pageAuthority, `Page authority must exist for ${route} after rollback`);
    assert.equal(asOfRb.pageAuthority?.pageIdentity, route === "/" ? "home" : route.slice(1));
  }

  // 11. P0-01 Crash Reconciliation test
  // Case A: Missing approval -> reconciler safely sets needs_review (no fabricated verification)
  const missingApprovalDepId = `dep-no-appr-${suffix}`;
  await store.createDeployment({
    id: missingApprovalDepId,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${missingApprovalDepId}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    versionId: publishedA.versionId,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const reconMissingAppr = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconMissingAppr.reconciled, true);
  const unverifiedDep = await store.getDeployment(missingApprovalDepId);
  assert.equal(unverifiedDep?.status, "needs_review");
  assert.equal(unverifiedDep?.productionVerified, false);

  // Case B: Valid approval, candidate, and QA -> reconciler re-runs real QA and recovers to verified
  const stuckDepId = `dep-stuck-${suffix}`;
  await store.createDeployment({
    id: stuckDepId,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${stuckDepId}`,
    candidateId: candidateIdA,
    artifactDigest: digestA,
    releaseApprovalId: approvalA.id,
    versionId: publishedA.versionId,
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const reconResult = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(reconResult.reconciled, true);
  const recovered = await store.getDeployment(stuckDepId);
  assert.equal(recovered?.status, "verified");
  assert.equal(recovered?.productionVerified, true);

  // 12. P0-03 Immutable execution origin test: derived from DB records, not environment variables
  // The reconciled transition recorded REAL_CLOUDFLARE because approvalA is a genuine, non-synthetic approval.
  // Setting environment variable to simulation must NEVER override the immutable DB origin!
  process.env.FACTORY_DELIVERY_MODE = "simulation";
  const effectiveSim = await governedDelivery.resolveCurrentEffectiveProduction(siteId);
  assert.equal(effectiveSim.executionOrigin, "REAL_CLOUDFLARE");
  delete process.env.FACTORY_DELIVERY_MODE;

  // 13. P0-04 Negative: Synthetic fixture QA can never be publication-eligible
  const fakeQa = {
    id: `qa-fixture-${suffix}`,
    projectId,
    candidateId: candidateIdA,
    candidateArtifactDigest: digestA,
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdA,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "SYNTHETIC_FIXTURE",
        publicationEligible: false,
        reviewAuthorityMode: "TEST_ONLY",
      },
    },
    overall: "PASS" as const,
  };

  const candidateA = (await prodStore.getCandidate(projectId, candidateIdA))!;
  const candidateInputsA = await prodStore.listCandidateInputs(projectId, candidateIdA);

  assert.throws(
    () =>
      assertCandidateReleaseQaProof({
        projectId,
        candidate: candidateA,
        latestQa: fakeQa as any,
        candidateInputs: candidateInputsA,
        currentPageInputIds: inputIdsA,
        canonicalOrigin: productionUrl,
        buildIdentity,
      }),
    (err: any) => err instanceof FactoryError && err.code === "production_authority_stale",
  );

  // 14. P0-01 Negative: When Cloudflare active version does NOT match stuck deployment,
  // recovery does not guess or call it failed blindly; it marks needs_review (P0-01 Case D).
  const mismatchDepId = `dep-mismatch-${suffix}`;
  await store.createDeployment({
    id: mismatchDepId,
    siteId,
    sourceCommit: shaA,
    workerName,
    productionUrl,
    artifactDirectory: `.factory/deployments/${mismatchDepId}`,
    candidateId: candidateIdA,
    versionId: "ver-never-activated",
    status: "promoting",
    candidateRoutes: SUTHERLAND_SIX_ROUTES,
  });

  const mismatchRecon = await governedDelivery.reconcilePendingDeployments(siteId);
  assert.equal(mismatchRecon.reconciled, true);
  const mismatchRecovered = await store.getDeployment(mismatchDepId);
  assert.equal(mismatchRecovered?.status, "needs_review");

  await rm(path.resolve(repoRoot, ".factory", "production", "projects", projectId), { recursive: true, force: true }).catch(() => {});
  await dbInst.close();
});
