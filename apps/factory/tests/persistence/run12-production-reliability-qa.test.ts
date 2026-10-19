import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, cp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { setupMigratedTestDatabase, createTestDatabase, TEST_DATABASE_URL } from "./helpers.js";
import type { FactoryDb } from "../../src/persistence/db.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { ProductionStore } from "../../src/production/store.js";
import {
  EditorialAuditStore,
  EditorialReviewService,
  ProjectMembershipAuthority,
  TrustedExternalIdpAdapter,
  AuditSealKeyring,
  computeAuditEventSeal,
} from "../../src/trust/editorial-review-boundary.js";
import {
  computeClaimSetDigest,
  computeSourceEvidenceSetDigest,
  computeWorkProductSetDigest,
  computePageSourceEvidenceDigest,
  computeWorkProductExecutionHash,
} from "../../src/production/qa/trust.js";
import {
  loadInseeEvidenceRegistry,
  type InseeEvidenceRegistry,
} from "../../src/trust/insee-evidence.js";
import {
  loadLegalEvidenceRegistry,
  type LegalEvidenceRegistry,
} from "../../src/trust/legal-evidence.js";
import {
  REQUIRED_PRODUCTION_QA_GATES,
  REQUIRED_TRUST_QA_GATES,
  TRUSTED_PRODUCTION_QA_GATES,
} from "../../src/production/qa/registry.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { DesignStore } from "../../src/design/design-store.js";
import { VisualStore } from "../../src/visual/store.js";
import {
  productionPageInputs,
  productionCandidates,
  productionCandidateInputs,
} from "../../src/persistence/schema.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import {
  type ClaimLineage,
  type OriginalValueRecord,
  type ProductionQaCheckResult,
  parseDesignCandidateData,
} from "@factory/contracts";
import { bindQaCheck } from "../../src/production/qa/registry.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const workerScript = path.resolve(__dirname, "helpers/seal-process-worker.ts");

const TEST_SEAL_KEY_V1 = createHash("sha256").update("seal-key-v1-stable-test-seed").digest("hex");
const TEST_SEAL_KEY_V2 = createHash("sha256").update("seal-key-v2-rotated-test-seed").digest("hex");
const TEST_SEAL_KEY_WRONG = createHash("sha256").update("seal-key-wrong-unauthorized").digest("hex");

function runWorker(command: string, args: Record<string, unknown>, envOverrides: Record<string, string> = {}) {
  const result = execFileSync(
    "npx",
    ["tsx", workerScript, command, JSON.stringify(args)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
        FACTORY_AUDIT_SEAL_KEY_ID: "v1",
        ...envOverrides,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(result.trim());
}

function candidateData(pageSlug: string) {
  const archKind = pageSlug.startsWith("locations/") ? "location" : "homepage";
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
        title: pageSlug,
        deviceType: "DESKTOP",
        archetype: archKind,
      },
    ],
    archetypes: [
      {
        kind: archKind,
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/fixture/screens/abc"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero placeholder",
            pageSlug,
            role: "hero",
            requiredRole: "hero",
            providerConsumed: false,
            placeholder: true,
            unresolvedReason: "No approved asset assignment for hero.",
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

// ---------------------------------------------------------------------------
// BLOCK 1: SEAL-01 through SEAL-06 (Audit Seal Across Process Restarts)
// ---------------------------------------------------------------------------

test("SEAL-01: Genuine approval survives process restart and remains verifiable in separate process", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const seeded = await seedSutherlandProject(dbInst, `seal01-${Date.now()}`);

  try {
    const pageIdentity = "locations/chamonix";
    const contentDigest = createHash("sha256").update("chamonix-content-seal-01").digest("hex");
    const claimSetDigest = createHash("sha256").update("claimset-seal-01").digest("hex");
    const sourceEvidenceSetDigest = createHash("sha256").update("source-evidence-seal-01").digest("hex");

    // Process A: records authenticated approval with configured v1 key
    const recorded = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      actorId: "director-chamonix-1",
      actorRole: "MANAGING_DIRECTOR",
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
      FACTORY_AUDIT_SEAL_KEY_ID: "v1",
    });

    assert.equal(recorded.ok, true);
    assert.equal(recorded.sealStatus, "SEALED");
    assert.equal(recorded.sealKeyId, "v1");
    assert.match(recorded.verificationSeal, /^[0-9a-f]{64}$/);

    // Process B (separate process execution over the same database): verifies the audit event
    const verifiedB = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
      FACTORY_AUDIT_SEAL_KEY_ID: "v1",
    });

    assert.equal(verifiedB.ok, true);
    assert.equal(verifiedB.found, true);
    assert.equal(verifiedB.sealVerified, true, "Valid approval must remain verifiable in a separate process");
    assert.equal(verifiedB.sealKeyId, "v1");

    // Verify review authority staleness check in separate process
    const reviewB = runWorker("verify-review-authority", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
      FACTORY_AUDIT_SEAL_KEY_ID: "v1",
    });

    assert.equal(reviewB.ok, true);
    assert.equal(reviewB.hasReview, true);
    assert.equal(reviewB.stale, false);
    assert.equal(reviewB.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
  } finally {
    await dbInst.close();
  }
});

test("SEAL-02: Verify the same event from two independent application instances", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const seeded = await seedSutherlandProject(dbInst, `seal02-${Date.now()}`);

  try {
    const pageIdentity = "locations/megeve";
    const contentDigest = createHash("sha256").update("megeve-content-seal-02").digest("hex");
    const claimSetDigest = createHash("sha256").update("claimset-seal-02").digest("hex");
    const sourceEvidenceSetDigest = createHash("sha256").update("source-evidence-seal-02").digest("hex");

    const recorded = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      actorId: "lead-megeve-2",
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    // Independent Instance 1
    const inst1 = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    // Independent Instance 2
    const inst2 = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    assert.equal(inst1.sealVerified, true, "Instance 1 must verify authentic seal");
    assert.equal(inst2.sealVerified, true, "Instance 2 must verify authentic seal");
  } finally {
    await dbInst.close();
  }
});

test("SEAL-03: Restart with incorrect or unavailable key fails closed without falsely marking authentic", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const seeded = await seedSutherlandProject(dbInst, `seal03-${Date.now()}`);

  try {
    const pageIdentity = "locations/chamonix";
    const contentDigest = createHash("sha256").update("chamonix-content-seal-03").digest("hex");
    const claimSetDigest = createHash("sha256").update("claimset-seal-03").digest("hex");
    const sourceEvidenceSetDigest = createHash("sha256").update("source-evidence-seal-03").digest("hex");

    const recorded = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      actorId: "director-chamonix-3",
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    // Verification attempt with WRONG key material
    const wrongKeyVerif = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_WRONG,
      FACTORY_AUDIT_SEAL_KEYS: "",
    });

    assert.equal(wrongKeyVerif.sealVerified, false, "Wrong verification key must fail seal check");

    // Review authority check with WRONG key must flag review as stale
    const wrongKeyReview = runWorker("verify-review-authority", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_WRONG,
      FACTORY_AUDIT_SEAL_KEYS: "",
    });

    assert.equal(wrongKeyReview.stale, true, "Wrong key must cause review authority to fail closed as stale");

    // Verification attempt with MISSING key material
    const missingKeyVerif = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: "",
      FACTORY_AUDIT_SEAL_KEYS: "",
    });

    assert.equal(missingKeyVerif.sealVerified, false, "Missing key must fail closed without erroring or falsifying trust");
  } finally {
    await dbInst.close();
  }
});

test("SEAL-04: Rotate signing keys while retaining legitimate historical verification under key version", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const seeded = await seedSutherlandProject(dbInst, `seal04-${Date.now()}`);

  try {
    const page1 = "locations/chamonix";
    const page2 = "locations/megeve";
    const d1 = createHash("sha256").update("d1").digest("hex");
    const d2 = createHash("sha256").update("d2").digest("hex");

    // Phase 1: Event 1 signed with key v1
    const eventV1 = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity: page1,
      contentDigest: d1,
      claimSetDigest: d1,
      sourceEvidenceSetDigest: d1,
      actorId: "actor-v1",
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
      FACTORY_AUDIT_SEAL_KEY_ID: "v1",
    });

    assert.equal(eventV1.sealKeyId, "v1");

    // Phase 2: Key rotation - v2 is active signing key, v1 is retained for verification
    const keyringConfig = JSON.stringify({
      v1: TEST_SEAL_KEY_V1,
      v2: TEST_SEAL_KEY_V2,
    });

    const eventV2 = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity: page2,
      contentDigest: d2,
      claimSetDigest: d2,
      sourceEvidenceSetDigest: d2,
      actorId: "actor-v2",
    }, {
      FACTORY_AUDIT_SEAL_KEYS: keyringConfig,
      FACTORY_AUDIT_SEAL_ACTIVE_KEY_ID: "v2",
    });

    assert.equal(eventV2.sealKeyId, "v2");

    // Verify historical Event 1 under rotated keyring
    const verifyHist = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: eventV1.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEYS: keyringConfig,
      FACTORY_AUDIT_SEAL_ACTIVE_KEY_ID: "v2",
    });

    assert.equal(verifyHist.sealVerified, true, "Historical event signed with v1 must verify under rotated keyring containing v1");

    // Verify modern Event 2 under rotated keyring
    const verifyMod = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: eventV2.reviewEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEYS: keyringConfig,
      FACTORY_AUDIT_SEAL_ACTIVE_KEY_ID: "v2",
    });

    assert.equal(verifyMod.sealVerified, true, "Modern event signed with v2 must verify under active v2 key");
  } finally {
    await dbInst.close();
  }
});

test("SEAL-05: Tamper with protected audit event field fails cryptographic verification", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const seeded = await seedSutherlandProject(dbInst, `seal05-${Date.now()}`);

  try {
    const pageIdentity = "locations/chamonix";
    const contentDigest = createHash("sha256").update("chamonix-content-seal-05").digest("hex");
    const claimSetDigest = createHash("sha256").update("claimset-seal-05").digest("hex");
    const sourceEvidenceSetDigest = createHash("sha256").update("source-evidence-seal-05").digest("hex");

    const recorded = runWorker("record-approval", {
      databaseUrl: dbUrl,
      projectId: seeded.projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      actorId: "actor-seal-05",
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    // 1. Direct SQL mutation attempt on protected field content_digest triggers PostgreSQL immutability error
    const tamperAttempt = runWorker("tamper-event-in-db", {
      databaseUrl: dbUrl,
      eventId: recorded.reviewEventId,
      newDigest: "e".repeat(64),
    });

    assert.equal(tamperAttempt.ok, false, "PostgreSQL trigger must reject direct modification of protected columns");
    assert.match(`${tamperAttempt.error} ${tamperAttempt.message}`, /23514|enforce_editorial_audit_event_immutability|protected fields are immutable/);

    // 2. Direct insertion of a row with tampered verification seal fails HMAC seal verification
    const forgedEventId = `forged-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO editorial_approval_audit_events (
        id, project_id, page_identity, actor_id, actor_role, review_action,
        content_digest, claim_set_digest, source_evidence_set_digest, audit_event_reference,
        is_synthetic, revoked, verification_seal, seal_key_id, seal_status
      ) VALUES (
        ${forgedEventId}, ${seeded.projectId}, ${pageIdentity}, 'attacker', 'HACKER', 'APPROVED',
        ${contentDigest}, ${claimSetDigest}, ${sourceEvidenceSetDigest}, 'FORGED',
        false, false, ${"f".repeat(64)}, 'v1', 'SEALED'
      )
    `);

    const forgedVerif = runWorker("verify-audit-event", {
      databaseUrl: dbUrl,
      eventId: forgedEventId,
    }, {
      FACTORY_AUDIT_SEAL_KEY: TEST_SEAL_KEY_V1,
    });

    assert.equal(forgedVerif.found, true);
    assert.equal(forgedVerif.sealVerified, false, "Tampered or forged verification seal must fail cryptographic check");
  } finally {
    await dbInst.close();
  }
});

