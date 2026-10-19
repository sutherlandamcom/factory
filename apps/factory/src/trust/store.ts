import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import {
  pageIntentAuthorities,
  claimLineageRecords,
  reviewAuthorities,
  originalValueRecords,
  type PageIntentAuthorityRecord,
  type ClaimLineageRecord,
  type ReviewAuthorityRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import {
  parsePageIntentAuthority,
  parseClaimLineage,
  parseReviewAuthority,
  originalValueRecordSchema,
  claimLineageProblems,
  claimLineageVerdict,
  reviewStaleness,
  checkCannibalization,
  type PageIntentAuthority,
  type ClaimLineage,
  type ReviewAuthority,
  type OriginalValueRecord,
} from "@factory/contracts";
import { normalizePageIdentity } from "../page-authority/store.js";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  EditorialAuditStore,
  ProjectMembershipAuthority,
  AuditSealKeyring,
} from "./editorial-review-boundary.js";
import {
  loadInseeEvidenceRegistry,
  INSEE_EVIDENCE_DIR,
  isInseeSourceRef,
  type InseeEvidenceRegistry,
} from "./insee-evidence.js";
import {
  loadLegalEvidenceRegistry,
  LEGAL_EVIDENCE_DIR,
  isLegalOrRegulatoryClaim,
  type LegalEvidenceRegistry,
} from "./legal-evidence.js";
import {
  computeClaimSetDigest,
  computePageSourceEvidenceDigest,
  computeSourceEvidenceSetDigest,
  computeWorkProductSetDigest,
  findRepoRoot,
} from "../production/qa/trust.js";

/**
 * TRUST GOVERNANCE STORE — Macro Run 12.
 *
 * Durable, versioned, digest-bound authorities for the trust semantics the
 * Run 12 proof requires:
 *
 *   PageIntentAuthority   — per-page strategy/YMYL/decision-role authority
 *   ClaimLineageRecord    — claim classification + evidence lineage
 *   ReviewAuthority       — real review events bound to content digests
 *   OriginalValueRecord   — per-page original-value evidence
 *
 * All writes go through the shared project advisory lock (namespace 104,
 * same serialization discipline as every other authority store). Reads are
 * pure. Fail-closed: malformed authority data never persists.
 */

export class TrustGovernanceError extends FactoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "TrustGovernanceError";
  }
}

function trustError(code: string, message: string): TrustGovernanceError {
  return new TrustGovernanceError(code, message);
}

/** Authenticated source-evidence inputs used to verify review freshness. */
export interface TrustEvidenceOptions {
  repoRoot?: string;
  evidenceRoot?: string;
  inseeEvidence?: InseeEvidenceRegistry;
  legalEvidence?: LegalEvidenceRegistry;
  /** Optional explicit override of the global source-evidence-set digest. */
  sourceEvidenceSetDigest?: string;
  keyring?: AuditSealKeyring;
}

export interface TrustGovernanceStoreOptions extends TrustEvidenceOptions {
  auditStore?: EditorialAuditStore;
  membershipAuthority?: ProjectMembershipAuthority;
}

export type PageEvidenceRequirementType =
  | "NO_EXTERNAL_EVIDENCE_REQUIRED"
  | "INSEE_EVIDENCE_REQUIRED"
  | "LEGAL_EVIDENCE_REQUIRED"
  | "OTHER_EXTERNAL_EVIDENCE_REQUIRED"
  | "FIRST_PARTY_WORK_REQUIRED"
  | "MULTIPLE_EVIDENCE_TYPES_REQUIRED";

export interface PageEvidenceRequirements {
  category: PageEvidenceRequirementType;
  needsInsee: boolean;
  needsLegal: boolean;
  needsFirstParty: boolean;
  needsOtherExternal: boolean;
}

/**
 * Dependency-aware evidence requirements classification.
 * Inspects accepted page claims and original-value records to determine
 * exactly which source registries are required, avoiding unnecessary
 * evidence loads or false failures on unrelated registries.
 */
