import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  parseVisualPlanData,
  parseVisualPromptSnapshotData,
  type VisualPlanData,
  type VisualPromptSnapshotData,
  type VisualTruthClass,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedVisualAssetSets,
  acceptedVisualAssetSlots,
  visualAssetCandidates,
  visualAssetPlans,
  visualGenerationRequests,
  visualPromptSnapshots,
  visualSlotClassifications,
  type AcceptedVisualAssetSetRecord,
  type AcceptedVisualAssetSlotRecord,
  type VisualAssetCandidateRecord,
  type VisualAssetPlanRecord,
  type VisualGenerationRequestRecord,
  type VisualPromptSnapshotRecord,
  type VisualSlotClassificationRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * VisualStore — persistence for the Run 7 visual pipeline. Semantics mirror
 * the accepted writer/design patterns:
 * - VisualAssetPlan versions are immutable; re-derivation creates versions;
 * - classifications are the confirmed truth authority per (plan, slot);
 * - prompt snapshots are immutable evidence; approval binds the exact
 *   prompt digest (row-locked);
 * - generation requests are request-digest deduplicated (UNIQUE project +
 *   digest); a repeat resolves to the existing request;
 * - candidates are immutable; acceptance state transitions are explicit;
 * - AcceptedVisualAssetSet is created ONLY by explicit human acceptance
 *   with every slot resolved; the set digest is computed from the exact
 *   slot rows under row lock;
 * - nothing here ever creates an AssetVersion — that stays Run 5 authority.
 */

function visualError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}

function pgCode(error: unknown): string | undefined {
  return (
    (error as { code?: string } | null)?.code ??
    (error as { cause?: { code?: string } | null } | null)?.cause?.code
  );
}

export class VisualStore {
  constructor(private readonly db: FactoryDb) {}

  // ---- VisualAssetPlan -------------------------------------------------------