test("SEAL-06: Attempt to obtain authentic approval seal through untrusted application interface is rejected", async () => {
  const dbUrl = process.env.FACTORY_TEST_DATABASE_URL!;
  const oracleResult = runWorker("test-oracle-prohibition", {
    databaseUrl: dbUrl,
  });

  assert.equal(oracleResult.ok, false);
  assert.equal(oracleResult.oracleSucceeded, false);
  assert.equal(oracleResult.error, "audit_seal_oracle_prohibited");
  assert.match(oracleResult.message, /Direct invocation of computeAuditEventSeal.*is prohibited/);
});

// ---------------------------------------------------------------------------
// BLOCK 1: SESSION-01..03 & ISOLATION-01..03 (Session Revocation & Tenant Isolation)
// ---------------------------------------------------------------------------

test("SESSION-01, SESSION-02, SESSION-03: Editorial session revocation survives restart and cross-instance isolation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seeded = await seedSutherlandProject(dbInst, `sess-${Date.now()}`);
  const pageSlug = "home";
  const contentDigest = "a".repeat(64);
  const claimDigest = "b".repeat(64);
  const sourceDigest = "c".repeat(64);

  try {
    const actorId = "sess-reviewer-1";
    const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
    await membership.grantMembership(seeded.projectId, actorId, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);

    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta", dbInst.db);
    const token = harness.issueSignedSession({
      actorId,
      actorName: "Session Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });

    // Verify session initially valid
    const initialVerify = await harness.adapter.verifySession(token);
    assert.ok(initialVerify !== null);

    // ---- SESSION-03: Valid, unrevoked signed session with current project permissions -> PASS ----
    const auditStore = EditorialAuditStore.getInstance(dbInst.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));
    const trustStore = new TrustGovernanceStore(dbInst.db, { auditStore });
    const service = new EditorialReviewService(trustStore, harness.adapter, membership, auditStore);

    const validReview = await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest: claimDigest,
      sourceEvidenceSetDigest: sourceDigest,
      verifiedClaimIds: ["claim-1"],
      note: "Session test approval",
      sessionToken: token,
      reviewerRef: actorId,
      reviewerExpertise: "Lead Reviewer",
      reviewAction: "APPROVED",
    });
    assert.ok(validReview.approvalEvent?.reviewEventId);
    assert.equal(validReview.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");

    // Revoke the session
    await harness.adapter.revokeSession(token, "Security credential revoked");

    // ---- SESSION-01: Revoke a signed session, restart Node.js, present the same session again -> REJECT ----
    // Verify durable record exists in DB
    const revRows = await dbInst.db.execute<{ session_id: string }>(sql`
      SELECT session_id FROM editorial_session_revocations
    `);
    assert.ok(revRows.rows.length > 0, "Revocation must be durably persisted in editorial_session_revocations");

    // Now test across separate Node.js process restart using runWorker
    const workerRes = runWorker("verify-session", {
      databaseUrl: TEST_DATABASE_URL,
      sessionToken: token,
      publicKeyPem: harness.publicKeyPem,
    });
    assert.equal(workerRes.ok, true);
    assert.equal(workerRes.valid, false, "SESSION-01: Session must be invalid after process restart");

    const workerApprovalRes = runWorker("attempt-approval-with-token", {
      databaseUrl: TEST_DATABASE_URL,
      sessionToken: token,
      publicKeyPem: harness.publicKeyPem,
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest: claimDigest,
      sourceEvidenceSetDigest: sourceDigest,
      actorId,
    });
    assert.equal(workerApprovalRes.ok, false, "SESSION-01: Approval with revoked session must fail in new process");
    assert.match(workerApprovalRes.error || workerApprovalRes.message, /session_revoked|unauthenticated_session_required/);

    // ---- SESSION-02: Revoke a session in instance A, attempt approval in instance B -> REJECT ----
    const dbInstB = await createTestDatabase();
    try {
      const adapterB = new TrustedExternalIdpAdapter({
        providerId: "sutherland-corp-okta",
        publicKeyPem: harness.publicKeyPem,
        db: dbInstB.db,
      });
      const membershipB = ProjectMembershipAuthority.getInstance(dbInstB.db);
      const auditStoreB = EditorialAuditStore.getInstance(dbInstB.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));
      const trustStoreB = new TrustGovernanceStore(dbInstB.db, { auditStore: auditStoreB });
      const serviceB = new EditorialReviewService(trustStoreB, adapterB, membershipB, auditStoreB);

      // Verify instance B observes revocation immediately
      const verifyB = await adapterB.verifySession(token);
      assert.equal(verifyB, null, "SESSION-02: Instance B must observe revocation recorded by instance A");

      await assert.rejects(
        async () => {
          await serviceB.recordAuthenticatedApproval({
            projectId: seeded.projectId,
            pageIdentity: pageSlug,
            contentDigest,
            claimSetDigest: claimDigest,
            sourceEvidenceSetDigest: sourceDigest,
            verifiedClaimIds: ["claim-1"],
            note: "Attempt in instance B",
            sessionToken: token,
            reviewerRef: actorId,
            reviewerExpertise: "Lead Reviewer",
            reviewAction: "APPROVED",
          });
        },
        (err: any) => {
          assert.match(err.code || err.message, /session_revoked|unauthenticated_session_required/);
          return true;
        },
        "SESSION-02: Approval attempt in instance B with revoked session must fail closed",
      );
    } finally {
      await dbInstB.close();
    }
  } finally {
    await dbInst.close();
  }
});

test("ISOLATION-01, ISOLATION-02, ISOLATION-03: Cryptographic and database tenant isolation under concurrent operations", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seeded1 = await seedSutherlandProject(dbInst, `iso1-${Date.now()}`);
  const seeded2 = await seedSutherlandProject(dbInst, `iso2-${Date.now()}`);

  try {
    // ---- ISOLATION-02: Test keyring injection cannot change production approval verification ----
    const prodKeyring = new AuditSealKeyring({ keys: { prod1: TEST_SEAL_KEY_V1 }, activeKeyId: "prod1" });
    const testKeyring = new AuditSealKeyring({ keys: { test1: TEST_SEAL_KEY_WRONG }, activeKeyId: "test1" });

    const auditStoreProd = EditorialAuditStore.getInstance(dbInst.db, prodKeyring);
    const auditStoreTest = EditorialAuditStore.getInstance(dbInst.db, testKeyring);

    const membership1 = ProjectMembershipAuthority.getInstance(dbInst.db);
    await membership1.grantMembership(seeded1.projectId, "actor-iso-1", ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);

    const harness1 = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta", dbInst.db);
    const token1 = harness1.issueSignedSession({
      actorId: "actor-iso-1",
      actorName: "Iso Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });

    const trustStoreProd = new TrustGovernanceStore(dbInst.db, { auditStore: auditStoreProd });
    const serviceProd = new EditorialReviewService(trustStoreProd, harness1.adapter, membership1, auditStoreProd);

    const prodReview = await serviceProd.recordAuthenticatedApproval({
      projectId: seeded1.projectId,
      pageIdentity: "home",
      contentDigest: "1".repeat(64),
      claimSetDigest: "2".repeat(64),
      sourceEvidenceSetDigest: "3".repeat(64),
      verifiedClaimIds: ["c1"],
      note: "Prod approval",
      sessionToken: token1,
      reviewerRef: "actor-iso-1",
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });

    const eventId = prodReview.approvalEvent!.reviewEventId;

    // Production store verifies seal as valid
    const eventInProd = await auditStoreProd.getApprovalAuditEvent(eventId, dbInst.db);
    assert.equal(eventInProd?.sealVerified, true, "ISOLATION-02: Production store must verify production seal");

    // Test store with isolated keyring CANNOT verify production seal
    const eventInTest = await auditStoreTest.getApprovalAuditEvent(eventId, dbInst.db);
    assert.equal(eventInTest?.sealVerified, false, "ISOLATION-02: Test keyring cannot verify production seal");
    assert.equal(eventInTest?.sealStatus, "SEALED");

    // Injecting/creating another store cannot mutate prodKeyring
    assert.equal(auditStoreProd.getKeyring().activeKeyId, "prod1");
    assert.equal(auditStoreTest.getKeyring().activeKeyId, "test1");

    // ---- ISOLATION-01: Two independent governance stores with different databases / project namespaces ----
    // Project 2 store cannot validate or read Project 1 approvals as belonging to Project 2
    const eventInProj2 = await auditStoreProd.getApprovalAuditEvent(eventId, dbInst.db);
    assert.equal(eventInProj2?.projectId, seeded1.projectId);
    assert.notEqual(eventInProj2?.projectId, seeded2.projectId, "ISOLATION-01: Event belongs exclusively to project 1");

    const trustStore2 = new TrustGovernanceStore(dbInst.db, { auditStore: auditStoreProd });
    const proj2Review = await trustStore2.latestReview(seeded2.projectId, "home");
    assert.equal(proj2Review, null, "ISOLATION-01: Project 2 cannot see Project 1 review");

    // ---- ISOLATION-03: Concurrent projects and audit reads maintain correct database and keyring bindings ----
    await membership1.grantMembership(seeded2.projectId, "actor-iso-2", ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);
    const token2 = harness1.issueSignedSession({
      actorId: "actor-iso-2",
      actorName: "Iso Reviewer 2",
      actorRole: "EDITORIAL_BOARD",
    });

    const [resP1, resP2] = await Promise.all([
      serviceProd.recordAuthenticatedApproval({
        projectId: seeded1.projectId,
        pageIdentity: "locations/chamonix",
        contentDigest: "4".repeat(64),
        claimSetDigest: "5".repeat(64),
        sourceEvidenceSetDigest: "6".repeat(64),
        verifiedClaimIds: ["c2"],
        note: "P1 Chamonix",
        sessionToken: token1,
        reviewerRef: "actor-iso-1",
        reviewerExpertise: "Lead",
        reviewAction: "APPROVED",
      }),
      serviceProd.recordAuthenticatedApproval({
        projectId: seeded2.projectId,
        pageIdentity: "locations/chamonix",
        contentDigest: "7".repeat(64),
        claimSetDigest: "8".repeat(64),
        sourceEvidenceSetDigest: "9".repeat(64),
        verifiedClaimIds: ["c3"],
        note: "P2 Chamonix",
        sessionToken: token2,
        reviewerRef: "actor-iso-2",
        reviewerExpertise: "Lead",
        reviewAction: "APPROVED",
      }),
    ]);

    assert.ok(resP1.approvalEvent?.reviewEventId);
    assert.ok(resP2.approvalEvent?.reviewEventId);
    assert.notEqual(resP1.approvalEvent!.reviewEventId, resP2.approvalEvent!.reviewEventId);

    const ev1 = await auditStoreProd.getApprovalAuditEvent(resP1.approvalEvent!.reviewEventId, dbInst.db);
    const ev2 = await auditStoreProd.getApprovalAuditEvent(resP2.approvalEvent!.reviewEventId, dbInst.db);
    assert.equal(ev1?.projectId, seeded1.projectId);
    assert.equal(ev2?.projectId, seeded2.projectId);
    assert.equal(ev1?.sealVerified, true);
    assert.equal(ev2?.sealVerified, true);
  } finally {
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// BLOCK 2: MIG-01 through MIG-12 (PostgreSQL 18 Migration Compatibility)
// ---------------------------------------------------------------------------

async function create0035MigrationFolder(): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "factory-mig-0035-"));
  const realDrizzle = path.resolve(__dirname, "../../drizzle");
  
  // Copy migrations 0000 through 0035
  for (let i = 0; i <= 35; i++) {
    const prefix = String(i).padStart(4, "0");
    const result = execFileSync("bash", ["-c", `ls ${realDrizzle}/${prefix}_*.sql`], { encoding: "utf8" }).trim();
    const basename = path.basename(result);
    await cp(result, path.join(tmp, basename));
  }

  // Copy meta with journal trimmed to entries 0..35
  await cp(path.join(realDrizzle, "meta"), path.join(tmp, "meta"), { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: any) => e.idx <= 35);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));

  return tmp;
}