export function classifyPageEvidenceRequirements(
  claims: ClaimLineage[],
  originals: OriginalValueRecord[] = [],
): PageEvidenceRequirements {
  const needsInsee = claims.some((c) =>
    c.sourceRefs.some(
      (r) =>
        (r.evidenceBindings && r.evidenceBindings.length > 0) ||
        isInseeSourceRef(r) ||
        r.canonicalDatasetId?.startsWith("INSEE-") ||
        r.acquisitionProvenance?.trustedProviderId === "insee",
    ),
  );

  const needsLegal = claims.some(
    (c) =>
      isLegalOrRegulatoryClaim(c) ||
      c.sourceRefs.some(
        (r) =>
          r.sourceClassification === "PRIMARY_SOURCE_CAPTURE" ||
          r.sourceClassification === "PRIMARY_PUBLIC_RECORD" ||
          r.sourceClassification === "VERIFIED_OFFICIAL_ARCHIVE" ||
          r.sourceClassification === "EXTRACTED_LEGAL_PROVISION" ||
          r.canonicalDatasetId?.startsWith("LEGAL-") ||
          r.canonicalDatasetId?.startsWith("PLU-") ||
          r.canonicalDatasetId?.startsWith("CGI-"),
      ),
  );

  const needsFirstParty =
    originals.length > 0 ||
    claims.some(
      (c) =>
        Boolean(c.calculationRef) ||
        c.sourceRefs.some((r) => r.evidenceOrigin === "ACCEPTED_FIRST_PARTY"),
    );

  const needsOtherExternal = claims.some((c) =>
    c.sourceRefs.some(
      (r) =>
        (r.evidenceOrigin === "EXTERNAL_ACQUIRED" || r.evidenceOrigin === "VERIFIED_ARCHIVED_EXTERNAL") &&
        !isInseeSourceRef(r) &&
        !isLegalOrRegulatoryClaim(c),
    ),
  );

  const count =
    (needsInsee ? 1 : 0) +
    (needsLegal ? 1 : 0) +
    (needsFirstParty ? 1 : 0) +
    (needsOtherExternal ? 1 : 0);

  let category: PageEvidenceRequirementType;
  if (count > 1) {
    category = "MULTIPLE_EVIDENCE_TYPES_REQUIRED";
  } else if (needsInsee) {
    category = "INSEE_EVIDENCE_REQUIRED";
  } else if (needsLegal) {
    category = "LEGAL_EVIDENCE_REQUIRED";
  } else if (needsFirstParty) {
    category = "FIRST_PARTY_WORK_REQUIRED";
  } else if (needsOtherExternal) {
    category = "OTHER_EXTERNAL_EVIDENCE_REQUIRED";
  } else {
    category = "NO_EXTERNAL_EVIDENCE_REQUIRED";
  }

  return { category, needsInsee, needsLegal, needsFirstParty, needsOtherExternal };
}

export class TrustGovernanceStore {
  private readonly auditStore: EditorialAuditStore;
  private readonly membershipAuthority: ProjectMembershipAuthority;

  constructor(
    private readonly db: FactoryDb,
    private readonly evidenceOptions: TrustGovernanceStoreOptions = {},
  ) {
    this.auditStore = evidenceOptions.auditStore ?? new EditorialAuditStore(this.db, evidenceOptions.keyring);
    this.membershipAuthority = evidenceOptions.membershipAuthority ?? new ProjectMembershipAuthority(this.db);
  }

  getAuditStore(): EditorialAuditStore {
    return this.auditStore;
  }

  getMembershipAuthority(): ProjectMembershipAuthority {
    return this.membershipAuthority;
  }

  private resolveEvidenceRoot(): string | undefined {
    if (this.evidenceOptions.evidenceRoot) {
      return this.evidenceOptions.evidenceRoot;
    }
    if (this.evidenceOptions.repoRoot) {
      const inseeManifest = path.join(this.evidenceOptions.repoRoot, ...INSEE_EVIDENCE_DIR, "manifest.json");
      const legalManifest = path.join(this.evidenceOptions.repoRoot, ...LEGAL_EVIDENCE_DIR, "manifest.json");
      if (existsSync(inseeManifest) || existsSync(legalManifest)) {
        return this.evidenceOptions.repoRoot;
      }
    }
    const discovered = findRepoRoot(process.cwd());
    const discoveredInsee = path.join(discovered, ...INSEE_EVIDENCE_DIR, "manifest.json");
    const discoveredLegal = path.join(discovered, ...LEGAL_EVIDENCE_DIR, "manifest.json");
    if (existsSync(discoveredInsee) || existsSync(discoveredLegal)) {
      return discovered;
    }
    return this.evidenceOptions.repoRoot ?? discovered;
  }

