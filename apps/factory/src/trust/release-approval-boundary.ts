import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  DEPLOYMENT_APPROVE_PERMISSION,
  DEPLOYMENT_PUBLISH_PERMISSION,
  qaRunPublicationEligible,
  type ReleaseApproval,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  deployments,
  productionCandidates,
  productionQaRuns,
  projectReviewerMemberships,
  releaseApprovals,
  type DeploymentRecord,
  type ProductionCandidateRecord,
  type ProductionQaRunRecord,
  type ReleaseApprovalRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import {
  AuditSealKeyring,
  InMemorySessionRevocationStore,
  PostgreSqlSessionRevocationStore,
  type AuthenticatedSession,
  type SessionRevocationStore,
  type TrustedIdentityProvider,
} from "./editorial-review-boundary.js";

export {
  AuditSealKeyring,
  InMemorySessionRevocationStore,
  PostgreSqlSessionRevocationStore,
  type AuthenticatedSession,
  type SessionRevocationStore,
  type TrustedIdentityProvider,
};
import { TrustGovernanceError } from "./store.js";

export interface ReleaseApprovalSealFields {
  approvalId: string;
  projectId: string;
  siteId: string;
  candidateId: string;
  qaRunId: string;
  artifactDigest: string;
  previewVersionId: string;
  targetWorkerName: string;
  targetProductionUrl: string;
  actorId: string;
  isSynthetic: boolean;
}

export function canonicalReleaseApprovalSealPayload(
  fields: ReleaseApprovalSealFields,
  sealKeyId: string,
): string {
  return [
    "release-approval-v1",
    sealKeyId,
    fields.approvalId,
    fields.projectId,
    fields.siteId,
    fields.candidateId,
    fields.qaRunId,
    fields.artifactDigest,
    fields.previewVersionId,
    fields.targetWorkerName,
    fields.targetProductionUrl,
    fields.actorId,
    fields.isSynthetic ? "synthetic" : "verified_human",
  ].join("|");
}

export function computeReleaseApprovalSeal(
  fields: ReleaseApprovalSealFields,
  keyring?: AuditSealKeyring,
  sealKeyId?: string,
): { seal: string; sealKeyId: string } {
  const activeKeyring = keyring ?? AuditSealKeyring.fromEnvironment();
  const { keyId, key } = activeKeyring.requireSigningKey(sealKeyId);
  const canonical = canonicalReleaseApprovalSealPayload(fields, keyId);
  const seal = createHmac("sha256", key).update(canonical).digest("hex");
  return { seal, sealKeyId: keyId };
}

