import { GapAuthorityReader } from "../competitors/authority.js";
import { CompetitorStore } from "../competitors/competitor-store.js";
import { ProjectIntakeStore } from "../operator/intake-store.js";
import { PageArchetypeStore, normalizePageIdentity } from "../page-authority/store.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  parseWriterPolicyData,
  parseContentBriefData,
  parsePageTarget,
  parseWriterPromptSnapshotData,
  parsePageContentProposalData,
  type WriterPolicyData,
  type ContentBriefData,
  type WriterPromptSnapshotData,
  type PageContentProposalData,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedContentGapSnapshots,
  contentBriefs,
  contentQaReports,
  acceptedPageContent,
  projectInputSnapshots,
  writerPolicies,
  writerPromptSnapshots,
  pageContentProposals,
  type WriterPolicyRecord,
  type ContentBriefRecord,
  type WriterPromptSnapshotRecord,
  type PageContentProposalRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * WriterStore — persistence for the Factory Writer Policy and the page-level
 * Content Production Brief (Macro Run 4). Semantics mirror accepted intake /
 * accepted gap snapshots:
 * - approve exact revision + exact digest -> immutable approved version;
 * - edits -> new draft version; approved versions stay inspectable;
 * - upstream accepted-input/policy/gap mutation -> dependent artifact STALE;
 * - no silent fallback on gap lineage: missing accepted gap snapshot fails
 *   closed with CONTENT_GAP_LINEAGE_MISSING unless the operator explicitly
 *   set noGapLineageAcknowledged at approval time.
 */

export interface ApprovalResult {
  id: string;
  version: number;
  digest: string;
  state: "approved";
}

function staleError(message: string): FactoryError {
  return new FactoryError("writer_artifact_stale", message);
}

function approvalError(message: string): FactoryError {
  return new FactoryError("writer_approval_failed", message);
}

export class WriterStore {
  constructor(private readonly db: FactoryDb) {}

  async gapStaleness(projectId: string, gapId: string): Promise<{ stale: boolean; reason: string | null }> {
    const competitors = new CompetitorStore(this.db);
    const [gap] = await this.db.select().from(acceptedContentGapSnapshots).where(and(eq(acceptedContentGapSnapshots.projectId, projectId), eq(acceptedContentGapSnapshots.id, gapId)));
    if (!gap) return { stale: true, reason: "Accepted gap does not exist in this project." };
    const check = await new GapAuthorityReader({ intake: new ProjectIntakeStore(this.db), competitorStore: competitors })
      .evaluateAcceptedSnapshotStaleness(projectId, gap);
    return { stale: check.stale, reason: check.staleReasons.join(" ") || null };
  }

  // ---- Factory Writer Policy -------------------------------------------------

  /**
   * Derive a writer policy draft from the LATEST accepted ProjectInputSnapshot.
   * Reuses the accepted Content Constitution — never a second editable SOT.
   */
  async deriveWriterPolicyDraft(input: { projectId: string }): Promise<WriterPolicyRecord> {
    const snapshot = await this.latestAcceptedInputSnapshot(input.projectId);
    const data = parseWriterPolicyData({
      schemaVersion: "writer-content-v1",
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputSnapshotVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      rules: (snapshot.data as { contentConstitution: Record<string, unknown> }).contentConstitution,
    });
    const policyDigest = deterministicDigest(data);
    // Idempotent derivation (mirrors the brief/snapshot draft pattern):
    // - re-deriving with an existing DRAFT updates that draft in place (same
    //   version, re-digest) instead of churning unbounded draft versions;
    // - re-deriving when the derivation is IDENTICAL to the latest approved
    //   policy returns it unchanged;
    // - otherwise (input changed vs the approved policy) a new draft version.
    const latest = await this.latestWriterPolicy(input.projectId);
    if (latest && latest.state === "draft") {
      const [row] = await this.db
        .update(writerPolicies)
        .set({
          acceptedInputSnapshotId: data.acceptedInputSnapshotId,
          acceptedInputVersion: data.acceptedInputSnapshotVersion,
          acceptedInputDigest: data.acceptedInputDigest,
          data,
          policyDigest,
        })
        .where(and(eq(writerPolicies.id, latest.id), eq(writerPolicies.state, "draft")))
        .returning();
      return row!;
    }
    if (latest && latest.state === "approved" && latest.policyDigest === policyDigest) {
      return latest;
    }
    const nextVersion = (latest?.version ?? 0) + 1;
    const id = `wpol-${randomUUID()}`;
    const [row] = await this.db
      .insert(writerPolicies)
      .values({
        id,
        projectId: input.projectId,
        version: nextVersion,
        state: "draft",
        acceptedInputSnapshotId: data.acceptedInputSnapshotId,
        acceptedInputVersion: data.acceptedInputSnapshotVersion,
        acceptedInputDigest: data.acceptedInputDigest,
        data,
        policyDigest,
      })
      .returning();
    return row!;
  }

