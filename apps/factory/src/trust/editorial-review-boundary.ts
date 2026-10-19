import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ReviewAuthority, AuthenticatedApprovalEvent } from "@factory/contracts";
import { TrustGovernanceStore, TrustGovernanceError } from "./store.js";
import type { FactoryDb } from "../persistence/db.js";
import {
  editorialApprovalAuditEvents,
  projectReviewerMemberships,
} from "../persistence/schema.js";

const RUNTIME_AUDIT_SEAL_KEY = randomBytes(32);
const INTERNAL_AUDIT_WRITE_CAPABILITY = Symbol("EditorialReviewServiceAuditWriteCapability");

export interface AuditSealFields {
  auditEventId: string;
  projectId: string;
  pageIdentity: string;
  actorId: string;
  actorRole: string;
  reviewAction: string;
  contentDigest: string;
  claimSetDigest: string;
  sourceEvidenceSetDigest: string;
  auditEventReference: string;
  isSynthetic: boolean;
}

export function computeAuditEventSeal(fields: AuditSealFields): string {
  const canonical = [
    fields.auditEventId,
    fields.projectId,
    fields.pageIdentity,
    fields.actorId,
    fields.actorRole,
    fields.reviewAction,
    fields.contentDigest,
    fields.claimSetDigest,
    fields.sourceEvidenceSetDigest,
    fields.auditEventReference,
    fields.isSynthetic ? "synthetic" : "verified_human",
  ].join("|");
  return createHmac("sha256", RUNTIME_AUDIT_SEAL_KEY).update(canonical).digest("hex");
}

export function verifyAuditEventSeal(
  fields: AuditSealFields & { verificationSeal?: string | null },
): boolean {
  if (!fields.verificationSeal || !/^[0-9a-f]{64}$/.test(fields.verificationSeal)) {
    return false;
  }
  const expected = computeAuditEventSeal(fields);
  return expected === fields.verificationSeal;
}

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
  readonly isSyntheticProvider?: boolean;
  verifySession(sessionToken: string): Promise<AuthenticatedSession | null>;
}

/**
 * Fail-closed production identity provider (default for EditorialReviewService).
 * Rejects all direct session creation and unverified session tokens unless a
 * cryptographically verified external IdP is explicitly configured.
 */
export class FailClosedProductionIdentityProvider implements TrustedIdentityProvider {
  readonly isSyntheticProvider = false;

  createSession(_actor?: unknown): string {
    throw new TrustGovernanceError(
      "production_idp_not_configured_fail_closed",
      "untrusted_session_creation_rejected: Production identity provider requires configured enterprise directory integration.",
    );
  }

  async verifySession(_sessionToken: string): Promise<AuthenticatedSession | null> {
    return null;
  }
}

export interface SignedIdpAssertionPayload {
  iss: string;
  aud: "factory-editorial-governance";
  sub: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface TrustedExternalIdpConfig {
  providerId?: string;
  publicKeyPem?: string;
}

/**
 * Cryptographic external identity provider boundary.
 *
 * Production authentication requires a configured upstream IdP public key
 * (`publicKeyPem` or `FACTORY_IDP_PUBLIC_KEY_PEM`) and a cryptographically
 * signed assertion token (`ext-idp-v1.<payloadB64Url>.<sigB64Url>`).
 *
 * Raw caller-supplied principal objects are rejected fail-closed.
 * For isolated test environments, use `TrustedExternalIdpAdapter.createTestHarness()`
 * to create an ephemeral Ed25519 keypair and sign test assertions.
 */
export class TrustedExternalIdpAdapter implements TrustedIdentityProvider {
  readonly isSyntheticProvider = false;
  public readonly providerId: string;
  private readonly publicKey: KeyObject | null;
  private readonly revokedSessionIds = new Set<string>();

