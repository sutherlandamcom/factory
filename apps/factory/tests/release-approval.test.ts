import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_APPROVE_PERMISSION,
  DEPLOYMENT_PUBLISH_PERMISSION,
} from "@factory/contracts";
import {
  AuditSealKeyring,
  InMemorySessionRevocationStore,
} from "../src/trust/editorial-review-boundary.js";
import {
  ReleaseApprovalBoundary,
  ReleaseIdentityProvider,
  computeReleaseApprovalSeal,
  verifyReleaseApprovalSeal,
  type ReleaseApprovalSealFields,
} from "../src/trust/release-approval-boundary.js";
import type { ReleaseApprovalRecord } from "../src/persistence/schema.js";

const TEST_SEAL_KEY = "0123456789abcdef0123456789abcdef";

test("release approval HMAC seal computation and verification passes with valid key", () => {
  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: TEST_SEAL_KEY },
  });

  const fields: ReleaseApprovalSealFields = {
    approvalId: "appr-1",
    projectId: "proj-1",
    siteId: "site-1",
    candidateId: "cand-1",
    qaRunId: "qa-1",
    artifactDigest: "a".repeat(64),
    previewVersionId: "v-prev-1",
    targetWorkerName: "worker-sutherland",
    targetProductionUrl: "https://sutherland.com",
    actorId: "actor-alice",
    isSynthetic: false,
  };

  const { seal, sealKeyId } = computeReleaseApprovalSeal(fields, keyring);
  assert.equal(sealKeyId, "v1");
  assert.match(seal, /^[0-9a-f]{64}$/);

  const approvalRecord: ReleaseApprovalRecord = {
    id: fields.approvalId,
    projectId: fields.projectId,
    siteId: fields.siteId,
    candidateId: fields.candidateId,
    qaRunId: fields.qaRunId,
    artifactDigest: fields.artifactDigest,
    previewVersionId: fields.previewVersionId,
    targetWorkerName: fields.targetWorkerName,
    targetProductionUrl: fields.targetProductionUrl,
    actorId: fields.actorId,
    actorName: "Alice Operator",
    actorRole: "RELEASE_APPROVER",
    sessionId: "sess-1",
    isSynthetic: false,
    verificationSeal: seal,
    sealKeyId: "v1",
    sealStatus: "SEALED",
    revoked: false,
    createdAt: new Date(),
  };

  assert.equal(verifyReleaseApprovalSeal(approvalRecord, keyring), true);

  // Verification fails if any bound field is modified (e.g. preview version changed)
  const tamperedRecord = { ...approvalRecord, previewVersionId: "v-prev-2" };
  assert.equal(verifyReleaseApprovalSeal(tamperedRecord, keyring), false);

  // Verification fails if seal is corrupted
  const corruptedSealRecord = { ...approvalRecord, verificationSeal: "f".repeat(64) };
  assert.equal(verifyReleaseApprovalSeal(corruptedSealRecord, keyring), false);
});

test("ReleaseIdentityProvider verifies cryptographically signed session tokens", async () => {
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-idp");

  const validToken = signAssertion({
    actorId: "actor-alice",
    actorName: "Alice Operator",
    actorRole: "DEPLOYER",
    audience: "factory-release-governance",
  });

  const session = await idp.verifySession(validToken);
  assert.ok(session);
  assert.equal(session.actorId, "actor-alice");
  assert.equal(session.actorName, "Alice Operator");
  assert.equal(session.isSynthetic, false);

  // Expired token rejected
  const expiredToken = signAssertion({
    actorId: "actor-alice",
    actorName: "Alice",
    actorRole: "DEPLOYER",
    ttlMs: -1000,
  });
  assert.equal(await idp.verifySession(expiredToken), null);

  // Forged signature rejected
  const forgedToken = validToken.slice(0, -6) + "abcdef";
  assert.equal(await idp.verifySession(forgedToken), null);

  // Non-ext-idp token rejected
  assert.equal(await idp.verifySession("invalid-token-format"), null);
});

test("ReleaseApprovalBoundary validates membership permissions and fails closed on missing permission", async () => {
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-idp");
  const revocationStore = new InMemorySessionRevocationStore();

  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => [
          {
            id: "mem-1",
            projectId: "proj-1",
            actorId: "actor-bob",
            actorRole: "VIEWER",
            permissions: ["OTHER:PERMISSION"],
            revokedAt: null,
          },
        ],
      }),
    }),
  };

  const boundary = new ReleaseApprovalBoundary(mockDb as any, {
    idp,
    revocationStore,
    keyring: new AuditSealKeyring({ activeKeyId: "v1", keys: { v1: TEST_SEAL_KEY } }),
  });

  const bobToken = signAssertion({
    actorId: "actor-bob",
    actorName: "Bob Viewer",
    actorRole: "VIEWER",
  });

  // Bob lacks DEPLOYMENT:APPROVE -> throws permission_denied
  await assert.rejects(
    () =>
      boundary.verifyActorPermission({
        sessionToken: bobToken,
        projectId: "proj-1",
        requiredPermission: DEPLOYMENT_APPROVE_PERMISSION,
      }),
    (err: any) => err.code === "permission_denied",
  );

  // Revoking session fails closed
  const payloadB64 = bobToken.split(".")[1]!;
  const parsedJti = JSON.parse(Buffer.from(payloadB64, "base64url").toString()).jti;
  await revocationStore.revokeSession(parsedJti);
  await assert.rejects(
    () =>
      boundary.verifyActorPermission({
        sessionToken: bobToken,
        projectId: "proj-1",
        requiredPermission: DEPLOYMENT_APPROVE_PERMISSION,
      }),
    (err: any) => err.code === "session_revoked" || err.code === "actor_unauthenticated",
  );
});