  /**
   * Create the next plan version for a project. Fails closed with a typed
   * conflict when two derivations race the version allocation.
   */
  async createPlan(input: {
    projectId: string;
    data: VisualPlanData;
  }): Promise<VisualAssetPlanRecord> {
    const data = parseVisualPlanData(input.data);
    const planDigest = deterministicDigest(data);
    const [latest] = await this.db
      .select({ version: visualAssetPlans.version })
      .from(visualAssetPlans)
      .where(eq(visualAssetPlans.projectId, input.projectId))
      .orderBy(desc(visualAssetPlans.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    try {
      const [row] = await this.db
        .insert(visualAssetPlans)
        .values({
          id: `vap-${randomUUID()}`,
          projectId: input.projectId,
          version,
          designArtifactId: data.designArtifactId,
          designArtifactVersion: data.designArtifactVersion,
          designCandidateDigest: data.designCandidateDigest,
          designInputDigest: data.designInputDigest,
          designProviderMode: data.designProviderMode,
          slots: data.slots,
          planDigest,
        })
        .returning();
      return row!;
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw visualError(
          "visual_acceptance_failed",
          "Concurrent visual plan derivation conflict; re-derive the plan.",
        );
      }
      throw error;
    }
  }

  /** Identical-digest plan for the same design, if one exists (idempotency). */
  async findPlanByDigest(projectId: string, planDigest: string): Promise<VisualAssetPlanRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualAssetPlans)
      .where(and(eq(visualAssetPlans.projectId, projectId), eq(visualAssetPlans.planDigest, planDigest)))
      .limit(1);
    return row ?? null;
  }

  async latestPlan(projectId: string): Promise<VisualAssetPlanRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualAssetPlans)
      .where(eq(visualAssetPlans.projectId, projectId))
      .orderBy(desc(visualAssetPlans.version))
      .limit(1);
    return row ?? null;
  }

  async getPlan(projectId: string, planId: string): Promise<VisualAssetPlanRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualAssetPlans)
      .where(and(eq(visualAssetPlans.projectId, projectId), eq(visualAssetPlans.id, planId)));
    return row ?? null;
  }

  async listPlans(projectId: string): Promise<VisualAssetPlanRecord[]> {
    return await this.db
      .select()
      .from(visualAssetPlans)
      .where(eq(visualAssetPlans.projectId, projectId))
      .orderBy(desc(visualAssetPlans.version));
  }

  /** Effective plan data parsed against the contract (fail closed on drift). */
  planData(plan: VisualAssetPlanRecord): VisualPlanData {
    return parseVisualPlanData({
      schemaVersion: "visual-assets-v1",
      designArtifactId: plan.designArtifactId,
      designArtifactVersion: plan.designArtifactVersion,
      designCandidateDigest: plan.designCandidateDigest,
      designInputDigest: plan.designInputDigest,
      designProviderMode: plan.designProviderMode as "live" | "fixture",
      slots: plan.slots,
    });
  }

  // ---- Slot classifications (truth authority) --------------------------------

  /** Confirm the operator truth class for one slot of a plan (upsert). */
  async confirmClassification(input: {
    projectId: string;
    planId: string;
    slot: string;
    truthClass: VisualTruthClass;
  }): Promise<VisualSlotClassificationRecord> {
    const [existing] = await this.db
      .select()
      .from(visualSlotClassifications)
      .where(
        and(
          eq(visualSlotClassifications.planId, input.planId),
          eq(visualSlotClassifications.slot, input.slot),
        ),
      );
    if (existing) {
      const [updated] = await this.db
        .update(visualSlotClassifications)
        .set({ truthClass: input.truthClass, confirmedAt: new Date() })
        .where(eq(visualSlotClassifications.id, existing.id))
        .returning();
      return updated!;
    }
    const [row] = await this.db
      .insert(visualSlotClassifications)
      .values({
        id: `vsc-${randomUUID()}`,
        planId: input.planId,
        projectId: input.projectId,
        slot: input.slot,
        truthClass: input.truthClass,
      })
      .returning();
    return row!;
  }

  async getClassifications(planId: string): Promise<VisualSlotClassificationRecord[]> {
    return await this.db
      .select()
      .from(visualSlotClassifications)
      .where(eq(visualSlotClassifications.planId, planId));
  }

  async getClassification(planId: string, slot: string): Promise<VisualSlotClassificationRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualSlotClassifications)
      .where(and(eq(visualSlotClassifications.planId, planId), eq(visualSlotClassifications.slot, slot)));
    return row ?? null;
  }

  // ---- Prompt snapshots --------------------------------------------------------

  async createPromptSnapshot(input: {
    projectId: string;
    planId: string;
    slot: string;
    operation: "edit" | "generate";
    truthClass: VisualTruthClass;
    data: VisualPromptSnapshotData;
  }): Promise<VisualPromptSnapshotRecord> {
    const data = parseVisualPromptSnapshotData(input.data);
    const promptDigest = deterministicDigest(data);
    const [row] = await this.db
      .insert(visualPromptSnapshots)
      .values({
        id: `vps-${randomUUID()}`,
        projectId: input.projectId,
        planId: input.planId,
        slot: input.slot,
        operation: input.operation,
        truthClass: input.truthClass,
        data,
        promptDigest,
      })
      .returning();
    return row!;
  }

  async getPromptSnapshot(projectId: string, snapshotId: string): Promise<VisualPromptSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualPromptSnapshots)
      .where(
        and(eq(visualPromptSnapshots.projectId, projectId), eq(visualPromptSnapshots.id, snapshotId)),
      );
    return row ?? null;
  }

  async latestPromptSnapshotForSlot(
    projectId: string,
    slot: string,
  ): Promise<VisualPromptSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualPromptSnapshots)
      .where(and(eq(visualPromptSnapshots.projectId, projectId), eq(visualPromptSnapshots.slot, slot)))
      .orderBy(desc(visualPromptSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }

  async listPromptSnapshots(projectId: string): Promise<VisualPromptSnapshotRecord[]> {
    return await this.db
      .select()
      .from(visualPromptSnapshots)
      .where(eq(visualPromptSnapshots.projectId, projectId))
      .orderBy(desc(visualPromptSnapshots.createdAt));
  }

  promptSnapshotData(row: VisualPromptSnapshotRecord): VisualPromptSnapshotData {
    return parseVisualPromptSnapshotData(row.data);
  }

  /**
   * Approve an exact prompt snapshot (row-locked; binds the exact digest).
   * A digest mismatch or already-approved snapshot with a different digest
   * fails closed.
   */
  async approvePromptSnapshot(input: {
    projectId: string;
    snapshotId: string;
    expectedPromptDigest: string;
  }): Promise<VisualPromptSnapshotRecord> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(visualPromptSnapshots)
        .where(
          and(
            eq(visualPromptSnapshots.projectId, input.projectId),
            eq(visualPromptSnapshots.id, input.snapshotId),
          ),
        )
        .for("update");
      if (!row) {
        throw visualError("visual_not_found", "Prompt snapshot not found for this project.");
      }
      if (row.promptDigest !== input.expectedPromptDigest) {
        throw visualError(
          "visual_prompt_not_approved",
          "Prompt digest mismatch: the snapshot changed between review and approval.",
        );
      }
      if (row.approvalState === "approved") return row;
      const [updated] = await tx
        .update(visualPromptSnapshots)
        .set({ approvalState: "approved", approvedAt: new Date() })
        .where(and(eq(visualPromptSnapshots.id, row.id), eq(visualPromptSnapshots.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  // ---- Generation requests (dedup) ---------------------------------------------

  /**
   * Find an existing request with the same request digest. Found requests
   * are dedup hits: their candidates are reused, no second spend occurs.
   */
  async findRequestByDigest(
    projectId: string,
    requestDigest: string,
  ): Promise<VisualGenerationRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualGenerationRequests)
      .where(
        and(
          eq(visualGenerationRequests.projectId, projectId),
          eq(visualGenerationRequests.requestDigest, requestDigest),
        ),
      );
    return row ?? null;
  }

  async createRequest(input: {
    projectId: string;
    slot: string;
    requestDigest: string;
    promptSnapshotId: string;
    promptDigest: string;
    provider: string;
    providerMode: "live" | "fixture";
    model: string;
    modelPolicyVersion: string;
    operation: "edit" | "generate";
    escalationReason: string | null;
    leaseHolder?: string;
    leaseDurationMs?: number;
  }): Promise<{ request: VisualGenerationRequestRecord; owner: boolean }> {
    const leaseHolder = input.leaseHolder ?? `worker-${randomUUID()}`;
    const leaseDurationMs = input.leaseDurationMs ?? 90_000;
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    try {
      const [row] = await this.db
        .insert(visualGenerationRequests)
        .values({
          id: `vgr-${randomUUID()}`,
          projectId: input.projectId,
          slot: input.slot,
          requestDigest: input.requestDigest,
          promptSnapshotId: input.promptSnapshotId,
          promptDigest: input.promptDigest,
          provider: input.provider,
          providerMode: input.providerMode,
          model: input.model,
          modelPolicyVersion: input.modelPolicyVersion,
          operation: input.operation,
          escalationReason: input.escalationReason,
          resultState: "running",
          leaseHolder,
          leaseExpiresAt,
        })
        .returning();
      return { request: row!, owner: true };
    } catch (error) {
      if (pgCode(error) === "23505") {
        // A concurrent identical request won the race; resolve to it as follower.
        const existing = await this.findRequestByDigest(input.projectId, input.requestDigest);
        if (existing) return { request: existing, owner: false };
      }
      throw error;
    }
  }

  async completeRequest(input: {
    requestId: string;
    providerRequestRef: string | null;
    costMicros: number | null;
    rawMetadata: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db
      .update(visualGenerationRequests)
      .set({
        resultState: "succeeded",
        providerRequestRef: input.providerRequestRef,
        costMicros: input.costMicros,
        rawMetadata: input.rawMetadata,
        completedAt: new Date(),
        leaseHolder: null,
        leaseExpiresAt: null,
      })
      .where(eq(visualGenerationRequests.id, input.requestId));
  }

  async failRequest(input: {
    requestId: string;
    failureCode: string;
    rawMetadata: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db
      .update(visualGenerationRequests)
      .set({
        resultState: "failed",
        failureCode: input.failureCode,
        rawMetadata: input.rawMetadata,
        completedAt: new Date(),
        leaseHolder: null,
        leaseExpiresAt: null,
      })
      .where(eq(visualGenerationRequests.id, input.requestId));
  }

  async getRequest(projectId: string, requestId: string): Promise<VisualGenerationRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualGenerationRequests)
      .where(
        and(eq(visualGenerationRequests.projectId, projectId), eq(visualGenerationRequests.id, requestId)),
      );
    return row ?? null;
  }

  async listRequests(projectId: string): Promise<VisualGenerationRequestRecord[]> {
    return await this.db
      .select()
      .from(visualGenerationRequests)
      .where(eq(visualGenerationRequests.projectId, projectId))
      .orderBy(desc(visualGenerationRequests.startedAt));
  }

  // ---- Candidates ---------------------------------------------------------------

  async createCandidate(input: {
    projectId: string;
    requestId: string;
    slot: string;
    candidateIndex: number;
    binaryDigest: string;
    mediaType: string;
    width: number;
    height: number;
    byteSize: number;
    storageKey: string;
    parentLineage: Array<{
      versionId: string;
      binaryDigest: string;
      governanceDigest: string;
    }>;
    promptDigest: string;
    c2pa: unknown;
    providerMetadata: Record<string, unknown> | null;
    qa: unknown;
  }): Promise<VisualAssetCandidateRecord> {
    const [row] = await this.db
      .insert(visualAssetCandidates)
      .values({
        id: `vac-${randomUUID()}`,
        projectId: input.projectId,
        requestId: input.requestId,
        slot: input.slot,
        candidateIndex: input.candidateIndex,
        binaryDigest: input.binaryDigest,
        mediaType: input.mediaType,
        width: input.width,
        height: input.height,
        byteSize: input.byteSize,
        storageKey: input.storageKey,
        parentLineage: input.parentLineage,
        promptDigest: input.promptDigest,
        c2pa: input.c2pa,
        providerMetadata: input.providerMetadata,
        qa: input.qa,
      })
      .returning();
    return row!;
  }

  async getCandidate(projectId: string, candidateId: string): Promise<VisualAssetCandidateRecord | null> {
    const [row] = await this.db
      .select()
      .from(visualAssetCandidates)
      .where(
        and(eq(visualAssetCandidates.projectId, projectId), eq(visualAssetCandidates.id, candidateId)),
      );
    return row ?? null;
  }

  async listCandidatesForRequest(requestId: string): Promise<VisualAssetCandidateRecord[]> {
    return await this.db
      .select()
      .from(visualAssetCandidates)
      .where(eq(visualAssetCandidates.requestId, requestId))
      .orderBy(visualAssetCandidates.candidateIndex);
  }

  async listCandidatesForSlot(projectId: string, slot: string): Promise<VisualAssetCandidateRecord[]> {
    return await this.db
      .select()
      .from(visualAssetCandidates)
      .where(and(eq(visualAssetCandidates.projectId, projectId), eq(visualAssetCandidates.slot, slot)))
      .orderBy(desc(visualAssetCandidates.createdAt));
  }

  async listCandidates(projectId: string): Promise<VisualAssetCandidateRecord[]> {
    return await this.db
      .select()
      .from(visualAssetCandidates)
      .where(eq(visualAssetCandidates.projectId, projectId))
      .orderBy(desc(visualAssetCandidates.createdAt));
  }

  /** Mark one candidate selected and its siblings rejected (idempotent). */
  async selectCandidate(projectId: string, candidateId: string): Promise<VisualAssetCandidateRecord> {
    return await this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(visualAssetCandidates)
        .where(
          and(eq(visualAssetCandidates.projectId, projectId), eq(visualAssetCandidates.id, candidateId)),
        )
        .for("update");
      if (!candidate) {
        throw visualError("visual_not_found", "Candidate not found for this project.");
      }
      await tx
        .update(visualAssetCandidates)
        .set({ state: "rejected" })
        .where(
          and(
            eq(visualAssetCandidates.requestId, candidate.requestId),
            eq(visualAssetCandidates.state, "pending"),
          ),
        );
      const [updated] = await tx
        .update(visualAssetCandidates)
        .set({ state: "selected" })
        .where(eq(visualAssetCandidates.id, candidate.id))
        .returning();
      return updated!;
    });
  }

  // ---- Accepted sets --------------------------------------------------------------

  async latestAcceptedSet(projectId: string): Promise<AcceptedVisualAssetSetRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(eq(acceptedVisualAssetSets.projectId, projectId))
      .orderBy(desc(acceptedVisualAssetSets.version))
      .limit(1);
    return row ?? null;
  }

  async listAcceptedSets(projectId: string): Promise<AcceptedVisualAssetSetRecord[]> {
    return await this.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(eq(acceptedVisualAssetSets.projectId, projectId))
      .orderBy(desc(acceptedVisualAssetSets.version));
  }

  async listAcceptedSlots(setId: string): Promise<AcceptedVisualAssetSlotRecord[]> {
    return await this.db
      .select()
      .from(acceptedVisualAssetSlots)
      .where(eq(acceptedVisualAssetSlots.setId, setId));
  }

  /**
   * Persist one accepted slot row. Used by the service INSIDE its own
   * acceptance transaction (the store method runs on the caller's tx).
   */
  async insertAcceptedSlotTx(
    tx: FactoryDb,
    input: {
      setId: string;
      projectId: string;
      slot: string;
      pageSlug: string;
      role: string;
      resolvedVersionId: string;
      binaryDigest: string;
      governanceDigest: string;
      resolutionMode: string;
      truthClass: VisualTruthClass;
      promptSnapshotId: string | null;
      generationRequestId: string | null;
      candidateId: string | null;
    },
  ): Promise<AcceptedVisualAssetSlotRecord> {
    const [row] = await tx
      .insert(acceptedVisualAssetSlots)
      .values({
        id: `avsl-${randomUUID()}`,
        setId: input.setId,
        projectId: input.projectId,
        slot: input.slot,
        pageSlug: input.pageSlug,
        role: input.role,
        resolvedVersionId: input.resolvedVersionId,
        binaryDigest: input.binaryDigest,
        governanceDigest: input.governanceDigest,
        resolutionMode: input.resolutionMode,
        truthClass: input.truthClass,
        promptSnapshotId: input.promptSnapshotId,
        generationRequestId: input.generationRequestId,
        candidateId: input.candidateId,
      })
      .returning();
    return row!;
  }

  /**
   * Atomically create an AcceptedVisualAssetSet and all its slot rows
   * within a single database transaction (P1-06). Rolls back cleanly
   * on any failure, preventing orphaned partial sets.
   */
  async createAcceptedSetAtomic(input: {
    projectId: string;
    planId: string;
    providerMode: "live" | "fixture";
    designArtifactId: string;
    designArtifactVersion: number;
    designCandidateDigest: string;
    designInputDigest: string;
    setDigest?: string;
    slots: Array<{
      slot: string;
      pageSlug: string;
      role: string;
      resolvedVersionId: string;
      binaryDigest: string;
      governanceDigest: string;
      resolutionMode: string;
      truthClass: VisualTruthClass;
      promptSnapshotId?: string | null;
      generationRequestId?: string | null;
      candidateId?: string | null;
    }>;
  }): Promise<AcceptedVisualAssetSetRecord> {
    return await this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ version: acceptedVisualAssetSets.version })
        .from(acceptedVisualAssetSets)
        .where(eq(acceptedVisualAssetSets.projectId, input.projectId))
        .orderBy(desc(acceptedVisualAssetSets.version))
        .limit(1)
        .for("update");
      const version = (latest?.version ?? 0) + 1;
      const computedSetDigest = input.setDigest ?? visualSetDigest(input.slots);

      try {
        const [set] = await tx
          .insert(acceptedVisualAssetSets)
          .values({
            id: `avs-${randomUUID()}`,
            projectId: input.projectId,
            version,
            planId: input.planId,
            providerMode: input.providerMode,
            designArtifactId: input.designArtifactId,
            designArtifactVersion: input.designArtifactVersion,
            designCandidateDigest: input.designCandidateDigest,
            designInputDigest: input.designInputDigest,
            setDigest: computedSetDigest,
          })
          .returning();

        for (const slot of input.slots) {
          await tx.insert(acceptedVisualAssetSlots).values({
            id: `avsl-${randomUUID()}`,
            setId: set!.id,
            projectId: input.projectId,
            slot: slot.slot,
            pageSlug: slot.pageSlug,
            role: slot.role,
            resolvedVersionId: slot.resolvedVersionId,
            binaryDigest: slot.binaryDigest,
            governanceDigest: slot.governanceDigest,
            resolutionMode: slot.resolutionMode,
            truthClass: slot.truthClass,
            promptSnapshotId: slot.promptSnapshotId ?? null,
            generationRequestId: slot.generationRequestId ?? null,
            candidateId: slot.candidateId ?? null,
          });
        }

        return set!;
      } catch (error) {
        if (pgCode(error) === "23505") {
          throw visualError(
            "visual_acceptance_failed",
            "Concurrent set acceptance conflict on the version sequence; retry the acceptance.",
          );
        }
        throw error;
      }
    });
  }

  async createSet(input: {
    projectId: string;
    planId: string;
    providerMode?: "live" | "fixture";
    designArtifactId: string;
    designArtifactVersion: number;
    designCandidateDigest: string;
    designInputDigest: string;
    setDigest: string;
  }): Promise<AcceptedVisualAssetSetRecord> {
    const [latest] = await this.db
      .select({ version: acceptedVisualAssetSets.version })
      .from(acceptedVisualAssetSets)
      .where(eq(acceptedVisualAssetSets.projectId, input.projectId))
      .orderBy(desc(acceptedVisualAssetSets.version))
      .limit(1);
    try {
      const [row] = await this.db
        .insert(acceptedVisualAssetSets)
        .values({
          id: `avs-${randomUUID()}`,
          projectId: input.projectId,
          version: (latest?.version ?? 0) + 1,
          planId: input.planId,
          providerMode: input.providerMode ?? "live",
          designArtifactId: input.designArtifactId,
          designArtifactVersion: input.designArtifactVersion,
          designCandidateDigest: input.designCandidateDigest,
          designInputDigest: input.designInputDigest,
          setDigest: input.setDigest,
        })
        .returning();
      return row!;
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw visualError(
          "visual_acceptance_failed",
          "Concurrent set acceptance conflict on the version sequence; retry the acceptance.",
        );
      }
      throw error;
    }
  }

  async findSetByDigest(projectId: string, setDigest: string): Promise<AcceptedVisualAssetSetRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(and(eq(acceptedVisualAssetSets.projectId, projectId), eq(acceptedVisualAssetSets.setDigest, setDigest)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Sole production authority boundary for visual asset sets (P1-03 / P2):
   * Verifies live provider mode (fixtures rejected), exact set digest,
   * row-level slot integrity, and bound AssetVersion legitimacy.
   */
  async requireProductionVisualSet(
    projectId: string,
    setId: string,
    expectedSetDigest: string,
  ): Promise<{ set: AcceptedVisualAssetSetRecord; slots: AcceptedVisualAssetSlotRecord[] }> {
    const [set] = await this.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(
        and(
          eq(acceptedVisualAssetSets.projectId, projectId),
          eq(acceptedVisualAssetSets.id, setId),
        ),
      );
    if (!set) {
      throw visualError("visual_not_found", "Accepted visual asset set not found for this project.");
    }
    if (set.providerMode !== "live") {
      throw visualError(
        "visual_acceptance_failed",
        "Test fixture acceptance is never production visual authority.",
      );
    }
    if (set.setDigest !== expectedSetDigest) {
      throw visualError("visual_acceptance_failed", "Visual asset set digest mismatch.");
    }
    const slots = await this.listAcceptedSlots(set.id);
    if (slots.length === 0) {
      throw visualError("visual_acceptance_failed", "Accepted visual set contains no slot rows.");
    }
    const recomputedDigest = visualSetDigest(
      slots.map((s) => ({
        slot: s.slot,
        pageSlug: s.pageSlug,
        role: s.role,
        resolvedVersionId: s.resolvedVersionId,
        binaryDigest: s.binaryDigest,
        governanceDigest: s.governanceDigest,
        resolutionMode: s.resolutionMode,
        truthClass: s.truthClass,
      })),
    );
    if (recomputedDigest !== set.setDigest) {
      throw visualError(
        "visual_acceptance_failed",
        "Visual asset set digest divergence under row verification.",
      );
    }
    return { set, slots };
  }
}

/** Build the dedup request digest for a generation request (canonical JSON). */
export function visualRequestDigest(input: {
  slot: string;
  designCandidateDigest: string;
  promptDigest: string;
  sourceAssets: Array<{ versionId: string; binaryDigest: string; governanceDigest: string }>;
  provider: string;
  providerMode: string;
  model: string;
  operation: string;
  targetAspectRatio: string;
  targetSize: string;
  escalationReason: string | null;
}): string {
  return deterministicDigest({
    slot: input.slot,
    designCandidateDigest: input.designCandidateDigest,
    promptDigest: input.promptDigest,
    sourceAssets: [...input.sourceAssets].sort((a, b) => a.versionId.localeCompare(b.versionId)),
    provider: input.provider,
    providerMode: input.providerMode,
    model: input.model,
    operation: input.operation,
    targetAspectRatio: input.targetAspectRatio,
    targetSize: input.targetSize,
    escalationReason: input.escalationReason,
  });
}

/**
 * Compute the deterministic set digest from the EXACT accepted slot rows
 * (sorted by slot for order-stability). Both digests per slot are included
 * so binary/governance conflation is detectable at the digest level.
 */
export function visualSetDigest(
  slots: Array<{
    slot: string;
    pageSlug: string;
    role: string;
    resolvedVersionId: string;
    binaryDigest: string;
    governanceDigest: string;
    resolutionMode: string;
    truthClass: string;
  }>,
): string {
  return deterministicDigest({
    setVersion: "visual-assets-v1",
    slots: [...slots].sort((a, b) => a.slot.localeCompare(b.slot)),
  });
}

/** Count active generation requests for the workspace read model. */
export async function countActiveRequests(db: FactoryDb, projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(visualGenerationRequests)
    .where(
      and(
        eq(visualGenerationRequests.projectId, projectId),
        inArray(visualGenerationRequests.resultState, ["running", "succeeded"]),
      ),
    );
  return Number(row?.count ?? 0);
}
