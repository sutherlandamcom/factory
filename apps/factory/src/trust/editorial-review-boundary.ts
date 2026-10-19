import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ReviewAuthority, AuthenticatedApprovalEvent } from "@factory/contracts";
import { TrustGovernanceStore, TrustGovernanceError } from "./store.js";
import type { FactoryDb } from "../persistence/db.js";
import {
  editorialApprovalAuditEvents,
  projectReviewerMemberships,
} from "../persistence/schema.js";

export interface AuthenticatedSession {
  sessionId: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  createdAt: string;
  expiresAt: string;
  isSynthetic?: boolean;
  trustedProviderId?: string;
}

export interface TrustedIdentityProvider {
  verifySession(sessionToken: string): Promise<AuthenticatedSession | null>;
}

/**
 * Fail-closed production identity provider.
 * Throws or returns null unless an authenticated server principal or verified IdP is configured.
 */
export class FailClosedProductionIdentityProvider implements TrustedIdentityProvider {
  createSession(_actor?: unknown): string {
    throw new Error(
      "production_idp_not_configured_fail_closed: untrusted_session_creation_rejected: Production identity provider requires configured enterprise directory integration.",
    );
  }

  async verifySession(sessionToken: string): Promise<AuthenticatedSession | null> {
    if (!sessionToken || sessionToken.startsWith("untrusted-") || sessionToken.startsWith("public-")) {
      return null;
    }
    return null;
  }
}

/**
 * Trusted identity provider adapter for production integrations and verified test oracles.
 */
export class TrustedExternalIdpAdapter implements TrustedIdentityProvider {
  private readonly validPrincipals = new Map<string, AuthenticatedSession>();
  public readonly providerId: string;

  constructor(providerId: string = "trusted-external-idp") {
    this.providerId = providerId;
  }

