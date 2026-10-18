import { randomUUID } from "node:crypto";
import type { ReviewAuthority, AuthenticatedApprovalEvent } from "@factory/contracts";
import { TrustGovernanceStore, TrustGovernanceError } from "./store.js";

export interface AuthenticatedPrincipal {
  actorId: string;
  role: string;
  permissions: string[];
}

export interface ReviewApprovalRequest {
  principal: AuthenticatedPrincipal;
  projectId: string;
  pageIdentity: string;
  contentDigest: string;
  claimSetDigest: string;
  sourceEvidenceSetDigest: string;
  reviewAction: "APPROVED" | "CHANGES_REQUESTED" | "REJECTED";
  reviewerRef: string;
  reviewerExpertise: string;
  verifiedClaimIds?: string[];
  note?: string;
  auditEventReference?: string;
}

export class EditorialReviewService {
  constructor(private readonly trustStore: TrustGovernanceStore) {}

  async recordAuthenticatedApproval(request: ReviewApprovalRequest): Promise<ReviewAuthority> {
    const { principal } = request;
    if (!principal || !principal.actorId || /^(?:anonymous|unauthenticated|guest|mock|bot)$/i.test(principal.actorId.trim())) {
      throw new TrustGovernanceError(
        "unauthenticated_principal_rejected",
        "Editorial approval requires an authenticated human principal.",
      );
    }
    if (!principal.permissions || !principal.permissions.includes("EDITORIAL_REVIEW:APPROVE")) {
      throw new TrustGovernanceError(
        "unauthorized_reviewer_actor",
        `Actor "${principal.actorId}" with role "${principal.role}" lacks "EDITORIAL_REVIEW:APPROVE" permission.`,
      );
    }
    if (!request.contentDigest || !/^[0-9a-f]{64}$/.test(request.contentDigest)) {
      throw new TrustGovernanceError(
        "invalid_content_digest",
        "Approval requires a valid 64-character contentDigest.",
      );
    }
    if (!request.claimSetDigest || !/^[0-9a-f]{64}$/.test(request.claimSetDigest)) {
      throw new TrustGovernanceError(
        "invalid_claim_set_digest",
        "Approval requires a valid 64-character claimSetDigest.",
      );
    }
    if (!request.sourceEvidenceSetDigest || !/^[0-9a-f]{64}$/.test(request.sourceEvidenceSetDigest)) {
      throw new TrustGovernanceError(
        "invalid_source_evidence_set_digest",
        "Approval requires a valid 64-character sourceEvidenceSetDigest.",
      );
    }

    const eventTimestamp = new Date().toISOString();
    const reviewEventId = `appr-evt-${randomUUID()}`;
    const approvalEvent: AuthenticatedApprovalEvent = {
      reviewEventId,
      authenticatedActorId: principal.actorId,
      actorRole: principal.role,
      authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
      reviewAction: request.reviewAction,
      reviewedContentDigest: request.contentDigest,
      reviewedClaimSetDigest: request.claimSetDigest,
      reviewedSourceEvidenceDigest: request.sourceEvidenceSetDigest,
      eventTimestamp,
      auditEventReference: request.auditEventReference ?? `AUDIT-REV-${eventTimestamp.slice(0, 10)}-${principal.actorId}`,
    };

    const review: ReviewAuthority = {
      schemaVersion: "trust-governance-v1",
      projectId: request.projectId,
      pageIdentity: request.pageIdentity,
      reviewerRef: request.reviewerRef,
      reviewerExpertise: request.reviewerExpertise,
      reviewedContentDigest: request.contentDigest,
      reviewedAt: eventTimestamp.slice(0, 10),
      result: request.reviewAction === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED",
      note: request.note ?? "Authenticated human review approved via EditorialReviewService.",
      verifiedClaimIds: request.verifiedClaimIds,
      reviewStatus: request.reviewAction === "APPROVED" ? "EDITORIAL_REVIEW_APPROVED" : "EDITORIAL_REVIEW_REJECTED",
      reviewerKind: "EXTERNAL_HUMAN_REVIEWER",
      authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
      claimSetDigest: request.claimSetDigest,
      sourceEvidenceSetDigest: request.sourceEvidenceSetDigest,
      approvalEventId: reviewEventId,
      approvalEventProvenance: `Authenticated human approval by ${principal.role} (${principal.actorId}) at ${eventTimestamp}`,
      approvalEvent,
    };

    await this.trustStore.recordReview({
      projectId: request.projectId,
      review,
    });

    return review;
  }
}
