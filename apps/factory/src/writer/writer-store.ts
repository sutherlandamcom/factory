import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  parseWriterPolicyData,
  parseContentBriefData,
  parsePageTarget,
  type WriterPolicyData,
  type ContentBriefData,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedContentGapSnapshots,
  contentBriefs,
  projectInputSnapshots,
  writerPolicies,
  type WriterPolicyRecord,
  type ContentBriefRecord,
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
    const nextVersion =
      ((await this.db
        .select({ maxVersion: sql<number>`coalesce(max(${writerPolicies.version}), 0)` })
        .from(writerPolicies)
        .where(eq(writerPolicies.projectId, input.projectId)))[0]?.maxVersion ?? 0) + 1;
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
  }): Promise<{ id: string; version: number; digest: string }> {
    const pageTarget = parsePageTarget(input.pageTarget);
    const snapshot = await this.latestAcceptedInputSnapshot(input.projectId);
    const policy = await this.latestWriterPolicy(input.projectId);
    if (!policy || policy.state !== "approved") {
      throw new FactoryError(
        "writer_policy_not_approved",
        "An approved Factory Writer Policy is required before a Content Production Brief can be drafted.",
      );
    }
    // Gap lineage: default REQUIRED (typed failure when missing).
    const gap = await this.latestAcceptedGapSnapshot(input.projectId);
    if (!gap) {
      throw new FactoryError(
        "content_gap_lineage_missing",
        "No accepted ContentGap snapshot exists for this project. Accept a gap snapshot first, or explicitly acknowledge the missing gap lineage at approval time.",
      );
    }
    if (gap.acceptedInputSnapshotId !== snapshot.id || gap.acceptedInputDigest !== snapshot.digest) {
      throw staleError("Accepted ContentGap snapshot is stale versus the current accepted ProjectInputSnapshot.");
    }

    const data = this.composeBriefData({ snapshot, policy, pageTarget, keyPoints: input.contentBriefKeyPoints, gap });
    const briefDigest = deterministicDigest(data);
    return await this.db.transaction(async (tx) => {
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
        noGapLineageAcknowledged: false,
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
    return { stale: false, reason: null };
  }

  // ---- Internals ---------------------------------------------------------------

  private composeBriefData(input: {
    snapshot: { id: string; version: number; digest: string; data: unknown };
    policy: WriterPolicyRecord;
    pageTarget: ReturnType<typeof parsePageTarget>;
    keyPoints: string[];
    gap: {
      id: string;
      version: number;
      snapshotDigest: string;
      data: unknown;
    };
  }): ContentBriefData {
    const intake = input.snapshot.data as {
      evidence: { allowedClaims: string[]; prohibitedClaims: string[]; unknownClaims: string[]; operatorFacts: string[] };
    };
    const gapData = input.gap.data as {
      searchSemantics: { primaryIntent: string; semanticCoverageRequirements: string[]; userNeeds: string[] };
    };
    return parseContentBriefData({
      schemaVersion: "writer-content-v1",
      lineage: {
        acceptedInputSnapshotId: input.snapshot.id,
        acceptedInputSnapshotVersion: input.snapshot.version,
        acceptedInputDigest: input.snapshot.digest,
        writerPolicyId: input.policy.id,
        writerPolicyVersion: input.policy.version,
        writerPolicyDigest: input.policy.policyDigest,
        gapSnapshotId: input.gap.id,
        gapSnapshotVersion: input.gap.version,
        gapSnapshotDigest: input.gap.snapshotDigest,
      },
      pageTarget: input.pageTarget,
      allowedClaims: intake.evidence.allowedClaims,
      prohibitedClaims: intake.evidence.prohibitedClaims,
      unknownClaims: intake.evidence.unknownClaims,
      operatorFacts: intake.evidence.operatorFacts,
      searchSemantics: {
        primaryIntent: gapData.searchSemantics.primaryIntent,
        semanticCoverageRequirements: gapData.searchSemantics.semanticCoverageRequirements,
        userNeeds: gapData.searchSemantics.userNeeds,
      },
      contentBriefKeyPoints: input.keyPoints,
      noGapLineageAcknowledged: false,
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