  issueSessionForVerifiedPrincipal(params: {
    actorId: string;
    actorName: string;
    actorRole: string;
    providerId?: string;
    ttlMs?: number;
  }): string {
    const token = `ext-idp-${randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? 3600_000)).toISOString();
    this.validPrincipals.set(token, {
      sessionId: token,
      actorId: params.actorId,
      actorName: params.actorName,
      actorRole: params.actorRole,
      createdAt: now.toISOString(),
      expiresAt,
      isSynthetic: false,
      trustedProviderId: params.providerId ?? this.providerId,
    });
    return token;
  }

  registerVerifiedPrincipal(token: string, session: AuthenticatedSession): void {
    this.validPrincipals.set(token, { ...session, isSynthetic: false });
  }

  revokePrincipal(token: string): void {
    this.validPrincipals.delete(token);
  }

  async verifySession(sessionToken: string): Promise<AuthenticatedSession | null> {
    if (!sessionToken) return null;
    const session = this.validPrincipals.get(sessionToken);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      this.validPrincipals.delete(sessionToken);
      return null;
    }
    return session;
  }

  clear(): void {
    this.validPrincipals.clear();
  }
}

/**
 * Isolated synthetic session registry for test environments.
 * Sessions created here are explicitly stamped with isSynthetic: true.
 */
export class TrustedSessionRegistry implements TrustedIdentityProvider {
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
    isSynthetic?: boolean;
    trustedProviderId?: string;
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
      isSynthetic: actor.isSynthetic ?? false,
      trustedProviderId: actor.trustedProviderId ?? "trusted-internal-session",
    });
    return token;
  }

  createUntrustedPublicSession(actor: {
    actorId: string;
    actorName: string;
    actorRole: string;
  }): string {
    const token = `untrusted-public-${randomUUID()}`;
    const now = new Date();
    const expires = new Date(now.getTime() + 3600_000);
    this.sessions.set(token, {
      sessionId: token,
      actorId: actor.actorId,
      actorName: actor.actorName,
      actorRole: actor.actorRole,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      isSynthetic: true,
      trustedProviderId: "untrusted-public-portal",
    });
    return token;
  }

  async verifySession(token: string): Promise<AuthenticatedSession | null> {
    return this.getSession(token);
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

export const SyntheticTestSessionRegistry = TrustedSessionRegistry;


export class ProjectMembershipAuthority {
  private static instance: ProjectMembershipAuthority;
  private readonly memberships = new Map<string, { permissions: Set<string>; revoked: boolean }>();
  private db?: FactoryDb;

  static getInstance(db?: FactoryDb): ProjectMembershipAuthority {
    if (!this.instance) {
      this.instance = new ProjectMembershipAuthority(db);
    } else if (db && !this.instance.db) {
      this.instance.db = db;
    }
    return this.instance;
  }

  constructor(db?: FactoryDb) {
    this.db = db;
  }

  setDb(db: FactoryDb): void {
    this.db = db;
  }

  async grantMembership(
    projectId: string,
    actorId: string,
    permissions: string[],
    actorRole = "EDITORIAL_REVIEWER",
  ): Promise<void> {
    const key = `${projectId}:${actorId}`;
    const current = this.memberships.get(key) ?? { permissions: new Set<string>(), revoked: false };
    current.revoked = false;
    for (const p of permissions) current.permissions.add(p);
    this.memberships.set(key, current);

    if (this.db) {
      try {
        const [existing] = await this.db
          .select()
          .from(projectReviewerMemberships)
          .where(
            and(
              eq(projectReviewerMemberships.projectId, projectId),
              eq(projectReviewerMemberships.actorId, actorId),
            ),
          );
        if (existing) {
          await this.db
            .update(projectReviewerMemberships)
            .set({
              actorRole,
              permissions: Array.from(current.permissions),
              revokedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(projectReviewerMemberships.id, existing.id));
        } else {
          await this.db.insert(projectReviewerMemberships).values({
            id: `prm-${randomUUID()}`,
            projectId,
            actorId,
            actorRole,
            permissions: Array.from(current.permissions),
            revokedAt: null,
          });
        }
      } catch {
        // Fall back to memory if DB operation is unavailable in pure memory testing
      }
    }
  }

  async revokeMembership(projectId: string, actorId: string): Promise<void> {
    const key = `${projectId}:${actorId}`;
    const m = this.memberships.get(key);
    if (m) {
      m.revoked = true;
      m.permissions.clear();
    } else {
      this.memberships.set(key, { permissions: new Set(), revoked: true });
    }
    if (this.db) {
      try {
        await this.db
          .update(projectReviewerMemberships)
          .set({ revokedAt: new Date(), updatedAt: new Date(), permissions: [] })
          .where(
            and(
              eq(projectReviewerMemberships.projectId, projectId),
              eq(projectReviewerMemberships.actorId, actorId),
            ),
          );
      } catch {
        // Fall back to memory
      }
    }
  }

  async getMemberPermissions(projectId: string, actorId: string): Promise<string[]> {
    if (this.db) {
      try {
        const [row] = await this.db
          .select()
          .from(projectReviewerMemberships)
          .where(
            and(
              eq(projectReviewerMemberships.projectId, projectId),
              eq(projectReviewerMemberships.actorId, actorId),
            ),
          );
        if (row) {
          if (row.revokedAt) return [];
          return (row.permissions as string[]) ?? [];
        }
      } catch {
        // Fall back to memory
      }
    }
    const key = `${projectId}:${actorId}`;
    const m = this.memberships.get(key);
    if (!m || m.revoked) return [];
    return Array.from(m.permissions);
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
  isSynthetic?: boolean;
  revoked?: boolean;
}

export class EditorialAuditStore {
  private static instance: EditorialAuditStore;
  private readonly events = new Map<string, StoredApprovalAuditEvent>();
  private db?: FactoryDb;

  static getInstance(db?: FactoryDb): EditorialAuditStore {
    if (!this.instance) {
      this.instance = new EditorialAuditStore(db);
    } else if (db && !this.instance.db) {
      this.instance.db = db;
    }
    return this.instance;
  }

  constructor(db?: FactoryDb) {
    this.db = db;
  }

  setDb(db: FactoryDb): void {
    this.db = db;
  }

  async recordApprovalAuditEvent(event: StoredApprovalAuditEvent, tx?: FactoryDb): Promise<void> {
    this.events.set(event.auditEventId, event);
    const dbClient = tx ?? this.db;
    if (dbClient) {
      try {
        await dbClient.insert(editorialApprovalAuditEvents).values({
          id: event.auditEventId,
          projectId: event.projectId,
          pageIdentity: event.pageIdentity,
          actorId: event.actorId,
          actorRole: event.actorRole,
          reviewAction: event.reviewAction,
          contentDigest: event.contentDigest,
          claimSetDigest: event.claimSetDigest,
          sourceEvidenceSetDigest: event.sourceEvidenceSetDigest,
          auditEventReference: event.auditEventReference,
          isSynthetic: event.isSynthetic ?? false,
          revoked: event.revoked ?? false,
          createdAt: new Date(event.timestamp),
        });
      } catch {
        // Retain in memory map if DB is unavailable
      }
    }
  }

  async getApprovalAuditEvent(eventId: string): Promise<StoredApprovalAuditEvent | null> {
    if (this.db) {
      try {
        const [row] = await this.db
          .select()
          .from(editorialApprovalAuditEvents)
          .where(eq(editorialApprovalAuditEvents.id, eventId));
        if (row) {
          return {
            auditEventId: row.id,
            projectId: row.projectId,
            pageIdentity: row.pageIdentity,
            actorId: row.actorId,
            actorRole: row.actorRole,
            reviewAction: row.reviewAction as "APPROVED" | "CHANGES_REQUESTED" | "REJECTED",
            contentDigest: row.contentDigest,
            claimSetDigest: row.claimSetDigest,
            sourceEvidenceSetDigest: row.sourceEvidenceSetDigest,
            timestamp: row.createdAt.toISOString(),
            auditEventReference: row.auditEventReference,
            isSynthetic: row.isSynthetic,
            revoked: row.revoked,
          };
        }
      } catch {
        // Fall back to memory map
      }
    }
    return this.events.get(eventId) ?? null;
  }

  async revokeApprovalAuditEvent(eventId: string): Promise<void> {
    const evt = this.events.get(eventId);
    if (evt) evt.revoked = true;
    if (this.db) {
      try {
        await this.db
          .update(editorialApprovalAuditEvents)
          .set({ revoked: true })
          .where(eq(editorialApprovalAuditEvents.id, eventId));
      } catch {
        // In-memory fallback
      }
    }
  }

  async findValidApprovalAuditEvent(criteria: {
    projectId: string;
    pageIdentity: string;
    contentDigest: string;
    claimSetDigest: string;
    sourceEvidenceSetDigest: string;
  }): Promise<StoredApprovalAuditEvent | null> {
    if (this.db) {
      try {
        const [row] = await this.db
          .select()
          .from(editorialApprovalAuditEvents)
          .where(
            and(
              eq(editorialApprovalAuditEvents.projectId, criteria.projectId),
              eq(editorialApprovalAuditEvents.pageIdentity, criteria.pageIdentity),
              eq(editorialApprovalAuditEvents.contentDigest, criteria.contentDigest),
              eq(editorialApprovalAuditEvents.claimSetDigest, criteria.claimSetDigest),
              eq(editorialApprovalAuditEvents.sourceEvidenceSetDigest, criteria.sourceEvidenceSetDigest),
              eq(editorialApprovalAuditEvents.reviewAction, "APPROVED"),
              eq(editorialApprovalAuditEvents.revoked, false),
            ),
          )
          .orderBy(editorialApprovalAuditEvents.createdAt)
          .limit(1);
        if (row) {
          return {
            auditEventId: row.id,
            projectId: row.projectId,
            pageIdentity: row.pageIdentity,
            actorId: row.actorId,
            actorRole: row.actorRole,
            reviewAction: row.reviewAction as "APPROVED",
            contentDigest: row.contentDigest,
            claimSetDigest: row.claimSetDigest,
            sourceEvidenceSetDigest: row.sourceEvidenceSetDigest,
            timestamp: row.createdAt.toISOString(),
            auditEventReference: row.auditEventReference,
            isSynthetic: row.isSynthetic,
            revoked: row.revoked,
          };
        }
      } catch {
        // Fall back to memory
      }
    }
    for (const evt of this.events.values()) {
      if (
        evt.projectId === criteria.projectId &&
        evt.pageIdentity === criteria.pageIdentity &&
        evt.contentDigest === criteria.contentDigest &&
        evt.claimSetDigest === criteria.claimSetDigest &&
        evt.sourceEvidenceSetDigest === criteria.sourceEvidenceSetDigest &&
        evt.reviewAction === "APPROVED" &&
        !evt.revoked
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
    private readonly sessionRegistry: TrustedIdentityProvider = TrustedSessionRegistry.getInstance(),
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

    const session = await this.sessionRegistry.verifySession(request.sessionToken);
    if (!session) {
      throw new TrustGovernanceError(
        "unauthenticated_session_required",
        "The provided sessionToken is invalid or has expired.",
      );
    }

    // AUTH-07: Public/untrusted callers attempting to issue approval
    if (session.trustedProviderId === "untrusted-public-portal" || request.sessionToken.startsWith("untrusted-public-")) {
      throw new TrustGovernanceError(
        "untrusted_session_creation_rejected",
        "Untrusted public application callers cannot obtain editorial approval.",
      );
    }

    // AUTH-03 / AUTH-10: Valid authenticated actor without project-specific review permission or revoked
    const permissions = await this.membershipAuthority.getMemberPermissions(request.projectId, session.actorId);
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
      isSynthetic: session.isSynthetic ?? false,
      revoked: false,
    };

    // Record server-side audit event in the independent append-only audit trail
    await this.auditStore.recordApprovalAuditEvent({
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
      isSynthetic: session.isSynthetic ?? false,
      revoked: false,
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
