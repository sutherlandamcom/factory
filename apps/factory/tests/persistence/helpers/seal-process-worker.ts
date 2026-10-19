import { createDatabaseInstance } from "../../../src/persistence/db.js";
import {
  EditorialAuditStore,
  EditorialReviewService,
  ProjectMembershipAuthority,
  TrustedExternalIdpAdapter,
  AuditSealKeyring,
  computeAuditEventSeal,
} from "../../../src/trust/editorial-review-boundary.js";
import { TrustGovernanceStore } from "../../../src/trust/store.js";
import { sql } from "drizzle-orm";

async function main() {
  const [,, command, argsJson] = process.argv;
  if (!command || !argsJson) {
    console.error("Usage: seal-process-worker <command> <json-args>");
    process.exit(1);
  }

  const args = JSON.parse(argsJson);
  const dbInst = createDatabaseInstance(args.databaseUrl);

  try {
    if (command === "record-approval") {
      const harness = TrustedExternalIdpAdapter.createTestHarness(
        args.trustedProviderId ?? "sutherland-corp-okta",
        dbInst.db,
      );
      const token = harness.issueSignedSession({
        actorId: args.actorId,
        actorName: args.actorName ?? "Test Reviewer",
        actorRole: args.actorRole ?? "EDITORIAL_BOARD",
      });

      const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
      await membership.grantMembership(args.projectId, args.actorId, ["EDITORIAL_REVIEW:APPROVE"], args.actorRole ?? "EDITORIAL_BOARD", dbInst.db);

      const auditStore = EditorialAuditStore.getInstance(dbInst.db, AuditSealKeyring.fromEnvironment());
      const trustStore = new TrustGovernanceStore(dbInst.db, { auditStore });

      const service = new EditorialReviewService(trustStore, harness.adapter, membership, auditStore);
      const review = await service.recordAuthenticatedApproval({
        projectId: args.projectId,
        pageIdentity: args.pageIdentity,
        contentDigest: args.contentDigest,
        claimSetDigest: args.claimSetDigest,
        sourceEvidenceSetDigest: args.sourceEvidenceSetDigest,
        verifiedClaimIds: args.verifiedClaimIds ?? ["claim-1"],
        note: args.note ?? "Process test approval",
        sessionToken: token,
        reviewerRef: args.reviewerRef ?? args.actorId,
        reviewerExpertise: args.reviewerExpertise ?? "Independent Reviewer",
        reviewAction: "APPROVED",
      });

      const auditEvent = await auditStore.getApprovalAuditEvent(review.approvalEvent!.reviewEventId, dbInst.db);

      console.log(JSON.stringify({
        ok: true,
        reviewEventId: review.approvalEvent!.reviewEventId,
        verificationSeal: auditEvent?.verificationSeal,
        sealKeyId: auditEvent?.sealKeyId,
        sealStatus: auditEvent?.sealStatus,
        sealVerified: auditEvent?.sealVerified,
        authorityKind: review.authorityKind,
      }));
    } else if (command === "verify-audit-event") {
      const auditStore = EditorialAuditStore.getInstance(dbInst.db, AuditSealKeyring.fromEnvironment());
      const event = await auditStore.getApprovalAuditEvent(args.eventId, dbInst.db);
      console.log(JSON.stringify({
        ok: true,
        found: !!event,
        sealVerified: event?.sealVerified ?? false,
        sealKeyId: event?.sealKeyId,
        sealStatus: event?.sealStatus,
        revoked: event?.revoked ?? false,
        contentDigest: event?.contentDigest,
      }));
    } else if (command === "verify-review-authority") {
      const auditStore = EditorialAuditStore.getInstance(dbInst.db, AuditSealKeyring.fromEnvironment());
      const trustStore = new TrustGovernanceStore(dbInst.db, { auditStore });

      const result = await trustStore.currentReview(
        args.projectId,
        args.pageIdentity,
        args.contentDigest,
        args.claimSetDigest,
        args.sourceEvidenceSetDigest,
        undefined,
        undefined,
        true, // verify backing authority
      );

      console.log(JSON.stringify({
        ok: true,
        hasReview: !!result.review,
        stale: result.stale,
        reason: result.reason,
        authorityKind: result.review?.authorityKind,
      }));
    } else if (command === "tamper-event-in-db") {
      // Direct SQL update attempt to see if DB trigger or HMAC verification catches it
      try {
        await dbInst.db.execute(sql`
          UPDATE editorial_approval_audit_events
          SET content_digest = ${args.newDigest}
          WHERE id = ${args.eventId}
        `);
        console.log(JSON.stringify({ ok: true, mutated: true }));
      } catch (err: any) {
        const pgErr = err.cause ?? err;
        console.log(JSON.stringify({
          ok: false,
          error: pgErr.code || err.code || err.message,
          message: pgErr.message || err.message,
        }));
      }
    } else if (command === "test-oracle-prohibition") {
      try {
        // Attempt to call computeAuditEventSeal without internal capability
        (computeAuditEventSeal as any)({
          id: "evt-test",
          projectId: "prj-test",
          pageIdentity: "test-page",
          actorId: "actor-1",
          actorRole: "ROLE",
          reviewAction: "APPROVED",
          contentDigest: "a".repeat(64),
          claimSetDigest: "b".repeat(64),
          sourceEvidenceSetDigest: "c".repeat(64),
          auditEventReference: "ref",
          isSynthetic: false,
          timestamp: new Date().toISOString(),
        });
        console.log(JSON.stringify({ ok: true, oracleSucceeded: true }));
      } catch (err: any) {
        console.log(JSON.stringify({
          ok: false,
          oracleSucceeded: false,
          error: err.code || err.message,
          message: err.message,
        }));
      }
    } else if (command === "attempt-approval-with-token") {
      const adapter = new TrustedExternalIdpAdapter({
        providerId: args.trustedProviderId ?? "sutherland-corp-okta",
        publicKeyPem: args.publicKeyPem,
        db: dbInst.db,
      });
      const membership = ProjectMembershipAuthority.getInstance(dbInst.db);
      const auditStore = EditorialAuditStore.getInstance(dbInst.db, AuditSealKeyring.fromEnvironment());
      const trustStore = new TrustGovernanceStore(dbInst.db, { auditStore });
      const service = new EditorialReviewService(trustStore, adapter, membership, auditStore);
      try {
        const review = await service.recordAuthenticatedApproval({
          projectId: args.projectId,
          pageIdentity: args.pageIdentity,
          contentDigest: args.contentDigest,
          claimSetDigest: args.claimSetDigest,
          sourceEvidenceSetDigest: args.sourceEvidenceSetDigest,
          verifiedClaimIds: args.verifiedClaimIds ?? ["claim-1"],
          note: args.note ?? "Worker token approval attempt",
          sessionToken: args.sessionToken,
          reviewerRef: args.reviewerRef ?? args.actorId,
          reviewerExpertise: args.reviewerExpertise ?? "Independent Reviewer",
          reviewAction: "APPROVED",
        });
        console.log(JSON.stringify({
          ok: true,
          reviewEventId: review.approvalEvent?.reviewEventId,
          authorityKind: review.authorityKind,
        }));
      } catch (err: any) {
        console.log(JSON.stringify({
          ok: false,
          error: err.code || err.message,
          message: err.message,
        }));
      }
    } else if (command === "verify-session") {
      const adapter = new TrustedExternalIdpAdapter({
        providerId: args.trustedProviderId ?? "sutherland-corp-okta",
        publicKeyPem: args.publicKeyPem,
        db: dbInst.db,
      });
      const res = await adapter.verifySession(args.sessionToken);
      console.log(JSON.stringify({
        ok: true,
        valid: res !== null,
        actorId: res?.actorId,
      }));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await dbInst.close();
  }
}

main().catch((err) => {
  console.error("Worker error:", err);
  process.exit(1);
});