  private resolveEvidence(
    needsInsee = true,
    needsLegal = true,
  ): { inseeEvidence?: InseeEvidenceRegistry; legalEvidence?: LegalEvidenceRegistry } {
    let inseeEvidence = this.evidenceOptions.inseeEvidence;
    let legalEvidence = this.evidenceOptions.legalEvidence;

    if (!needsInsee && !needsLegal) {
      return { inseeEvidence, legalEvidence };
    }

    const resolvedRoot = this.resolveEvidenceRoot();

    if (needsInsee && !inseeEvidence && resolvedRoot) {
      try {
        inseeEvidence = loadInseeEvidenceRegistry(resolvedRoot);
      } catch {
        inseeEvidence = undefined;
      }
    }

    if (needsLegal && !legalEvidence && resolvedRoot) {
      try {
        legalEvidence = loadLegalEvidenceRegistry(resolvedRoot);
      } catch {
        legalEvidence = undefined;
      }
    }

    return { inseeEvidence, legalEvidence };
  }

  /**
   * Pure read: the CURRENT evidentiary state of one page (claim lineage,
   * work products, authenticated source evidence) as digests. Used by every
   * freshness decision so unchanged HTML never implies unchanged authority.
   */
  async currentPageEvidence(
    projectId: string,
    pageIdentity: string,
    contentDigest: string,
    latestReview?: ReviewAuthority | null,
  ) {
    const claims = await this.listClaimLineage(projectId, pageIdentity, contentDigest);
    const originals = await this.listOriginalValues(projectId, pageIdentity);
    const reqs = classifyPageEvidenceRequirements(claims, originals);
    const { inseeEvidence, legalEvidence } = this.resolveEvidence(reqs.needsInsee, reqs.needsLegal);
    const pageSourceInfo = computePageSourceEvidenceDigest({ claims, originals, inseeEvidence, legalEvidence });
    const claimSetDigest = claims.length > 0 ? computeClaimSetDigest(claims) : undefined;
    const workProductSetDigest = originals.length > 0 ? computeWorkProductSetDigest(originals) : undefined;
    const rev = latestReview === undefined ? await this.latestReview(projectId, pageIdentity) : latestReview;

    const pageNeedsSources =
      reqs.needsInsee ||
      reqs.needsLegal ||
      (originals.length > 0 && originals.some((o) => (o.workProduct?.inputDatasetDigests.length ?? 0) > 0));

    if (reqs.needsInsee && (!inseeEvidence || inseeEvidence.snapshots.length === 0)) {
      pageSourceInfo.problems.push("review_authority_stale: Required INSEE evidence registry is unavailable.");
    }
    if (reqs.needsLegal && (!legalEvidence || legalEvidence.snapshots.length === 0)) {
      pageSourceInfo.problems.push("review_authority_stale: Required legal evidence registry is unavailable.");
    }

    const requiredRegistriesAvailable =
      (!reqs.needsInsee || Boolean(inseeEvidence && inseeEvidence.snapshots.length > 0)) &&
      (!reqs.needsLegal || Boolean(legalEvidence && legalEvidence.snapshots.length > 0));

    if (pageNeedsSources && !requiredRegistriesAvailable && pageSourceInfo.problems.length === 0) {
      pageSourceInfo.problems.push("review_authority_stale: Required source evidence registries are unavailable.");
    }

    const registriesAvailable = Boolean(
      (!reqs.needsInsee || inseeEvidence) && (!reqs.needsLegal || legalEvidence),
    );

    const globalDigest = computeSourceEvidenceSetDigest({ inseeEvidence, legalEvidence });
    const sourceEvidenceSetDigest =
      this.evidenceOptions.sourceEvidenceSetDigest ??
      (pageSourceInfo.referencedCount > 0 &&
      pageSourceInfo.problems.length === 0 &&
      registriesAvailable &&
      (!rev?.pageSourceEvidenceDigest || rev.pageSourceEvidenceDigest === pageSourceInfo.digest) &&
      rev?.sourceEvidenceSetDigest
        ? rev.sourceEvidenceSetDigest
        : (registriesAvailable && (inseeEvidence || legalEvidence) ? globalDigest : undefined));
    return {
      claims,
      originals,
      claimSetDigest,
      workProductSetDigest,
      pageSourceInfo,
      sourceEvidenceSetDigest,
      registriesAvailable,
      evidenceRequirements: reqs,
    };
  }