  constructor(configOrProviderId: string | TrustedExternalIdpConfig = "trusted-external-idp") {
    if (typeof configOrProviderId === "string") {
      this.providerId = configOrProviderId;
      const envPem = process.env.FACTORY_IDP_PUBLIC_KEY_PEM?.trim();
      this.publicKey = envPem ? createPublicKey(envPem) : null;
    } else {
      this.providerId = configOrProviderId.providerId ?? "trusted-external-idp";
      const pem = configOrProviderId.publicKeyPem?.trim() ?? process.env.FACTORY_IDP_PUBLIC_KEY_PEM?.trim();
      this.publicKey = pem ? createPublicKey(pem) : null;
    }
  }

  /**
   * Explicit test-only harness that generates an ephemeral Ed25519 keypair
   * so tests can exercise real cryptographic signature verification without
   * allowing unverified caller-supplied principal objects.
   */
  static createTestHarness(providerId = "trusted-external-idp"): {
    adapter: TrustedExternalIdpAdapter;
    signPrincipalAssertion: (params: {
      actorId: string;
      actorName: string;
      actorRole: string;
      providerId?: string;
      ttlMs?: number;
    }) => string;
    issueSignedSession: (params: {
      actorId: string;
      actorName: string;
      actorRole: string;
      providerId?: string;
      ttlMs?: number;
    }) => string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const privKeyObj = createPrivateKey(privateKeyPem);
    const adapter = new TrustedExternalIdpAdapter({ providerId, publicKeyPem });

    const signPrincipalAssertion = (params: {
      actorId: string;
      actorName: string;
      actorRole: string;
      providerId?: string;
      ttlMs?: number;
    }): string => {
      const nowMs = Date.now();
      const payload: SignedIdpAssertionPayload = {
        iss: params.providerId ?? providerId,
        aud: "factory-editorial-governance",
        sub: params.actorId,
        name: params.actorName,
        role: params.actorRole,
        iat: nowMs,
        exp: nowMs + (params.ttlMs ?? 3600_000),
        jti: `jti-${randomUUID()}`,
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signatureB64 = cryptoSign(null, Buffer.from(payloadB64, "utf8"), privKeyObj).toString("base64url");
      return `ext-idp-v1.${payloadB64}.${signatureB64}`;
    };

    return { adapter, signPrincipalAssertion, issueSignedSession: signPrincipalAssertion };
  }

  isConfigured(): boolean {
    return this.publicKey !== null;
  }

  /**
   * Direct caller-supplied principal issuance without cryptographic upstream
   * identity evidence is prohibited. Only a pre-signed cryptographic assertion
   * verified against the configured IdP public key is accepted.
   */
  issueSessionForVerifiedPrincipal(params: {
    actorId: string;
    actorName: string;
    actorRole: string;
    providerId?: string;
    ttlMs?: number;
    signedAssertion?: string;
  }): string {
    if (!params?.signedAssertion) {
      throw new TrustGovernanceError(
        "unverified_idp_assertion_required",
        "TrustedExternalIdpAdapter rejects caller-supplied principals without a cryptographically signed upstream IdP assertion.",
      );
    }
    const verified = this.verifySignedTokenSync(params.signedAssertion);
    if (
      !verified ||
      verified.actorId !== params.actorId ||
      verified.actorRole !== params.actorRole
    ) {
      throw new TrustGovernanceError(
        "unverified_idp_assertion_required",
        "Signed IdP assertion failed cryptographic verification or principal binding.",
      );
    }
    return params.signedAssertion;
  }

  registerVerifiedPrincipal(_token: string, _session: AuthenticatedSession): never {
    throw new TrustGovernanceError(
      "unverified_principal_registration_prohibited",
      "Direct caller-supplied principal registration is prohibited on TrustedExternalIdpAdapter.",
    );
  }

  revokePrincipal(token: string): void {
    this.revokedSessionIds.add(token);
  }

  private verifySignedTokenSync(sessionToken: string): AuthenticatedSession | null {
    if (!sessionToken || !this.publicKey) return null;
    if (this.revokedSessionIds.has(sessionToken)) return null;
    const parts = sessionToken.split(".");
    if (parts.length !== 3 || parts[0] !== "ext-idp-v1") return null;
    const [, payloadB64, signatureB64] = parts;
    if (!payloadB64 || !signatureB64) return null;

    try {
      const sigValid = cryptoVerify(
        null,
        Buffer.from(payloadB64, "utf8"),
        this.publicKey,
        Buffer.from(signatureB64, "base64url"),
      );
      if (!sigValid) return null;

      const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<SignedIdpAssertionPayload>;
      if (
        !parsed ||
        parsed.iss !== this.providerId ||
        parsed.aud !== "factory-editorial-governance" ||
        typeof parsed.sub !== "string" ||
        !parsed.sub ||
        typeof parsed.name !== "string" ||
        typeof parsed.role !== "string" ||
        typeof parsed.iat !== "number" ||
        typeof parsed.exp !== "number" ||
        typeof parsed.jti !== "string"
      ) {
        return null;
      }
      if (parsed.exp < Date.now()) {
        return null;
      }
      if (this.revokedSessionIds.has(parsed.jti)) {
        return null;
      }
      return {
        sessionId: parsed.jti,
        actorId: parsed.sub,
        actorName: parsed.name,
        actorRole: parsed.role,
        createdAt: new Date(parsed.iat).toISOString(),
        expiresAt: new Date(parsed.exp).toISOString(),
        isSynthetic: false,
        trustedProviderId: this.providerId,
      };
    } catch {
      return null;
    }
  }

  async verifySession(sessionToken: string): Promise<AuthenticatedSession | null> {
    return this.verifySignedTokenSync(sessionToken);
  }

  clear(): void {
    this.revokedSessionIds.clear();
  }
}

/**
 * Isolated synthetic session registry for test environments.
 * Every session created here is unconditionally classified as synthetic
 * (`isSynthetic: true`). No caller-supplied flag can upgrade a synthetic
 * session into genuine human identity.
 */
export class TrustedSessionRegistry implements TrustedIdentityProvider {
  private static instance: TrustedSessionRegistry;
  readonly isSyntheticProvider = true as const;
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
    // Caller-supplied isSynthetic=false is ignored: self-created sessions in the
    // synthetic registry can never upgrade to non-synthetic production identity.
    this.sessions.set(token, {
      sessionId: token,
      actorId: actor.actorId,
      actorName: actor.actorName,
      actorRole: actor.actorRole,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      isSynthetic: true,
      trustedProviderId: "synthetic-test-session-registry",
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
    return {
      ...session,
      isSynthetic: true,
      trustedProviderId: session.trustedProviderId === "untrusted-public-portal"
        ? "untrusted-public-portal"
        : "synthetic-test-session-registry",
    };
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const SyntheticTestSessionRegistry = TrustedSessionRegistry;

/**
 * Authoritative PostgreSQL-backed project membership store.
 * Never falls back to in-memory maps; database unavailability or errors fail closed.
 */
export class ProjectMembershipAuthority {
  private static instance: ProjectMembershipAuthority;
  private db?: FactoryDb;

  static getInstance(db?: FactoryDb): ProjectMembershipAuthority {
    if (!this.instance) {
      this.instance = new ProjectMembershipAuthority(db);
    } else if (db) {
      this.instance.db = db;
    }
    return this.instance;
  }

  constructor(db?: FactoryDb) {
    this.db = db;
  }

  setDb(db: FactoryDb | undefined): void {
    this.db = db;
  }

  private requireDb(tx?: FactoryDb): FactoryDb {
    const client = tx ?? this.db;
    if (!client) {
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        "PostgreSQL database connection is required for project membership governance.",
      );
    }
    return client;
  }

  async grantMembership(
    projectId: string,
    actorId: string,
    permissions: string[],
    actorRole = "EDITORIAL_REVIEWER",
    tx?: FactoryDb,
  ): Promise<void> {
    const dbClient = this.requireDb(tx);
    try {
      const [existing] = await dbClient
        .select()
        .from(projectReviewerMemberships)
        .where(
          and(
            eq(projectReviewerMemberships.projectId, projectId),
            eq(projectReviewerMemberships.actorId, actorId),
          ),
        );
      if (existing) {
        const merged = existing.revokedAt
          ? Array.from(new Set(permissions))
          : Array.from(new Set([...((existing.permissions as string[]) ?? []), ...permissions]));
        await dbClient
          .update(projectReviewerMemberships)
          .set({
            actorRole,
            permissions: merged,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(projectReviewerMemberships.id, existing.id));
      } else {
        await dbClient.insert(projectReviewerMemberships).values({
          id: `prm-${randomUUID()}`,
          projectId,
          actorId,
          actorRole,
          permissions: Array.from(new Set(permissions)),
          revokedAt: null,
        });
      }
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to persist project reviewer membership in PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async revokeMembership(projectId: string, actorId: string, tx?: FactoryDb): Promise<void> {
    const dbClient = this.requireDb(tx);
    try {
      const [existing] = await dbClient
        .select()
        .from(projectReviewerMemberships)
        .where(
          and(
            eq(projectReviewerMemberships.projectId, projectId),
            eq(projectReviewerMemberships.actorId, actorId),
          ),
        );
      if (existing) {
        await dbClient
          .update(projectReviewerMemberships)
          .set({ revokedAt: new Date(), updatedAt: new Date(), permissions: [] })
          .where(eq(projectReviewerMemberships.id, existing.id));
      } else {
        await dbClient.insert(projectReviewerMemberships).values({
          id: `prm-${randomUUID()}`,
          projectId,
          actorId,
          actorRole: "REVOKED",
          permissions: [],
          revokedAt: new Date(),
        });
      }
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to revoke project reviewer membership in PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getMemberPermissions(projectId: string, actorId: string, tx?: FactoryDb): Promise<string[]> {
    const dbClient = this.requireDb(tx);
    try {
      const [row] = await dbClient
        .select()
        .from(projectReviewerMemberships)
        .where(
          and(
            eq(projectReviewerMemberships.projectId, projectId),
            eq(projectReviewerMemberships.actorId, actorId),
          ),
        );
      if (!row || row.revokedAt) return [];
      return (row.permissions as string[]) ?? [];
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to query project reviewer membership from PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  verificationSeal?: string;
  sealVerified?: boolean;
}

/**
 * Authoritative PostgreSQL-backed append-only editorial audit store.
 * Never falls back to in-memory maps; database unavailability or forged
 * writes fail closed.
 */
export class EditorialAuditStore {
  private static instance: EditorialAuditStore;
  private db?: FactoryDb;

  static getInstance(db?: FactoryDb): EditorialAuditStore {
    if (!this.instance) {
      this.instance = new EditorialAuditStore(db);
    } else if (db) {
      this.instance.db = db;
    }
    return this.instance;
  }

  constructor(db?: FactoryDb) {
    this.db = db;
  }

  setDb(db: FactoryDb | undefined): void {
    this.db = db;
  }

  private requireDb(tx?: FactoryDb): FactoryDb {
    const client = tx ?? this.db;
    if (!client) {
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        "PostgreSQL database connection is required for editorial approval audit persistence.",
      );
    }
    return client;
  }

  async recordApprovalAuditEvent(
    event: StoredApprovalAuditEvent,
    tx?: FactoryDb,
    capability?: symbol,
  ): Promise<void> {
    if (capability !== INTERNAL_AUDIT_WRITE_CAPABILITY) {
      throw new TrustGovernanceError(
        "forged_audit_event_rejected",
        "Direct audit event injection outside EditorialReviewService is prohibited.",
      );
    }
    const dbClient = this.requireDb(tx);
    const isSynthetic = event.isSynthetic ?? false;
    const seal = computeAuditEventSeal({
      auditEventId: event.auditEventId,
      projectId: event.projectId,
      pageIdentity: event.pageIdentity,
      actorId: event.actorId,
      actorRole: event.actorRole,
      reviewAction: event.reviewAction,
      contentDigest: event.contentDigest,
      claimSetDigest: event.claimSetDigest,
      sourceEvidenceSetDigest: event.sourceEvidenceSetDigest,
      auditEventReference: event.auditEventReference,
      isSynthetic,
    });
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
        isSynthetic,
        revoked: event.revoked ?? false,
        verificationSeal: seal,
        createdAt: new Date(event.timestamp),
      });
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to record editorial approval audit event in PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getApprovalAuditEvent(eventId: string, tx?: FactoryDb): Promise<StoredApprovalAuditEvent | null> {
    const dbClient = this.requireDb(tx);
    try {
      const [row] = await dbClient
        .select()
        .from(editorialApprovalAuditEvents)
        .where(eq(editorialApprovalAuditEvents.id, eventId));
      if (!row) return null;
      const sealVerified = verifyAuditEventSeal({
        auditEventId: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        actorId: row.actorId,
        actorRole: row.actorRole,
        reviewAction: row.reviewAction,
        contentDigest: row.contentDigest,
        claimSetDigest: row.claimSetDigest,
        sourceEvidenceSetDigest: row.sourceEvidenceSetDigest,
        auditEventReference: row.auditEventReference,
        isSynthetic: row.isSynthetic,
        verificationSeal: row.verificationSeal,
      });
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
        verificationSeal: row.verificationSeal,
        sealVerified,
      };
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to read editorial approval audit event from PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async revokeApprovalAuditEvent(eventId: string, tx?: FactoryDb): Promise<void> {
    const dbClient = this.requireDb(tx);
    try {
      await dbClient
        .update(editorialApprovalAuditEvents)
        .set({ revoked: true })
        .where(eq(editorialApprovalAuditEvents.id, eventId));
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to revoke editorial approval audit event in PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findValidApprovalAuditEvent(
    criteria: {
      projectId: string;
      pageIdentity: string;
      contentDigest: string;
      claimSetDigest: string;
      sourceEvidenceSetDigest: string;
    },
    tx?: FactoryDb,
  ): Promise<StoredApprovalAuditEvent | null> {
    const dbClient = this.requireDb(tx);
    try {
      const [row] = await dbClient
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
      if (!row) return null;
      const sealVerified = verifyAuditEventSeal({
        auditEventId: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        actorId: row.actorId,
        actorRole: row.actorRole,
        reviewAction: row.reviewAction,
        contentDigest: row.contentDigest,
        claimSetDigest: row.claimSetDigest,
        sourceEvidenceSetDigest: row.sourceEvidenceSetDigest,
        auditEventReference: row.auditEventReference,
        isSynthetic: row.isSynthetic,
        verificationSeal: row.verificationSeal,
      });
      if (!sealVerified) return null;
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
        verificationSeal: row.verificationSeal,
        sealVerified: true,
      };
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Failed to query valid editorial approval audit event from PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  metadata?: Record<string, unknown>;
}

export class EditorialReviewService {
  private readonly sessionRegistry: TrustedIdentityProvider;
  private readonly membershipAuthority: ProjectMembershipAuthority;
  private readonly auditStore: EditorialAuditStore;

  constructor(
    private readonly trustStore: TrustGovernanceStore,
    sessionRegistry: TrustedIdentityProvider = new FailClosedProductionIdentityProvider(),
    membershipAuthority?: ProjectMembershipAuthority,
    auditStore?: EditorialAuditStore,
  ) {
    this.sessionRegistry = sessionRegistry;
    const db = this.trustStore?.getDb?.();
    this.membershipAuthority = membershipAuthority ?? ProjectMembershipAuthority.getInstance(db);
    this.auditStore = auditStore ?? EditorialAuditStore.getInstance(db);
    if (db) {
      this.membershipAuthority.setDb(db);
      this.auditStore.setDb(db);
    }
  }

  async recordAuthenticatedApproval(request: AuthenticatedReviewApprovalRequest): Promise<ReviewAuthority> {
    // AUTH-15: Reject any request metadata attempting to upgrade a test/synthetic identity provider to production
    const rawReq = request as unknown as Record<string, unknown>;
    if (
      rawReq.upgradeToProduction !== undefined ||
      rawReq.forceProductionIdentity !== undefined ||
      rawReq.overrideSynthetic !== undefined ||
      rawReq.isSynthetic !== undefined ||
      rawReq.identityMode !== undefined ||
      rawReq.trustedProviderId !== undefined ||
      (rawReq.metadata && typeof rawReq.metadata === "object")
    ) {
      throw new TrustGovernanceError(
        "synthetic_identity_upgrade_rejected",
        "Request metadata cannot upgrade a test identity provider or override synthetic session classification.",
      );
    }

    // AUTH-01: Caller provides an apparently valid AuthenticatedPrincipal directly in a request without an authenticated session
    if (!request.sessionToken || rawReq.callerProvidedPrincipal !== undefined || rawReq.principal !== undefined) {
      throw new TrustGovernanceError(
        "unauthenticated_session_required",
        "Editorial approval requires a valid authenticated server session. Self-certified principals supplied in request body are rejected.",
      );
    }

    const session = await this.sessionRegistry.verifySession(request.sessionToken);
    if (!session) {
      throw new TrustGovernanceError(
        "unauthenticated_session_required",
        "The provided sessionToken is invalid, unverified by a configured production IdP, or has expired.",
      );
    }

    // AUTH-07: Public/untrusted callers attempting to issue approval
    if (session.trustedProviderId === "untrusted-public-portal" || request.sessionToken.startsWith("untrusted-public-")) {
      throw new TrustGovernanceError(
        "untrusted_session_creation_rejected",
        "Untrusted public application callers cannot obtain editorial approval.",
      );
    }

    // AUTH-13 / AUTH-15: Synthetic session registries and synthetic sessions can never certify real human review
    if (
      this.sessionRegistry.isSyntheticProvider === true ||
      session.isSynthetic === true ||
      session.trustedProviderId === "synthetic-test-session-registry"
    ) {
      throw new TrustGovernanceError(
        "synthetic_approval_not_production_authority",
        "Synthetic or self-created sessions cannot certify real human editorial approval.",
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

    const db = this.trustStore?.getDb?.();
    if (!db) {
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        "PostgreSQL database connection is required for transactional editorial approval.",
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
      isSynthetic: false,
      revoked: false,
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
      approvalEventProvenance: `Authenticated human approval by ${session.actorRole} (${session.actorId}) at ${eventTimestamp}`,
      approvalEvent,
    };

    // AUTH-16 / AUTH-17: Coordinate membership check, append-only audit persistence, and review insertion
    // in a single PostgreSQL transaction so any failure rolls back cleanly without orphaned approvals.
    try {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as FactoryDb;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${request.projectId}, 104))`);

        // AUTH-03 / AUTH-10 / AUTH-18: Verify active project-scoped permission inside transaction
        const permissions = await this.membershipAuthority.getMemberPermissions(
          request.projectId,
          session.actorId,
          txDb,
        );
        if (!permissions.includes("EDITORIAL_REVIEW:APPROVE")) {
          throw new TrustGovernanceError(
            "unauthorized_reviewer_actor",
            `Actor "${session.actorId}" with role "${session.actorRole}" lacks "EDITORIAL_REVIEW:APPROVE" permission for project "${request.projectId}".`,
          );
        }

        await this.auditStore.recordApprovalAuditEvent(
          {
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
            isSynthetic: false,
            revoked: false,
          },
          txDb,
          INTERNAL_AUDIT_WRITE_CAPABILITY,
        );

        await this.trustStore.recordReviewLocked(txDb, {
          projectId: request.projectId,
          review,
        });
      });
    } catch (err) {
      if (err instanceof TrustGovernanceError) throw err;
      throw new TrustGovernanceError(
        "trust_database_unavailable",
        `Transactional editorial approval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return review;
  }
}
