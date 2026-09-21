import { PageAuthorityReader } from "../writer/page-authority.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  DESIGN_SCHEMA_VERSION_V2,
  PAGE_ARCHETYPE_BINDING_POLICY_V1,
  parseDesignCandidateData,
  parseDesignCandidateAnyVersion,
  parseDesignInputSnapshotData,
  parseDesignInputSnapshotAnyVersion,
  isDesignInputSnapshotV2,
  isDesignCandidateV2,
  type DesignCandidateData,
  type DesignCandidateDataV2,
  type DesignInputSnapshotData,
  type DesignInputSnapshotDataV2,
  type DesignStaleness,
  type DesignStalenessCode,
} from "@factory/contracts";
import { derivePageArchetype, PAGE_ARCHETYPE_POLICY_VERSION } from "../production/page-archetype.js";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedDesignArtifacts,
  acceptedPageContent,
  acceptedVisualAssetSets,
  acceptedVisualAssetSlots,
  assetPageAssignments,
  assetVersions,
  designArtifactRefs,
  designCandidates,
  designInputSnapshots,
  projectInputSnapshots,
  visualAssetCandidates,
  visualAssetPlans,
  visualGenerationRequests,
  visualPromptSnapshots,
  visualSlotResolutions,
  type AcceptedDesignArtifactRecord,
  type DesignCandidateRecord,
  type DesignInputSnapshotRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * DesignStore — persistence for the Run 6 design pipeline. Semantics mirror
 * the accepted writer/intake patterns:
 * - immutable DesignInputSnapshot binds exact upstream digests;
 * - candidates are immutable evidence; approval transitions pending ->
 *   accepted | rejected bind the exact candidate digest (row-locked);
 * - AcceptedDesignArtifact is created ONLY by explicit human acceptance of
 *   an exact candidate; bind-time digests are copied so staleness never
 *   silently tracks mutable "latest" state;
 * - staleness is computed against CURRENT upstream digests, never mutated.
 */

function staleError(message: string): FactoryError {
  return new FactoryError("design_input_stale", message);
}
function approvalError(message: string): FactoryError {
  return new FactoryError("design_approval_failed", message);
}
/** Not-found errors use the operator contract's single design_not_found code. */
function designNotFound(message: string): FactoryError {
  return new FactoryError("design_not_found", message);
}

export type { DesignStaleness, DesignStalenessCode };

export class DesignStore {
  constructor(private readonly db: FactoryDb) {}

  // ---- DesignInputSnapshot ---------------------------------------------------