  getDb(): FactoryDb {
    return this.db;
  }

  // ---- PageIntentAuthority ----------------------------------------------------

  /**
   * Sets or updates the durable page intent authority. Idempotent when the
   * intent data is unchanged (no fake version bump).
   */
  async setPageIntentAuthority(input: {
    projectId: string;
    intent: PageIntentAuthority;
  }): Promise<PageIntentAuthorityRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return this.setPageIntentAuthorityLocked(tx, input);
    });
  }

  /** Transaction-aware internal mutation through the CALLER-provided tx. */
  async setPageIntentAuthorityLocked(
    tx: FactoryDb,
    input: { projectId: string; intent: PageIntentAuthority },
  ): Promise<PageIntentAuthorityRecord> {
    const intent = parsePageIntentAuthority(input.intent);
    if (intent.projectId !== input.projectId) {
      throw trustError("trust_authority_wrong_project", "Intent authority projectId mismatch.");
    }
    const pageIdentity = normalizePageIdentity(intent.pageIdentity);
    const normalized: PageIntentAuthority = { ...intent, pageIdentity };
    const digest = deterministicDigest(normalized);

    const [latest] = await tx
      .select()
      .from(pageIntentAuthorities)
      .where(
        and(
          eq(pageIntentAuthorities.projectId, input.projectId),
          eq(pageIntentAuthorities.pageIdentity, pageIdentity),
        ),
      )
      .orderBy(desc(pageIntentAuthorities.version))
      .limit(1);

    if (latest && latest.intentDigest === digest) return latest;

    const nextVersion = (latest?.version ?? 0) + 1;
    const id = `pia-${randomUUID()}`;
    const [inserted] = await tx
      .insert(pageIntentAuthorities)
      .values({
        id,
        projectId: input.projectId,
        pageIdentity,
        version: nextVersion,
        intentDigest: digest,
        data: normalized,
      })
      .returning();
    return inserted!;
  }

  /** Pure read: latest intent authority for a page (null when absent). */
  async getIntentAuthority(projectId: string, pageIdentity: string): Promise<PageIntentAuthority | null> {
    const norm = normalizePageIdentity(pageIdentity);
    const [row] = await this.db
      .select()
      .from(pageIntentAuthorities)
      .where(
        and(
          eq(pageIntentAuthorities.projectId, projectId),
          eq(pageIntentAuthorities.pageIdentity, norm),
        ),
      )
      .orderBy(desc(pageIntentAuthorities.version))
      .limit(1);
    return row ? (row.data as PageIntentAuthority) : null;
  }

  /** Pure read: all current intent authorities for a project (latest per page). */
  async listCurrentIntentAuthorities(projectId: string): Promise<PageIntentAuthority[]> {
    const rows = await this.db
      .select()
      .from(pageIntentAuthorities)
      .where(eq(pageIntentAuthorities.projectId, projectId))
      .orderBy(desc(pageIntentAuthorities.version));
    const seen = new Set<string>();
    const current: PageIntentAuthority[] = [];
    for (const row of rows) {
      if (seen.has(row.pageIdentity)) continue;
      seen.add(row.pageIdentity);
      current.push(row.data as PageIntentAuthority);
    }
    return current;
  }

  /**
   * Deterministic site-wide anti-cannibalization gate over stored intent
   * authorities. FAIL blocks production acceptance; REVIEW surfaces for
   * human judgment; no numeric score is produced.
   */
  cannibalizationVerdict(projectId: string): Promise<{ verdict: "PASS" | "REVIEW" | "FAIL"; findings: ReturnType<typeof checkCannibalization>["findings"] }> {
    return this.listCurrentIntentAuthorities(projectId).then((intents) => {
      const result = checkCannibalization(intents);
      return { verdict: result.verdict, findings: result.findings };
    });
  }

  // ---- ClaimLineage -----------------------------------------------------------

  /**
   * Persist claim lineage records bound to the exact accepted content
   * digest. Every record must pass the deterministic lineage verdict
   * (fail closed) before persistence.
   */
  async saveClaimLineage(input: {
    projectId: string;
    pageIdentity: string;
    contentDigest: string;
    claims: ClaimLineage[];
  }): Promise<ClaimLineageRecord[]> {
    if (!/^[0-9a-f]{64}$/.test(input.contentDigest)) {
      throw trustError("trust_lineage_invalid", "Claim lineage requires the exact accepted content digest.");
    }
    const pageIdentity = normalizePageIdentity(input.pageIdentity);
    const rows: ClaimLineageRecord[] = [];
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      for (const claim of input.claims) {
        const parsed = parseClaimLineage(claim);
        const verdict = claimLineageVerdict(parsed);
        if (verdict === "FAIL") {
          throw trustError(
            "trust_claim_lineage_invalid",
            `Claim ${parsed.claimId} fails lineage validation: ${claimLineageProblems(parsed).join("; ")}`,
          );
        }
        await tx
          .delete(claimLineageRecords)
          .where(
            and(
              eq(claimLineageRecords.projectId, input.projectId),
              eq(claimLineageRecords.pageIdentity, pageIdentity),
              eq(claimLineageRecords.contentDigest, input.contentDigest),
              eq(claimLineageRecords.claimId, parsed.claimId),
            ),
          );
        const id = `clm-${randomUUID()}`;
        const [inserted] = await tx
          .insert(claimLineageRecords)
          .values({
            id,
            projectId: input.projectId,
            pageIdentity,
            claimId: parsed.claimId,
            contentDigest: input.contentDigest,
            data: parsed,
          })
          .returning();
        rows.push(inserted!);
      }
      return rows;
    });
  }

  /** Pure read: lineage records bound to one exact content digest. */
  async listClaimLineage(projectId: string, pageIdentity: string, contentDigest: string): Promise<ClaimLineage[]> {
    const norm = normalizePageIdentity(pageIdentity);
    const rows = await this.db
      .select()
      .from(claimLineageRecords)
      .where(
        and(
          eq(claimLineageRecords.projectId, projectId),
          eq(claimLineageRecords.pageIdentity, norm),
          eq(claimLineageRecords.contentDigest, contentDigest),
        ),
      );
    return rows.map((row) => row.data as ClaimLineage);
  }

  // ---- ReviewAuthority --------------------------------------------------------

  /** Record a real review event bound to the exact content digest. */
  async recordReview(input: {
    projectId: string;
    review: ReviewAuthority;
  }): Promise<ReviewAuthorityRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return this.recordReviewLocked(tx, input);
    });
  }

  async recordReviewLocked(
    tx: FactoryDb,
    input: { projectId: string; review: ReviewAuthority },
    overrideAuditStore?: EditorialAuditStore,
  ): Promise<ReviewAuthorityRecord> {
    const review = parseReviewAuthority(input.review);
    if (review.projectId !== input.projectId) {
      throw trustError("trust_authority_wrong_project", "Review authority projectId mismatch.");
    }
    const pageIdentity = normalizePageIdentity(review.pageIdentity);

    if (
      review.authorityKind === "VERIFIED_HUMAN_REVIEW_AUTHORITY" ||
      review.reviewAuthorityKind === "VERIFIED_HUMAN_REVIEW_AUTHORITY"
    ) {
      const appEvt = review.approvalEvent;
      if (!appEvt || !appEvt.reviewEventId || !appEvt.authenticatedActorId || !appEvt.reviewAction || !appEvt.eventTimestamp) {
        throw trustError(
          "unauthenticated_human_review_rejected",
          "Direct submission of VERIFIED_HUMAN_REVIEW_AUTHORITY without a validated authenticated approval event is rejected. Approvals must originate from an authorized editorial action.",
        );
      }
      const auditStore = overrideAuditStore
        ? new EditorialAuditStore(tx, overrideAuditStore.getKeyring())
        : new EditorialAuditStore(tx, this.evidenceOptions.keyring ?? this.auditStore.getKeyring());
      const auditEvent = await auditStore.getApprovalAuditEvent(appEvt.reviewEventId, tx);
      if (!auditEvent) {
        throw trustError(
          "unauthenticated_human_review_rejected",
          `No verified server audit event found for review event "${appEvt.reviewEventId}". Direct store insertion of VERIFIED_HUMAN_REVIEW_AUTHORITY is rejected.`,
        );
      }
      if (!auditEvent.sealVerified) {
        throw trustError(
          "forged_audit_event_rejected",
          `Audit event "${appEvt.reviewEventId}" failed cryptographic verification seal check. Forged or directly injected audit events cannot certify production review authority.`,
        );
      }
      if (auditEvent.revoked || appEvt.revoked) {
        throw trustError(
          "revoked_approval_rejected",
          `Audit event "${appEvt.reviewEventId}" has been revoked. Revoked approvals cannot be recorded or used.`,
        );
      }
      if (auditEvent.isSynthetic || appEvt.isSynthetic) {
        throw trustError(
          "synthetic_approval_not_production_authority",
          `Audit event "${appEvt.reviewEventId}" was created with synthetic test credentials and cannot certify production content as human-approved.`,
        );
      }
      if (auditEvent.projectId !== input.projectId) {
        throw trustError(
          "cross_project_audit_event_rejected",
          `Audit event "${appEvt.reviewEventId}" was recorded for project "${auditEvent.projectId}", not "${input.projectId}". Cross-project approvals are rejected.`,
        );
      }
      const membershipAuthority = new ProjectMembershipAuthority(tx);
      const permissions = await membershipAuthority.getMemberPermissions(input.projectId, auditEvent.actorId, tx);
      if (!permissions.includes("EDITORIAL_REVIEW:APPROVE")) {
        throw trustError(
          "unauthorized_reviewer_actor",
          `Actor "${auditEvent.actorId}" lacks active "EDITORIAL_REVIEW:APPROVE" permission for project "${input.projectId}". Revoked or missing authorization rejects approval.`,
        );
      }
      if (
        auditEvent.contentDigest !== review.reviewedContentDigest ||
        auditEvent.claimSetDigest !== review.claimSetDigest ||
        auditEvent.sourceEvidenceSetDigest !== review.sourceEvidenceSetDigest
      ) {
        throw trustError(
          "audit_event_digest_mismatch",
          "Audit event digests do not match the submitted review authority digests. Replayed or tampered approvals are rejected.",
        );
      }
      if (auditEvent.actorId !== appEvt.authenticatedActorId) {
        throw trustError(
          "unauthenticated_principal_rejected",
          "Approval event actorId does not match server audit record.",
        );
      }
      if (appEvt.actorRole === "UNAUTHORIZED_ACTOR" || /unauthorized/i.test(appEvt.actorRole)) {
        throw trustError(
          "unauthorized_reviewer_actor",
          `Actor "${appEvt.authenticatedActorId}" with role "${appEvt.actorRole}" lacks editorial approval authorization.`,
        );
      }
      if (
        /fake|mock|dummy|injected|fabricated/i.test(appEvt.auditEventReference) ||
        /fake|mock|dummy|injected|fabricated/i.test(review.approvalEventProvenance ?? "") ||
        /fake|mock|dummy|injected|fabricated/i.test(auditEvent.auditEventReference)
      ) {
        throw trustError(
          "fake_audit_event_rejected",
          "Fake or simulated audit event references and minutes are rejected.",
        );
      }
    }
    const bound = await new TrustGovernanceStore(tx, this.evidenceOptions).currentPageEvidence(
      input.projectId,
      pageIdentity,
      review.reviewedContentDigest,
      null,
    );
    const storedReview: ReviewAuthority = {
      ...review,
      claimSetDigest: review.claimSetDigest ?? bound.claimSetDigest,
      pageSourceEvidenceDigest: review.pageSourceEvidenceDigest,
      workProductSetDigest: review.workProductSetDigest,
    };
    const [latest] = await tx
      .select()
      .from(reviewAuthorities)
      .where(
        and(
          eq(reviewAuthorities.projectId, input.projectId),
          eq(reviewAuthorities.pageIdentity, pageIdentity),
        ),
      )
      .orderBy(desc(reviewAuthorities.version))
      .limit(1);
    const nextVersion = (latest?.version ?? 0) + 1;
    const id = `rev-${randomUUID()}`;
    const [inserted] = await tx
      .insert(reviewAuthorities)
      .values({
        id,
        projectId: input.projectId,
        pageIdentity,
        version: nextVersion,
        reviewerRef: review.reviewerRef,
        reviewedContentDigest: review.reviewedContentDigest,
        reviewedAt: new Date(review.reviewedAt),
        result: review.result,
        data: { ...storedReview, pageIdentity },
      })
      .returning();
    return inserted!;
  }

  /**
   * Pure read: the CURRENT review for a page. Stale when the bound content
   * digest no longer matches the current accepted content digest.
   */
  async currentReview(
    projectId: string,
    pageIdentity: string,
    currentContentDigest: string,
    currentClaimSetDigest?: string,
    currentSourceEvidenceSetDigest?: string,
    currentPageSourceEvidenceDigest?: string,
    currentWorkProductSetDigest?: string,
    verifyBackingAuthority = false,
  ): Promise<{ review: ReviewAuthority | null; stale: boolean; reason: string | null }> {
    const norm = normalizePageIdentity(pageIdentity);
    const [row] = await this.db
      .select()
      .from(reviewAuthorities)
      .where(
        and(
          eq(reviewAuthorities.projectId, projectId),
          eq(reviewAuthorities.pageIdentity, norm),
        ),
      )
      .orderBy(desc(reviewAuthorities.version))
      .limit(1);
    if (!row) return { review: null, stale: false, reason: null };
    const review = row.data as ReviewAuthority;
    const staleness = reviewStaleness(
      review,
      currentContentDigest,
      currentClaimSetDigest,
      currentSourceEvidenceSetDigest,
      currentPageSourceEvidenceDigest,
      currentWorkProductSetDigest,
    );
    if (staleness.stale) return { review, stale: true, reason: staleness.reason };
    if (
      verifyBackingAuthority &&
      (review.authorityKind === "VERIFIED_HUMAN_REVIEW_AUTHORITY" ||
        review.reviewAuthorityKind === "VERIFIED_HUMAN_REVIEW_AUTHORITY")
    ) {
      const eventId = review.approvalEvent?.reviewEventId;
      const auditEvent = eventId
        ? await this.auditStore.getApprovalAuditEvent(eventId, this.db)
        : null;
      const permissions = auditEvent
        ? await this.membershipAuthority.getMemberPermissions(projectId, auditEvent.actorId, this.db)
        : [];
      if (
        !auditEvent ||
        !auditEvent.sealVerified ||
        auditEvent.revoked ||
        auditEvent.isSynthetic ||
        auditEvent.projectId !== projectId ||
        !permissions.includes("EDITORIAL_REVIEW:APPROVE")
      ) {
        return {
          review,
          stale: true,
          reason:
            "review_authority_stale: Backing editorial approval audit event or reviewer membership has been revoked or failed cryptographic seal verification.",
        };
      }
    }
    return { review, stale: false, reason: null };
  }

  /**
   * Pure read: the latest recorded review for a page, regardless of current digest staleness.
   */
  async latestReview(
    projectId: string,
    pageIdentity: string,
  ): Promise<ReviewAuthority | null> {
    const norm = normalizePageIdentity(pageIdentity);
    const [row] = await this.db
      .select()
      .from(reviewAuthorities)
      .where(
        and(
          eq(reviewAuthorities.projectId, projectId),
          eq(reviewAuthorities.pageIdentity, norm),
        ),
      )
      .orderBy(desc(reviewAuthorities.version))
      .limit(1);
    return row ? (row.data as ReviewAuthority) : null;
  }

  // ---- OriginalValueRecord ------------------------------------------------------

  async saveOriginalValue(input: { projectId: string; record: OriginalValueRecord }): Promise<void> {
    const parsed = originalValueRecordSchema.parse(input.record);
    const pageIdentity = normalizePageIdentity(parsed.pageIdentity);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      await tx.insert(originalValueRecords).values({
        id: `ovr-${randomUUID()}`,
        projectId: input.projectId,
        pageIdentity,
        data: { ...parsed, pageIdentity },
      });
    });
  }

  async listOriginalValues(projectId: string, pageIdentity: string): Promise<OriginalValueRecord[]> {
    const norm = normalizePageIdentity(pageIdentity);
    const rows = await this.db
      .select()
      .from(originalValueRecords)
      .where(
        and(
          eq(originalValueRecords.projectId, projectId),
          eq(originalValueRecords.pageIdentity, norm),
        ),
      )
      .orderBy(originalValueRecords.createdAt);
    // Latest record per work product / claim / kind is the active state.
    const active = new Map<string, OriginalValueRecord>();
    for (const row of rows) {
      const rec = row.data as OriginalValueRecord;
      const key = rec.workProductId
        ? `wp:${rec.workProductId}`
        : rec.lineageClaimId
          ? `claim:${rec.kind}:${rec.lineageClaimId}`
          : `kind:${rec.kind}:${rec.description}`;
      active.delete(key);
      active.set(key, rec);
    }
    return [...active.values()];
  }
}