async function create0036HistoricalMigrationFolder(): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "factory-mig-0036-"));
  const realDrizzle = path.resolve(__dirname, "../../drizzle");

  // Copy migrations 0000 through 0036
  for (let i = 0; i <= 36; i++) {
    const prefix = String(i).padStart(4, "0");
    const result = execFileSync("bash", ["-c", `ls ${realDrizzle}/${prefix}_*.sql`], { encoding: "utf8" }).trim();
    const basename = path.basename(result);
    await cp(result, path.join(tmp, basename));
  }

  // Copy meta with journal trimmed to entries 0..36
  await cp(path.join(realDrizzle, "meta"), path.join(tmp, "meta"), { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: any) => e.idx <= 36);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));

  return tmp;
}

test("MIG-01 & MIG-02: Upgrade empty and populated version-0035 database to version 0036 on PostgreSQL 18", async () => {
  const dbInst = await createTestDatabase();
  const v35Dir = await create0035MigrationFolder();
  const realMigrationsDir = path.resolve(__dirname, "../../drizzle");

  try {
    // ---- MIG-01: Empty 0035 -> 0036 ----
    await dbInst.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    
    // Apply 0000..0035 to empty database
    const v35Result = await migrateDb(dbInst.db, { migrationsFolder: v35Dir });
    assert.equal(v35Result.applied, true);

    // Upgrade to 0036
    const v36Result = await migrateDb(dbInst.db, { migrationsFolder: realMigrationsDir });
    assert.equal(v36Result.applied, true, "MIG-01: Upgrading empty 0035 to 0036 must succeed");

    // ---- MIG-02: Populated 0035 -> 0036 ----
    await dbInst.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await migrateDb(dbInst.db, { migrationsFolder: v35Dir });

    // Seed project
    const prjId = `prj-mig-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO projects (id, key, name, created_at, updated_at)
      VALUES (${prjId}, 'mig-test', 'Migration Test Project', now(), now());
    `);

    // Insert representative pre-0036 historical audit rows (no seal columns exist in 0035)
    const histEvent1 = "evt-hist-valid-1";
    const histEvent2 = "evt-hist-revoked-2";
    const digest = "a".repeat(64);

    await dbInst.db.execute(sql`
      INSERT INTO editorial_approval_audit_events (
        id, project_id, page_identity, actor_id, actor_role, review_action,
        content_digest, claim_set_digest, source_evidence_set_digest, audit_event_reference,
        is_synthetic, revoked, created_at
      ) VALUES (
        ${histEvent1}, ${prjId}, 'locations/chamonix', 'actor-hist-1', 'EDITOR', 'APPROVED',
        ${digest}, ${digest}, ${digest}, 'MINUTES-HIST-1', false, false, now()
      ), (
        ${histEvent2}, ${prjId}, 'locations/megeve', 'actor-hist-2', 'EDITOR', 'APPROVED',
        ${digest}, ${digest}, ${digest}, 'MINUTES-HIST-2', false, true, now()
      );
    `);

    // Run forward migration to 0036 over populated database
    const popMigResult = await migrateDb(dbInst.db, { migrationsFolder: realMigrationsDir });
    assert.equal(popMigResult.applied, true, "MIG-02: Migration 0036 must succeed over existing historical records");

    // Verify historical records normalized to LEGACY_UNSEALED
    const rows = await dbInst.db.execute<{
      id: string;
      verification_seal: string | null;
      seal_key_id: string | null;
      seal_status: string;
      revoked: boolean;
    }>(sql`
      SELECT id, verification_seal, seal_key_id, seal_status, revoked
      FROM editorial_approval_audit_events
      ORDER BY id;
    `);

    assert.equal(rows.rows.length, 2);
    const r1 = rows.rows.find((r) => r.id === histEvent1)!;
    const r2 = rows.rows.find((r) => r.id === histEvent2)!;

    assert.equal(r1.seal_status, "LEGACY_UNSEALED");
    assert.equal(r1.verification_seal, null);
    assert.equal(r1.seal_key_id, null);
    assert.equal(r1.revoked, false);

    assert.equal(r2.seal_status, "LEGACY_UNSEALED");
    assert.equal(r2.revoked, true);
  } finally {
    await rm(v35Dir, { recursive: true, force: true });
    await dbInst.close();
  }
});

test("MIG-03, MIG-04, MIG-05, MIG-06: Historical unsealed blocked, modern sealed passes, idempotent rerun, restart durability", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const realMigrationsDir = path.resolve(__dirname, "../../drizzle");
  const seeded = await seedSutherlandProject(dbInst, `mig03-${Date.now()}`);

  try {
    const auditStore = EditorialAuditStore.getInstance(dbInst.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));

    // Insert historical legacy unsealed row directly to simulate migrated row
    const legacyEventId = `evt-legacy-${Date.now()}`;
    const digest = "b".repeat(64);
    await dbInst.db.execute(sql`
      INSERT INTO editorial_approval_audit_events (
        id, project_id, page_identity, actor_id, actor_role, review_action,
        content_digest, claim_set_digest, source_evidence_set_digest, audit_event_reference,
        is_synthetic, revoked, verification_seal, seal_key_id, seal_status
      ) VALUES (
        ${legacyEventId}, ${seeded.projectId}, 'locations/chamonix', 'legacy-actor', 'EDITOR', 'APPROVED',
        ${digest}, ${digest}, ${digest}, 'MINUTES-LEGACY', false, false, NULL, NULL, 'LEGACY_UNSEALED'
      );
    `);

    // MIG-03: Historical unsealed record cannot certify publication
    const legacyEvent = await auditStore.getApprovalAuditEvent(legacyEventId, dbInst.db);
    assert.ok(legacyEvent);
    assert.equal(legacyEvent.sealStatus, "LEGACY_UNSEALED");
    assert.equal(legacyEvent.sealVerified, false, "Legacy unsealed record must not be verified");

    // Attempting to record review authority referencing legacy unsealed approval fails closed
    const trustStore = new TrustGovernanceStore(dbInst.db);
    await assert.rejects(
      async () => {
        await trustStore.recordReviewLocked(dbInst.db, {
          projectId: seeded.projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId: seeded.projectId,
            pageIdentity: "locations/chamonix",
            reviewerRef: "legacy-reviewer",
            reviewerExpertise: "Expertise",
            reviewedContentDigest: digest,
            reviewedAt: "2026-10-18",
            result: "APPROVED",
            note: "Legacy review test note",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            claimSetDigest: digest,
            sourceEvidenceSetDigest: digest,
            approvalEventId: legacyEventId,
            approvalEvent: {
              reviewEventId: legacyEventId,
              authenticatedActorId: "legacy-actor",
              actorRole: "EDITOR",
              authorizationScope: "EDITORIAL_REVIEW",
              reviewAction: "APPROVED",
              reviewedContentDigest: digest,
              reviewedClaimSetDigest: digest,
              reviewedSourceEvidenceDigest: digest,
              eventTimestamp: "2026-10-18T10:00:00Z",
              auditEventReference: "MINUTES-LEGACY",
            },
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /forged_audit_event_rejected/);
        return true;
      },
      "MIG-03: Legacy unsealed approval cannot certify publication",
    );

    // MIG-04: New approval after migration receives a valid durable cryptographic seal
    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const token = harness.issueSignedSession({
      actorId: "modern-editor-1",
      actorName: "Modern Editor",
      actorRole: "EDITORIAL_BOARD",
    });
    const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
    await membership.grantMembership(seeded.projectId, "modern-editor-1", ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);

    const service = new EditorialReviewService(trustStore, harness.adapter, membership, auditStore);
    const modernReview = await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: "locations/chamonix",
      contentDigest: digest,
      claimSetDigest: digest,
      sourceEvidenceSetDigest: digest,
      verifiedClaimIds: ["claim-1"],
      note: "Modern post-migration approval",
      sessionToken: token,
      reviewerRef: "modern-editor-1",
      reviewerExpertise: "Lead Reviewer",
      reviewAction: "APPROVED",
    });

    const modernAuditEvent = await auditStore.getApprovalAuditEvent(modernReview.approvalEvent!.reviewEventId, dbInst.db);
    assert.ok(modernAuditEvent);
    assert.equal(modernAuditEvent.sealStatus, "SEALED");
    assert.equal(modernAuditEvent.sealKeyId, "v1");
    assert.equal(modernAuditEvent.sealVerified, true, "MIG-04: Modern approval receives a valid cryptographic seal");

    // MIG-05: Re-running migration is idempotent
    const rerun = await migrateDb(dbInst.db, { migrationsFolder: realMigrationsDir });
    assert.equal(rerun.applied, true, "MIG-05: Re-running migration must be idempotent and non-destructive");

    // MIG-06: Database connection restart and application restart preserve legitimate records and revocation
    await dbInst.close();

    const dbInst2 = await createTestDatabase();
    try {
      const auditStore2 = EditorialAuditStore.getInstance(dbInst2.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));

      const rereadModern = await auditStore2.getApprovalAuditEvent(modernReview.approvalEvent!.reviewEventId, dbInst2.db);
      assert.ok(rereadModern);
      assert.equal(rereadModern.sealVerified, true);
      assert.equal(rereadModern.revoked, false);

      // Revoke the approval
      await auditStore2.revokeApprovalAuditEvent(modernReview.approvalEvent!.reviewEventId, dbInst2.db);

      const rereadRevoked = await auditStore2.getApprovalAuditEvent(modernReview.approvalEvent!.reviewEventId, dbInst2.db);
      assert.ok(rereadRevoked);
      assert.equal(rereadRevoked.revoked, true);
    } finally {
      await dbInst2.close();
    }
  } finally {
    // Ensure database is clean for next tests
    const cleanupDb = await setupMigratedTestDatabase();
    await cleanupDb.close();
  }
});