  /**
   * Derive a design input snapshot from CURRENT accepted upstream authority:
   * latest accepted ProjectInputSnapshot + all AcceptedPageContent rows +
   * all approved asset assignments (exact approved versions). Fails closed
   * when no accepted project inputs exist. Re-derivation is idempotent on
   * identical digests; changed upstream creates the next version.
   */
  async deriveInputSnapshotDraft(input: { projectId: string }): Promise<DesignInputSnapshotRecord> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return new DesignStore(tx as unknown as FactoryDb).deriveInputSnapshotDraftLocked(input);
    });
  }

  private async deriveInputSnapshotDraftLocked(input: { projectId: string }): Promise<DesignInputSnapshotRecord> {
    const [inputSnapshot] = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, input.projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!inputSnapshot) {
      throw new FactoryError(
        "design_input_not_accepted",
        "No accepted ProjectInputSnapshot exists for this project; accept project inputs first.",
      );
    }

    const contentRows = (await new PageAuthorityReader(this.db).currentPages(input.projectId)).sort((a,b) => a.slug.localeCompare(b.slug));
    for (const row of contentRows) await new PageAuthorityReader(this.db).requireCurrent(input.projectId, row);

    const assignmentRows = await this.db
      .select({
        versionId: assetPageAssignments.versionId,
        binaryDigest: assetPageAssignments.binaryDigest,
        governanceDigest: assetPageAssignments.versionDigest,
        approvedGovernanceDigest: assetVersions.governanceDigest,
        approvedBinaryDigest: assetVersions.binaryDigest,
        approvalState: assetVersions.approvalState,
        assetProjectId: assetVersions.projectId,
        acceptedPageContentId: assetPageAssignments.acceptedPageContentId,
        acceptedPageContentVersion: assetPageAssignments.acceptedPageContentVersion,
        acceptedPageContentDigest: assetPageAssignments.acceptedPageContentDigest,
        pageSlug: assetPageAssignments.pageSlug,
        role: assetPageAssignments.role,
        versionNumber: assetVersions.version,
      })
      .from(assetPageAssignments)
      .innerJoin(assetVersions, eq(assetPageAssignments.versionId, assetVersions.id))
      .where(eq(assetPageAssignments.projectId, input.projectId))
      .orderBy(assetPageAssignments.pageSlug, assetPageAssignments.role);

    if (assignmentRows.some((row) => !validAssignmentAuthority(row, input.projectId) || !contentRows.some(page => page.id === row.acceptedPageContentId && page.version === row.acceptedPageContentVersion && page.contentDigest === row.acceptedPageContentDigest && page.slug === row.pageSlug))) {
      throw staleError("An asset assignment no longer matches its exact approved binary/governance authority.");
    }

    const intake = inputSnapshot.payload as Record<string, unknown>;
    const brand = (intake["brand"] ?? {}) as Record<string, unknown>;
    const audience = (intake["audience"] ?? {}) as Record<string, unknown>;
    const designRefs = (intake["designReferences"] ?? {}) as Record<string, unknown>;

    const brandBlock = {
      facts: brand["facts"] ?? [],
      positioning: brand["positioning"] ?? "",
      tone: brand["tone"] ?? "",
      visualIdentityNotes: brand["visualIdentityNotes"] ?? "",
    };
    const audienceBlock = {
      segments: audience["segments"] ?? [],
      needs: audience["needs"] ?? [],
      decisionContext: audience["decisionContext"] ?? "",
    };
    const referencesBlock = {
      referenceUrls: designRefs["referenceUrls"] ?? [],
      antiReferenceUrls: designRefs["antiReferenceUrls"] ?? [],
      learn: designRefs["learn"] ?? [],
      avoid: designRefs["avoid"] ?? [],
      preferredPerception: designRefs["preferredPerception"] ?? "",
    };
    // UX requirements are derived from the accepted evidence/conversion
    // intent — deterministic projection, not provider-invented content.
    const uxRequirements = designUxRequirements(intake);
    const assetRefs = assignmentRows.map((row) => ({
      versionId: row.versionId,
      binaryDigest: row.binaryDigest,
      governanceDigest: row.governanceDigest,
      acceptedPageContentId: row.acceptedPageContentId,
      acceptedPageContentVersion: row.acceptedPageContentVersion,
      acceptedPageContentDigest: row.acceptedPageContentDigest,
      pageSlug: row.pageSlug,
      role: row.role,
    }));
    const representativePages = deriveRepresentativePages(contentRows);

    // Snapshot schema version: design-v2 scopes the snapshot to
    // DESIGN-DEFINING material (representative pages only) and records the
    // whole page inventory as typed archetype bindings. design-v1 keeps the
    // exact historical whole-inventory semantics (never reinterpreted).
    const designSchemaVersion = designSnapshotSchemaVersion(input.projectId);
    const data =
      designSchemaVersion === DESIGN_SCHEMA_VERSION_V2
        ? parseDesignInputSnapshotAnyVersion({
            schemaVersion: DESIGN_SCHEMA_VERSION_V2,
            acceptedInputSnapshotId: inputSnapshot.id,
            acceptedInputSnapshotVersion: inputSnapshot.version,
            acceptedInputDigest: inputSnapshot.digest,
            brand: brandBlock,
            audience: audienceBlock,
            references: referencesBlock,
            uxRequirements,
            // design-defining content ONLY: the representative pages.
            contentRefs: representativePages.map((representative) => {
              const row = contentRows.find((entry) => entry.slug === representative.slug);
              if (!row) throw staleError(`Representative page ${representative.slug} disappeared while deriving the design input snapshot.`);
              return { id: row.id, version: row.version, slug: row.slug, contentDigest: row.contentDigest };
            }),
            // design-defining assets ONLY: assets belonging to representative pages.
            assetRefs: assetRefs.filter((ref) => representativePages.some((r) => r.slug === ref.pageSlug)),
            archetypes: deriveArchetypes(contentRows.map((row) => row.slug)),
            representativePages,
            // Whole current page inventory -> typed archetype bindings
            // (fail-closed derivation; provenance record, not runtime truth).
            pageArchetypeBindings: contentRows.map((row) => ({
              slug: row.slug,
              archetype: derivePageArchetype(
                row.slug,
                deriveArchetypes(contentRows.map((entry) => entry.slug)),
              ).archetype,
              contentDigest: row.contentDigest,
            })),
            pageArchetypeBindingPolicy: PAGE_ARCHETYPE_BINDING_POLICY_V1,
          })
        : parseDesignInputSnapshotData({
            schemaVersion: "design-v1",
            acceptedInputSnapshotId: inputSnapshot.id,
            acceptedInputSnapshotVersion: inputSnapshot.version,
            acceptedInputDigest: inputSnapshot.digest,
            brand: brandBlock,
            audience: audienceBlock,
            references: referencesBlock,
            uxRequirements,
            contentRefs: contentRows.map((row) => ({
              id: row.id,
              version: row.version,
              slug: row.slug,
              contentDigest: row.contentDigest,
            })),
            assetRefs,
            archetypes: deriveArchetypes(contentRows.map((row) => row.slug)),
            // Page-exact copy routing: each archetype binds exactly one
            // representative accepted page (deterministic selection below).
            representativePages,
          });

    const inputDigest = deterministicDigest(data);

    // Idempotent derivation (mirrors writer policy draft pattern):
    // identical digest to latest -> return latest; latest is a draft ->
    // update in place; otherwise new version.
    const [latest] = await this.db
      .select()
      .from(designInputSnapshots)
      .where(eq(designInputSnapshots.projectId, input.projectId))
      .orderBy(desc(designInputSnapshots.version))
      .limit(1);
    if (latest && latest.inputDigest === inputDigest) {
      return latest;
    }
    if (latest) {
      const nextVersion = latest.version + 1;
      try {
        const [row] = await this.db
          .insert(designInputSnapshots)
          .values({
            id: `dsi-${randomUUID()}`,
            projectId: input.projectId,
            version: nextVersion,
            data,
            inputDigest,
          })
          .returning();
        return row!;
      } catch (error) {
        // Two concurrent derivations can race the version allocation into
        // UNIQUE(project_id, version). Fail closed with the typed conflict
        // instead of a raw 500 (Run 5 QA precedent). drizzle-orm 0.45.x
        // wraps driver errors in DrizzleQueryError: the PostgreSQL code
        // lives on error.cause.code, not error.code.
        const pgCode =
          (error as { code?: string } | null)?.code ??
          (error as { cause?: { code?: string } | null } | null)?.cause?.code;
        if (pgCode === "23505") {
          throw new FactoryError(
            "design_approval_failed",
            "Concurrent design input derivation conflict; re-derive the snapshot.",
          );
        }
        throw error;
      }
    }
    try {
      const [row] = await this.db
        .insert(designInputSnapshots)
        .values({
          id: `dsi-${randomUUID()}`,
          projectId: input.projectId,
          version: 1,
          data,
          inputDigest,
        })
        .returning();
      return row!;
    } catch (error) {
      const pgCode =
        (error as { code?: string } | null)?.code ??
        (error as { cause?: { code?: string } | null } | null)?.cause?.code;
      if (pgCode === "23505") {
        throw new FactoryError(
          "design_approval_failed",
          "Concurrent design input derivation conflict; re-derive the snapshot.",
        );
      }
      throw error;
    }
  }

  async latestInputSnapshot(projectId: string): Promise<DesignInputSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(designInputSnapshots)
      .where(eq(designInputSnapshots.projectId, projectId))
      .orderBy(desc(designInputSnapshots.version))
      .limit(1);
    return row ?? null;
  }

  /**
   * Snapshot schema version for NEW derivations in this project. design-v2
   * activates when the project opts in via trusted server configuration
   * (FACTORY_DESIGN_SNAPSHOT_SCHEMA); the default remains design-v1 so
   * existing behavior and historical semantics never change silently.
   */
  designSnapshotSchemaVersion(projectId: string): "design-v1" | "design-v2" {
    return designSnapshotSchemaVersion(projectId);
  }

  async getInputSnapshot(projectId: string, snapshotId: string): Promise<DesignInputSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(designInputSnapshots)
      .where(
        and(eq(designInputSnapshots.projectId, projectId), eq(designInputSnapshots.id, snapshotId)),
      );
    return row ?? null;
  }

  async listInputSnapshots(projectId: string): Promise<DesignInputSnapshotRecord[]> {
    return await this.db
      .select()
      .from(designInputSnapshots)
      .where(eq(designInputSnapshots.projectId, projectId))
      .orderBy(desc(designInputSnapshots.version));
  }

  /** Accepted page content rows for copy resolution (digest-verified upstream). */
  async getAcceptedContentForProject(projectId: string): Promise<
    Array<{ id: string; version: number; slug: string; contentDigest: string; data: unknown }>
  > {
    return new PageAuthorityReader(this.db).currentPages(projectId);
  }


  async inputSnapshotStaleness(
    projectId: string,
    snapshot: DesignInputSnapshotRecord,
  ): Promise<DesignStaleness> {
    return this.inputSnapshotStalenessTx(this.db, projectId, snapshot);
  }

  /**
   * Strict Run 7 replacement authorization for `RUN7_EXACT_ASSET_REPLACED`.
   *
   * The ENTIRE transition must be provable from durable authority — an
   * arbitrary approved assignment mutation is NEVER Run7-authorized:
   *
   * 1. A VisualAssetPlan slot planned exactly this old binding
   *    (pageSlug/role/existingVersionId == the OLD design asset ref).
   * 2. The CURRENT assignment equals the exact Run 7 resolution evidence:
   *    (a) post-acceptance — the accepted set's slot row for the same
   *        page/role binds the exact current versionId + binaryDigest +
   *        governanceDigest; or
   *    (b) pre-set-acceptance — a durable VisualSlotResolution record for that
   *        plan slot (bound to the plan through planId, slot, pageSlug, role,
   *        matching toVersionId, toBinaryDigest, and toGovernanceDigest).
   *        This covers all four resolution modes symmetrically (reuse_real,
   *        deterministic_transform, ai_edit, ai_generate) and is never heuristic
   *        inference.
   *
   * Any gap (no plan slot, no set row, no durable resolution, digest
   * mismatch, wrong slot) fails closed to ASSET_ASSIGNMENT_CHANGED.
   */
  private async isAuthorizedPlanReplacement(
    projectId: string,
    ref: { pageSlug: string; role: string; versionId: string },
    current: {
      versionId: string;
      binaryDigest: string;
      governanceDigest: string;
      approvalState: string;
      assetProjectId: string;
    },
    tx: FactoryDb = this.db,
  ): Promise<boolean> {
    if (current.approvalState !== "approved" || current.assetProjectId !== projectId) {
      return false;
    }
    // Step 1: a plan slot that planned exactly this old->new transition.
    const [plan] = await tx
      .select({ id: visualAssetPlans.id, slots: visualAssetPlans.slots })
      .from(visualAssetPlans)
      .where(eq(visualAssetPlans.projectId, projectId))
      .orderBy(desc(visualAssetPlans.version))
      .limit(1);
    if (!plan || !plan.slots) return false;
    const slots = plan.slots as Array<{ slot: string; pageSlug: string; role: string; existingVersionId?: string | null }>;
    if (!Array.isArray(slots)) return false;
    const plannedSlot = slots.find(
      (s) => s.pageSlug === ref.pageSlug && s.role === ref.role && s.existingVersionId === ref.versionId,
    );
    if (!plannedSlot) return false;

    // Step 2a: the current assignment equals the exact accepted Run 7
    // resolution for that slot (latest AcceptedVisualAssetSet bound to the
    // plan; slot row identity + both digests must match exactly).
    const [set] = await tx
      .select({ id: acceptedVisualAssetSets.id })
      .from(acceptedVisualAssetSets)
      .where(
        and(
          eq(acceptedVisualAssetSets.projectId, projectId),
          eq(acceptedVisualAssetSets.planId, plan.id),
        ),
      )
      .orderBy(desc(acceptedVisualAssetSets.version))
      .limit(1);
    if (set) {
      const [slotRow] = await tx
        .select({
          resolvedVersionId: acceptedVisualAssetSlots.resolvedVersionId,
          binaryDigest: acceptedVisualAssetSlots.binaryDigest,
          governanceDigest: acceptedVisualAssetSlots.governanceDigest,
        })
        .from(acceptedVisualAssetSlots)
        .where(
          and(
            eq(acceptedVisualAssetSlots.setId, set.id),
            eq(acceptedVisualAssetSlots.projectId, projectId),
            eq(acceptedVisualAssetSlots.pageSlug, ref.pageSlug),
            eq(acceptedVisualAssetSlots.role, ref.role),
          ),
        )
        .limit(1);
      if (
        slotRow &&
        slotRow.resolvedVersionId === current.versionId &&
        slotRow.binaryDigest === current.binaryDigest &&
        slotRow.governanceDigest === current.governanceDigest
      ) {
        return true;
      }
      return false;
    }

    // Step 2b: pre-acceptance durable Run 7 resolution record — the
    // durable slot resolution for this plan slot, covering all 4 resolution
    // modes symmetrically (reuse_real, deterministic_transform, ai_edit, ai_generate).
    const [resolution] = await tx
      .select({
        id: visualSlotResolutions.id,
        fromVersionId: visualSlotResolutions.fromVersionId,
        toVersionId: visualSlotResolutions.toVersionId,
        toBinaryDigest: visualSlotResolutions.toBinaryDigest,
        toGovernanceDigest: visualSlotResolutions.toGovernanceDigest,
      })
      .from(visualSlotResolutions)
      .where(
        and(
          eq(visualSlotResolutions.projectId, projectId),
          eq(visualSlotResolutions.planId, plan.id),
          eq(visualSlotResolutions.slot, plannedSlot.slot),
          eq(visualSlotResolutions.pageSlug, ref.pageSlug),
          eq(visualSlotResolutions.role, ref.role),
          eq(visualSlotResolutions.toVersionId, current.versionId),
          eq(visualSlotResolutions.toBinaryDigest, current.binaryDigest),
          eq(visualSlotResolutions.toGovernanceDigest, current.governanceDigest),
        ),
      )
      .limit(1);

    if (!resolution) return false;
    if (ref.versionId && resolution.fromVersionId && resolution.fromVersionId !== ref.versionId) {
      return false;
    }
    return true;
  }


  async recordArtifactRefs(input: {
    projectId: string;
    candidateId: string;
    artifacts: Array<{ kind: string; digest: string }>;
  }): Promise<void> {
    if (input.artifacts.length === 0) return;
    await this.db
      .insert(designArtifactRefs)
      .values(
        input.artifacts.map((artifact) => ({
          id: `dar-${randomUUID()}`,
          projectId: input.projectId,
          candidateId: input.candidateId,
          artifactKind: artifact.kind,
          artifactDigest: artifact.digest,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * TRUE when the project holds an authorized reference to the artifact
   * digest (through any of its design candidates). This is the
   * project-scoped authorization check for artifact access.
   */
  async projectReferencesArtifact(projectId: string, digest: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: designArtifactRefs.id })
      .from(designArtifactRefs)
      .where(and(eq(designArtifactRefs.projectId, projectId), eq(designArtifactRefs.artifactDigest, digest)))
      .limit(1);
    return row !== undefined;
  }

  async createCandidate(input: {
    projectId: string;
    inputSnapshot: DesignInputSnapshotRecord;
    data: DesignCandidateData | DesignCandidateDataV2;
  }): Promise<DesignCandidateRecord> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const store = new DesignStore(tx as unknown as FactoryDb);
      const freshness = await store.inputSnapshotStaleness(input.projectId, input.inputSnapshot);
      if (freshness.stale) throw staleError(freshness.reason!);
      return store.createCandidateLocked(input);
    });
  }

  private async createCandidateLocked(input: { projectId: string; inputSnapshot: DesignInputSnapshotRecord; data: DesignCandidateData | DesignCandidateDataV2 }): Promise<DesignCandidateRecord> {
    const data = parseDesignCandidateAnyVersion(input.data);
    const snapshotData = parseDesignInputSnapshotAnyVersion(input.inputSnapshot.data);
    if (input.inputSnapshot.projectId !== input.projectId || deterministicDigest(snapshotData) !== input.inputSnapshot.inputDigest) {
      throw staleError("Design input snapshot identity/digest is invalid.");
    }
    // Snapshot/candidate schema versions must agree: a v2 candidate is only
    // valid against a v2 snapshot (which carries the archetype bindings the
    // candidate's visual-role requirements derive from).
    if (isDesignCandidateV2(data) !== isDesignInputSnapshotV2(snapshotData)) {
      throw staleError("Design candidate schemaVersion does not match its bound input snapshot schemaVersion.");
    }
    validateAssetLineage(data, snapshotData);
    const candidateDigest = deterministicDigest(data);
    const [row] = await this.db
      .insert(designCandidates)
      .values({
        id: `dsn-${randomUUID()}`,
        projectId: input.projectId,
        inputSnapshotId: input.inputSnapshot.id,
        inputSnapshotVersion: input.inputSnapshot.version,
        inputDigest: input.inputSnapshot.inputDigest,
        provider: input.data.provider,
        providerMode: input.data.providerMode,
        providerProjectName: input.data.providerProjectName,
        data: input.data,
        candidateDigest,
      })
      .returning();
    return row!;
  }

  async getCandidate(projectId: string, candidateId: string): Promise<DesignCandidateRecord | null> {
    const [row] = await this.db
      .select()
      .from(designCandidates)
      .where(and(eq(designCandidates.projectId, projectId), eq(designCandidates.id, candidateId)));
    return row ?? null;
  }

  async listCandidates(projectId: string): Promise<DesignCandidateRecord[]> {
    return await this.db
      .select()
      .from(designCandidates)
      .where(eq(designCandidates.projectId, projectId))
      .orderBy(desc(designCandidates.createdAt));
  }

  /**
   * Accept an exact candidate (row-locked state transition binding the exact
   * digest). Creates the immutable AcceptedDesignArtifact. Rejection path is
   * separate; a rejected candidate can never become accepted.
   */
  async acceptCandidate(input: {
    projectId: string;
    candidateId: string;
    expectedCandidateDigest: string;
    reviewNotes: string | null;
  }): Promise<AcceptedDesignArtifactRecord> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [candidate] = await tx
        .select()
        .from(designCandidates)
        .where(
          and(eq(designCandidates.projectId, input.projectId), eq(designCandidates.id, input.candidateId)),
        )
        .for("update");
      if (!candidate) {
        throw designNotFound("Design candidate not found for this project.");
      }
      if (candidate.approvalState === "rejected") {
        throw approvalError("A rejected design candidate can never become accepted.");
      }
      if (candidate.candidateDigest !== input.expectedCandidateDigest) {
        throw approvalError(
          "Candidate digest mismatch: the design changed between review and acceptance.",
        );
      }
      // Evidence-mode gate (fail closed): a fixture candidate may be
      // accepted ONLY as an explicitly-marked fixture acceptance (review
      // notes must declare it); it can never silently become live provider
      // authority. The accepted artifact carries the candidate's
      // providerMode so downstream state always distinguishes the two.
      const candidateData = parseDesignCandidateAnyVersion(candidate.data);
      if (deterministicDigest(candidateData) !== candidate.candidateDigest || candidateData.providerMode !== candidate.providerMode) {
        throw approvalError("Stored candidate identity/digest is invalid.");
      }
      if (candidateData.providerMode === "fixture") {
        const declared = (input.reviewNotes ?? "").toLowerCase().includes("fixture");
        if (!declared) {
          throw approvalError(
            "Fixture design candidates cannot be accepted as production design authority: the provider candidate is a deterministic fixture (providerMode=fixture), not live Google Stitch evidence. Fixture acceptance requires review notes that explicitly declare the fixture mode.",
          );
        }
      }
      if (candidate.approvalState === "accepted") {
        // Idempotent: return the existing accepted artifact.
        const [existing] = await tx
          .select()
          .from(acceptedDesignArtifacts)
          .where(
            and(
              eq(acceptedDesignArtifacts.projectId, input.projectId),
              eq(acceptedDesignArtifacts.candidateId, candidate.id),
            ),
          );
        if (existing) return existing;
      }

      // Fail closed on a stale input snapshot: acceptance binds exact upstream
      // authority. The snapshot's OWN staleness is authoritative (it compares
      // every bound upstream digest — inputs, content, assets — against the
      // current authority), which is strictly stronger than a single
      // digest comparison.
      const [boundSnapshot] = await tx
        .select()
        .from(designInputSnapshots)
        .where(eq(designInputSnapshots.id, candidate.inputSnapshotId));
      if (!boundSnapshot) {
        throw staleError("The bound design input snapshot no longer exists.");
      }
      const staleness = await this.inputSnapshotStalenessTx(tx, input.projectId, boundSnapshot);
      if (staleness.stale) {
        throw staleError(
          `Design candidate is stale versus current accepted upstream authority: ${staleness.reason} Re-derive the design input and regenerate.`,
        );
      }

      validateAssetLineage(candidateData, parseDesignInputSnapshotAnyVersion(boundSnapshot.data));

      const [maxVersion] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${acceptedDesignArtifacts.version}), 0)` })
        .from(acceptedDesignArtifacts)
        .where(eq(acceptedDesignArtifacts.projectId, input.projectId));
      const nextVersion = (maxVersion?.maxVersion ?? 0) + 1;
      const id = `dsac-${randomUUID()}`;

      let accepted: AcceptedDesignArtifactRecord | undefined;
      try {
        [accepted] = await tx
          .insert(acceptedDesignArtifacts)
          .values({
            id,
            projectId: input.projectId,
            version: nextVersion,
            candidateId: candidate.id,
            candidateDigest: candidate.candidateDigest,
            inputSnapshotId: candidate.inputSnapshotId,
            inputSnapshotVersion: candidate.inputSnapshotVersion,
            inputDigest: candidate.inputDigest,
            provider: candidate.provider,
            providerMode: candidate.providerMode,
            providerProjectName: candidate.providerProjectName,
            designMdDigest: candidateData.designMdDigest,
            data: candidate.data,
          })
          .returning();
      } catch (error) {
        // Two concurrent acceptances can race the max-version allocation
        // into UNIQUE(project_id, version). Fail closed with the typed
        // acceptance conflict instead of a raw 500 (Run 5 QA precedent).
        const pgCode =
          (error as { code?: string } | null)?.code ??
          (error as { cause?: { code?: string } | null } | null)?.cause?.code;
        if (pgCode === "23505") {
          throw new FactoryError(
            "design_approval_failed",
            "Concurrent acceptance conflict on the design version sequence; retry the acceptance.",
          );
        }
        throw error;
      }

      await tx
        .update(designCandidates)
        .set({ approvalState: "accepted", acceptedAt: new Date(), reviewNotes: input.reviewNotes })
        .where(and(eq(designCandidates.id, candidate.id), eq(designCandidates.approvalState, "pending")));

      return accepted!;
    });
  }

  async rejectCandidate(input: {
    projectId: string;
    candidateId: string;
    expectedCandidateDigest: string;
    reviewNotes: string | null;
  }): Promise<DesignCandidateRecord> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [candidate] = await tx
        .select()
        .from(designCandidates)
        .where(
          and(eq(designCandidates.projectId, input.projectId), eq(designCandidates.id, input.candidateId)),
        )
        .for("update");
      if (!candidate) {
        throw designNotFound("Design candidate not found for this project.");
      }
      if (candidate.approvalState === "accepted") {
        throw approvalError("An accepted design candidate is immutable and cannot be rejected.");
      }
      if (candidate.candidateDigest !== input.expectedCandidateDigest) {
        throw approvalError("Candidate digest mismatch: the design changed between review and rejection.");
      }
      const [updated] = await tx
        .update(designCandidates)
        .set({ approvalState: "rejected", rejectedAt: new Date(), reviewNotes: input.reviewNotes })
        .where(and(eq(designCandidates.id, candidate.id), eq(designCandidates.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  /**
   * The latest accepted design artifact for a project, with computed
   * staleness against CURRENT upstream authority.
   */
  /**
   * Transaction-aware staleness: identical computation to
   * inputSnapshotStaleness but running on the caller's transaction handle
   * so acceptance checks are atomic with the state transition.
   */
  async inputSnapshotStalenessTx(
    tx: FactoryDb,
    projectId: string,
    snapshot: DesignInputSnapshotRecord,
  ): Promise<DesignStaleness> {
    let data: DesignInputSnapshotData | DesignInputSnapshotDataV2;
    try { data = parseDesignInputSnapshotAnyVersion(snapshot.data); }
    catch { return { stale: true, reason: "Design input snapshot lacks valid exact upstream lineage; re-derive it.", code: "DESIGN_INPUT_SNAPSHOT_INVALID" }; }
    if (snapshot.projectId !== projectId || deterministicDigest(data) !== snapshot.inputDigest) {
      return { stale: true, reason: "Design input snapshot identity/digest is invalid.", code: "DESIGN_INPUT_SNAPSHOT_INVALID" };
    }

    const [inputSnapshot] = await tx
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!inputSnapshot) {
      return { stale: true, reason: "The accepted project inputs no longer exist.", code: "INPUT_REMOVED" };
    }
    if (inputSnapshot.id !== data.acceptedInputSnapshotId || inputSnapshot.digest !== data.acceptedInputDigest) {
      return {
        stale: true,
        reason: `Accepted project inputs changed (snapshot ${data.acceptedInputSnapshotVersion} -> ${inputSnapshot.version}).`,
        code: "INPUT_CHANGED",
      };
    }

    const contentRows = await new PageAuthorityReader(tx).currentPages(projectId);
    const currentContent = new Map(contentRows.map((row) => [row.id, row]));
    for (const ref of data.contentRefs) {
      try { await new PageAuthorityReader(tx).requireCurrent(projectId, ref); }
      catch (error) { return { stale: true, reason: error instanceof Error ? error.message : "Accepted content is stale." }; }
    }
    for (const ref of data.contentRefs) {
      const current = currentContent.get(ref.id);
      if (!current) {
        return { stale: true, reason: `Accepted content "${ref.slug}" was removed.`, code: "CONTENT_REMOVED" };
      }
      if (current.contentDigest !== ref.contentDigest || current.slug !== ref.slug || current.version !== ref.version) {
        return { stale: true, reason: `Accepted content "${ref.slug}" changed.`, code: "CONTENT_CHANGED" };
      }
    }
    // design-v2 scope: the snapshot binds ONLY design-defining content
    // (representative pages). Adding an ordinary page under a supported
    // archetype does NOT stale the design — the design's archetype support
    // is what gates new pages, not the page inventory. design-v1 keeps the
    // exact historical whole-inventory CONTENT_ADDED semantics.
    if (!isDesignInputSnapshotV2(data)) {
      const boundContentIds = new Set(data.contentRefs.map((ref) => ref.id));
      const addedContent = contentRows.filter((row) => !boundContentIds.has(row.id));
      if (addedContent.length > 0) {
        return {
          stale: true,
          reason: `New accepted content exists (${addedContent.map((r) => r.slug).join(", ")}).`,
          code: "CONTENT_ADDED",
        };
      }
    }

    const assignmentRows = await tx
      .select({
        versionId: assetPageAssignments.versionId,
        binaryDigest: assetPageAssignments.binaryDigest,
        governanceDigest: assetPageAssignments.versionDigest,
        approvedGovernanceDigest: assetVersions.governanceDigest,
        approvedBinaryDigest: assetVersions.binaryDigest,
        approvalState: assetVersions.approvalState,
        assetProjectId: assetVersions.projectId,
        acceptedPageContentId: assetPageAssignments.acceptedPageContentId,
        acceptedPageContentVersion: assetPageAssignments.acceptedPageContentVersion,
        acceptedPageContentDigest: assetPageAssignments.acceptedPageContentDigest,
        pageSlug: assetPageAssignments.pageSlug,
        role: assetPageAssignments.role,
      })
      .from(assetPageAssignments)
      .innerJoin(assetVersions, eq(assetPageAssignments.versionId, assetVersions.id))
      .where(eq(assetPageAssignments.projectId, projectId));
    const currentAssignments = new Map(
      assignmentRows.map((row) => [`${row.pageSlug}::${row.role}`, row]),
    );
    for (const ref of data.assetRefs) {
      const current = currentAssignments.get(`${ref.pageSlug}::${ref.role}`);
      if (!current) {
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} was removed.`, code: "ASSET_ASSIGNMENT_REMOVED" };
      }
      if (current.acceptedPageContentId !== ref.acceptedPageContentId || current.acceptedPageContentVersion !== ref.acceptedPageContentVersion || current.acceptedPageContentDigest !== ref.acceptedPageContentDigest || !validAssignmentAuthority(current, projectId) ||
          current.binaryDigest !== ref.binaryDigest || current.versionId !== ref.versionId ||
          current.governanceDigest !== ref.governanceDigest) {
        const isAuthorizedReplacement = await this.isAuthorizedPlanReplacement(projectId, ref, current, tx);
        if (isAuthorizedReplacement) {
          return {
            stale: true,
            reason: `Asset assignment ${ref.pageSlug}/${ref.role} replaced with the exact accepted Run 7 resolution.`,
            code: "RUN7_EXACT_ASSET_REPLACED",
          };
        }
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} changed.`, code: "ASSET_ASSIGNMENT_CHANGED" };
      }
    }
    const boundAssignmentKeys = new Set(data.assetRefs.map((ref) => `${ref.pageSlug}::${ref.role}`));
    const addedAssignments = assignmentRows.filter(
      (row) => !boundAssignmentKeys.has(`${row.pageSlug}::${row.role}`),
    );
    // design-v2 scope: the design authority covers archetype DESIGN, not the
    // per-page asset inventory. A new page-exact asset assignment under an
    // already-supported archetype is ordinary page visual authority
    // (VisualAssetPlan/AcceptedVisualAssetSet) and does NOT stale the
    // design. design-v1 keeps the exact historical whole-inventory
    // RUN7_ASSET_ASSIGNMENTS_ADDED semantics.
    if (addedAssignments.length > 0 && !isDesignInputSnapshotV2(data)) {
      return {
        stale: true,
        reason: `New asset assignments exist (${addedAssignments.map((r) => `${r.pageSlug}/${r.role}`).join(", ")}).`,
        code: "RUN7_ASSET_ASSIGNMENTS_ADDED",
      };
    }

    return { stale: false, reason: null, code: null };
  }

  async latestAcceptedDesign(projectId: string): Promise<{
    artifact: AcceptedDesignArtifactRecord;
    staleness: DesignStaleness;
  } | null> {
    const [artifact] = await this.db
      .select()
      .from(acceptedDesignArtifacts)
      .where(eq(acceptedDesignArtifacts.projectId, projectId))
      .orderBy(desc(acceptedDesignArtifacts.version))
      .limit(1);
    if (!artifact) return null;

    // Staleness: the accepted design's bound input snapshot must still be
    // fresh against CURRENT upstream authority (inputs + content + assets).
    const [boundSnapshot] = await this.db
      .select()
      .from(designInputSnapshots)
      .where(eq(designInputSnapshots.id, artifact.inputSnapshotId));
    if (!boundSnapshot) {
      return {
        artifact,
        staleness: { stale: true, reason: "The bound design input snapshot no longer exists." },
      };
    }
    const staleness = await this.inputSnapshotStaleness(projectId, boundSnapshot);
    if (staleness.stale) {
      return { artifact, staleness };
    }

    return { artifact, staleness: { stale: false, reason: null } };
  }

  /** Sole production authority boundary for Runs 8/9: exact identity, never latest. */
  async requireProductionDesign(projectId: string, artifactId: string, expectedCandidateDigest: string): Promise<AcceptedDesignArtifactRecord> {
    const [artifact] = await this.db.select().from(acceptedDesignArtifacts).where(and(
      eq(acceptedDesignArtifacts.projectId, projectId), eq(acceptedDesignArtifacts.id, artifactId),
    ));
    if (!artifact) throw designNotFound("Accepted design not found for this project.");
    const data = parseDesignCandidateAnyVersion(artifact.data);
    if (artifact.providerMode !== "live" || data.providerMode !== "live") {
      throw approvalError("Test fixture acceptance is never production design authority.");
    }
    if (artifact.candidateDigest !== expectedCandidateDigest || deterministicDigest(data) !== expectedCandidateDigest) {
      throw approvalError("Production design digest does not match the exact accepted candidate.");
    }
    const [snapshot] = await this.db.select().from(designInputSnapshots).where(and(
      eq(designInputSnapshots.projectId, projectId), eq(designInputSnapshots.id, artifact.inputSnapshotId),
    ));
    if (!snapshot || snapshot.inputDigest !== artifact.inputDigest || (await this.inputSnapshotStaleness(projectId, snapshot)).stale) {
      throw staleError("Production design upstream authority is stale.");
    }
    validateAssetLineage(data, parseDesignInputSnapshotAnyVersion(snapshot.data));
    return artifact;
  }

  async listAcceptedDesigns(projectId: string): Promise<AcceptedDesignArtifactRecord[]> {
    return await this.db
      .select()
      .from(acceptedDesignArtifacts)
      .where(eq(acceptedDesignArtifacts.projectId, projectId))
      .orderBy(desc(acceptedDesignArtifacts.version));
  }
}

/**
 * Deterministic UX-requirement projection from accepted intake facts. These
 * are bounded, non-marketing requirements the design must structurally
 * support (trust patterns, navigation clarity, responsiveness) — they never
 * invent business claims.
 */
/**
 * Snapshot schema version for NEW design input snapshot derivations in a
 * project. design-v2 activates ONLY through explicit trusted server
 * configuration (FACTORY_DESIGN_SNAPSHOT_SCHEMA=design-v2); the default
 * remains design-v1 so existing projects keep their exact historical
 * semantics and no behavior changes silently.
 */
function designSnapshotSchemaVersion(_projectId: string): "design-v1" | "design-v2" {
  const configured = process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA?.trim();
  return configured === DESIGN_SCHEMA_VERSION_V2 ? DESIGN_SCHEMA_VERSION_V2 : "design-v1";
}

function designUxRequirements(intake: Record<string, unknown>): string[] {
  const requirements: string[] = [
    "Mobile-first responsive layout; no horizontal overflow at common phone widths",
    "Single clear primary call-to-action visible without scrolling on mobile",
    "Logical heading hierarchy with exactly one H1 per page",
    "Visible focus states and keyboard-reachable navigation",
    "Readable body text measure (45-75 characters per line)",
  ];
  const business = (intake["business"] ?? {}) as Record<string, unknown>;
  const name = typeof business["name"] === "string" ? business["name"] : "";
  if (name) {
    requirements.push(`Site identity "${name}" presented consistently in header and footer`);
  }
  const constraints = (intake["constraints"] ?? {}) as Record<string, unknown>;
  const technical = Array.isArray(constraints["technical"]) ? constraints["technical"] : [];
  for (const item of technical) {
    if (typeof item === "string" && item.trim().length > 0 && item.length <= 300) {
      requirements.push(`Operator constraint: ${item.trim()}`);
    }
  }
  return requirements.slice(0, 20);
}

/**
 * Deterministic archetype derivation from accepted content slugs. The
 * homepage archetype is always included; slugs containing service/location/
 * research markers map to their archetypes. This is a structural mapping,
 * not content invention.
 */
function deriveArchetypes(slugs: string[]): Array<"homepage" | "service" | "location" | "editorial" | "investment_advisory"> {
  const archetypes = new Set<"homepage" | "service" | "location" | "editorial" | "investment_advisory">();
  archetypes.add("homepage");
  for (const slug of slugs) {
    if (/(^|\/)(services?|solutions?|offerings?)(\/|$)/.test(slug)) archetypes.add("service");
    if (/(^|\/)(locations?|areas?|regions?|contact)(\/|$)/.test(slug)) archetypes.add("location");
    if (/(^|\/)(research|insights?|articles?|blog|editorial|journal)(\/|$)/.test(slug)) archetypes.add("editorial");
    if (/(^|\/)(invest|advisory|capital|portfolio)(\/|$)/.test(slug)) archetypes.add("investment_advisory");
  }
  return [...archetypes].slice(0, 5);
}

/**
 * Explicit representative-page routing (page-exact copy authority). Each
 * derived archetype binds exactly one accepted page:
 * - homepage -> the canonical homepage slug (root, "home", or "index");
 *   when none exists, the lexicographically first accepted page stands in
 *   (deterministic; the binding is explicit and inspectable either way).
 * - service/location/editorial/investment_advisory -> the lexicographically
 *   first accepted page whose slug matches that archetype's marker pattern.
 * The homepage archetype is always derivable; non-homepage archetypes bind
 * only when a matching page exists (their archetype is only derived when a
 * matching page exists, so the representative is always found).
 */
function deriveRepresentativePages(
  contentRows: Array<{ slug: string; contentDigest: string }>,
): Array<{ archetype: "homepage" | "service" | "location" | "editorial" | "investment_advisory"; slug: string; contentDigest: string }> {
  const sorted = [...contentRows].sort((a, b) => a.slug.localeCompare(b.slug));
  const representatives: Array<{ archetype: "homepage" | "service" | "location" | "editorial" | "investment_advisory"; slug: string; contentDigest: string }> = [];
  const homepage = sorted.find((row) => /^(home|index|\/)$/.test(row.slug) || row.slug === "") ?? sorted[0];
  if (homepage) {
    representatives.push({ archetype: "homepage", slug: homepage.slug, contentDigest: homepage.contentDigest });
  }
  const marker: Array<["service" | "location" | "editorial" | "investment_advisory", RegExp]> = [
    ["service", /(^|\/)(services?|solutions?|offerings?)(\/|$)/],
    ["location", /(^|\/)(locations?|areas?|regions?|contact)(\/|$)/],
    ["editorial", /(^|\/)(research|insights?|articles?|blog|editorial|journal)(\/|$)/],
    ["investment_advisory", /(^|\/)(invest|advisory|capital|portfolio)(\/|$)/],
  ];
  for (const [archetype, pattern] of marker) {
    const match = sorted.find((row) => pattern.test(row.slug));
    if (match) {
      representatives.push({ archetype, slug: match.slug, contentDigest: match.contentDigest });
    }
  }
  return representatives;
}


function validAssignmentAuthority(row: {
  governanceDigest: string; approvedGovernanceDigest: string | null;
  binaryDigest: string; approvedBinaryDigest: string; approvalState: string; assetProjectId: string;
}, projectId: string): boolean {
  return row.assetProjectId === projectId && row.approvalState === "approved" &&
    row.approvedGovernanceDigest !== null && row.governanceDigest === row.approvedGovernanceDigest &&
    row.binaryDigest === row.approvedBinaryDigest;
}

/** Provider-returned bindings are claims, checked against Factory authority. */
function validateAssetLineage(
  data: DesignCandidateData | DesignCandidateDataV2,
  input: DesignInputSnapshotData | DesignInputSnapshotDataV2,
): void {
  for (const archetype of data.archetypes) {
    const representative = input.representativePages.find((page) => page.archetype === archetype.kind);
    for (const slot of archetype.assetSlots) {
      const bound = slot.boundAssetVersionId || slot.boundBinaryDigest || slot.boundGovernanceDigest;
      if (!bound) {
        if (slot.providerConsumed || !slot.placeholder) throw approvalError("Unbound asset slot must remain an unresolved placeholder.");
        continue;
      }
      const ref = input.assetRefs.find((asset) => asset.pageSlug === slot.pageSlug && asset.role === slot.requiredRole);
      if (!representative || representative.slug !== slot.pageSlug || slot.role !== slot.requiredRole || !ref ||
          ref.versionId !== slot.boundAssetVersionId || ref.binaryDigest !== slot.boundBinaryDigest ||
          ref.governanceDigest !== slot.boundGovernanceDigest) {
        throw approvalError("Provider asset lineage does not match the exact accepted page, role, version and binary/governance digests.");
      }
    }
  }
}
