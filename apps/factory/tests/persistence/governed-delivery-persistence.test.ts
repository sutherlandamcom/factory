import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "./helpers.js";
import {
  projects,
  sites,
  productionCandidates,
  productionPageInputs,
  productionQaRuns,
  deployments,
  releaseApprovals,
} from "../../src/persistence/schema.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { AuditSealKeyring, ReleaseApprovalBoundary } from "../../src/trust/release-approval-boundary.js";
import { GovernedDeliveryService } from "../../src/delivery/governed-service.js";
import { ProductionStore } from "../../src/production/store.js";

test("governed delivery persistence: PostgreSQL 18 schema, constraints, immutability trigger", async () => {
  const dbInst = await createTestDatabase();
  const db = dbInst.db;
  const store = new FactoryStore(db);

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-pers-${suffix}`;
  const siteId = `site-pers-${suffix}`;
  const inputId = `input-pers-${suffix}`;
  const candidateId = `cand-pers-${suffix}`;
  const qaRunId = `qa-pers-${suffix}`;
  const deploymentId = `dep-pers-${suffix}`;
  const approvalId = `appr-pers-${suffix}`;

  const digest64 = "a".repeat(64);
  const sha40 = "b".repeat(40);

  // 1. Seed project & site
  await db.insert(projects).values({
    id: projectId,
    key: `test-proj-${suffix}`,
    name: "Persistence Test Project",
  });

  await db.insert(sites).values({
    id: siteId,
    projectId,
    key: `site-key-${suffix}`,
    name: "Persistence Test Site",
    cloudflareWorkerName: "worker-pers-test",
    productionUrl: "https://test.example.com",
  });

  // 2. Seed production page input, candidate, QA run
  await db.insert(productionPageInputs).values({
    id: inputId,
    projectId,
    version: 1,
    pageIdentity: "home",
    pageType: "homepage",
    route: "/",
    canonicalOrigin: "https://test.example.com",
    acceptedContentId: "c-1",
    acceptedContentVersion: 1,
    acceptedContentDigest: digest64,
    acceptedDesignId: "d-1",
    acceptedDesignVersion: 1,
    acceptedDesignDigest: digest64,
    acceptedVisualSetId: "v-1",
    acceptedVisualSetVersion: 1,
    acceptedVisualSetDigest: digest64,
    rendererId: "astro-static",
    rendererVersion: "astro-v5",
    rendererPolicyVersion: "production-policy-v3",
    data: {},
    inputDigest: digest64,
  });

  await db.insert(productionCandidates).values({
    id: candidateId,
    projectId,
    productionInputId: inputId,
    productionInputVersion: 1,
    productionInputDigest: digest64,
    pageIdentity: "home",
    route: "/",
    canonicalUrl: "https://test.example.com/",
    artifactDigest: digest64,
    artifactRef: ".factory/dist",
    manifestSetDigest: digest64,
    redirectSnapshotDigest: digest64,
    siteProfileDigest: digest64,
    lockfileDigest: digest64,
    rendererVersion: "astro-v5",
    repositorySha: sha40,
    state: "qa_passed",
  });

  await db.insert(productionQaRuns).values({
    id: qaRunId,
    projectId,
    candidateId,
    candidateArtifactDigest: digest64,
    data: { overall: "PASS" },
    overall: "PASS",
  });

  // 3. Create governed deployment with Run 13 lineage fields
  const deployment = await store.createDeployment({
    id: deploymentId,
    siteId,
    sourceCommit: sha40,
    workerName: "worker-pers-test",
    productionUrl: "https://test.example.com",
    artifactDirectory: `.factory/deployments/${deploymentId}`,
    candidateId,
    qaRunId,
    candidateRoutes: ["/"],
    snapshotData: { renderer: "astro-v5" },
  });

  assert.equal(deployment.candidateId, candidateId);
  assert.equal(deployment.qaRunId, qaRunId);
  assert.deepEqual(deployment.candidateRoutes, ["/"]);

  // 4. Insert release approval
  const seal = "c".repeat(64);
  const approval = await store.insertReleaseApproval({
    id: approvalId,
    projectId,
    siteId,
    candidateId,
    qaRunId,
    artifactDigest: digest64,
    previewVersionId: "v-prev-pers-1",
    targetWorkerName: "worker-pers-test",
    targetProductionUrl: "https://test.example.com",
    actorId: "actor-alice",
    actorName: "Alice Lead",
    actorRole: "RELEASE_APPROVER",
    sessionId: "sess-1",
    isSynthetic: false,
    verificationSeal: seal,
    sealKeyId: "v1",
    sealStatus: "SEALED",
  });

  assert.equal(approval.id, approvalId);
  assert.equal(approval.candidateId, candidateId);
  assert.equal(approval.verificationSeal, seal);

  // 5. Query release approval via store
  const found = await store.findReleaseApproval(candidateId, "v-prev-pers-1");
  assert.ok(found);
  assert.equal(found.id, approvalId);

  // 6. Immutability trigger: direct UPDATE on release_approvals MUST FAIL
  await assert.rejects(
    () =>
      db.execute(
        sql`UPDATE release_approvals SET verification_seal = 'modified' WHERE id = ${approvalId}`,
      ),
    (err: any) =>
      /release_approvals protected fields are immutable/i.test(err?.message ?? "") ||
      /release_approvals protected fields are immutable/i.test(err?.cause?.message ?? ""),
  );

  // 7. Transition deployment through valid governed lifecycle states
  await store.updateDeployment({
    id: deploymentId,
    status: "uploaded",
    versionId: "v-prev-pers-1",
  });
  await store.updateDeployment({
    id: deploymentId,
    status: "preview_verified",
    previewVerified: true,
  });
  await store.updateDeployment({
    id: deploymentId,
    status: "promoting",
    releaseApprovalId: approvalId,
  });
  await store.updateDeployment({
    id: deploymentId,
    status: "promoted",
    promotedAt: new Date(),
  });
  const updatedDeployment = await store.updateDeployment({
    id: deploymentId,
    status: "verified",
    productionVerified: true,
    verifiedAt: new Date(),
  });

  assert.equal(updatedDeployment.status, "verified");
  assert.equal(updatedDeployment.releaseApprovalId, approvalId);
  assert.equal(updatedDeployment.productionVerified, true);

  await dbInst.close();
});

test("governed delivery concurrency (P0-01): multi-connection PostgreSQL session advisory lock & atomic CAS", async () => {
  const dbInst1 = await createTestDatabase();
  const dbInst2 = await createTestDatabase();

  const store1 = new FactoryStore(dbInst1.db);
  const store2 = new FactoryStore(dbInst2.db);
  const prodStore1 = new ProductionStore(dbInst1.db);
  const prodStore2 = new ProductionStore(dbInst2.db);

  const boundary1 = new ReleaseApprovalBoundary(dbInst1.db);
  const boundary2 = new ReleaseApprovalBoundary(dbInst2.db);

  const service1 = new GovernedDeliveryService({
    db: dbInst1.db,
    pool: dbInst1.pool,
    repoRoot: process.cwd(),
    store: store1,
    productionStore: prodStore1,
    releaseBoundary: boundary1,
  });

  const service2 = new GovernedDeliveryService({
    db: dbInst2.db,
    pool: dbInst2.pool,
    repoRoot: process.cwd(),
    store: store2,
    productionStore: prodStore2,
    releaseBoundary: boundary2,
  });

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-conc-${suffix}`;
  const siteId = `site-conc-${suffix}`;

  await dbInst1.db.insert(projects).values({
    id: projectId,
    key: `test-proj-conc-${suffix}`,
    name: "Concurrency Test Project",
  });

  await dbInst1.db.insert(sites).values({
    id: siteId,
    projectId,
    key: `site-conc-${suffix}`,
    name: "Concurrency Site",
    cloudflareWorkerName: "worker-conc-test",
    productionUrl: "https://conc.example.com",
  });

  // 1. Multi-connection session advisory lock mutual exclusion
  let lock1Active = false;
  let service2AttemptFinished = false;
  let service2Rejected = false;

  const promise1 = service1.withProjectLock(projectId, async () => {
    lock1Active = true;
    // Wait long enough for service2 to try and fail
    await new Promise((r) => setTimeout(r, 600));
    lock1Active = false;
    return "service1_done";
  });

  // Small delay to ensure service1 has acquired the lock
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lock1Active, true);

  // Connection 2 attempts to acquire lock on the same project with short timeout
  const promise2 = service2
    .withProjectLock(
      projectId,
      async () => {
        return "service2_should_not_run";
      },
      300,
    )
    .catch((err) => {
      service2AttemptFinished = true;
      if (err.code === "concurrent_deployment_in_progress") {
        service2Rejected = true;
      }
      return "rejected";
    });

  const [res1, res2] = await Promise.all([promise1, promise2]);
  assert.equal(res1, "service1_done");
  assert.equal(res2, "rejected");
  assert.equal(service2Rejected, true);
  assert.equal(service2AttemptFinished, true);

  // 2. Lock is now released: service2 can acquire without contention
  const res3 = await service2.withProjectLock(projectId, async () => {
    return "service2_subsequent_acquired";
  }, 1000);
  assert.equal(res3, "service2_subsequent_acquired");

  // 3. Atomic CAS: updateDeployment prevents concurrent double-promotion
  const deploymentId = `dep-cas-${suffix}`;
  await store1.createDeployment({
    id: deploymentId,
    siteId,
    sourceCommit: "c".repeat(40),
    workerName: "worker-conc-test",
    productionUrl: "https://conc.example.com",
    artifactDirectory: ".factory/deployments/test",
  });

  // Advance to promoting
  await store1.updateDeployment({ id: deploymentId, status: "promoting" });

  // Two independent connections race to update status to "promoted"
  const race = await Promise.allSettled([
    store1.updateDeployment({ id: deploymentId, status: "promoted", promotedAt: new Date() }),
    store2.updateDeployment({ id: deploymentId, status: "promoted", promotedAt: new Date() }),
  ]);

  const fulfilled = race.filter((r) => r.status === "fulfilled");
  const rejected = race.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one concurrent transition must succeed");
  assert.equal(rejected.length, 1, "The concurrent transition race loser must fail");
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason?.code,
    "deployment_transition_invalid",
    "Loser must receive deployment_transition_invalid",
  );

  await dbInst1.close();
  await dbInst2.close();
});
