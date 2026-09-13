import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  parseDesignCandidateData,
  parseDesignInputSnapshotData,
  type DesignCandidateData,
  type DesignInputSnapshotData,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedDesignArtifacts,
  acceptedPageContent,
  assetPageAssignments,
  assetVersions,
  designCandidates,
  designInputSnapshots,
  projectInputSnapshots,
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

export interface DesignStaleness {
  stale: boolean;
  reason: string | null;
}

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

    const contentRows = await this.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, input.projectId))
      .orderBy(acceptedPageContent.slug);

    const assignmentRows = await this.db
      .select({
        versionId: assetPageAssignments.versionId,
        binaryDigest: assetPageAssignments.binaryDigest,
        pageSlug: assetPageAssignments.pageSlug,
        role: assetPageAssignments.role,
        versionNumber: assetVersions.version,
      })
      .from(assetPageAssignments)
      .innerJoin(assetVersions, eq(assetPageAssignments.versionId, assetVersions.id))
      .where(eq(assetPageAssignments.projectId, input.projectId))
      .orderBy(assetPageAssignments.pageSlug, assetPageAssignments.role);

    const intake = inputSnapshot.payload as Record<string, unknown>;
    const brand = (intake["brand"] ?? {}) as Record<string, unknown>;
    const audience = (intake["audience"] ?? {}) as Record<string, unknown>;
    const designRefs = (intake["designReferences"] ?? {}) as Record<string, unknown>;

    const data = parseDesignInputSnapshotData({
      schemaVersion: "design-v1",
      acceptedInputSnapshotId: inputSnapshot.id,
      acceptedInputSnapshotVersion: inputSnapshot.version,
      acceptedInputDigest: inputSnapshot.digest,
      brand: {
        facts: brand["facts"] ?? [],
        positioning: brand["positioning"] ?? "",
        tone: brand["tone"] ?? "",
        visualIdentityNotes: brand["visualIdentityNotes"] ?? "",
      },
      audience: {
        segments: audience["segments"] ?? [],
        needs: audience["needs"] ?? [],
        decisionContext: audience["decisionContext"] ?? "",
      },
      references: {
        referenceUrls: designRefs["referenceUrls"] ?? [],
        antiReferenceUrls: designRefs["antiReferenceUrls"] ?? [],
        learn: designRefs["learn"] ?? [],
        avoid: designRefs["avoid"] ?? [],
        preferredPerception: designRefs["preferredPerception"] ?? "",
      },
      // UX requirements are derived from the accepted evidence/conversion
      // intent — deterministic projection, not provider-invented content.
      uxRequirements: designUxRequirements(intake),
      contentRefs: contentRows.map((row) => ({
        id: row.id,
        version: row.version,
        slug: row.slug,
        contentDigest: row.contentDigest,
      })),
      assetRefs: assignmentRows.map((row) => ({
        versionId: row.versionId,
        binaryDigest: row.binaryDigest,
        pageSlug: row.pageSlug,
        role: row.role,
      })),
      archetypes: deriveArchetypes(contentRows.map((row) => row.slug)),
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
    const rows = await this.db
      .select({
        id: acceptedPageContent.id,
        version: acceptedPageContent.version,
        slug: acceptedPageContent.slug,
        contentDigest: acceptedPageContent.contentDigest,
        data: acceptedPageContent.data,
      })
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, projectId))
      .orderBy(acceptedPageContent.slug);
    return rows;
  }

  /**
   * Compute staleness of a design input snapshot against CURRENT upstream
   * authority. Never mutates anything: staleness is a computed state.
   */
  async inputSnapshotStaleness(
    projectId: string,
    snapshot: DesignInputSnapshotRecord,
  ): Promise<DesignStaleness> {
    const data = snapshot.data as DesignInputSnapshotData;

    // 1. Accepted project inputs.
    const [inputSnapshot] = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!inputSnapshot) {
      return { stale: true, reason: "The accepted project inputs no longer exist." };
    }
    if (inputSnapshot.id !== data.acceptedInputSnapshotId || inputSnapshot.digest !== data.acceptedInputDigest) {
      return {
        stale: true,
        reason: `Accepted project inputs changed (snapshot ${data.acceptedInputSnapshotVersion} -> ${inputSnapshot.version}).`,
      };
    }

    // 2. Accepted page content digests.
    const contentRows = await this.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, projectId));
    const currentContent = new Map(contentRows.map((row) => [row.id, row]));
    for (const ref of data.contentRefs) {
      const current = currentContent.get(ref.id);
      if (!current) {
        return { stale: true, reason: `Accepted content "${ref.slug}" was removed.` };
      }
      if (current.contentDigest !== ref.contentDigest) {
        return { stale: true, reason: `Accepted content "${ref.slug}" changed.` };
      }
    }
    const boundContentIds = new Set(data.contentRefs.map((ref) => ref.id));
    const addedContent = contentRows.filter((row) => !boundContentIds.has(row.id));
    if (addedContent.length > 0) {
      return {
        stale: true,
        reason: `New accepted content exists (${addedContent.map((r) => r.slug).join(", ")}).`,
      };
    }

    // 3. Approved asset assignments (exact version digests).
    const assignmentRows = await this.db
      .select({
        versionId: assetPageAssignments.versionId,
        binaryDigest: assetPageAssignments.binaryDigest,
        pageSlug: assetPageAssignments.pageSlug,
        role: assetPageAssignments.role,
      })
      .from(assetPageAssignments)
      .where(eq(assetPageAssignments.projectId, projectId));
    const currentAssignments = new Map(
      assignmentRows.map((row) => [`${row.pageSlug}::${row.role}`, row]),
    );
    for (const ref of data.assetRefs) {
      const current = currentAssignments.get(`${ref.pageSlug}::${ref.role}`);
      if (!current) {
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} was removed.` };
      }
      if (current.binaryDigest !== ref.binaryDigest || current.versionId !== ref.versionId) {
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} changed.` };
      }
    }
    const boundAssignmentKeys = new Set(data.assetRefs.map((ref) => `${ref.pageSlug}::${ref.role}`));
    const addedAssignments = assignmentRows.filter(
      (row) => !boundAssignmentKeys.has(`${row.pageSlug}::${row.role}`),
    );
    if (addedAssignments.length > 0) {
      return {
        stale: true,
        reason: `New asset assignments exist (${addedAssignments.map((r) => `${r.pageSlug}/${r.role}`).join(", ")}).`,
      };
    }

    return { stale: false, reason: null };
  }

  // ---- Design candidates -----------------------------------------------------

  /**
   * Persist a provider generation result as an immutable candidate. The
   * caller must have validated the payload against the contract. The exact
   * input snapshot lineage is copied at bind time.
   */
  async createCandidate(input: {
    projectId: string;
    inputSnapshot: DesignInputSnapshotRecord;
    data: DesignCandidateData;
  }): Promise<DesignCandidateRecord> {
    const candidateDigest = deterministicDigest(input.data);
    const [row] = await this.db
      .insert(designCandidates)
      .values({
        id: `dsn-${randomUUID()}`,
        projectId: input.projectId,
        inputSnapshotId: input.inputSnapshot.id,
        inputSnapshotVersion: input.inputSnapshot.version,
        inputDigest: input.inputSnapshot.inputDigest,
        provider: input.data.provider,
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

      const [maxVersion] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${acceptedDesignArtifacts.version}), 0)` })
        .from(acceptedDesignArtifacts)
        .where(eq(acceptedDesignArtifacts.projectId, input.projectId));
      const nextVersion = (maxVersion?.maxVersion ?? 0) + 1;
      const id = `dsac-${randomUUID()}`;
      const candidateData = parseDesignCandidateData(candidate.data);

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
    const data = snapshot.data as DesignInputSnapshotData;

    const [inputSnapshot] = await tx
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version))
      .limit(1);
    if (!inputSnapshot) {
      return { stale: true, reason: "The accepted project inputs no longer exist." };
    }
    if (inputSnapshot.id !== data.acceptedInputSnapshotId || inputSnapshot.digest !== data.acceptedInputDigest) {
      return {
        stale: true,
        reason: `Accepted project inputs changed (snapshot ${data.acceptedInputSnapshotVersion} -> ${inputSnapshot.version}).`,
      };
    }

    const contentRows = await tx
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, projectId));
    const currentContent = new Map(contentRows.map((row) => [row.id, row]));
    for (const ref of data.contentRefs) {
      const current = currentContent.get(ref.id);
      if (!current) {
        return { stale: true, reason: `Accepted content "${ref.slug}" was removed.` };
      }
      if (current.contentDigest !== ref.contentDigest) {
        return { stale: true, reason: `Accepted content "${ref.slug}" changed.` };
      }
    }
    const boundContentIds = new Set(data.contentRefs.map((ref) => ref.id));
    const addedContent = contentRows.filter((row) => !boundContentIds.has(row.id));
    if (addedContent.length > 0) {
      return {
        stale: true,
        reason: `New accepted content exists (${addedContent.map((r) => r.slug).join(", ")}).`,
      };
    }

    const assignmentRows = await tx
      .select({
        versionId: assetPageAssignments.versionId,
        binaryDigest: assetPageAssignments.binaryDigest,
        pageSlug: assetPageAssignments.pageSlug,
        role: assetPageAssignments.role,
      })
      .from(assetPageAssignments)
      .where(eq(assetPageAssignments.projectId, projectId));
    const currentAssignments = new Map(
      assignmentRows.map((row) => [`${row.pageSlug}::${row.role}`, row]),
    );
    for (const ref of data.assetRefs) {
      const current = currentAssignments.get(`${ref.pageSlug}::${ref.role}`);
      if (!current) {
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} was removed.` };
      }
      if (current.binaryDigest !== ref.binaryDigest || current.versionId !== ref.versionId) {
        return { stale: true, reason: `Asset assignment ${ref.pageSlug}/${ref.role} changed.` };
      }
    }
    const boundAssignmentKeys = new Set(data.assetRefs.map((ref) => `${ref.pageSlug}::${ref.role}`));
    const addedAssignments = assignmentRows.filter(
      (row) => !boundAssignmentKeys.has(`${row.pageSlug}::${row.role}`),
    );
    if (addedAssignments.length > 0) {
      return {
        stale: true,
        reason: `New asset assignments exist (${addedAssignments.map((r) => `${r.pageSlug}/${r.role}`).join(", ")}).`,
      };
    }

    return { stale: false, reason: null };
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