test("MIG-07 through MIG-12: Forward migration from already-applied 0036 to 0037", async () => {
  const dbInst = await createTestDatabase();
  const v36Dir = await create0036HistoricalMigrationFolder();
  const realMigrationsDir = path.resolve(__dirname, "../../drizzle");

  try {
    // ---- MIG-07: Apply original historical 0036, populate audit records, then migrate forward with 0037 ----
    await dbInst.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);

    // Apply 0000..0036 (historical 0036 where verification_seal is NOT NULL, no seal_key_id, no seal_status)
    const v36Result = await migrateDb(dbInst.db, { migrationsFolder: v36Dir });
    assert.equal(v36Result.applied, true, "Historical 0000..0036 migration must succeed");

    // Populate representative historical audit records in 0036 schema
    const prjId = `prj-mig7-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO projects (id, key, name, created_at, updated_at)
      VALUES (${prjId}, 'mig7-test', 'Migration 0037 Forward Test', now(), now());
    `);

    const hist0036SealedId = "evt-0036-sealed-1";
    const hist0036RevokedId = "evt-0036-revoked-2";
    const dig = "e".repeat(64);
    const oldSeal = "0".repeat(64);

    await dbInst.db.execute(sql`
      INSERT INTO editorial_approval_audit_events (
        id, project_id, page_identity, actor_id, actor_role, review_action,
        content_digest, claim_set_digest, source_evidence_set_digest, audit_event_reference,
        is_synthetic, revoked, verification_seal, created_at
      ) VALUES (
        ${hist0036SealedId}, ${prjId}, 'locations/chamonix', 'actor-36-1', 'EDITOR', 'APPROVED',
        ${dig}, ${dig}, ${dig}, 'MINUTES-36-1', false, false, ${oldSeal}, now()
      ), (
        ${hist0036RevokedId}, ${prjId}, 'locations/megeve', 'actor-36-2', 'EDITOR', 'APPROVED',
        ${dig}, ${dig}, ${dig}, 'MINUTES-36-2', false, true, ${oldSeal}, now()
      );
    `);

    // Verify editorial_session_revocations does NOT exist in 0036
    const tableCheckBefore = await dbInst.db.execute<{ count: string }>(sql`
      SELECT count(*) as count FROM information_schema.tables WHERE table_name = 'editorial_session_revocations';
    `);
    assert.equal(parseInt(tableCheckBefore.rows[0]?.count ?? "0", 10), 0, "editorial_session_revocations must not exist prior to 0037");

    // Apply forward migration to 0037
    const v37Result = await migrateDb(dbInst.db, { migrationsFolder: realMigrationsDir });
    assert.equal(v37Result.applied, true, "MIG-07: Forward migration 0036 -> 0037 must succeed");

    // ---- MIG-08: Confirm that Drizzle migration journal records migration 0037 ----
    const journalCheck = await dbInst.db.execute<{ count: string }>(sql`
      SELECT count(*) as count FROM drizzle.__drizzle_migrations;
    `);
    assert.ok(parseInt(journalCheck.rows[0]?.count ?? "0", 10) >= 38, "MIG-08: Migration journal must record all migrations including 0037");

    // Verify editorial_session_revocations exists post-0037
    const tableCheckAfter = await dbInst.db.execute<{ count: string }>(sql`
      SELECT count(*) as count FROM information_schema.tables WHERE table_name = 'editorial_session_revocations';
    `);
    assert.equal(parseInt(tableCheckAfter.rows[0]?.count ?? "0", 10), 1, "editorial_session_revocations must exist after 0037");

    // ---- MIG-09: Existing audit rows remain present and correctly classified ----
    const postMigRows = await dbInst.db.execute<{
      id: string;
      verification_seal: string | null;
      seal_key_id: string | null;
      seal_status: string;
      revoked: boolean;
    }>(sql`
      SELECT id, verification_seal, seal_key_id, seal_status, revoked
      FROM editorial_approval_audit_events
      WHERE id IN (${hist0036SealedId}, ${hist0036RevokedId})
      ORDER BY id;
    `);
    assert.equal(postMigRows.rows.length, 2, "MIG-09: Both historical rows must remain present");
    const rSealed = postMigRows.rows.find((r) => r.id === hist0036SealedId)!;
    const rRevoked = postMigRows.rows.find((r) => r.id === hist0036RevokedId)!;
    assert.equal(rSealed.seal_status, "SEALED");
    assert.equal(rRevoked.revoked, true);

    // Verify immutability trigger works on 0037: attempting to delete or mutate protected fields fails
    await assert.rejects(
      async () => {
        await dbInst.db.execute(sql`DELETE FROM editorial_approval_audit_events WHERE id = ${hist0036SealedId}`);
      },
      (err: any) => {
        assert.match(String(err.cause?.message || err.message), /DELETE is prohibited/i);
        return true;
      },
      "MIG-09: Append-only protection must prevent DELETE post-migration",
    );

    // ---- MIG-10: Historical unsigned records cannot confer production authority ----
    const legacyRowId = `evt-legacy-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO editorial_approval_audit_events (
        id, project_id, page_identity, actor_id, actor_role, review_action,
        content_digest, claim_set_digest, source_evidence_set_digest, audit_event_reference,
        is_synthetic, revoked, verification_seal, seal_key_id, seal_status
      ) VALUES (
        ${legacyRowId}, ${prjId}, 'locations/chamonix', 'legacy-actor', 'EDITOR', 'APPROVED',
        ${dig}, ${dig}, ${dig}, 'MINUTES-LEGACY', false, false, NULL, NULL, 'LEGACY_UNSEALED'
      );
    `);

    const auditStore = EditorialAuditStore.getInstance(dbInst.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));
    const legacyEvent = await auditStore.getApprovalAuditEvent(legacyRowId, dbInst.db);
    assert.ok(legacyEvent);
    assert.equal(legacyEvent.sealStatus, "LEGACY_UNSEALED");
    assert.equal(legacyEvent.sealVerified, false, "MIG-10: LEGACY_UNSEALED must never be marked sealVerified: true");

    // ---- MIG-11: New signed approvals after migration remain verifiable across process restart ----
    const workerRes = runWorker("record-approval", {
      databaseUrl: TEST_DATABASE_URL,
      projectId: prjId,
      pageIdentity: "locations/chamonix",
      actorId: "actor-mig11",
      contentDigest: dig,
      claimSetDigest: dig,
      sourceEvidenceSetDigest: dig,
      verifiedClaimIds: ["c1"],
    });
    assert.equal(workerRes.ok, true, "MIG-11: New approval write must succeed");
    assert.equal(workerRes.sealVerified, true, "MIG-11: New approval must be cryptographically sealed and verified");
    assert.equal(workerRes.sealStatus, "SEALED");

    // Read back in separate process worker
    const verifyWorker = runWorker("verify-audit-event", {
      databaseUrl: TEST_DATABASE_URL,
      eventId: workerRes.reviewEventId,
    });
    assert.equal(verifyWorker.ok, true);
    assert.equal(verifyWorker.sealVerified, true, "MIG-11: Verification must hold across process restart");

    // ---- MIG-12: Upgrade does not require deleting or resetting the existing database ----
    const prjCheck = await dbInst.db.execute<{ id: string }>(sql`
      SELECT id FROM projects WHERE id = ${prjId};
    `);
    assert.equal(prjCheck.rows.length, 1, "MIG-12: Existing project must be preserved without DB reset");
  } finally {
    await rm(v36Dir, { recursive: true, force: true });
    await dbInst.close();
    // Ensure clean state for next tests
    const cleanup = await setupMigratedTestDatabase();
    await cleanup.close();
  }
});

// ---------------------------------------------------------------------------
// BLOCK 3: STALE-01 through STALE-12 (Source & Claim Staleness Gaps)
// ---------------------------------------------------------------------------

test("STALE-01 through STALE-06: Full authority chain staleness and historical isolation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seeded = await seedSutherlandProject(dbInst, `stale-${Date.now()}`);
  const trustStore = new TrustGovernanceStore(dbInst.db, { repoRoot });
  const prodStore = new ProductionStore(dbInst.db, { repoRoot });

  try {
    const pageSlug = "locations/chamonix";
    const contentDigest = "c".repeat(64);

    // Seed intent authority
    await trustStore.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: pageSlug,
        primaryIntent: "Chamonix investment guide",
        secondaryIntents: [],
        primaryQueryCluster: "chamonix property",
        secondaryQueryClusters: [],
        contentGapPurpose: "Advisory",
        siteRole: "Location",
        targetAudience: "Buyers",
        mainUserTask: "Evaluate market",
        primaryConversionAction: "Consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE",
        internalLinksOut: [],
      },
    });

    const inseeRegistry = loadInseeEvidenceRegistry(repoRoot);
    const snap2022 = inseeRegistry.snapshots.find((s: any) => s.geoCode === "74056" && s.reportingYear === 2022)!;

    // Base claim binding
    const baseClaims: ClaimLineage[] = [
      {
        claimId: "clm-cham-1",
        pageIdentity: pageSlug,
        claimType: "SOURCE_DERIVED_FACT",
        claimText: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units according to official INSEE census records.",
        limitation: "Limited to census housing count.",
        sourceRefs: [
          {
            ref: "INSEE RP2022 Chamonix",
            sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
            canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
            datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            supportingExcerpt: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units",
            tier: "TIER_A",
            sourceDate: "2025-07-01",
            freshnessBasis: "observation_date",
            entailment: "SUPPORTED",
            evidenceBindings: [
              {
                kind: "table_fact",
                geoCode: "74056",
                reportingYear: 2022,
                tableId: "LOG T1",
                rowKey: "Ensemble",
                columnKey: "2022",
                value: 14538,
                unit: "dwellings",
              },
            ],
            acquisitionProvenance: {
              acquisitionEventId: "acq-1",
              trustedProviderId: "insee",
              acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
              retrievedAt: "2026-09-01T10:00:00Z",
              contentDigest: snap2022.rawContentDigest,
              signatureOrReceipt: "REC-1",
              canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
              datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            },
          },
        ],
      },
    ];

    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claims: baseClaims,
    });

    const initialClaimSetDigest = computeClaimSetDigest(baseClaims);
    const initialSourceDigest = computeSourceEvidenceSetDigest({ inseeEvidence: inseeRegistry });
    const initialPageSource = computePageSourceEvidenceDigest({ claims: baseClaims, inseeEvidence: inseeRegistry });
    assert.equal(initialPageSource.problems.length, 0, "Initial Chamonix evidence must have 0 problems");

    // Record verified human review
    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const token = harness.issueSignedSession({
      actorId: "stale-editor",
      actorName: "Stale Test Editor",
      actorRole: "EDITORIAL_BOARD",
    });
    const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
    await membership.grantMembership(seeded.projectId, "stale-editor", ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);

    const auditStore = EditorialAuditStore.getInstance(dbInst.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));
    const reviewService = new EditorialReviewService(trustStore, harness.adapter, membership, auditStore);

    await reviewService.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest: initialClaimSetDigest,
      sourceEvidenceSetDigest: initialSourceDigest,
      pageSourceEvidenceDigest: initialPageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Initial authentic review",
      sessionToken: token,
      reviewerRef: "stale-editor",
      reviewerExpertise: "Alpine Editor",
      reviewAction: "APPROVED",
    });

    // Check initial freshness
    const initialCheck = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      initialSourceDigest,
      initialPageSource.digest,
    );
    assert.equal(initialCheck.stale, false, "Initial review must be fresh");

    // ---- STALE-01: Changed authenticated source digest -> STALE ----
    const mutatedSourceDigest = "d".repeat(64);
    const stale01 = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      mutatedSourceDigest,
      initialPageSource.digest,
    );
    assert.equal(stale01.stale, true, "STALE-01: Changed source evidence digest must cause review staleness");
    assert.match(stale01.reason!, /source evidence/i);

    // ---- STALE-02: Same HTML but changed claim-set evidence -> STALE ----
    const mutatedClaims: ClaimLineage[] = [
      {
        ...baseClaims[0]!,
        limitation: "Altered limitation changing canonical claim-set hash",
      },
    ];
    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claims: mutatedClaims,
    });
    const mutatedClaimSetDigest = computeClaimSetDigest(mutatedClaims);

    const stale02 = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      mutatedClaimSetDigest,
      initialSourceDigest,
      initialPageSource.digest,
    );
    assert.equal(stale02.stale, true, "STALE-02: Changed claim-set digest must cause review staleness");
    assert.match(stale02.reason!, /claim lineage/i);

    // Restore claims for subsequent tests
    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claims: baseClaims,
    });

    // ---- STALE-03: Previously accepted numerical analysis with changed material inputs -> STALE ----
    const workProductRecord: OriginalValueRecord = {
      schemaVersion: "trust-governance-v1",
      pageIdentity: pageSlug,
      kind: "original_calculation",
      description: "Net equity yield model for Chamonix",
      lineageClaimId: "clm-cham-1",
      verifiableAnchors: ["7.2% net initial yield", "14,538 total housing units"],
      workProductId: "wp-cham-yield",
      workProduct: {
        workProductId: "wp-cham-yield",
        pageIdentity: pageSlug,
        productType: "COMPUTATIONAL_MODEL",
        title: "Chamonix Alpine Yield Model",
        description: "Deterministic yield model",
        inputDatasetDigests: ["1".repeat(64), "2".repeat(64)],
        transformationId: "alpine-gross-yield-v1",
        transformationDigest: "3".repeat(64),
        executionHash: "4".repeat(64),
        outputArtifactRef: "models/chamonix-yield.json",
        reproducibleCommand: "tsx models/run.ts",
        verifiableAnchors: ["7.2% net initial yield", "14,538 total housing units"],
        provenance: "Sutherland Private Office Research",
      },
    };
    await trustStore.saveOriginalValue({
      projectId: seeded.projectId,
      record: workProductRecord,
    });

    const initialWorkProductDigest = computeWorkProductSetDigest([workProductRecord]);

    // Record review binding workProductSetDigest
    await reviewService.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest: initialClaimSetDigest,
      sourceEvidenceSetDigest: initialSourceDigest,
      pageSourceEvidenceDigest: initialPageSource.digest,
      workProductSetDigest: initialWorkProductDigest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Review with work product binding",
      sessionToken: token,
      reviewerRef: "stale-editor",
      reviewerExpertise: "Alpine Editor",
      reviewAction: "APPROVED",
    });

    // Mutate numerical analysis inputs
    const mutatedWorkProduct: OriginalValueRecord = {
      ...workProductRecord,
      workProduct: {
        ...workProductRecord.workProduct!,
        inputDatasetDigests: ["1".repeat(64), "9".repeat(64)], // mutated input
        executionHash: "8".repeat(64),
      },
    };
    await trustStore.saveOriginalValue({
      projectId: seeded.projectId,
      record: mutatedWorkProduct,
    });
    const mutatedWpDigest = computeWorkProductSetDigest([mutatedWorkProduct]);

    const stale03 = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      initialSourceDigest,
      initialPageSource.digest,
      mutatedWpDigest,
    );
    assert.equal(stale03.stale, true, "STALE-03: Mutated work product inputs must cause review staleness");
    assert.match(stale03.reason!, /OriginalWorkProduct inputs/i);

    // ---- STALE-04: Review event digest matches an old review but not candidate's current evidence -> BLOCKED ----
    const stale04 = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      "mismatched-claim-digest-04".padEnd(64, "0"),
      initialSourceDigest,
      initialPageSource.digest,
    );
    assert.equal(stale04.stale, true, "STALE-04: Review matching old digests must be blocked against current candidate evidence");

    // ---- STALE-05: An unrelated source changes -> unaffected page remains valid ----
    // Page Chamonix only references geoCode "74056"
    // Mutate unrelated Megève snapshot in insee registry
    const mutatedInseeRegistry: InseeEvidenceRegistry = {
      ...inseeRegistry,
      snapshots: inseeRegistry.snapshots.map((s: any) =>
        s.geoCode === "74173" // Megève
          ? { ...s, rawContentDigest: "9".repeat(64) }
          : s,
      ),
    };
    const chamPageSource = computePageSourceEvidenceDigest({
      claims: baseClaims,
      inseeEvidence: mutatedInseeRegistry,
    });

    assert.equal(chamPageSource.problems.length, 0, "STALE-05: Unrelated Megève mutation must not cause problems for Chamonix");
    const chamRev = await trustStore.latestReview(seeded.projectId, pageSlug);
    assert.ok(chamRev);
    // Page-scoped digest for Chamonix is unchanged!
    assert.equal(chamPageSource.digest, chamRev.pageSourceEvidenceDigest);

    // ---- STALE-06: Historical INSEE 2022 statistic remains historical after arrival of 2023 series ----
    const augmentedInseeRegistry: InseeEvidenceRegistry = {
      ...inseeRegistry,
      snapshots: [
        ...inseeRegistry.snapshots,
        {
          sourceId: "insee-74056-2023",
          sourceOrigin: "EXTERNAL_ACQUIRED",
          originalUrl: "https://www.insee.fr/fr/statistiques/2023?geo=COM-74056",
          publisher: "INSEE",
          documentTitle: "INSEE Logement 2023",
          geoCode: "74056",
          reportingYear: 2023,
          rawContentDigest: "2023".repeat(16),
          storedEvidenceLocation: "insee/74056-2023.html",
          contentType: "text/html",
        },
      ],
    };

    const histCheck = computePageSourceEvidenceDigest({
      claims: baseClaims,
      inseeEvidence: augmentedInseeRegistry,
    });

    assert.equal(histCheck.problems.length, 0, "STALE-06: 2022 historical claim must not be invalidated by arrival of 2023 series");
  } finally {
    await dbInst.close();
  }
});