  /**
   * Approve the exact draft revision + digest. Stale digest or non-current
   * revision fails closed. Approved policies are immutable.
   */
  async approveWriterPolicy(input: {
    projectId: string;
    policyId: string;
    expectedVersion: number;
    expectedDigest: string;
  }): Promise<ApprovalResult> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      // Lock the policy row so concurrent approvals serialize.
      const [row] = await tx
        .select()
        .from(writerPolicies)
        .where(and(eq(writerPolicies.id, input.policyId), eq(writerPolicies.projectId, input.projectId)))
        .for("update");
      if (!row) throw new FactoryError("writer_artifact_not_found", "Writer policy not found.");
      if (row.state === "approved") {
        if (row.policyDigest === input.expectedDigest) {
          return { id: row.id, version: row.version, digest: row.policyDigest, state: "approved" as const };
        }
        throw approvalError("Writer policy is already approved at a different digest.");
      }
      if (row.version !== input.expectedVersion) {
        throw approvalError(
          `Writer policy revision mismatch: expected ${input.expectedVersion}, current ${row.version}.`,
        );
      }
      // Staleness: the accepted input the policy derives from must still be
      // the latest accepted version with the same digest.
      const latest = await this.latestAcceptedInputSnapshotTx(tx, input.projectId);
      if (latest.id !== row.acceptedInputSnapshotId || latest.digest !== row.acceptedInputDigest) {
        throw staleError(
          "Writer policy is stale: the accepted ProjectInputSnapshot changed after this draft was created.",
        );
      }
      if (row.policyDigest !== input.expectedDigest) {
        throw approvalError("Writer policy digest mismatch: expected digest does not match the stored draft.");
      }
      const [updated] = await tx
        .update(writerPolicies)
        .set({ state: "approved", approvedAt: new Date() })
        .where(and(eq(writerPolicies.id, row.id), eq(writerPolicies.state, "draft")))
        .returning();
      return { id: updated!.id, version: updated!.version, digest: updated!.policyDigest, state: "approved" as const };
    });
  }

  async latestWriterPolicy(projectId: string): Promise<WriterPolicyRecord | null> {
    const [row] = await this.db
      .select()
      .from(writerPolicies)
      .where(eq(writerPolicies.projectId, projectId))
      .orderBy(desc(writerPolicies.version))
      .limit(1);
    return row ?? null;
  }

  async listWriterPolicyVersions(
    projectId: string,
  ): Promise<Array<{ id: string; version: number; state: string; digest: string; createdAt: Date }>> {
    const rows = await this.db
      .select({
        id: writerPolicies.id,
        version: writerPolicies.version,
        state: writerPolicies.state,
        digest: writerPolicies.policyDigest,
        createdAt: writerPolicies.createdAt,
      })
      .from(writerPolicies)
      .where(eq(writerPolicies.projectId, projectId))
      .orderBy(desc(writerPolicies.version));
    return rows;
  }

  async writerPolicyVersion(projectId: string, version: number): Promise<WriterPolicyRecord | null> {
    const [row] = await this.db
      .select()
      .from(writerPolicies)
      .where(and(eq(writerPolicies.projectId, projectId), eq(writerPolicies.version, version)));
    return row ?? null;
  }

  /**
   * Staleness scan: a DRAFT policy is stale when the accepted input changed;
   * an APPROVED policy never mutates — callers use latestWriterPolicy lineage
   * checks (see brief staleness) to detect dependency drift.
   */
  async writerPolicyStaleness(
    projectId: string,
    policy: WriterPolicyRecord,
  ): Promise<{ stale: boolean; reason: string | null }> {
    const latest = await this.latestAcceptedInputSnapshot(projectId);
    if (latest.id !== policy.acceptedInputSnapshotId || latest.digest !== policy.acceptedInputDigest) {
      return { stale: true, reason: "accepted ProjectInputSnapshot changed" };
    }
    return { stale: false, reason: null };
  }

  // ---- Content Production Brief ----------------------------------------------

  async saveBriefDraft(input: {
    projectId: string;
    pageTarget: unknown;
    contentBriefKeyPoints: string[];
    expectedRevision?: number | null;
    /**
     * Explicit operator acknowledgement that this brief is drafted WITHOUT an
     * accepted ContentGap snapshot. Persisted on the draft, digest-bound, and
     * must be provided again (unchanged) at approval time. The default path
     * (flag absent/false) stays REQUIRED and is unchanged.
     */
    noGapLineageAcknowledged?: boolean;
  }): Promise<{ id: string; version: number; digest: string }> {
    const pageTarget = parsePageTarget(input.pageTarget);
    const pageArchetypeStore = new PageArchetypeStore(this.db);
    let effectiveTarget = pageTarget;
    const existingArchetype = await pageArchetypeStore.getArchetype(input.projectId, pageTarget.slug);
    if (existingArchetype) {
      if (pageTarget.designBinding && pageTarget.designBinding.archetype !== existingArchetype) {
        throw new FactoryError(
          "page_archetype_conflict",
          `Content brief specifies archetype ${pageTarget.designBinding.archetype} which conflicts with durable page archetype ${existingArchetype} for ${pageTarget.slug}.`,
        );
      }
      effectiveTarget = {
        ...pageTarget,
        designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: existingArchetype },
      };
    } else if (pageTarget.designBinding) {
      await pageArchetypeStore.setPageArchetype({
        projectId: input.projectId,
        pageIdentity: pageTarget.slug,
        archetype: pageTarget.designBinding.archetype,
      });
    } else if (normalizePageIdentity(pageTarget.slug) === "home") {
      await pageArchetypeStore.setPageArchetype({
        projectId: input.projectId,
        pageIdentity: pageTarget.slug,
        archetype: "homepage",
      });
      effectiveTarget = {
        ...pageTarget,
        designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "homepage" },
      };
    }
    const snapshot = await this.latestAcceptedInputSnapshot(input.projectId);
    const policy = await this.latestWriterPolicy(input.projectId);
    if (!policy || policy.state !== "approved") {
      throw new FactoryError(
        "writer_policy_not_approved",
        "An approved Factory Writer Policy is required before a Content Production Brief can be drafted.",
      );
    }
    const acknowledged = input.noGapLineageAcknowledged === true;
    // Gap lineage: default REQUIRED (typed failure when missing). Drafting
    // without a gap snapshot is only possible with the explicit flag.
    const gap = await this.latestAcceptedGapSnapshot(input.projectId);
    if (gap) {
      const freshness = await this.gapStaleness(input.projectId, gap.id);
      if (freshness.stale) throw staleError(freshness.reason!);
    }
    if (!gap) {
      if (!acknowledged) {
        throw new FactoryError(
          "content_gap_lineage_missing",
          "No accepted ContentGap snapshot exists for this project. Accept a gap snapshot first, or explicitly acknowledge the missing gap lineage at draft and approval time.",
        );
      }
    } else {
      if (acknowledged) {
        throw approvalError(
          "noGapLineageAcknowledged is only valid when the brief has no accepted gap lineage.",
        );
      }
      if (gap.acceptedInputSnapshotId !== snapshot.id || gap.acceptedInputDigest !== snapshot.digest) {
        throw staleError("Accepted ContentGap snapshot is stale versus the current accepted ProjectInputSnapshot.");
      }
    }

    const data = this.composeBriefData({ snapshot, policy, pageTarget: effectiveTarget, keyPoints: input.contentBriefKeyPoints, gap, noGapLineageAcknowledged: acknowledged });
    const briefDigest = deterministicDigest(data);
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [current] = await tx
        .select({ id: contentBriefs.id, version: contentBriefs.version, state: contentBriefs.state })
        .from(contentBriefs)
        .where(eq(contentBriefs.projectId, input.projectId))
        .orderBy(desc(contentBriefs.version))
        .limit(1);
      if (current && current.state === "draft") {
        if (input.expectedRevision == null || current.version !== input.expectedRevision) {
          throw new FactoryError(
            "writer_approval_failed",
            `Brief draft revision mismatch: expected ${input.expectedRevision ?? "none"}, current ${current.version}.`,
          );
        }
        // Update the existing draft in place (same version, re-digest).
        await tx
          .update(contentBriefs)
          .set({
            slug: pageTarget.slug,
            data,
            briefDigest,
            acceptedInputSnapshotId: data.lineage.acceptedInputSnapshotId,
            acceptedInputVersion: data.lineage.acceptedInputSnapshotVersion,
            acceptedInputDigest: data.lineage.acceptedInputDigest,
            writerPolicyId: data.lineage.writerPolicyId,
            writerPolicyVersion: data.lineage.writerPolicyVersion,
            writerPolicyDigest: data.lineage.writerPolicyDigest,
            gapSnapshotId: data.lineage.gapSnapshotId ?? null,
            gapSnapshotVersion: data.lineage.gapSnapshotVersion ?? null,
            gapSnapshotDigest: data.lineage.gapSnapshotDigest ?? null,
            noGapLineageAcknowledged: acknowledged,
          })
          .where(eq(contentBriefs.id, current.id));
        return { id: current.id, version: current.version, digest: briefDigest };
      }
      const nextVersion = (current?.version ?? 0) + 1;
      const id = `wbrf-${randomUUID()}`;
      await tx.insert(contentBriefs).values({
        id,
        projectId: input.projectId,
        version: nextVersion,
        state: "draft",
        slug: pageTarget.slug,
        data,
        briefDigest,
        acceptedInputSnapshotId: data.lineage.acceptedInputSnapshotId,
        acceptedInputVersion: data.lineage.acceptedInputSnapshotVersion,
        acceptedInputDigest: data.lineage.acceptedInputDigest,
        writerPolicyId: data.lineage.writerPolicyId,
        writerPolicyVersion: data.lineage.writerPolicyVersion,
        writerPolicyDigest: data.lineage.writerPolicyDigest,
        gapSnapshotId: data.lineage.gapSnapshotId ?? null,
        gapSnapshotVersion: data.lineage.gapSnapshotVersion ?? null,
        gapSnapshotDigest: data.lineage.gapSnapshotDigest ?? null,
        noGapLineageAcknowledged: acknowledged,
      });
      return { id, version: nextVersion, digest: briefDigest };
    });
  }

  /**
   * Approve the exact brief revision + digest. noGapLineageAcknowledged may
   * ONLY be set at approval time, is persisted and digest-bound, and is only
   * valid when the brief genuinely has no gap lineage.
   */
  async approveBrief(input: {
    projectId: string;
    briefId: string;
    expectedVersion: number;
    expectedDigest: string;
    noGapLineageAcknowledged?: boolean;
  }): Promise<ApprovalResult> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      // Lock the brief row so concurrent approvals serialize.
      const [row] = await tx
        .select()
        .from(contentBriefs)
        .where(and(eq(contentBriefs.id, input.briefId), eq(contentBriefs.projectId, input.projectId)))
        .for("update");
      if (!row) throw new FactoryError("writer_artifact_not_found", "Content brief not found.");
      if (row.state === "approved") {
        if (row.briefDigest === input.expectedDigest) {
          return { id: row.id, version: row.version, digest: row.briefDigest, state: "approved" as const };
        }
        throw approvalError("Content brief is already approved at a different digest.");
      }
      if (row.version !== input.expectedVersion) {
        throw approvalError(`Brief revision mismatch: expected ${input.expectedVersion}, current ${row.version}.`);
      }
      const fresh = await new WriterStore(tx as unknown as FactoryDb).briefStaleness(input.projectId, row);
      if (fresh.stale) throw staleError(fresh.reason!);
      const data = parseContentBriefData(row.data);
      if (input.noGapLineageAcknowledged) {
        if (data.lineage.gapSnapshotId != null) {
          throw approvalError(
            "noGapLineageAcknowledged is only valid when the brief has no accepted gap lineage.",
          );
        }
      } else if (data.lineage.gapSnapshotId == null) {
        throw new FactoryError(
          "content_gap_lineage_missing",
          "Brief has no accepted gap lineage and no explicit noGapLineageAcknowledged was provided.",
        );
      }
      // Staleness: upstream accepted inputs/policy/gap must be unchanged.
      const latestSnapshot = await this.latestAcceptedInputSnapshotTx(tx, input.projectId);
      if (
        latestSnapshot.id !== data.lineage.acceptedInputSnapshotId ||
        latestSnapshot.digest !== data.lineage.acceptedInputDigest
      ) {
        throw staleError("Brief is stale: the accepted ProjectInputSnapshot changed.");
      }
      const [policy] = await tx
        .select()
        .from(writerPolicies)
        .where(and(eq(writerPolicies.id, data.lineage.writerPolicyId), eq(writerPolicies.projectId, input.projectId)));
      if (!policy || policy.state !== "approved" || policy.policyDigest !== data.lineage.writerPolicyDigest) {
        throw staleError("Brief is stale: the approved Factory Writer Policy changed.");
      }
      if (data.lineage.gapSnapshotId != null) {
        const [gap] = await tx
          .select()
          .from(acceptedContentGapSnapshots)
          .where(
            and(
              eq(acceptedContentGapSnapshots.id, data.lineage.gapSnapshotId),
              eq(acceptedContentGapSnapshots.projectId, input.projectId),
            ),
          );
        if (!gap || gap.snapshotDigest !== data.lineage.gapSnapshotDigest) {
          throw staleError("Brief is stale: the accepted ContentGap snapshot changed.");
        }
      }
      if (row.briefDigest !== input.expectedDigest) {
        throw approvalError("Brief digest mismatch: expected digest does not match the stored draft.");
      }
      const acknowledged = input.noGapLineageAcknowledged === true;
      const [updated] = await tx
        .update(contentBriefs)
        .set({ state: "approved", approvedAt: new Date(), noGapLineageAcknowledged: acknowledged })
        .where(and(eq(contentBriefs.id, row.id), eq(contentBriefs.state, "draft")))
        .returning();
      return { id: updated!.id, version: updated!.version, digest: updated!.briefDigest, state: "approved" as const };
    });
  }

  async latestBrief(projectId: string): Promise<ContentBriefRecord | null> {
    const [row] = await this.db
      .select()
      .from(contentBriefs)
      .where(eq(contentBriefs.projectId, projectId))
      .orderBy(desc(contentBriefs.version))
      .limit(1);
    return row ?? null;
  }

  async listBriefVersions(
    projectId: string,
  ): Promise<Array<{ id: string; version: number; state: string; digest: string; slug: string; createdAt: Date }>> {
    const rows = await this.db
      .select({
        id: contentBriefs.id,
        version: contentBriefs.version,
        state: contentBriefs.state,
        digest: contentBriefs.briefDigest,
        slug: contentBriefs.slug,
        createdAt: contentBriefs.createdAt,
      })
      .from(contentBriefs)
      .where(eq(contentBriefs.projectId, projectId))
      .orderBy(desc(contentBriefs.version));
    return rows;
  }

  async briefVersion(projectId: string, version: number): Promise<ContentBriefRecord | null> {
    const [row] = await this.db
      .select()
      .from(contentBriefs)
      .where(and(eq(contentBriefs.projectId, projectId), eq(contentBriefs.version, version)));
    return row ?? null;
  }

  async briefById(projectId: string, briefId: string): Promise<ContentBriefRecord | null> {
    const [row] = await this.db
      .select()
      .from(contentBriefs)
      .where(and(eq(contentBriefs.id, briefId), eq(contentBriefs.projectId, projectId)));
    return row ?? null;
  }

  /** Brief staleness across ALL lineage dimensions (input, policy, gap). */
  async briefStaleness(projectId: string, brief: ContentBriefRecord): Promise<{ stale: boolean; reason: string | null }> {
    const data = parseContentBriefData(brief.data);
    const latestSnapshot = await this.latestAcceptedInputSnapshot(projectId);
    if (
      latestSnapshot.id !== data.lineage.acceptedInputSnapshotId ||
      latestSnapshot.digest !== data.lineage.acceptedInputDigest
    ) {
      return { stale: true, reason: "accepted ProjectInputSnapshot changed" };
    }
    const [policy] = await this.db
      .select()
      .from(writerPolicies)
      .where(and(eq(writerPolicies.id, data.lineage.writerPolicyId), eq(writerPolicies.projectId, projectId)));
    if (!policy || policy.state !== "approved" || policy.policyDigest !== data.lineage.writerPolicyDigest) {
      return { stale: true, reason: "approved Factory Writer Policy changed" };
    }
    if (data.lineage.gapSnapshotId != null) {
      const [gap] = await this.db
        .select()
        .from(acceptedContentGapSnapshots)
        .where(
          and(
            eq(acceptedContentGapSnapshots.id, data.lineage.gapSnapshotId),
            eq(acceptedContentGapSnapshots.projectId, projectId),
          ),
        );
      if (!gap || gap.snapshotDigest !== data.lineage.gapSnapshotDigest) {
        return { stale: true, reason: "accepted ContentGap snapshot changed" };
      }
    }
    if (data.lineage.gapSnapshotId) return this.gapStaleness(projectId, data.lineage.gapSnapshotId);
    return { stale: false, reason: null };
  }

  // ---- Internals ---------------------------------------------------------------

  private composeBriefData(input: {
    snapshot: { id: string; version: number; digest: string; data: unknown };
    policy: WriterPolicyRecord;
    pageTarget: ReturnType<typeof parsePageTarget>;
    keyPoints: string[];
    /** Accepted gap snapshot, or null when drafting under an explicit no-gap-lineage acknowledgement. */
    gap: {
      id: string;
      version: number;
      snapshotDigest: string;
      data: unknown;
    } | null;
    noGapLineageAcknowledged: boolean;
  }): ContentBriefData {
    const intake = input.snapshot.data as {
      evidence: { allowedClaims: string[]; prohibitedClaims: string[]; unknownClaims: string[]; operatorFacts: string[] };
    };
    const gapData = input.gap?.data as
      | { searchSemantics: { primaryIntent: string; semanticCoverageRequirements: string[]; userNeeds: string[] } }
      | undefined;
    return parseContentBriefData({
      schemaVersion: "writer-content-v1",
      lineage: {
        acceptedInputSnapshotId: input.snapshot.id,
        acceptedInputSnapshotVersion: input.snapshot.version,
        acceptedInputDigest: input.snapshot.digest,
        writerPolicyId: input.policy.id,
        writerPolicyVersion: input.policy.version,
        writerPolicyDigest: input.policy.policyDigest,
        ...(input.gap
          ? {
              gapSnapshotId: input.gap.id,
              gapSnapshotVersion: input.gap.version,
              gapSnapshotDigest: input.gap.snapshotDigest,
            }
          : {}),
      },
      pageTarget: input.pageTarget,
      allowedClaims: intake.evidence.allowedClaims,
      prohibitedClaims: intake.evidence.prohibitedClaims,
      unknownClaims: intake.evidence.unknownClaims,
      operatorFacts: intake.evidence.operatorFacts,
      searchSemantics: {
        primaryIntent: gapData?.searchSemantics.primaryIntent ?? "no accepted gap snapshot (explicit operator acknowledgement)",
        semanticCoverageRequirements: gapData?.searchSemantics.semanticCoverageRequirements ?? [],
        userNeeds: gapData?.searchSemantics.userNeeds ?? [],
      },
      contentBriefKeyPoints: input.keyPoints,
      noGapLineageAcknowledged: input.noGapLineageAcknowledged,
    });
  }

  private async latestAcceptedInputSnapshot(projectId: string): Promise<{
    id: string;
    version: number;
    digest: string;
    data: unknown;
  }> {
    const [row] = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!row) {
      throw new FactoryError(
        "writer_input_not_accepted",
        "No accepted ProjectInputSnapshot exists for this project; accept project inputs first.",
      );
    }
    return { id: row.id, version: row.version, digest: row.digest, data: row.payload };
  }

  /** Fetch the EXACT accepted input snapshot a brief lineage binds to. */
  async acceptedInputSnapshotByLineage(
    projectId: string,
    snapshotId: string,
    version: number,
  ): Promise<{ id: string; version: number; digest: string; data: unknown } | null> {
    const [row] = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(
        and(
          eq(projectInputSnapshots.projectId, projectId),
          eq(projectInputSnapshots.id, snapshotId),
          eq(projectInputSnapshots.version, version),
        ),
      );
    if (!row) return null;
    return { id: row.id, version: row.version, digest: row.digest, data: row.payload };
  }

  private async latestAcceptedInputSnapshotTx(
    tx: FactoryDb,
    projectId: string,
  ): Promise<{ id: string; version: number; digest: string; data: unknown }> {
    const [row] = await tx
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!row) {
      throw new FactoryError("writer_input_not_accepted", "No accepted ProjectInputSnapshot exists.");
    }
    return { id: row.id, version: row.version, digest: row.digest, data: row.payload };
  }

  private async latestAcceptedGapSnapshot(
    projectId: string,
  ): Promise<{ id: string; version: number; snapshotDigest: string; acceptedInputSnapshotId: string; acceptedInputDigest: string; data: unknown } | null> {
    const [row] = await this.db
      .select()
      .from(acceptedContentGapSnapshots)
      .where(eq(acceptedContentGapSnapshots.projectId, projectId))
      .orderBy(desc(acceptedContentGapSnapshots.version))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      snapshotDigest: row.snapshotDigest,
      acceptedInputSnapshotId: row.acceptedInputSnapshotId,
      acceptedInputDigest: row.acceptedInputDigest,
      data: row.data,
    };
  }
}