export function verifyReleaseApprovalSeal(
  approval: ReleaseApprovalRecord,
  keyring?: AuditSealKeyring,
): boolean {
  if (approval.sealStatus !== "SEALED") return false;
  if (!approval.verificationSeal || !/^[0-9a-f]{64}$/.test(approval.verificationSeal)) {
    return false;
  }
  const keyId = approval.sealKeyId?.trim();
  if (!keyId) return false;
  const activeKeyring = keyring ?? AuditSealKeyring.fromEnvironment();
  const key = activeKeyring.getVerificationKey(keyId);
  if (!key) return false;

  const canonical = canonicalReleaseApprovalSealPayload(
    {
      approvalId: approval.id,
      projectId: approval.projectId,
      siteId: approval.siteId,
      candidateId: approval.candidateId,
      qaRunId: approval.qaRunId,
      artifactDigest: approval.artifactDigest,
      previewVersionId: approval.previewVersionId,
      targetWorkerName: approval.targetWorkerName,
      targetProductionUrl: approval.targetProductionUrl,
      actorId: approval.actorId,
      isSynthetic: approval.isSynthetic,
    },
    keyId,
  );
  const expected = createHmac("sha256", key).update(canonical).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(approval.verificationSeal, "hex");
  if (expectedBuf.byteLength !== actualBuf.byteLength) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface ReleaseIdpTokenPayload {
  iss: string;
  aud: "factory-release-governance";
  sub: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Release-specific Identity Provider verifying cryptographic upstream tokens.
 * Strictly requires audience 'factory-release-governance' (P1-01 audience separation).
 */
export class ReleaseIdentityProvider implements TrustedIdentityProvider {
  readonly isSyntheticProvider = false;
  public readonly providerId: string;
  private readonly publicKey: KeyObject | null;
  private readonly revocationStore: SessionRevocationStore;

  constructor(config?: {
    providerId?: string;
    publicKeyPem?: string;
    db?: FactoryDb;
    revocationStore?: SessionRevocationStore;
  }) {
    this.providerId = config?.providerId ?? "trusted-external-idp";
    const pem = config?.publicKeyPem?.trim() ?? process.env.FACTORY_IDP_PUBLIC_KEY_PEM?.trim();
    this.publicKey = pem ? createPublicKey(pem) : null;
    if (config?.revocationStore) {
      this.revocationStore = config.revocationStore;
    } else if (config?.db) {
      this.revocationStore = new PostgreSqlSessionRevocationStore(config.db);
    } else {
      this.revocationStore = new InMemorySessionRevocationStore();
    }
  }

  isConfigured(): boolean {
    return this.publicKey !== null;
  }

  async verifySession(sessionToken: string): Promise<AuthenticatedSession | null> {
    if (!sessionToken || !this.publicKey) return null;
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

      const parsed = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      ) as Partial<ReleaseIdpTokenPayload>;

      if (
        !parsed ||
        parsed.iss !== this.providerId ||
        parsed.aud !== "factory-release-governance" ||
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

      if (parsed.exp < Date.now()) return null;

      if (this.revocationStore && (await this.revocationStore.isRevoked(parsed.jti))) {
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

  /** Test helper for signing release assertions. */
  static createTestHarness(providerId = "trusted-external-idp", db?: FactoryDb): {
    idp: ReleaseIdentityProvider;
    publicKeyPem: string;
    signAssertion: (params: {
      actorId: string;
      actorName: string;
      actorRole: string;
      audience?: "factory-release-governance" | "factory-editorial-governance";
      ttlMs?: number;
    }) => string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privKeyObj = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
    const revocationStore = db ? new PostgreSqlSessionRevocationStore(db) : new InMemorySessionRevocationStore();
    const idp = new ReleaseIdentityProvider({
      providerId,
      publicKeyPem,
      db,
      revocationStore,
    });

    const signAssertion = (params: {
      actorId: string;
      actorName: string;
      actorRole: string;
      audience?: "factory-release-governance" | "factory-editorial-governance";
      ttlMs?: number;
    }): string => {
      const now = Date.now();
      const payload = {
        iss: providerId,
        aud: params.audience ?? "factory-release-governance",
        sub: params.actorId,
        name: params.actorName,
        role: params.actorRole,
        iat: now,
        exp: now + (params.ttlMs ?? 3600_000),
        jti: `jti-${randomUUID()}`,
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signatureB64 = cryptoSign(null, Buffer.from(payloadB64, "utf8"), privKeyObj).toString("base64url");
      return `ext-idp-v1.${payloadB64}.${signatureB64}`;
    };

    return { idp, publicKeyPem, signAssertion };
  }
}

export class ReleaseApprovalBoundary {
  private readonly keyring: AuditSealKeyring;
  private readonly idp: TrustedIdentityProvider;
  private readonly revocationStore: SessionRevocationStore;

  constructor(
    private readonly db: FactoryDb,
    options?: {
      keyring?: AuditSealKeyring;
      idp?: TrustedIdentityProvider;
      revocationStore?: SessionRevocationStore;
    },
  ) {
    this.keyring = options?.keyring ?? AuditSealKeyring.fromEnvironment();
    this.idp = options?.idp ?? new ReleaseIdentityProvider({ db });
    this.revocationStore =
      options?.revocationStore ?? new PostgreSqlSessionRevocationStore(db);
  }

  /**
   * Verify actor identity from session token, ensure session is unrevoked,
   * and confirm project reviewer membership contains required release permission.
   */
  async verifyActorPermission(params: {
    sessionToken: string;
    projectId: string;
    requiredPermission: typeof DEPLOYMENT_APPROVE_PERMISSION | typeof DEPLOYMENT_PUBLISH_PERMISSION;
    tx?: FactoryDb;
  }): Promise<AuthenticatedSession> {
    const client = params.tx ?? this.db;

    if (!params.sessionToken || typeof params.sessionToken !== "string") {
      throw new FactoryError("actor_unauthenticated", "Missing or malformed actor session token.");
    }

    const session = await this.idp.verifySession(params.sessionToken);
    if (!session || !session.actorId) {
      throw new FactoryError(
        "actor_unauthenticated",
        "Actor session token failed cryptographic verification or has expired.",
      );
    }

    if (session.isSynthetic) {
      throw new FactoryError(
        "synthetic_actor_rejected",
        "Synthetic identity is prohibited for production release authorization.",
      );
    }

    if (await this.revocationStore.isRevoked(session.sessionId, client)) {
      throw new FactoryError("session_revoked", "Actor session has been revoked.");
    }

    const [membership] = await client
      .select()
      .from(projectReviewerMemberships)
      .where(
        and(
          eq(projectReviewerMemberships.projectId, params.projectId),
          eq(projectReviewerMemberships.actorId, session.actorId),
        ),
      );

    if (!membership || membership.revokedAt) {
      throw new FactoryError(
        "project_membership_revoked",
        `Actor '${session.actorId}' does not have active membership in project '${params.projectId}'.`,
      );
    }

    const perms = (membership.permissions as string[]) ?? [];
    if (!perms.includes(params.requiredPermission)) {
      throw new FactoryError(
        "permission_denied",
        `Actor '${session.actorId}' lacks required permission '${params.requiredPermission}'.`,
      );
    }

    return session;
  }

  /**
   * Create an immutable, cryptographically sealed Release Approval for an exact
   * candidate and preview-verified deployment.
   */
  async createReleaseApproval(input: {
    projectId: string;
    siteId: string;
    candidateId: string;
    previewVersionId: string;
    sessionToken: string;
    tx?: FactoryDb;
  }): Promise<ReleaseApprovalRecord> {
    const client = paramsClient(this.db, input.tx);

    const run = async (c: FactoryDb) => {
      // 1. Verify actor has DEPLOYMENT:APPROVE permission
      const session = await this.verifyActorPermission({
        sessionToken: input.sessionToken,
        projectId: input.projectId,
        requiredPermission: DEPLOYMENT_APPROVE_PERMISSION,
        tx: c,
      });

      // 2. Query candidate
      const [candidate] = await c
        .select()
        .from(productionCandidates)
        .where(
          and(
            eq(productionCandidates.projectId, input.projectId),
            eq(productionCandidates.id, input.candidateId),
          ),
        );

      if (!candidate) {
        throw new FactoryError("candidate_not_found", `Candidate '${input.candidateId}' not found.`);
      }
      if (candidate.state !== "qa_passed" || !candidate.artifactDigest) {
        throw new FactoryError(
          "candidate_not_eligible",
          `Candidate '${candidate.id}' is in state '${candidate.state}', not 'qa_passed'.`,
        );
      }

      // 3. Query deployment: must be preview_verified and match previewVersionId
      const [deployment] = await c
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.siteId, input.siteId),
            eq(deployments.candidateId, input.candidateId),
            eq(deployments.versionId, input.previewVersionId),
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(1);

      if (!deployment) {
        throw new FactoryError(
          "deployment_not_found",
          `No deployment found matching candidate '${input.candidateId}' and version '${input.previewVersionId}'.`,
        );
      }
      if (deployment.status !== "preview_verified" || !deployment.previewVerified) {
        throw new FactoryError(
          "preview_not_verified",
          `Deployment '${deployment.id}' is in state '${deployment.status}', not 'preview_verified'.`,
        );
      }
      if (!deployment.qaRunId) {
        throw new FactoryError("qa_run_not_found", `Deployment '${deployment.id}' has no associated QA run.`);
      }

      // 4. Query QA run: must be PASS and publication eligible
      const [qaRun] = await c
        .select()
        .from(productionQaRuns)
        .where(
          and(
            eq(productionQaRuns.projectId, input.projectId),
            eq(productionQaRuns.id, deployment.qaRunId),
          ),
        );

      if (!qaRun || qaRun.overall !== "PASS" || !qaRunPublicationEligible(qaRun.data)) {
        throw new FactoryError("qa_not_eligible", "QA run is missing, not PASS, or not publication-eligible.");
      }

      // 5. Check if approval already exists
      const [existing] = await c
        .select()
        .from(releaseApprovals)
        .where(
          and(
            eq(releaseApprovals.candidateId, input.candidateId),
            eq(releaseApprovals.previewVersionId, input.previewVersionId),
          ),
        );

      if (existing) {
        if (existing.revoked) {
          throw new FactoryError("approval_revoked", "Prior approval for this candidate/version was revoked.");
        }
        return existing;
      }

      // 6. Compute HMAC verification seal
      const approvalId = `rel-appr-${randomUUID()}`;
      const sealFields: ReleaseApprovalSealFields = {
        approvalId,
        projectId: input.projectId,
        siteId: input.siteId,
        candidateId: candidate.id,
        qaRunId: qaRun.id,
        artifactDigest: candidate.artifactDigest,
        previewVersionId: input.previewVersionId,
        targetWorkerName: deployment.workerName,
        targetProductionUrl: deployment.productionUrl,
        actorId: session.actorId,
        isSynthetic: false,
      };

      const { seal, sealKeyId } = computeReleaseApprovalSeal(sealFields, this.keyring);

      // 7. Insert release_approvals record
      const [created] = await c
        .insert(releaseApprovals)
        .values({
          id: approvalId,
          projectId: input.projectId,
          siteId: input.siteId,
          candidateId: candidate.id,
          qaRunId: qaRun.id,
          artifactDigest: candidate.artifactDigest,
          previewVersionId: input.previewVersionId,
          targetWorkerName: deployment.workerName,
          targetProductionUrl: deployment.productionUrl,
          actorId: session.actorId,
          actorName: session.actorName,
          actorRole: session.actorRole,
          sessionId: session.sessionId,
          isSynthetic: false,
          verificationSeal: seal,
          sealKeyId,
          sealStatus: "SEALED",
          revoked: false,
        })
        .returning();

      if (!created) {
        throw new FactoryError("persistence_write_failed", "Failed to insert release approval record.");
      }

      // 8. Link release approval to deployment record
      await c
        .update(deployments)
        .set({ releaseApprovalId: approvalId, updatedAt: new Date() })
        .where(eq(deployments.id, deployment.id));

      return created;
    };

    if (!input.tx && typeof client.transaction === "function") {
      return await client.transaction(async (innerTx) => {
        return await run(innerTx as unknown as FactoryDb);
      });
    }
    return await run(client);
  }

  /**
   * Verify that a release approval exists, is not revoked, has a valid HMAC seal,
   * matches the exact candidate / QA / version / target, and actor permission is current.
   */
  async assertValidReleaseApproval(params: {
    approvalId: string;
    projectId: string;
    siteId: string;
    candidateId: string;
    previewVersionId: string;
    targetWorkerName: string;
    targetProductionUrl: string;
    tx?: FactoryDb;
  }): Promise<ReleaseApprovalRecord> {
    const client = paramsClient(this.db, params.tx);
    const [approval] = await client
      .select()
      .from(releaseApprovals)
      .where(eq(releaseApprovals.id, params.approvalId));

    if (!approval) {
      throw new FactoryError("release_approval_not_found", `Release approval '${params.approvalId}' not found.`);
    }

    if (approval.revoked) {
      throw new FactoryError("release_approval_revoked", "Release approval has been revoked.");
    }

    if (
      approval.projectId !== params.projectId ||
      approval.siteId !== params.siteId ||
      approval.candidateId !== params.candidateId ||
      approval.previewVersionId !== params.previewVersionId ||
      approval.targetWorkerName !== params.targetWorkerName ||
      approval.targetProductionUrl !== params.targetProductionUrl
    ) {
      throw new FactoryError(
        "release_approval_mismatch",
        "Release approval bindings do not match the publication target.",
      );
    }

    if (!verifyReleaseApprovalSeal(approval, this.keyring)) {
      throw new FactoryError(
        "release_approval_seal_invalid",
        "Release approval HMAC verification seal is invalid or key is unavailable.",
      );
    }

    // Check that approval session was not revoked
    if (await this.revocationStore.isRevoked(approval.sessionId, client)) {
      throw new FactoryError(
        "release_approval_revoked",
        "Actor session used for release approval has been revoked.",
      );
    }

    // Check that the approver's project membership is still active
    const [membership] = await client
      .select()
      .from(projectReviewerMemberships)
      .where(
        and(
          eq(projectReviewerMemberships.projectId, approval.projectId),
          eq(projectReviewerMemberships.actorId, approval.actorId),
        ),
      );

    if (!membership || membership.revokedAt) {
      throw new FactoryError(
        "project_membership_revoked",
        `Approving actor '${approval.actorId}' membership has been revoked.`,
      );
    }

    const perms = (membership.permissions as string[]) ?? [];
    if (!perms.includes(DEPLOYMENT_APPROVE_PERMISSION)) {
      throw new FactoryError(
        "permission_revoked",
        `Approving actor '${approval.actorId}' no longer holds required permission '${DEPLOYMENT_APPROVE_PERMISSION}'.`,
      );
    }

    return approval;
  }
}

function paramsClient(defaultDb: FactoryDb, tx?: FactoryDb): FactoryDb {
  return tx ?? defaultDb;
}
