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
import { AuditSealKeyring } from "../../src/trust/release-approval-boundary.js";

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