// Re-export contract types for service consumers.
export type { WriterPolicyData, ContentBriefData };

// ---- WriterPromptSnapshot -----------------------------------------------------

export interface WriterSnapshotSaveResult {
  id: string;
  version: number;
  digest: string;
}

export class WriterSnapshotStore {
  constructor(private readonly db: FactoryDb) {}

  /** Compile + persist a draft snapshot from the CURRENT approved brief. */
  async compileSnapshot(input: {
    projectId: string;
    briefId: string;
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
  }): Promise<WriterSnapshotSaveResult> {
    const brief = await this.db
      .select()
      .from(contentBriefs)
      .where(and(eq(contentBriefs.id, input.briefId), eq(contentBriefs.projectId, input.projectId)))
      .limit(1);
    const briefRow = brief[0];
    if (!briefRow) throw new FactoryError("writer_artifact_not_found", "Content brief not found.");
    if (briefRow.state !== "approved") {
      throw new FactoryError("writer_policy_not_approved", "The brief must be approved before a snapshot can be compiled.");
    }
    const fresh = await new WriterStore(this.db).briefStaleness(input.projectId, briefRow);
    if (fresh.stale) throw staleError(fresh.reason!);
    const data = parseWriterPromptSnapshotData({
      schemaVersion: "writer-content-v1",
      briefId: briefRow.id,
      briefVersion: briefRow.version,
      briefDigest: briefRow.briefDigest,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      maxOutputTokens: input.maxOutputTokens,
    });
    const snapshotDigest = deterministicDigest(data);
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const currentAuthority = await new WriterStore(tx as unknown as FactoryDb).briefStaleness(input.projectId, briefRow);
      if (currentAuthority.stale) throw staleError(currentAuthority.reason!);
      const [current] = await tx
        .select({ version: writerPromptSnapshots.version, state: writerPromptSnapshots.state })
        .from(writerPromptSnapshots)
        .where(eq(writerPromptSnapshots.projectId, input.projectId))
        .orderBy(desc(writerPromptSnapshots.version))
        .limit(1);
      if (current && current.state === "draft") {
        await tx
          .update(writerPromptSnapshots)
          .set({
            briefId: data.briefId,
            briefVersion: data.briefVersion,
            briefDigest: data.briefDigest,
            systemPrompt: data.systemPrompt,
            userPrompt: data.userPrompt,
            maxOutputTokens: data.maxOutputTokens,
            data,
            snapshotDigest,
          })
          .where(
            and(
              eq(writerPromptSnapshots.projectId, input.projectId),
              eq(writerPromptSnapshots.version, current.version),
              eq(writerPromptSnapshots.state, "draft"),
            ),
          );
        const [updatedRow] = await tx
          .select({ id: writerPromptSnapshots.id })
          .from(writerPromptSnapshots)
          .where(
            and(
              eq(writerPromptSnapshots.projectId, input.projectId),
              eq(writerPromptSnapshots.version, current.version),
            ),
          );
        return { version: current.version, digest: snapshotDigest, id: updatedRow!.id };
      }
      const nextVersion = (current?.version ?? 0) + 1;
      const id = `wsnp-${randomUUID()}`;
      await tx.insert(writerPromptSnapshots).values({
        id,
        projectId: input.projectId,
        version: nextVersion,
        state: "draft",
        briefId: data.briefId,
        briefVersion: data.briefVersion,
        briefDigest: data.briefDigest,
        systemPrompt: data.systemPrompt,
        userPrompt: data.userPrompt,
        maxOutputTokens: data.maxOutputTokens,
        data,
        snapshotDigest,
      });
      return { id, version: nextVersion, digest: snapshotDigest };
    });
  }

  /**
   * Approve the exact snapshot revision + digest. Staleness: the brief the
   * snapshot was compiled from must still be the approved brief with the same
   * digest. Approved snapshots are immutable; no paid call without approval.
   */
  async approveSnapshot(input: {
    projectId: string;
    snapshotId: string;
    expectedVersion: number;
    expectedDigest: string;
  }): Promise<ApprovalResult> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [row] = await tx
        .select()
        .from(writerPromptSnapshots)
        .where(and(eq(writerPromptSnapshots.id, input.snapshotId), eq(writerPromptSnapshots.projectId, input.projectId)))
        .for("update");
      if (!row) throw new FactoryError("writer_artifact_not_found", "Writer prompt snapshot not found.");
      if (row.state === "approved") {
        if (row.snapshotDigest === input.expectedDigest) {
          return { id: row.id, version: row.version, digest: row.snapshotDigest, state: "approved" as const };
        }
        throw approvalError("Snapshot is already approved at a different digest.");
      }
      if (row.version !== input.expectedVersion) {
        throw approvalError(`Snapshot revision mismatch: expected ${input.expectedVersion}, current ${row.version}.`);
      }
      const [brief] = await tx
        .select()
        .from(contentBriefs)
        .where(and(eq(contentBriefs.id, row.briefId), eq(contentBriefs.projectId, input.projectId)));
      if (!brief || brief.state !== "approved" || brief.briefDigest !== row.briefDigest) {
        throw staleError("Snapshot is stale: the approved brief changed after this snapshot was compiled.");
      }
      const freshness = await new WriterStore(tx as unknown as FactoryDb).briefStaleness(input.projectId, brief);
      if (freshness.stale) throw staleError(freshness.reason!);
      if (row.snapshotDigest !== input.expectedDigest) {
        throw approvalError("Snapshot digest mismatch: expected digest does not match the stored draft.");
      }
      const [updated] = await tx
        .update(writerPromptSnapshots)
        .set({ state: "approved", approvedAt: new Date() })
        .where(and(eq(writerPromptSnapshots.id, row.id), eq(writerPromptSnapshots.state, "draft")))
        .returning();
      return { id: updated!.id, version: updated!.version, digest: updated!.snapshotDigest, state: "approved" as const };
    });
  }

  async latestSnapshot(projectId: string): Promise<WriterPromptSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(writerPromptSnapshots)
      .where(eq(writerPromptSnapshots.projectId, projectId))
      .orderBy(desc(writerPromptSnapshots.version))
      .limit(1);
    return row ?? null;
  }

  async snapshotVersion(projectId: string, version: number): Promise<WriterPromptSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(writerPromptSnapshots)
      .where(and(eq(writerPromptSnapshots.projectId, projectId), eq(writerPromptSnapshots.version, version)));
    return row ?? null;
  }

  async listSnapshotVersions(
    projectId: string,
  ): Promise<Array<{ id: string; version: number; state: string; digest: string; createdAt: Date }>> {
    return await this.db
      .select({
        id: writerPromptSnapshots.id,
        version: writerPromptSnapshots.version,
        state: writerPromptSnapshots.state,
        digest: writerPromptSnapshots.snapshotDigest,
        createdAt: writerPromptSnapshots.createdAt,
      })
      .from(writerPromptSnapshots)
      .where(eq(writerPromptSnapshots.projectId, projectId))
      .orderBy(desc(writerPromptSnapshots.version));
  }

  /** Snapshot staleness: bound to the exact approved brief digest AND to the
   * current approved brief — a newer approved brief makes older snapshots
   * stale (they can no longer be executed against). */
  async snapshotStaleness(
    projectId: string,
    snapshot: WriterPromptSnapshotRecord,
  ): Promise<{ stale: boolean; reason: string | null }> {
    const [brief] = await this.db
      .select()
      .from(contentBriefs)
      .where(and(eq(contentBriefs.id, snapshot.briefId), eq(contentBriefs.projectId, projectId)));
    if (!brief || brief.state !== "approved" || brief.briefDigest !== snapshot.briefDigest) {
      return { stale: true, reason: "approved brief changed" };
    }
    const latest = await this.db
      .select({ state: contentBriefs.state, briefDigest: contentBriefs.briefDigest })
      .from(contentBriefs)
      .where(and(eq(contentBriefs.projectId, projectId), eq(contentBriefs.slug, brief.slug)))
      .orderBy(desc(contentBriefs.version))
      .limit(1);
    if (latest[0] && latest[0].state === "approved" && latest[0].briefDigest !== snapshot.briefDigest) {
      return { stale: true, reason: "a newer approved brief exists" };
    }
    return new WriterStore(this.db).briefStaleness(projectId, brief);
  }

  // ---- PageContentProposal ------------------------------------------------------

  async saveProposal(input: {
    projectId: string;
    snapshotId: string;
    snapshotVersion: number;
    snapshotDigest: string;
    slug: string;
    provider: string;
    model: string;
    overrideApplied: boolean;
    overriddenChampion: string | null;
    data: unknown;
  }): Promise<{ id: string; version: number; digest: string }> {
    const data = parsePageContentProposalData(input.data);
    // The proposal MUST bind to an APPROVED snapshot at the exact digest.
    const [snapshot] = await this.db
      .select()
      .from(writerPromptSnapshots)
      .where(and(eq(writerPromptSnapshots.id, input.snapshotId), eq(writerPromptSnapshots.projectId, input.projectId)));
    if (!snapshot) throw new FactoryError("writer_artifact_not_found", "Writer prompt snapshot not found.");
    if (snapshot.state !== "approved" || snapshot.snapshotDigest !== input.snapshotDigest) {
      throw new FactoryError(
        "writer_proposal_invalid",
        "Proposal rejected: it does not bind to the exact approved WriterPromptSnapshot digest.",
      );
    }
    const proposalDigest = deterministicDigest(data);
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [bound] = await tx.select().from(writerPromptSnapshots).where(and(eq(writerPromptSnapshots.id, input.snapshotId), eq(writerPromptSnapshots.projectId, input.projectId)));
      if (!bound || bound.snapshotDigest !== input.snapshotDigest) throw staleError("Proposal snapshot lineage changed.");
      const fresh = await new WriterSnapshotStore(tx as unknown as FactoryDb).snapshotStaleness(input.projectId, bound);
      if (fresh.stale) throw staleError(fresh.reason!);
      const [current] = await tx
        .select({ version: pageContentProposals.version })
        .from(pageContentProposals)
        .where(eq(pageContentProposals.projectId, input.projectId))
        .orderBy(desc(pageContentProposals.version))
        .limit(1);
      const nextVersion = (current?.version ?? 0) + 1;
      const id = `wprp-${randomUUID()}`;
      await tx.insert(pageContentProposals).values({
        id,
        projectId: input.projectId,
        version: nextVersion,
        snapshotId: input.snapshotId,
        snapshotVersion: input.snapshotVersion,
        snapshotDigest: input.snapshotDigest,
        slug: input.slug,
        provider: input.provider,
        model: input.model,
        overrideApplied: input.overrideApplied,
        overriddenChampion: input.overriddenChampion,
        data,
        proposalDigest,
      });
      return { id, version: nextVersion, digest: proposalDigest };
    });
  }

  async latestProposal(projectId: string): Promise<PageContentProposalRecord | null> {
    const [row] = await this.db
      .select()
      .from(pageContentProposals)
      .where(eq(pageContentProposals.projectId, projectId))
      .orderBy(desc(pageContentProposals.version))
      .limit(1);
    return row ?? null;
  }

  async proposalVersion(projectId: string, version: number): Promise<PageContentProposalRecord | null> {
    const [row] = await this.db
      .select()
      .from(pageContentProposals)
      .where(and(eq(pageContentProposals.projectId, projectId), eq(pageContentProposals.version, version)));
    return row ?? null;
  }

  /** Proposal staleness: bound to the exact approved snapshot digest. */
  async proposalStaleness(
    projectId: string,
    proposal: PageContentProposalRecord,
  ): Promise<{ stale: boolean; reason: string | null }> {
    const [snapshot] = await this.db
      .select()
      .from(writerPromptSnapshots)
      .where(and(eq(writerPromptSnapshots.id, proposal.snapshotId), eq(writerPromptSnapshots.projectId, projectId)));
    if (!snapshot || snapshot.state !== "approved" || snapshot.snapshotDigest !== proposal.snapshotDigest) {
      return { stale: true, reason: "approved snapshot changed" };
    }
    return this.snapshotStaleness(projectId, snapshot);
  }
}

