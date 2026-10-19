import { randomUUID } from "node:crypto";
import type { ReviewAuthority, AuthenticatedApprovalEvent } from "@factory/contracts";
import { TrustGovernanceStore, TrustGovernanceError } from "./store.js";

export interface AuthenticatedSession {
  sessionId: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  createdAt: string;
  expiresAt: string;
}

export class TrustedSessionRegistry {
  private static instance: TrustedSessionRegistry;
  private readonly sessions = new Map<string, AuthenticatedSession>();

  static getInstance(): TrustedSessionRegistry {
    if (!this.instance) {
      this.instance = new TrustedSessionRegistry();
    }
    return this.instance;
  }

  createSession(actor: {
    actorId: string;
    actorName: string;
    actorRole: string;
    ttlMs?: number;
  }): string {
    const token = `sess-${randomUUID()}`;
    const now = new Date();
    const expires = new Date(now.getTime() + (actor.ttlMs ?? 3600_000));
    this.sessions.set(token, {
      sessionId: token,
      actorId: actor.actorId,
      actorName: actor.actorName,
      actorRole: actor.actorRole,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    });
    return token;
  }

  getSession(token: string): AuthenticatedSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export class ProjectMembershipAuthority {
  private static instance: ProjectMembershipAuthority;
  private readonly memberships = new Map<string, Set<string>>();

  static getInstance(): ProjectMembershipAuthority {
    if (!this.instance) {
      this.instance = new ProjectMembershipAuthority();
    }
    return this.instance;
  }

  grantMembership(projectId: string, actorId: string, permissions: string[]): void {
    const key = `${projectId}:${actorId}`;
    const current = this.memberships.get(key) ?? new Set<string>();
    for (const p of permissions) current.add(p);
    this.memberships.set(key, current);
  }

  revokeMembership(projectId: string, actorId: string): void {
    this.memberships.delete(`${projectId}:${actorId}`);
  }

  getMemberPermissions(projectId: string, actorId: string): string[] {
    const key = `${projectId}:${actorId}`;
    return Array.from(this.memberships.get(key) ?? []);
  }

  clear(): void {
    this.memberships.clear();
  }
}

export interface StoredApprovalAuditEvent {
  auditEventId: string;
  projectId: string;
  pageIdentity: string;
  actorId: string;
  actorRole: string;
  reviewAction: "APPROVED" | "CHANGES_REQUESTED" | "REJECTED";
  contentDigest: string;
  claimSetDigest: string;
  sourceEvidenceSetDigest: string;
  timestamp: string;
  auditEventReference: string;
}

export class EditorialAuditStore {
  private static instance: EditorialAuditStore;
  private readonly events = new Map<string, StoredApprovalAuditEvent>();

  static getInstance(): EditorialAuditStore {
    if (!this.instance) {
      this.instance = new EditorialAuditStore();
    }
    return this.instance;
  }

  recordApprovalAuditEvent(event: StoredApprovalAuditEvent): void {
    this.events.set(event.auditEventId, event);
  }

  getApprovalAuditEvent(eventId: string): StoredApprovalAuditEvent | null {
    return this.events.get(eventId) ?? null;
  }

  findValidApprovalAuditEvent(criteria: {
    projectId: string;
    pageIdentity: string;
    contentDigest: string;
    claimSetDigest: string;
    sourceEvidenceSetDigest: string;
  }): StoredApprovalAuditEvent | null {
    for (const evt of this.events.values()) {
      if (
        evt.projectId === criteria.projectId &&
        evt.pageIdentity === criteria.pageIdentity &&
        evt.contentDigest === criteria.contentDigest &&
        evt.claimSetDigest === criteria.claimSetDigest &&
        evt.sourceEvidenceSetDigest === criteria.sourceEvidenceSetDigest &&
        evt.reviewAction === "APPROVED"
      ) {
        return evt;
      }
    }
    return null;
  }

  clear(): void {
    this.events.clear();
  }
}

export interface AuthenticatedReviewApprovalRequest {
  sessionToken?: string;
  principal?: unknown;
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
  constructor(
    private readonly trustStore: TrustGovernanceStore,
    private readonly sessionRegistry: TrustedSessionRegistry = TrustedSessionRegistry.getInstance(),
    private readonly membershipAuthority: ProjectMembershipAuthority = ProjectMembershipAuthority.getInstance(),
    private readonly auditStore: EditorialAuditStore = EditorialAuditStore.getInstance(),
  ) {}

  async recordAuthenticatedApproval(request: AuthenticatedReviewApprovalRequest): Promise<ReviewAuthority> {
    // AUTH-01: Caller provides an apparently valid AuthenticatedPrincipal directly in a request without an authenticated session
    if (!request.sessionToken) {
      throw new TrustGovernanceError(
        "unauthenticated_session_required",
        "Editorial approval requires a valid authenticated server session. Self-certified principals supplied in request body are rejected.",
      );
    }

    const session = this.sessionRegistry.getSession(request.sessionToken);
    if (!session) {
      throw new TrustGovernanceError(
        "unauthenticated_session_required",
        "The provided sessionToken is invalid or has expired.",
      );
    }

    // AUTH-03: Valid authenticated actor without project-specific review permission
    const permissions = this.membershipAuthority.getMemberPermissions(request.projectId, session.actorId);
    if (!permissions.includes("EDITORIAL_REVIEW:APPROVE")) {
      throw new TrustGovernanceError(
        "unauthorized_reviewer_actor",
        `Actor "${session.actorId}" with role "${session.actorRole}" lacks "EDITORIAL_REVIEW:APPROVE" permission for project "${request.projectId}".`,
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
    const auditEventRef = request.auditEventReference ?? `AUDIT-REV-${eventTimestamp.slice(0, 10)}-${session.actorId}`;

    const approvalEvent: AuthenticatedApprovalEvent = {
      reviewEventId,
      authenticatedActorId: session.actorId,
      actorRole: session.actorRole,
      authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
      reviewAction: request.reviewAction,
      reviewedContentDigest: request.contentDigest,
      reviewedClaimSetDigest: request.claimSetDigest,
      reviewedSourceEvidenceDigest: request.sourceEvidenceSetDigest,
      eventTimestamp,
      auditEventReference: auditEventRef,
    };

    // Record server-side audit event in the independent append-only audit trail
    this.auditStore.recordApprovalAuditEvent({
      auditEventId: reviewEventId,
      projectId: request.projectId,
      pageIdentity: request.pageIdentity,
      actorId: session.actorId,
      actorRole: session.actorRole,
      reviewAction: request.reviewAction,
      contentDigest: request.contentDigest,
      claimSetDigest: request.claimSetDigest,
      sourceEvidenceSetDigest: request.sourceEvidenceSetDigest,
      timestamp: eventTimestamp,
      auditEventReference: auditEventRef,
    });

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
      approvalEventProvenance: `Authenticated human approval by ${session.actorRole} (${session.actorId}) at ${eventTimestamp}`,
      approvalEvent,
    };

    await this.trustStore.recordReview({
      projectId: request.projectId,
      review,
    });

    return review;
  }
}