test("STALE-07 through STALE-12: Fail-closed behavior on missing evidence, source unavailability, and non-YMYL policy", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seeded = await seedSutherlandProject(dbInst, `stale7-${Date.now()}`);
  const testKeyring = new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" });
  const auditStore = EditorialAuditStore.getInstance(dbInst.db, testKeyring);
  const trustStore = new TrustGovernanceStore(dbInst.db, { repoRoot, keyring: testKeyring, auditStore });
  const prodStore = new ProductionStore(dbInst.db, { repoRoot, keyring: testKeyring });
  const pageSlug = "locations/chamonix";
  const route = "/locations/chamonix";
  let rootDir: string | undefined;

  try {
    // Intent authority: YMYL_DECISION_SUPPORT
    await trustStore.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: pageSlug,
        primaryIntent: "Chamonix investment guide",
        secondaryIntents: [],
        primaryQueryCluster: "chamonix property",
        secondaryQueryClusters: [],
        contentGapPurpose: "Advisory",
        siteRole: "Location",
        targetAudience: "Buyers",
        mainUserTask: "Evaluate market",
        primaryConversionAction: "Consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE",
        internalLinksOut: [],
      },
    });

    const page = await acceptFixturePage(dbInst, seeded.projectId, pageSlug);
    const contentDigest = page.contentDigest;

    // Load authentic evidence
    const inseeRegistry = loadInseeEvidenceRegistry(repoRoot);
    const baseClaims: ClaimLineage[] = [
      {
        claimId: "clm-cham-1",
        pageIdentity: pageSlug,
        claimType: "SOURCE_DERIVED_FACT",
        claimText: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units according to official INSEE census records.",
        limitation: "Limited to census housing count.",
        sourceRefs: [
          {
            ref: "INSEE RP2022 Chamonix",
            sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
            canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
            datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            supportingExcerpt: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units",
            tier: "TIER_A",
            sourceDate: "2025-07-01",
            freshnessBasis: "observation_date",
            entailment: "SUPPORTED",
            evidenceBindings: [
              {
                kind: "table_fact",
                geoCode: "74056",
                reportingYear: 2022,
                tableId: "LOG T1",
                rowKey: "Ensemble",
                columnKey: "2022",
                value: 14538,
                unit: "dwellings",
              },
            ],
            acquisitionProvenance: {
              acquisitionEventId: "acq-1",
              trustedProviderId: "insee",
              acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
              retrievedAt: "2026-09-01T10:00:00Z",
              contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
              signatureOrReceipt: "REC-1",
              canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
              datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            },
          },
        ],
      },
    ];

    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claims: baseClaims,
    });

    const workProductRecord: OriginalValueRecord = {
      schemaVersion: "trust-governance-v1",
      pageIdentity: pageSlug,
      kind: "original_calculation",
      description: "Net equity yield model for Chamonix",
      lineageClaimId: "clm-cham-1",
      verifiableAnchors: ["7.2% net initial yield", "14,538 total housing units"],
      workProductId: "wp-cham-yield",
      workProduct: {
        workProductId: "wp-cham-yield",
        pageIdentity: pageSlug,
        productType: "COMPUTATIONAL_MODEL",
        title: "Chamonix Alpine Yield Model",
        description: "Deterministic yield model",
        inputDatasetDigests: [inseeRegistry.snapshots[0]!.rawContentDigest],
        transformationId: "alpine-gross-yield-v1",
        transformationDigest: "3".repeat(64),
        executionHash: computeWorkProductExecutionHash({
          productType: "COMPUTATIONAL_MODEL",
          inputDatasetDigests: [inseeRegistry.snapshots[0]!.rawContentDigest],
          transformationDigest: "3".repeat(64),
        }),
        outputArtifactRef: "models/chamonix-yield.json",
        reproducibleCommand: "tsx models/run.ts",
        verifiableAnchors: ["7.2% net initial yield", "14,538 total housing units"],
        provenance: "Sutherland Private Office Research",
      },
    };
    await trustStore.saveOriginalValue({
      projectId: seeded.projectId,
      record: workProductRecord,
    });

    const initialEv = await trustStore.currentPageEvidence(seeded.projectId, pageSlug, contentDigest);
    assert.equal(initialEv.pageSourceInfo.problems.length, 0, "Initial Chamonix evidence must have 0 problems");
    const initialClaimSetDigest = initialEv.claimSetDigest!;
    const initialSourceDigest = initialEv.sourceEvidenceSetDigest!;
    const initialPageSource = initialEv.pageSourceInfo;
    const initialWorkProductDigest = initialEv.workProductSetDigest!;

    // Live asset setup
    rootDir = await mkdtemp(path.join(tmpdir(), "stale-live-"));
    const assetsModule = await import("../../src/assets/service.js");
    const assetStorageModule = await import("../../src/assets/storage.js");
    const sharp = (await import("sharp")).default;
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      storage: assetStorageModule.createAssetStorage(rootDir),
    });
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(seeded.projectId, {
      filename: "hero.jpg",
      kind: "photo",
      title: "Hero",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
    });
    const approved = await assets.approveVersion(seeded.projectId, upload.version.id, upload.version.binaryDigest);

    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seeded.projectId, schemaVersion: "design-v1" });
    const fixtureData = candidateData(pageSlug);
    const liveData = parseDesignCandidateData({ ...fixtureData, providerMode: "live", providerProjectName: "projects/live" });
    const candidate = await designStore.createCandidate({ projectId: seeded.projectId, inputSnapshot: snapshot, data: liveData });
    await dbInst.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
    const acceptedDesign = await designStore.acceptCandidate({
      projectId: seeded.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "live acceptance",
    });

    const visualStore = new VisualStore(dbInst.db);
    const planId = `vap-stale-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
      VALUES (${planId}, ${seeded.projectId}, 1, ${acceptedDesign.id}, ${acceptedDesign.version}, ${acceptedDesign.candidateDigest}, ${acceptedDesign.inputDigest}, 'live', '[]'::jsonb, ${"c".repeat(64)})
    `);
    await visualStore.createAcceptedSetAtomic({
      projectId: seeded.projectId,
      planId,
      providerMode: "live",
      designArtifactId: acceptedDesign.id,
      designArtifactVersion: acceptedDesign.version,
      designCandidateDigest: acceptedDesign.candidateDigest,
      designInputDigest: acceptedDesign.inputDigest,
      slots: [
        {
          slot: "hero.primary",
          pageSlug,
          role: "hero",
          resolvedVersionId: approved.id,
          binaryDigest: approved.binaryDigest,
          governanceDigest: approved.governanceDigest!,
          resolutionMode: "reuse_real",
          truthClass: "illustrative",
        },
      ],
    });

    const actorId = "stale-editor-7";
    const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
    await membership.grantMembership(seeded.projectId, actorId, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);
    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta", dbInst.db);
    const token = harness.issueSignedSession({
      actorId,
      actorName: "Stale Editor 7",
      actorRole: "EDITORIAL_BOARD",
    });
    const auditStore = EditorialAuditStore.getInstance(dbInst.db, new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" }));
    const service = new EditorialReviewService(trustStore, harness.adapter, membership, auditStore);

    const initialApproval = await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest: initialClaimSetDigest,
      sourceEvidenceSetDigest: initialSourceDigest,
      pageSourceEvidenceDigest: initialPageSource.digest,
      workProductSetDigest: initialWorkProductDigest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Initial authentic YMYL review",
      sessionToken: token,
      reviewerRef: actorId,
      reviewerExpertise: "Lead Reviewer",
      reviewAction: "APPROVED",
    });

    // Derive production input and create candidate
    const pInput = await prodStore.deriveProductionInput({
      projectId: seeded.projectId,
      pageSlug,
      siteIdentity: { siteId: "site-1", siteName: "Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "0".repeat(64) },
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });

    const repoSha = "1".repeat(40);
    const lockfileDig = "2".repeat(64);
    const manifestSetDig = "3".repeat(64);
    const redirectDig = deterministicDigest({ projectId: seeded.projectId, rules: [] });

    const prodCandidate = await prodStore.createCandidate({
      projectId: seeded.projectId,
      productionInputId: pInput.id,
      currentEnvironment: {
        siteProfileDigest: "0".repeat(64),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      },
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
    });

    await prodStore.recordBuild({
      projectId: seeded.projectId,
      candidateId: prodCandidate.id,
      artifactDigest: "a".repeat(64),
      artifactRef: "/tmp/dist",
      assetReferences: [],
      manifestSetDigest: manifestSetDig,
      candidateInputs: [
        {
          productionInputId: pInput.id,
          productionInputVersion: pInput.version,
          productionInputDigest: pInput.inputDigest,
          pageIdentity: pInput.pageIdentity,
          route: pInput.route,
          manifestDigest: "5".repeat(64),
        },
      ],
      redirectRules: [],
      redirectSnapshotDigest: redirectDig,
    });

    const passingChecks: ProductionQaCheckResult[] = [
      ...REQUIRED_PRODUCTION_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : gate.scope === "site" ? manifestSetDig : repoSha;
        const group = gate.checkId.split(".")[0] as ProductionQaCheckResult["group"];
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
      ...REQUIRED_TRUST_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : manifestSetDig;
        const group = "content" as const;
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
    ];

    for (const check of passingChecks.filter((c) => TRUSTED_PRODUCTION_QA_GATES.some((g: any) => g.checkId === c.checkId))) {
      await prodStore.recordTrustedQaEvidence({
        projectId: seeded.projectId,
        candidateId: prodCandidate.id,
        check,
        artifactDigest: "a".repeat(64),
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
      });
    }

    // Verify initial candidate input is fresh
    const initStale = await prodStore.inputStaleness(pInput);
    assert.equal(initStale.stale, false, "Initial input must be fresh");

    // ---- STALE-07: Approved YMYL page loses all its ClaimLineage records while HTML stays unchanged -> STALE / BLOCKED ----
    await dbInst.db.execute(sql`DELETE FROM claim_lineage_records WHERE project_id = ${seeded.projectId} AND page_identity = ${pageSlug}`);

    // Check inputStaleness directly: must fail closed because verifiedClaimIds existed on the review
    const stale07Input = await prodStore.inputStaleness(pInput);
    assert.equal(stale07Input.stale, true, "STALE-07: inputStaleness must be stale when all claims are removed");

    // Check through persisted candidate QA path: must fail closed and reject with production_authority_stale
    await assert.rejects(
      async () => {
        await prodStore.recordQaRun({
          projectId: seeded.projectId,
          candidateId: prodCandidate.id,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_authority_stale/);
        return true;
      },
      "STALE-07: QA overall must be BLOCKED when claims disappear",
    );

    // Restore claims for STALE-08
    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claims: baseClaims,
    });
    await dbInst.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${prodCandidate.id}`);

    // ---- STALE-08: Previously approved OriginalWorkProduct records are removed -> STALE / BLOCKED ----
    await dbInst.db.execute(sql`DELETE FROM original_value_records WHERE project_id = ${seeded.projectId} AND page_identity = ${pageSlug}`);

    const stale08Check = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      initialSourceDigest,
      initialPageSource.digest,
      undefined, // workProductSetDigest now undefined / missing
    );
    assert.equal(stale08Check.stale, true, "STALE-08: currentReview must be stale when approved work products are removed");
    assert.match(stale08Check.reason!, /OriginalWorkProduct/);

    const stale08Input = await prodStore.inputStaleness(pInput);
    assert.equal(stale08Input.stale, true, "STALE-08: inputStaleness must be stale when work products are missing");

    await assert.rejects(
      async () => {
        await prodStore.recordQaRun({
          projectId: seeded.projectId,
          candidateId: prodCandidate.id,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_authority_stale/);
        return true;
      },
      "STALE-08: QA must be BLOCKED when work products disappear",
    );

    // Restore work product for STALE-09
    await trustStore.saveOriginalValue({
      projectId: seeded.projectId,
      record: workProductRecord,
    });
    await dbInst.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${prodCandidate.id}`);

    // ---- STALE-09: Current source registry becomes unavailable after a real approval -> BLOCKED ----
    const emptyInseeRegistry: InseeEvidenceRegistry = {
      facts: [],
      rejected: [],
      snapshots: [],
    };
    const prodStoreUnavailable = new ProductionStore(dbInst.db, {
      repoRoot,
      inseeEvidence: emptyInseeRegistry,
      keyring: testKeyring,
    });

    const stale09Input = await prodStoreUnavailable.inputStaleness(pInput);
    assert.equal(stale09Input.stale, true, "STALE-09: Missing/empty source evidence registry must fail closed as stale");

    await assert.rejects(
      async () => {
        await prodStoreUnavailable.recordQaRun({
          projectId: seeded.projectId,
          candidateId: prodCandidate.id,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_authority_stale/);
        return true;
      },
      "STALE-09: QA must be BLOCKED when source registry is unavailable",
    );

    // ---- STALE-10: One required page-source digest becomes undefined -> BLOCKED ----
    const stale10Check = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      initialSourceDigest,
      undefined, // pageSourceEvidenceDigest explicitly undefined
      initialWorkProductDigest,
    );
    assert.equal(stale10Check.stale, true, "STALE-10: Missing pageSourceEvidenceDigest must cause staleness");
    assert.match(stale10Check.reason!, /page[- ]bound source evidence|page source evidence/i);

    // ---- STALE-11: Legitimate non-YMYL page with no requirement for those evidence types remains valid under its explicit policy ----
    const nonYmylSlug = "about";
    await trustStore.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: nonYmylSlug,
        primaryIntent: "Company background",
        secondaryIntents: [],
        primaryQueryCluster: "sutherland agency",
        secondaryQueryClusters: [],
        contentGapPurpose: "About",
        siteRole: "About",
        targetAudience: "General",
        mainUserTask: "Read",
        primaryConversionAction: "None",
        ymylClassification: "NON_YMYL",
        decisionRole: "INFORMATIONAL_RESEARCH",
        internalLinksOut: [],
      },
    });

    const nonYmylContentDigest = "f".repeat(64);
    const nonYmylClaimDigest = computeClaimSetDigest([]);
    const nonYmylSourceDigest = computeSourceEvidenceSetDigest({});
    await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: nonYmylSlug,
      contentDigest: nonYmylContentDigest,
      claimSetDigest: nonYmylClaimDigest,
      sourceEvidenceSetDigest: nonYmylSourceDigest,
      note: "Non-YMYL about page review",
      sessionToken: token,
      reviewerRef: actorId,
      reviewerExpertise: "Editor",
      reviewAction: "APPROVED",
    });

    const nonYmylCheck = await trustStore.currentReview(
      seeded.projectId,
      nonYmylSlug,
      nonYmylContentDigest,
      nonYmylClaimDigest,
      nonYmylSourceDigest,
      undefined,
      undefined,
    );
    assert.equal(nonYmylCheck.stale, false, "STALE-11: Legitimate non-YMYL page without evidence requirements must remain valid");

    // ---- STALE-12: Restoring correct evidence does not resurrect a revoked approval ----
    await auditStore.revokeApprovalAuditEvent(initialApproval.approvalEvent!.reviewEventId, dbInst.db);

    const stale12Check = await trustStore.currentReview(
      seeded.projectId,
      pageSlug,
      contentDigest,
      initialClaimSetDigest,
      initialSourceDigest,
      initialPageSource.digest,
      initialWorkProductDigest,
      true, // verify backing authority
    );
    assert.equal(stale12Check.stale, true, "STALE-12: Restoring perfect evidence must NOT resurrect revoked approval");
    assert.match(stale12Check.reason!, /revoked/i);
  } finally {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
    await dbInst.close();
  }
});