export type { WriterPromptSnapshotData, PageContentProposalData };

// ---- Content QA report + AcceptedPageContent ---------------------------------

export class WriterQaStore {
  constructor(private readonly db: FactoryDb) {}

  /**
   * Save the deterministic QA report for a proposal. Rows are INSERT-ONLY:
   * a stored report is never replaced, so an AcceptedPageContent row's
   * `qa_report_digest` reference can never be orphaned by a later re-run.
   * - No report yet -> insert.
   * - Re-run for the SAME proposal digest -> idempotent-identical: the FIRST
   *   stored report is returned unchanged (its verdicts are the QA history
   *   that gated acceptance).
   * - Existing row for the proposal at a DIFFERENT digest -> typed conflict
   *   (defensive: proposals are immutable, so this must never occur).
   */
  async saveQaReport(input: {
    projectId: string;
    proposalId: string;
    proposalVersion: number;
    proposalDigest: string;
    data: unknown;
  }): Promise<{ id: string; digest: string; data: unknown; reused: boolean }> {
    const { parseContentQaReportData } = await import("@factory/contracts");
    const data = parseContentQaReportData(input.data);
    const reportDigest = deterministicDigest(data);
    const [existing] = await this.db
      .select()
      .from(contentQaReports)
      .where(eq(contentQaReports.proposalId, input.proposalId));
    if (existing) {
      if (existing.proposalDigest !== input.proposalDigest) {
        throw new FactoryError(
          "writer_qa_conflict",
          "A QA report already exists for this proposal at a different digest; QA reports are insert-only and are never replaced.",
        );
      }
      return { id: existing.id, digest: existing.reportDigest, data: existing.data, reused: true };
    }
    const id = `wqar-${randomUUID()}`;
    await this.db.insert(contentQaReports).values({
      id,
      projectId: input.projectId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      proposalDigest: input.proposalDigest,
      data,
      reportDigest,
    });
    return { id, digest: reportDigest, data, reused: false };
  }

  async latestQaReport(projectId: string): Promise<{ id: string; proposalId: string; digest: string; data: unknown } | null> {
    const [row] = await this.db
      .select()
      .from(contentQaReports)
      .where(eq(contentQaReports.projectId, projectId))
      .orderBy(desc(contentQaReports.createdAt))
      .limit(1);
    if (!row) return null;
    return { id: row.id, proposalId: row.proposalId, digest: row.reportDigest, data: row.data };
  }

  /**
   * Accept the proposal as AcceptedPageContent v1 (or next version for a new
   * slug after upstream mutation). FAILS CLOSED unless:
   * - the proposal is current (not stale) and bound to an approved snapshot;
   * - the TRANSITIVE upstream lineage of the bound brief is still current
   *   (accepted ProjectInputSnapshot, approved Writer Policy, accepted gap
   *   snapshot) — an upstream mutation marks the whole chain STALE;
   * - a QA report exists for the exact proposal digest with overall != FAIL.
   */
  async acceptContent(input: {
    projectId: string;
    proposalId: string;
    expectedProposalDigest: string;
  }): Promise<{ id: string; version: number; digest: string; slug: string; proposalId: string; proposalDigest: string; qaReportDigest: string }> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [alreadyAccepted] = await tx.select().from(acceptedPageContent)
        .where(and(eq(acceptedPageContent.projectId, input.projectId), eq(acceptedPageContent.proposalId, input.proposalId)));
      if (alreadyAccepted) {
        if (alreadyAccepted.proposalDigest !== input.expectedProposalDigest) throw new FactoryError("content_accept_failed", "Proposal digest mismatch.");
        return { ...alreadyAccepted, digest: alreadyAccepted.contentDigest };
      }
      const [proposal] = await tx
        .select()
        .from(pageContentProposals)
        .where(and(eq(pageContentProposals.id, input.proposalId), eq(pageContentProposals.projectId, input.projectId)))
        .for("update");
      if (!proposal) throw new FactoryError("writer_artifact_not_found", "Proposal not found.");
      if (proposal.proposalDigest !== input.expectedProposalDigest) {
        throw new FactoryError(
          "content_accept_failed",
          "Proposal digest mismatch: expected digest does not match the stored proposal.",
        );
      }
      const proposalAuthority = await new WriterSnapshotStore(tx as unknown as FactoryDb).proposalStaleness(input.projectId, proposal);
      if (proposalAuthority.stale) throw staleError(proposalAuthority.reason!);
      // Snapshot binding must still hold.
      const [snapshot] = await tx
        .select()
        .from(writerPromptSnapshots)
        .where(and(eq(writerPromptSnapshots.id, proposal.snapshotId), eq(writerPromptSnapshots.projectId, input.projectId)));
      if (!snapshot || snapshot.state !== "approved" || snapshot.snapshotDigest !== proposal.snapshotDigest) {
        throw staleError("Proposal is stale: the approved snapshot changed.");
      }
      // Transitive upstream chain: the snapshot's bound brief must still be
      // the exact approved brief, and ITS upstream lineage (accepted intake
      // snapshot, approved writer policy, accepted gap snapshot) must still
      // be current. An upstream mutation anywhere rejects with STALE.
      const [brief] = await tx
        .select()
        .from(contentBriefs)
        .where(and(eq(contentBriefs.id, snapshot.briefId), eq(contentBriefs.projectId, input.projectId)));
      if (!brief || brief.state !== "approved" || brief.briefDigest !== snapshot.briefDigest) {
        throw staleError("Proposal is stale: the bound approved brief changed.");
      }
      const authority = await new WriterStore(tx as unknown as FactoryDb).briefStaleness(input.projectId, brief);
      if (authority.stale) throw staleError(authority.reason!);
      const briefData = parseContentBriefData(brief.data);
      const [latestInput] = await tx
        .select()
        .from(projectInputSnapshots)
        .where(eq(projectInputSnapshots.projectId, input.projectId))
        .orderBy(desc(projectInputSnapshots.version))
        .limit(1);
      if (
        !latestInput ||
        latestInput.id !== briefData.lineage.acceptedInputSnapshotId ||
        latestInput.digest !== briefData.lineage.acceptedInputDigest
      ) {
        throw staleError("Proposal is stale: the accepted ProjectInputSnapshot changed after the bound brief was created.");
      }
      const [policy] = await tx
        .select()
        .from(writerPolicies)
        .where(and(eq(writerPolicies.id, briefData.lineage.writerPolicyId), eq(writerPolicies.projectId, input.projectId)));
      if (!policy || policy.state !== "approved" || policy.policyDigest !== briefData.lineage.writerPolicyDigest) {
        throw staleError("Proposal is stale: the approved Factory Writer Policy changed.");
      }
      if (briefData.lineage.gapSnapshotId != null) {
        const [gap] = await tx
          .select()
          .from(acceptedContentGapSnapshots)
          .where(
            and(
              eq(acceptedContentGapSnapshots.id, briefData.lineage.gapSnapshotId),
              eq(acceptedContentGapSnapshots.projectId, input.projectId),
            ),
          );
        if (!gap || gap.snapshotDigest !== briefData.lineage.gapSnapshotDigest) {
          throw staleError("Proposal is stale: the accepted ContentGap snapshot changed.");
        }
      }
      // QA gate: a QA report for the exact proposal digest with overall != FAIL.
      const [qa] = await tx
        .select()
        .from(contentQaReports)
        .where(and(eq(contentQaReports.proposalId, proposal.id), eq(contentQaReports.proposalDigest, proposal.proposalDigest)));
      if (!qa) {
        throw new FactoryError("content_accept_failed", "No QA report exists for this proposal; run deterministic QA first.");
      }
      const qaData = qa.data as { overall?: string };
      if (qaData.overall === "FAIL") {
        throw new FactoryError("content_accept_failed", "QA overall verdict is FAIL; acceptance is blocked.");
      }
      // Same slug re-acceptance with the same proposal digest is idempotent.
      const [maxVersion] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${acceptedPageContent.version}), 0)` })
        .from(acceptedPageContent)
        .where(eq(acceptedPageContent.projectId, input.projectId));
      const nextVersion = (maxVersion?.maxVersion ?? 0) + 1;
      const id = `wacc-${randomUUID()}`;
      const contentDigest = deterministicDigest({
        projectId: input.projectId,
        version: nextVersion,
        proposalDigest: proposal.proposalDigest,
        qaReportDigest: qa.reportDigest,
        data: proposal.data,
      });
      try {
        await tx.insert(acceptedPageContent).values({
          id,
          projectId: input.projectId,
          version: nextVersion,
          slug: proposal.slug,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          proposalDigest: proposal.proposalDigest,
          qaReportDigest: qa.reportDigest,
          data: proposal.data,
          contentDigest,
        });
      } catch (error) {
        // Two concurrent acceptances of different slugs can race the
        // max-version allocation into UNIQUE(project_id, version). Fail
        // closed with the typed acceptance conflict instead of a raw 500.
        // drizzle-orm 0.45.x wraps driver errors in DrizzleQueryError: the
        // PostgreSQL error code lives on error.cause.code, not error.code.
        // Both shapes are checked so the typed conflict is guaranteed.
        const pgCode =
          (error as { code?: string } | null)?.code ??
          (error as { cause?: { code?: string } | null } | null)?.cause?.code;
        if (pgCode === "23505") {
          throw new FactoryError(
            "content_accept_failed",
            "Concurrent acceptance conflict on the project version sequence; retry the acceptance.",
          );
        }
        throw error;
      }
      return {
        id,
        version: nextVersion,
        digest: contentDigest,
        slug: proposal.slug,
        proposalId: proposal.id,
        proposalDigest: proposal.proposalDigest,
        qaReportDigest: qa.reportDigest,
      };
    });
  }

  async acceptedLineageQualification(projectId: string, proposalId: string): Promise<"complete" | "no-gap-waiver" | "unqualified"> {
    const [lineage] = await this.db.select({ gapId: contentBriefs.gapSnapshotId, waiver: contentBriefs.noGapLineageAcknowledged })
      .from(pageContentProposals)
      .innerJoin(writerPromptSnapshots, and(eq(writerPromptSnapshots.id, pageContentProposals.snapshotId), eq(writerPromptSnapshots.snapshotDigest, pageContentProposals.snapshotDigest), eq(writerPromptSnapshots.projectId, projectId)))
      .innerJoin(contentBriefs, and(eq(contentBriefs.id, writerPromptSnapshots.briefId), eq(contentBriefs.briefDigest, writerPromptSnapshots.briefDigest), eq(contentBriefs.projectId, projectId)))
      .where(and(eq(pageContentProposals.id, proposalId), eq(pageContentProposals.projectId, projectId)));
    return !lineage ? "unqualified" : lineage.waiver ? "no-gap-waiver" : lineage.gapId ? "complete" : "unqualified";
  }

  async acceptedContentVersions(projectId: string) {
    return this.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.projectId, projectId)).orderBy(desc(acceptedPageContent.version));
  }

  async acceptedContentById(projectId: string, id: string) {
    const [row] = await this.db.select().from(acceptedPageContent).where(and(eq(acceptedPageContent.projectId, projectId), eq(acceptedPageContent.id, id)));
    return row ?? null;
  }

  async latestAcceptedContent(
    projectId: string,
  ): Promise<{
    id: string;
    version: number;
    slug: string;
    digest: string;
    proposalId: string;
    proposalDigest: string;
    qaReportDigest: string;
    data: unknown;
    acceptedAt: Date;
  } | null> {
    const [row] = await this.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, projectId))
      .orderBy(desc(acceptedPageContent.version))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      slug: row.slug,
      digest: row.contentDigest,
      proposalId: row.proposalId,
      proposalDigest: row.proposalDigest,
      qaReportDigest: row.qaReportDigest,
      data: row.data,
      acceptedAt: row.acceptedAt,
    };
  }
}