// ---------------------------------------------------------------------------
// BLOCK 4: SEQ-01..05 & RACE-06..10 (QA Approval Concurrency & Race Gaps)
// ---------------------------------------------------------------------------

test("SEQ-01 through SEQ-05: Sequential revocation and tampering under advisory locks", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seeded = await seedSutherlandProject(dbInst, `race-${Date.now()}`);
  const testKeyring = new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" });
  const auditStore = EditorialAuditStore.getInstance(dbInst.db, testKeyring);
  const trustStore = new TrustGovernanceStore(dbInst.db, { repoRoot, keyring: testKeyring, auditStore });
  const prodStore = new ProductionStore(dbInst.db, { repoRoot, keyring: testKeyring });
  const membershipAuth = ProjectMembershipAuthority.getInstance(dbInst.db);

  let rootDir: string | undefined;
  try {
    const pageSlug = "home";
    const route = "/home";
    const repoSha = "1".repeat(40);
    const lockfileDig = "2".repeat(64);
    const manifestSetDig = "3".repeat(64);
    const redirectDig = deterministicDigest({ projectId: seeded.projectId, rules: [] });

    // Set page intent authority
    await trustStore.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: pageSlug,
        primaryIntent: "Homepage",
        secondaryIntents: [],
        primaryQueryCluster: "alpine property",
        secondaryQueryClusters: [],
        contentGapPurpose: "Entry",
        siteRole: "Home",
        targetAudience: "Buyers",
        mainUserTask: "Explore",
        primaryConversionAction: "Inquire",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });

    // Accept genuine fixture page content
    const page = await acceptFixturePage(dbInst, seeded.projectId, pageSlug);
    const contentDigest = page.contentDigest;

    // Set up live asset, design, and visual set to satisfy inputStaleness
    rootDir = await mkdtemp(path.join(tmpdir(), "race-live-"));
    const assetsModule = await import("../../src/assets/service.js");
    const assetStorageModule = await import("../../src/assets/storage.js");
    const sharp = (await import("sharp")).default;
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      storage: assetStorageModule.createAssetStorage(rootDir),
    });
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(seeded.projectId, {
      filename: "hero.jpg",
      kind: "photo",
      title: "Hero",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
    });
    const approved = await assets.approveVersion(seeded.projectId, upload.version.id, upload.version.binaryDigest);

    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seeded.projectId, schemaVersion: "design-v1" });
    const fixtureData = candidateData(pageSlug);
    const liveData = parseDesignCandidateData({ ...fixtureData, providerMode: "live", providerProjectName: "projects/live" });
    const candidate = await designStore.createCandidate({ projectId: seeded.projectId, inputSnapshot: snapshot, data: liveData });
    await dbInst.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
    const acceptedDesign = await designStore.acceptCandidate({
      projectId: seeded.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "live acceptance (race authority)",
    });

    const visualStore = new VisualStore(dbInst.db);
    const planId = `vap-race-${Date.now()}`;
    await dbInst.db.execute(sql`
      INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
      VALUES (${planId}, ${seeded.projectId}, 1, ${acceptedDesign.id}, ${acceptedDesign.version}, ${acceptedDesign.candidateDigest}, ${acceptedDesign.inputDigest}, 'live', '[]'::jsonb, ${"c".repeat(64)})
    `);
    const acceptedSet = await visualStore.createAcceptedSetAtomic({
      projectId: seeded.projectId,
      planId,
      providerMode: "live",
      designArtifactId: acceptedDesign.id,
      designArtifactVersion: acceptedDesign.version,
      designCandidateDigest: acceptedDesign.candidateDigest,
      designInputDigest: acceptedDesign.inputDigest,
      slots: [
        {
          slot: "hero.primary",
          pageSlug,
          role: "hero",
          resolvedVersionId: approved.id,
          binaryDigest: approved.binaryDigest,
          governanceDigest: approved.governanceDigest!,
          resolutionMode: "reuse_real",
          truthClass: "illustrative",
        },
      ],
    });

    const input = await prodStore.deriveProductionInput({
      projectId: seeded.projectId,
      pageSlug,
      siteIdentity: { siteId: "site-1", siteName: "Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "0".repeat(64) },
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(input.route, route);

    const prodCandidate = await prodStore.createCandidate({
      projectId: seeded.projectId,
      productionInputId: input.id,
      currentEnvironment: {
        siteProfileDigest: "0".repeat(64),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      },
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
    });

    await prodStore.recordBuild({
      projectId: seeded.projectId,
      candidateId: prodCandidate.id,
      artifactDigest: "a".repeat(64),
      artifactRef: "/tmp/dist",
      assetReferences: [],
      manifestSetDigest: manifestSetDig,
      candidateInputs: [
        {
          productionInputId: input.id,
          productionInputVersion: input.version,
          productionInputDigest: input.inputDigest,
          pageIdentity: input.pageIdentity,
          route: input.route,
          manifestDigest: "5".repeat(64),
        },
      ],
      redirectRules: [],
      redirectSnapshotDigest: redirectDig,
    });

    const candId = prodCandidate.id;
    const inputId = input.id;

    // Claims and source evidence for the review
    const inseeRegistry = loadInseeEvidenceRegistry(repoRoot);
    const sourceEvidenceSetDigest = computeSourceEvidenceSetDigest({ inseeEvidence: inseeRegistry });
    const raceClaims: ClaimLineage[] = [
      {
        claimId: "clm-cham-1",
        pageIdentity: pageSlug,
        claimType: "SOURCE_DERIVED_FACT",
        claimText: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units according to official INSEE census records.",
        limitation: "Limited to census housing count.",
        sourceRefs: [
          {
            ref: "INSEE RP2022 Chamonix",
            sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
            canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
            datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            supportingExcerpt: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units",
            tier: "TIER_A",
            sourceDate: "2025-07-01",
            freshnessBasis: "observation_date",
            entailment: "SUPPORTED",
            evidenceBindings: [
              {
                kind: "table_fact",
                geoCode: "74056",
                reportingYear: 2022,
                tableId: "LOG T1",
                rowKey: "Ensemble",
                columnKey: "2022",
                value: 14538,
                unit: "dwellings",
              },
            ],
            acquisitionProvenance: {
              acquisitionEventId: "acq-1",
              trustedProviderId: "insee",
              acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
              retrievedAt: "2026-09-01T10:00:00Z",
              contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
              signatureOrReceipt: "REC-1",
              canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
              datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            },
          },
        ],
      },
    ];

    const claimSetDigest = computeClaimSetDigest(raceClaims);
    const racePageSource = computePageSourceEvidenceDigest({ claims: raceClaims, inseeEvidence: inseeRegistry });
    assert.equal(racePageSource.problems.length, 0, "Race claims must have 0 problems against inseeRegistry");
    await trustStore.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claims: raceClaims,
    });

    // Authorize reviewer and record approval
    const actorId = "race-editor-1";
    await membershipAuth.grantMembership(seeded.projectId, actorId, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);
    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const token = harness.issueSignedSession({
      actorId,
      actorName: "Race Editor",
      actorRole: "EDITORIAL_BOARD",
    });

    const service = new EditorialReviewService(trustStore, harness.adapter, membershipAuth, auditStore);
    const approval = await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Initial race approval",
      sessionToken: token,
      reviewerRef: actorId,
      reviewerExpertise: "Lead Editor",
      reviewAction: "APPROVED",
    });

    // Generate complete passing QA checks (including TRUST gates)
    const passingChecks: ProductionQaCheckResult[] = [
      ...REQUIRED_PRODUCTION_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : gate.scope === "site" ? manifestSetDig : repoSha;
        const group = gate.checkId.split(".")[0] as ProductionQaCheckResult["group"];
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
      ...REQUIRED_TRUST_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : manifestSetDig;
        const group = "content" as const;
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
    ];

    // Record trusted QA evidence
    for (const check of passingChecks.filter((c) => TRUSTED_PRODUCTION_QA_GATES.some((g: any) => g.checkId === c.checkId))) {
      await prodStore.recordTrustedQaEvidence({
        projectId: seeded.projectId,
        candidateId: candId,
        check,
        artifactDigest: "a".repeat(64),
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
      });
    }

    // ---- SEQ-01: Revoke approval between evaluation and persistence -> Cannot become eligible ----
    // Revoke the approval
    await auditStore.revokeApprovalAuditEvent(approval.approvalEvent!.reviewEventId, dbInst.db);

    const race01Run = await prodStore.recordQaRun({
      projectId: seeded.projectId,
      candidateId: candId,
      checks: passingChecks,
      evaluatedArtifactDigest: "a".repeat(64),
      manifestSetDigest: manifestSetDig,
      redirectSnapshotDigest: redirectDig,
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
      pageRoutes: [route],
    });

    assert.equal(race01Run.overall, "FAIL", "SEQ-01: Revoked approval must make QA overall FAIL");
    const race01Data = race01Run.data as any;
    assert.equal(race01Data.provenance.publicationEligible, false, "SEQ-01: Cannot be publication eligible when approval revoked");
    assert.equal(race01Data.provenance.reviewAuthorityMode, "PENDING");
    const candAfter01 = await prodStore.getCandidate(seeded.projectId, candId);
    assert.equal(candAfter01!.state, "qa_failed");

    // ---- SEQ-02: Revoke reviewer membership concurrently with QA -> Ineligible ----
    // Reset candidate back to built and re-approve with new actor
    await dbInst.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);
    const actor2 = "race-editor-2";
    await membershipAuth.grantMembership(seeded.projectId, actor2, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);
    const token2 = harness.issueSignedSession({
      actorId: actor2,
      actorName: "Editor 2",
      actorRole: "EDITORIAL_BOARD",
    });
    await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Approval 2",
      sessionToken: token2,
      reviewerRef: actor2,
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });

    // Revoke reviewer membership
    await membershipAuth.revokeMembership(seeded.projectId, actor2, dbInst.db);

    const race02Run = await prodStore.recordQaRun({
      projectId: seeded.projectId,
      candidateId: candId,
      checks: passingChecks,
      evaluatedArtifactDigest: "a".repeat(64),
      manifestSetDigest: manifestSetDig,
      redirectSnapshotDigest: redirectDig,
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
      pageRoutes: [route],
    });

    assert.equal(race02Run.overall, "FAIL", "SEQ-02: Revoked membership must make QA overall FAIL");
    assert.equal((race02Run.data as any).provenance.publicationEligible, false);

    // ---- SEQ-03: Change source evidence while QA is executing -> Stale / blocked ----
    await dbInst.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);
    // Re-grant and re-approve
    await membershipAuth.grantMembership(seeded.projectId, actor2, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInst.db);
    await service.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Approval 3",
      sessionToken: token2,
      reviewerRef: actor2,
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });

    // Mutate source evidence digest in production page input
    await dbInst.db.execute(sql`UPDATE production_page_inputs SET accepted_content_digest = ${"f".repeat(64)} WHERE id = ${inputId}`);

    await assert.rejects(
      async () => {
        await prodStore.recordQaRun({
          projectId: seeded.projectId,
          candidateId: candId,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_authority_digest_mismatch|production_authority_stale/);
        return true;
      },
      "SEQ-03: Mutated input evidence must fail QA persistence",
    );

    // Restore input content digest
    await dbInst.db.execute(sql`UPDATE production_page_inputs SET accepted_content_digest = ${contentDigest} WHERE id = ${inputId}`);

    // ---- SEQ-04: Two concurrent QA attempts against the same candidate -> Deterministic state ----
    await dbInst.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);

    const [runA, runB] = await Promise.all([
      prodStore.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      }),
      prodStore.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      }),
    ]);

    assert.ok(runA.id && runB.id, "SEQ-04: Concurrent QA runs must serialize without deadlock");
    const finalCand = await prodStore.getCandidate(seeded.projectId, candId);
    assert.equal(finalCand!.state, "qa_passed");

    // ---- SEQ-05: Unchanged authorized evidence and valid current approval -> Successful pass ----
    assert.equal(runA.overall, "PASS");
    assert.equal((runA.data as any).provenance.publicationEligible, true, "SEQ-05: Valid approval and evidence must be publication eligible");
  } finally {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
    await dbInst.close();
  }
});

test("RACE-06 through RACE-10: Genuine concurrency with independent PostgreSQL connections and synchronization barriers", async () => {
  const dbInstA = await createTestDatabase();
  const dbInstB = await createTestDatabase();
  const seeded = await seedSutherlandProject(dbInstA, `race-real-${Date.now()}`);
  const testKeyring = new AuditSealKeyring({ keys: { v1: TEST_SEAL_KEY_V1 }, activeKeyId: "v1" });
  const auditStoreA = EditorialAuditStore.getInstance(dbInstA.db, testKeyring);
  const auditStoreB = EditorialAuditStore.getInstance(dbInstB.db, testKeyring);
  const trustStoreA = new TrustGovernanceStore(dbInstA.db, { repoRoot, keyring: testKeyring, auditStore: auditStoreA });
  const prodStoreA = new ProductionStore(dbInstA.db, { repoRoot, keyring: testKeyring });
  const prodStoreB = new ProductionStore(dbInstB.db, { repoRoot, keyring: testKeyring });
  const membershipAuthA = ProjectMembershipAuthority.getInstance(dbInstA.db);
  const membershipAuthB = ProjectMembershipAuthority.getInstance(dbInstB.db);

  let rootDir: string | undefined;
  try {
    const pageSlug = "home";
    const route = "/home";
    const repoSha = "1".repeat(40);
    const lockfileDig = "2".repeat(64);
    const manifestSetDig = "3".repeat(64);
    const redirectDig = deterministicDigest({ projectId: seeded.projectId, rules: [] });

    await trustStoreA.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: pageSlug,
        primaryIntent: "Homepage",
        secondaryIntents: [],
        primaryQueryCluster: "alpine property",
        secondaryQueryClusters: [],
        contentGapPurpose: "Entry",
        siteRole: "Home",
        targetAudience: "Buyers",
        mainUserTask: "Explore",
        primaryConversionAction: "Inquire",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });

    const page = await acceptFixturePage(dbInstA, seeded.projectId, pageSlug);
    const contentDigest = page.contentDigest;

    // Set up live asset, design, and visual set to satisfy inputStaleness
    rootDir = await mkdtemp(path.join(tmpdir(), "race-real-live-"));
    const assetsModule = await import("../../src/assets/service.js");
    const assetStorageModule = await import("../../src/assets/storage.js");
    const sharp = (await import("sharp")).default;
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInstA.db),
      storage: assetStorageModule.createAssetStorage(rootDir),
    });
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(seeded.projectId, {
      filename: "hero.jpg",
      kind: "photo",
      title: "Hero",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
    });
    const approved = await assets.approveVersion(seeded.projectId, upload.version.id, upload.version.binaryDigest);

    const designStore = new DesignStore(dbInstA.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seeded.projectId, schemaVersion: "design-v1" });
    const fixtureData = candidateData(pageSlug);
    const liveData = parseDesignCandidateData({ ...fixtureData, providerMode: "live", providerProjectName: "projects/live" });
    const candidate = await designStore.createCandidate({ projectId: seeded.projectId, inputSnapshot: snapshot, data: liveData });
    await dbInstA.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
    const acceptedDesign = await designStore.acceptCandidate({
      projectId: seeded.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "live acceptance (real concurrency)",
    });

    const visualStore = new VisualStore(dbInstA.db);
    const planId = `vap-race-real-${Date.now()}`;
    await dbInstA.db.execute(sql`
      INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
      VALUES (${planId}, ${seeded.projectId}, 1, ${acceptedDesign.id}, ${acceptedDesign.version}, ${acceptedDesign.candidateDigest}, ${acceptedDesign.inputDigest}, 'live', '[]'::jsonb, ${"c".repeat(64)})
    `);
    await visualStore.createAcceptedSetAtomic({
      projectId: seeded.projectId,
      planId,
      providerMode: "live",
      designArtifactId: acceptedDesign.id,
      designArtifactVersion: acceptedDesign.version,
      designCandidateDigest: acceptedDesign.candidateDigest,
      designInputDigest: acceptedDesign.inputDigest,
      slots: [
        {
          slot: "hero.primary",
          pageSlug,
          role: "hero",
          resolvedVersionId: approved.id,
          binaryDigest: approved.binaryDigest,
          governanceDigest: approved.governanceDigest!,
          resolutionMode: "reuse_real",
          truthClass: "illustrative",
        },
      ],
    });

    const input = await prodStoreA.deriveProductionInput({
      projectId: seeded.projectId,
      pageSlug,
      siteIdentity: { siteId: "site-1", siteName: "Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "0".repeat(64) },
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });

    const prodCandidate = await prodStoreA.createCandidate({
      projectId: seeded.projectId,
      productionInputId: input.id,
      currentEnvironment: {
        siteProfileDigest: "0".repeat(64),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      },
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
    });

    await prodStoreA.recordBuild({
      projectId: seeded.projectId,
      candidateId: prodCandidate.id,
      artifactDigest: "a".repeat(64),
      artifactRef: "/tmp/dist",
      assetReferences: [],
      manifestSetDigest: manifestSetDig,
      candidateInputs: [
        {
          productionInputId: input.id,
          productionInputVersion: input.version,
          productionInputDigest: input.inputDigest,
          pageIdentity: input.pageIdentity,
          route: input.route,
          manifestDigest: "5".repeat(64),
        },
      ],
      redirectRules: [],
      redirectSnapshotDigest: redirectDig,
    });

    const candId = prodCandidate.id;

    // Claims and source evidence for the review
    const inseeRegistry = loadInseeEvidenceRegistry(repoRoot);
    const sourceEvidenceSetDigest = computeSourceEvidenceSetDigest({ inseeEvidence: inseeRegistry });
    const raceClaims: ClaimLineage[] = [
      {
        claimId: "clm-cham-1",
        pageIdentity: pageSlug,
        claimType: "SOURCE_DERIVED_FACT",
        claimText: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units according to official INSEE census records.",
        limitation: "Limited to census housing count.",
        sourceRefs: [
          {
            ref: "INSEE RP2022 Chamonix",
            sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
            canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
            datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            supportingExcerpt: "In 2022, Chamonix-Mont-Blanc contained 14,538 total housing units",
            tier: "TIER_A",
            sourceDate: "2025-07-01",
            freshnessBasis: "observation_date",
            entailment: "SUPPORTED",
            evidenceBindings: [
              {
                kind: "table_fact",
                geoCode: "74056",
                reportingYear: 2022,
                tableId: "LOG T1",
                rowKey: "Ensemble",
                columnKey: "2022",
                value: 14538,
                unit: "dwellings",
              },
            ],
            acquisitionProvenance: {
              acquisitionEventId: "acq-1",
              trustedProviderId: "insee",
              acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
              retrievedAt: "2026-09-01T10:00:00Z",
              contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
              signatureOrReceipt: "REC-1",
              canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
              datasetIdentity: { geoCode: "74056", reportingPeriod: 2022 },
            },
          },
        ],
      },
    ];

    const claimSetDigest = computeClaimSetDigest(raceClaims);
    const racePageSource = computePageSourceEvidenceDigest({ claims: raceClaims, inseeEvidence: inseeRegistry });
    await trustStoreA.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claims: raceClaims,
    });

    const actorId = "race-editor-concurrent";
    await membershipAuthA.grantMembership(seeded.projectId, actorId, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInstA.db);
    const harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta", dbInstA.db);
    const token = harness.issueSignedSession({
      actorId,
      actorName: "Concurrent Race Editor",
      actorRole: "EDITORIAL_BOARD",
    });

    const serviceA = new EditorialReviewService(trustStoreA, harness.adapter, membershipAuthA, auditStoreA);
    const approval = await serviceA.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Genuine concurrent review approval",
      sessionToken: token,
      reviewerRef: actorId,
      reviewerExpertise: "Lead Editor",
      reviewAction: "APPROVED",
    });

    const passingChecks: ProductionQaCheckResult[] = [
      ...REQUIRED_PRODUCTION_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : gate.scope === "site" ? manifestSetDig : repoSha;
        const group = gate.checkId.split(".")[0] as ProductionQaCheckResult["group"];
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
      ...REQUIRED_TRUST_QA_GATES.map((gate) => {
        const subject = gate.scope === "page" ? route : manifestSetDig;
        const group = "content" as const;
        return bindQaCheck(
          { checkId: gate.checkId, group, verdict: "PASS", detail: "passed initial checks", evidence: [] },
          { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
        );
      }),
    ];

    for (const check of passingChecks.filter((c) => TRUSTED_PRODUCTION_QA_GATES.some((g: any) => g.checkId === c.checkId))) {
      await prodStoreA.recordTrustedQaEvidence({
        projectId: seeded.projectId,
        candidateId: candId,
        check,
        artifactDigest: "a".repeat(64),
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
      });
    }

    // ---- RACE-06: Concurrent approval revocation with two independent PostgreSQL connections ----
    let barrierBStarted = false;
    let barrierAReadyToLock = false;

    const taskRevoke = async () => {
      await dbInstB.db.transaction(async (tx) => {
        barrierBStarted = true;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seeded.projectId}, 104))`);
        while (!barrierAReadyToLock) {
          await new Promise((r) => setTimeout(r, 10));
        }
        await new Promise((r) => setTimeout(r, 50));
        await auditStoreB.revokeApprovalAuditEvent(approval.approvalEvent!.reviewEventId, tx as unknown as FactoryDb);
      });
    };

    const taskQa = async () => {
      while (!barrierBStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }
      barrierAReadyToLock = true;
      return prodStoreA.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      });
    };

    const [, race06Run] = await Promise.all([taskRevoke(), taskQa()]);
    assert.equal(race06Run.overall, "FAIL", "RACE-06: Concurrently revoked approval must cause QA run to FAIL");
    assert.equal((race06Run.data as any).provenance.publicationEligible, false, "RACE-06: Concurrently revoked approval cannot be publication eligible");
    const candAfter06 = await prodStoreA.getCandidate(seeded.projectId, candId);
    assert.equal(candAfter06!.state, "qa_failed", "RACE-06: Candidate state must transition to qa_failed");

    // ---- RACE-07: Concurrent membership revocation with independent connections ----
    await dbInstA.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);
    const actor7 = "race-editor-7-conn";
    await membershipAuthA.grantMembership(seeded.projectId, actor7, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInstA.db);
    const token7 = harness.issueSignedSession({
      actorId: actor7,
      actorName: "Editor 7",
      actorRole: "EDITORIAL_BOARD",
    });
    await serviceA.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Approval 7",
      sessionToken: token7,
      reviewerRef: actor7,
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });

    let barrierRevokeMembershipStarted = false;
    let barrierQa7Waiting = false;

    const taskRevokeMembership = async () => {
      await dbInstB.db.transaction(async (tx) => {
        barrierRevokeMembershipStarted = true;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seeded.projectId}, 104))`);
        while (!barrierQa7Waiting) {
          await new Promise((r) => setTimeout(r, 10));
        }
        await new Promise((r) => setTimeout(r, 50));
        await membershipAuthB.revokeMembership(seeded.projectId, actor7, tx as unknown as FactoryDb);
      });
    };

    const taskQa7 = async () => {
      while (!barrierRevokeMembershipStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }
      barrierQa7Waiting = true;
      return prodStoreA.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      });
    };

    const [, race07Run] = await Promise.all([taskRevokeMembership(), taskQa7()]);
    assert.equal(race07Run.overall, "FAIL", "RACE-07: Concurrently revoked membership must make QA overall FAIL");
    assert.equal((race07Run.data as any).provenance.publicationEligible, false, "RACE-07: Must not be publication eligible");

    // ---- RACE-08: Concurrent source change while QA evaluates authority ----
    await dbInstA.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);
    await membershipAuthA.grantMembership(seeded.projectId, actor7, ["EDITORIAL_REVIEW:APPROVE"], "EDITORIAL_BOARD", dbInstA.db);
    await serviceA.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Approval 8",
      sessionToken: token7,
      reviewerRef: actor7,
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });

    let barrierSourceMutationStarted = false;
    let barrierQa8Waiting = false;

    const taskMutateSource = async () => {
      await dbInstB.db.transaction(async (tx) => {
        barrierSourceMutationStarted = true;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seeded.projectId}, 104))`);
        while (!barrierQa8Waiting) {
          await new Promise((r) => setTimeout(r, 10));
        }
        await new Promise((r) => setTimeout(r, 50));
        const mutatedClaims: ClaimLineage[] = [
          {
            ...raceClaims[0]!,
            limitation: "Concurrent mutation of claim limitation during QA",
          },
        ];
        const txTrust = new TrustGovernanceStore(tx as unknown as FactoryDb, { repoRoot });
        await txTrust.saveClaimLineage({
          projectId: seeded.projectId,
          pageIdentity: pageSlug,
          contentDigest: page.contentDigest,
          claims: mutatedClaims,
        });
      });
    };

    let race08Error: any = null;
    let race08Run: any = null;
    const taskQa8 = async () => {
      while (!barrierSourceMutationStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }
      barrierQa8Waiting = true;
      try {
        race08Run = await prodStoreA.recordQaRun({
          projectId: seeded.projectId,
          candidateId: candId,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      } catch (err) {
        race08Error = err;
      }
    };

    await Promise.all([taskMutateSource(), taskQa8()]);
    assert.ok(
      (race08Run && race08Run.overall === "FAIL") ||
      (race08Error && /production_authority_stale|review_authority_stale/.test(race08Error.code || race08Error.message)),
      "RACE-08: Concurrently mutated source evidence must fail closed (QA fail or production_authority_stale)",
    );
    const candAfter08 = await prodStoreA.getCandidate(seeded.projectId, candId);
    assert.notEqual(candAfter08!.state, "qa_passed", "RACE-08: Candidate must not pass QA with concurrently mutated source evidence");

    // ---- RACE-09: Concurrent valid QA runs across independent connections serialize cleanly ----
    await trustStoreA.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claims: raceClaims,
    });
    await serviceA.recordAuthenticatedApproval({
      projectId: seeded.projectId,
      pageIdentity: pageSlug,
      contentDigest: page.contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      pageSourceEvidenceDigest: racePageSource.digest,
      verifiedClaimIds: ["clm-cham-1"],
      note: "Approval 9 valid",
      sessionToken: token7,
      reviewerRef: actor7,
      reviewerExpertise: "Lead",
      reviewAction: "APPROVED",
    });
    await dbInstA.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);

    const [runA, runB] = await Promise.all([
      prodStoreA.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      }),
      prodStoreB.recordQaRun({
        projectId: seeded.projectId,
        candidateId: candId,
        checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64),
        manifestSetDigest: manifestSetDig,
        redirectSnapshotDigest: redirectDig,
        repositorySha: repoSha,
        lockfileDigest: lockfileDig,
        pageRoutes: [route],
      }),
    ]);

    assert.ok(runA.id && runB.id, "RACE-09: Both concurrent QA runs must succeed without deadlocks");
    assert.equal(runA.overall, "PASS", "RACE-09: Run A overall must PASS");
    assert.equal(runB.overall, "PASS", "RACE-09: Run B overall must PASS");
    assert.equal((runA.data as any).provenance.publicationEligible, true);
    assert.equal((runB.data as any).provenance.publicationEligible, true);
    const candAfter09 = await prodStoreA.getCandidate(seeded.projectId, candId);
    assert.equal(candAfter09!.state, "qa_passed", "RACE-09: Final candidate state must be qa_passed");

    // ---- RACE-10: Recovery after conflict: retry succeeds once conflict is resolved ----
    await dbInstA.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);
    const [pInput] = await dbInstA.db.select().from(productionPageInputs).where(eq(productionPageInputs.id, input.id));
    await dbInstA.db.execute(sql`UPDATE production_page_inputs SET accepted_content_digest = ${"0".repeat(64)} WHERE id = ${input.id}`);

    await assert.rejects(
      async () => {
        await prodStoreA.recordQaRun({
          projectId: seeded.projectId,
          candidateId: candId,
          checks: passingChecks,
          evaluatedArtifactDigest: "a".repeat(64),
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: redirectDig,
          repositorySha: repoSha,
          lockfileDigest: lockfileDig,
          pageRoutes: [route],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_authority_digest_mismatch|production_authority_stale/);
        return true;
      },
      "RACE-10: Conflicting input must fail",
    );

    // Resolve conflict by restoring the correct digest and candidate state
    await dbInstA.db.execute(sql`UPDATE production_page_inputs SET accepted_content_digest = ${pInput!.acceptedContentDigest} WHERE id = ${input.id}`);
    await dbInstA.db.execute(sql`UPDATE production_candidates SET state = 'built' WHERE id = ${candId}`);

    const retryRun = await prodStoreA.recordQaRun({
      projectId: seeded.projectId,
      candidateId: candId,
      checks: passingChecks,
      evaluatedArtifactDigest: "a".repeat(64),
      manifestSetDigest: manifestSetDig,
      redirectSnapshotDigest: redirectDig,
      repositorySha: repoSha,
      lockfileDigest: lockfileDig,
      pageRoutes: [route],
    });

    assert.equal(retryRun.overall, "PASS", "RACE-10: Retried QA run must succeed after conflict resolution");
    assert.equal((retryRun.data as any).provenance.publicationEligible, true);
    const finalCand10 = await prodStoreA.getCandidate(seeded.projectId, candId);
    assert.equal(finalCand10!.state, "qa_passed");
  } finally {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
    await dbInstA.close();
    await dbInstB.close();
  }
});
