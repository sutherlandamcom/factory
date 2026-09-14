import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedDesignArtifacts,
  acceptedPageContent,
  acceptedVisualAssetSets,
  acceptedVisualAssetSlots,
  assetPageAssignments,
  designInputSnapshots,
  productionCandidates,
  productionPageInputs,
  productionQaRuns,
} from "../persistence/schema.js";
import type {
  AcceptedDesignArtifactRecord,
  ProductionCandidateRecord,
  ProductionPageInputRecord,
  ProductionQaRunRecord,
} from "../persistence/schema.js";
import {
  parseProductionPageInputData,
  parseProductionQaReportData,
  qaOverallVerdict,
  type ProductionPageInputData,
  type ProductionQaCheckResult,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { PageAuthorityReader } from "../writer/page-authority.js";
import { DesignStore } from "../design/design-store.js";
import { VisualStore } from "../visual/store.js";
import { AssetStore } from "../assets/asset-store.js";

/**
 * PRODUCTION STORE — Macro Run 9.
 *
 * Owns the immutable ProductionPageInput / ProductionCandidate / QA-run
 * lineage. Derivation fails closed on any stale/missing/forged upstream
 * authority. Candidate creation participates in the shared project-level
 * PostgreSQL advisory-lock discipline (`hashtextextended(projectId, 104)`)
 * so upstream authority cannot mutate concurrently inside an acceptance
 * window — the same serialization namespace every other authority store
 * uses. No second lock namespace is introduced.
 */

export interface ProductionAuthorityBundle {
  content: {
    id: string;
    version: number;
    slug: string;
    digest: string;
    data: unknown;
  };
  design: AcceptedDesignArtifactRecord;
  /** Parsed design input snapshot data (representative-page routing). */
  designInputData: unknown;
  visualSet: { id: string; version: number; digest: string };
  visualSlots: Array<{
    slot: string;
    pageSlug: string;
    role: string;
    resolvedVersionId: string;
    binaryDigest: string;
    governanceDigest: string;
    resolutionMode: string;
    truthClass: string;
  }>;
  assignments: Array<{
    assetId: string;
    versionId: string;
    binaryDigest: string;
    governanceDigest: string;
    pageSlug: string;
    role: string;
  }>;
}

export class ProductionStore {
  constructor(private readonly db: FactoryDb) {}

  // ---- Derivation (fail-closed authority binding) ----------------------------

  /**
   * Verify CURRENT accepted authority for one page and return the exact
   * bundle. Throws typed ProductionErrorCodes on any staleness/missing/
   * forged authority. Fixture authority never qualifies as production
   * authority (mirrors requireProductionDesign/requireProductionVisualSet).
   */
  async deriveAuthorityBundle(input: {
    projectId: string;
    pageSlug: string;
  }): Promise<ProductionAuthorityBundle> {
    // Content: exact current accepted page with full upstream lineage proof.
    const pages = await new PageAuthorityReader(this.db).currentPages(input.projectId);
    const page = pages.find((row) => row.slug === input.pageSlug);
    if (!page) {
      throw productionError(
        "production_authority_not_found",
        `No AcceptedPageContent exists for slug ${input.pageSlug}.`,
      );
    }
    await new PageAuthorityReader(this.db).requireCurrent(input.projectId, page);

    // Design: exact production design authority (live-only, digest-verified,
    // transitive staleness proven by the Run 6/7 machinery).
    const latestDesign = await new DesignStore(this.db).latestAcceptedDesign(input.projectId);
    if (!latestDesign) {
      throw productionError(
        "production_authority_not_found",
        "No AcceptedDesignArtifact exists for this project.",
      );
    }
    if (latestDesign.staleness.stale) {
      throw productionError("production_authority_stale", latestDesign.staleness.reason ?? "Design authority is stale.");
    }
    // requireProductionDesign re-verifies digest + live mode against the
    // exact candidate digest; use the artifact's own recorded digest.
    const design = await new DesignStore(this.db).requireProductionDesign(
      input.projectId,
      latestDesign.artifact.id,
      latestDesign.artifact.candidateDigest,
    );
    // The design input snapshot carries the representative-page routing
    // (archetype <-> accepted page slug binding).
    const [designSnapshot] = await this.db
      .select()
      .from(designInputSnapshots)
      .where(eq(designInputSnapshots.id, design.inputSnapshotId));

    // Visual set: exact production visual authority + per-slot lineage.
    const visualStore = new VisualStore(this.db);
    const latestSet = await visualStore.latestAcceptedSet(input.projectId);
    if (!latestSet) {
      throw productionError(
        "production_authority_not_found",
        "No AcceptedVisualAssetSet exists for this project.",
      );
    }
    if (latestSet.designArtifactId !== design.id || latestSet.designArtifactVersion !== design.version) {
      throw productionError(
        "production_authority_stale",
        "Accepted visual set is bound to a different design artifact than current accepted design.",
      );
    }
    const verifiedSet = await visualStore.requireProductionVisualSet(
      input.projectId,
      latestSet.id,
      latestSet.setDigest,
    );

    // Run 5 assignments: exact approved versions bound to this page/slot.
    const assignmentRows = await this.db
      .select()
      .from(assetPageAssignments)
      .where(
        and(
          eq(assetPageAssignments.projectId, input.projectId),
          eq(assetPageAssignments.pageSlug, input.pageSlug),
        ),
      );
    for (const row of assignmentRows) {
      const version = await new AssetStore(this.db).getVersion(input.projectId, row.versionId);
      if (!version || version.binaryDigest !== row.binaryDigest || version.governanceDigest !== row.versionDigest) {
        throw productionError(
          "production_authority_stale",
          `Asset assignment ${row.id} no longer matches its bound AssetVersion.`,
        );
      }
      if (version.approvalState !== "approved") {
        throw productionError(
          "production_authority_stale",
          `Assigned asset version ${row.versionId} is not approved.`,
        );
      }
    }

    return {
      content: {
        id: page.id,
        version: page.version,
        slug: page.slug,
        digest: page.contentDigest,
        data: page.data,
      },
      design,
      designInputData: designSnapshot?.data ?? null,
      visualSet: { id: latestSet.id, version: latestSet.version, digest: latestSet.setDigest },
      visualSlots: verifiedSet.slots
        .filter((slot) => slot.pageSlug === input.pageSlug)
        .map((slot) => ({
          slot: slot.slot,
          pageSlug: slot.pageSlug,
          role: slot.role,
          resolvedVersionId: slot.resolvedVersionId,
          binaryDigest: slot.binaryDigest,
          governanceDigest: slot.governanceDigest,
          resolutionMode: slot.resolutionMode,
          truthClass: slot.truthClass,
        })),
      assignments: assignmentRows.map((row) => ({
        assetId: row.assetId,
        versionId: row.versionId,
        binaryDigest: row.binaryDigest,
        governanceDigest: row.versionDigest,
        pageSlug: row.pageSlug,
        role: row.role,
      })),
    };
  }

  // ---- ProductionPageInput ---------------------------------------------------

  /**
   * Derive the immutable ProductionPageInput for one page under the shared
   * project advisory lock. Re-derivation with unchanged upstream authority
   * is idempotent (returns the existing latest input); changed authority
   * creates the next version. Route authority is enforced: a route already
   * claimed by a different page identity fails closed.
   */
  async deriveProductionInput(input: {
    projectId: string;
    pageSlug: string;
    canonicalOrigin: string;
    rendererVersion: string;
    rendererPolicyVersion: string;
  }): Promise<ProductionPageInputRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return new ProductionStore(tx as unknown as FactoryDb).deriveProductionInputLocked(input);
    });
  }

  private async deriveProductionInputLocked(input: {
    projectId: string;
    pageSlug: string;
    canonicalOrigin: string;
    rendererVersion: string;
    rendererPolicyVersion: string;
  }): Promise<ProductionPageInputRecord> {
    const bundle = await new ProductionStore(this.db).deriveAuthorityBundle({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
    });

    // Accepted content data carries the page title/meta. The archetype
    // pageType comes from the accepted design's representative-page routing
    // (bound in the design input snapshot at design acceptance time).
    const designData = bundle.design.data as {
      representativePages?: Array<{ slug?: string; archetype?: string }>;
    };
    const designInputData = bundle.designInputData as {
      representativePages?: Array<{ slug?: string; archetype?: string }>;
    };
    const representative = (designData.representativePages ?? designInputData.representativePages ?? []).find(
      (entry) => entry.slug === input.pageSlug,
    );
    const pageType = representative?.archetype;
    if (!pageType) {
      throw productionError(
        "production_route_conflict",
        `Accepted design does not bind archetype for page ${input.pageSlug}; cannot derive production input.`,
      );
    }

    const route = normalizeRoute(input.pageSlug);
    // Route authority invariant: the route must not already belong to a
    // different page identity.
    const [routeOwner] = await this.db
      .select()
      .from(productionPageInputs)
      .where(and(eq(productionPageInputs.projectId, input.projectId), eq(productionPageInputs.route, route)));
    if (routeOwner && routeOwner.pageIdentity !== input.pageSlug) {
      throw productionError(
        "production_route_conflict",
        `Route ${route} is already claimed by page ${routeOwner.pageIdentity}.`,
      );
    }

    const data: ProductionPageInputData = {
      schemaVersion: "production-v1",
      projectId: input.projectId,
      pageIdentity: input.pageSlug,
      pageType: pageType as ProductionPageInputData["pageType"],
      route,
      canonicalOrigin: input.canonicalOrigin,
      acceptedContent: {
        id: bundle.content.id,
        version: bundle.content.version,
        digest: bundle.content.digest,
      },
      acceptedDesign: {
        id: bundle.design.id,
        version: bundle.design.version,
        digest: bundle.design.candidateDigest,
      },
      acceptedVisualSet: {
        id: bundle.visualSet.id,
        version: bundle.visualSet.version,
        digest: bundle.visualSet.digest,
      },
      renderer: {
        id: "astro-static",
        version: input.rendererVersion,
        policyVersion: input.rendererPolicyVersion,
      },
    };
    parseProductionPageInputData(data);
    // Digest over the proven canonical JSON serializer (Run 4.1 RFC 8785
    // verification applies to this exact implementation).
    const digest = deterministicDigest(data);

    // Idempotency: identical upstream authority + identical renderer config
    // returns the existing latest input for this page identity.
    const [latest] = await this.db
      .select()
      .from(productionPageInputs)
      .where(
        and(
          eq(productionPageInputs.projectId, input.projectId),
          eq(productionPageInputs.pageIdentity, input.pageSlug),
        ),
      )
      .orderBy(desc(productionPageInputs.version))
      .limit(1);
    if (latest && latest.inputDigest === digest) {
      return latest;
    }

    const [maxVersion] = await this.db
      .select({ maxVersion: sql<number>`coalesce(max(${productionPageInputs.version}), 0)` })
      .from(productionPageInputs)
      .where(eq(productionPageInputs.projectId, input.projectId));
    const nextVersion = (maxVersion?.maxVersion ?? 0) + 1;
    const id = `ppin-${randomUUID()}`;
    try {
      const [row] = await this.db
        .insert(productionPageInputs)
        .values({
          id,
          projectId: input.projectId,
          version: nextVersion,
          pageIdentity: input.pageSlug,
          pageType: data.pageType,
          route: data.route,
          canonicalOrigin: input.canonicalOrigin,
          acceptedContentId: data.acceptedContent.id,
          acceptedContentVersion: data.acceptedContent.version,
          acceptedContentDigest: data.acceptedContent.digest,
          acceptedDesignId: data.acceptedDesign.id,
          acceptedDesignVersion: data.acceptedDesign.version,
          acceptedDesignDigest: data.acceptedDesign.digest,
          acceptedVisualSetId: data.acceptedVisualSet.id,
          acceptedVisualSetVersion: data.acceptedVisualSet.version,
          acceptedVisualSetDigest: data.acceptedVisualSet.digest,
          rendererId: data.renderer.id,
          rendererVersion: data.renderer.version,
          rendererPolicyVersion: data.renderer.policyVersion,
          data,
          inputDigest: digest,
        })
        .returning();
      return row!;
    } catch (error) {
      // Concurrent route claims or version races fail closed with the typed
      // conflict (drizzle wraps driver errors: check both shapes).
      const pgCode =
        (error as { code?: string } | null)?.code ??
        (error as { cause?: { code?: string } | null } | null)?.cause?.code;
      if (pgCode === "23505" || pgCode === "23514") {
        throw productionError(
          "production_route_conflict",
          "Production input rejected: route/version conflict under concurrent derivation.",
        );
      }
      throw error;
    }
  }

  async latestProductionInput(projectId: string, pageSlug: string): Promise<ProductionPageInputRecord | null> {
    const [row] = await this.db
      .select()
      .from(productionPageInputs)
      .where(
        and(
          eq(productionPageInputs.projectId, projectId),
          eq(productionPageInputs.pageIdentity, pageSlug),
        ),
      )
      .orderBy(desc(productionPageInputs.version))
      .limit(1);
    return row ?? null;
  }

  async listProductionInputs(projectId: string): Promise<ProductionPageInputRecord[]> {
    return await this.db
      .select()
      .from(productionPageInputs)
      .where(eq(productionPageInputs.projectId, projectId))
      .orderBy(desc(productionPageInputs.version));
  }

  // ---- Staleness -------------------------------------------------------------

  /**
   * Compute staleness of a ProductionPageInput against CURRENT accepted
   * authority from exact identities/digests. Never mutates anything.
   */
  async inputStaleness(
    input: ProductionPageInputRecord,
  ): Promise<{ stale: boolean; reason: string | null }> {
    // Content: exact id/version/digest must still be the current accepted page.
    const pages = await new PageAuthorityReader(this.db).currentPages(input.projectId);
    const page = pages.find((row) => row.slug === input.pageIdentity);
    if (!page || page.id !== input.acceptedContentId || page.version !== input.acceptedContentVersion || page.contentDigest !== input.acceptedContentDigest) {
      return { stale: true, reason: "AcceptedPageContent changed or was superseded." };
    }

    // Design: exact id/version/digest.
    const [design] = await this.db
      .select()
      .from(acceptedDesignArtifacts)
      .where(
        and(
          eq(acceptedDesignArtifacts.projectId, input.projectId),
          eq(acceptedDesignArtifacts.id, input.acceptedDesignId),
        ),
      );
    if (!design || design.version !== input.acceptedDesignVersion || design.candidateDigest !== input.acceptedDesignDigest) {
      return { stale: true, reason: "AcceptedDesignArtifact changed or was superseded." };
    }

    // Visual set: exact id/version/digest.
    const [set] = await this.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(
        and(
          eq(acceptedVisualAssetSets.projectId, input.projectId),
          eq(acceptedVisualAssetSets.id, input.acceptedVisualSetId),
        ),
      );
    if (!set || set.version !== input.acceptedVisualSetVersion || set.setDigest !== input.acceptedVisualSetDigest) {
      return { stale: true, reason: "AcceptedVisualAssetSet changed or was superseded." };
    }

    // Per-slot lineage for this page must still match the accepted slots.
    const slots = await this.db
      .select()
      .from(acceptedVisualAssetSlots)
      .where(eq(acceptedVisualAssetSlots.setId, input.acceptedVisualSetId));
    const pageSlots = slots.filter((slot) => slot.pageSlug === input.pageIdentity);
    for (const slot of pageSlots) {
      const version = await new AssetStore(this.db).getVersion(input.projectId, slot.resolvedVersionId);
      if (!version || version.binaryDigest !== slot.binaryDigest || version.governanceDigest !== slot.governanceDigest) {
        return { stale: true, reason: `Visual slot ${slot.slot} no longer resolves to its bound asset version.` };
      }
    }

    return { stale: false, reason: null };
  }

  // ---- ProductionCandidate ---------------------------------------------------

  /**
   * Create a new immutable ProductionCandidate for an input. Serialized by
   * the shared project advisory lock. Stale inputs are refused: upstream
   * mutation requires re-derivation (a new input), never a silent rebuild.
   */
  async createCandidate(input: { projectId: string; productionInputId: string }): Promise<ProductionCandidateRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return new ProductionStore(tx as unknown as FactoryDb).createCandidateLocked(input);
    });
  }

  private async createCandidateLocked(input: {
    projectId: string;
    productionInputId: string;
  }): Promise<ProductionCandidateRecord> {
    const [productionInput] = await this.db
      .select()
      .from(productionPageInputs)
      .where(
        and(
          eq(productionPageInputs.projectId, input.projectId),
          eq(productionPageInputs.id, input.productionInputId),
        ),
      );
    if (!productionInput) {
      throw productionError("production_input_immutable", "ProductionPageInput not found for this project.");
    }
    const staleness = await new ProductionStore(this.db).inputStaleness(productionInput);
    if (staleness.stale) {
      throw productionError("production_authority_stale", staleness.reason ?? "Production input is stale.");
    }

    const canonicalUrl = `${productionInput.canonicalOrigin.replace(/\/$/, "")}${productionInput.route === "/" ? "/" : productionInput.route}`;
    const id = `pcand-${randomUUID()}`;
    const [row] = await this.db
      .insert(productionCandidates)
      .values({
        id,
        projectId: input.projectId,
        productionInputId: productionInput.id,
        productionInputVersion: productionInput.version,
        productionInputDigest: productionInput.inputDigest,
        pageIdentity: productionInput.pageIdentity,
        route: productionInput.route,
        canonicalUrl,
        state: "pending",
      })
      .returning();
    return row!;
  }

  async getCandidate(projectId: string, candidateId: string): Promise<ProductionCandidateRecord | null> {
    const [row] = await this.db
      .select()
      .from(productionCandidates)
      .where(
        and(
          eq(productionCandidates.projectId, projectId),
          eq(productionCandidates.id, candidateId),
        ),
      );
    return row ?? null;
  }

  async latestCandidate(projectId: string, pageSlug: string): Promise<ProductionCandidateRecord | null> {
    const [row] = await this.db
      .select()
      .from(productionCandidates)
      .where(
        and(
          eq(productionCandidates.projectId, projectId),
          eq(productionCandidates.pageIdentity, pageSlug),
        ),
      )
      .orderBy(desc(productionCandidates.createdAt))
      .limit(1);
    return row ?? null;
  }

  async listCandidates(projectId: string): Promise<ProductionCandidateRecord[]> {
    return await this.db
      .select()
      .from(productionCandidates)
      .where(eq(productionCandidates.projectId, projectId))
      .orderBy(desc(productionCandidates.createdAt));
  }

  /**
   * Record a completed build. The candidate must be pending; the recorded
   * input digest must match exactly (fail closed on drift).
   */
  async recordBuild(input: {
    projectId: string;
    candidateId: string;
    artifactDigest: string;
    artifactRef: string;
    assetReferences: unknown;
  }): Promise<ProductionCandidateRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [candidate] = await tx
        .select()
        .from(productionCandidates)
        .where(
          and(
            eq(productionCandidates.projectId, input.projectId),
            eq(productionCandidates.id, input.candidateId),
          ),
        );
      if (!candidate) throw productionError("production_candidate_not_found", "Candidate not found.");
      if (candidate.state !== "pending") {
        throw productionError(
          "production_build_rejected",
          `Candidate ${candidate.id} is already ${candidate.state}; build once per candidate.`,
        );
      }
      const [productionInput] = await tx
        .select()
        .from(productionPageInputs)
        .where(eq(productionPageInputs.id, candidate.productionInputId));
      if (!productionInput || productionInput.inputDigest !== candidate.productionInputDigest) {
        throw productionError("production_authority_digest_mismatch", "Candidate input digest drifted.");
      }
      const staleness = await new ProductionStore(tx as unknown as FactoryDb).inputStaleness(productionInput);
      if (staleness.stale) {
        // Upstream changed between candidate creation and build completion.
        await tx
          .update(productionCandidates)
          .set({ state: "stale" })
          .where(eq(productionCandidates.id, candidate.id));
        throw productionError("production_authority_stale", staleness.reason ?? "Authority changed during build.");
      }
      const [updated] = await tx
        .update(productionCandidates)
        .set({
          artifactDigest: input.artifactDigest,
          artifactRef: input.artifactRef,
          assetReferences: input.assetReferences as never,
          state: "built",
        })
        .where(eq(productionCandidates.id, candidate.id))
        .returning();
      return updated!;
    });
  }

  /**
   * Mark all built/qa_passed candidates stale when their bound authority
   * changed. Called by upstream authority stores is NOT required — staleness
   * is always computed on read; this helper exists for explicit sweep after
   * known upstream mutations.
   */
  async sweepStaleCandidates(projectId: string): Promise<number> {
    const candidates = await this.db
      .select()
      .from(productionCandidates)
      .where(eq(productionCandidates.projectId, projectId));
    let marked = 0;
    for (const candidate of candidates) {
      if (candidate.state !== "built" && candidate.state !== "qa_passed") continue;
      const [productionInput] = await this.db
        .select()
        .from(productionPageInputs)
        .where(eq(productionPageInputs.id, candidate.productionInputId));
      if (!productionInput) continue;
      const staleness = await this.inputStaleness(productionInput);
      if (staleness.stale) {
        await this.db
          .update(productionCandidates)
          .set({ state: "stale" })
          .where(eq(productionCandidates.id, candidate.id));
        marked += 1;
      }
    }
    return marked;
  }

  // ---- QA runs ---------------------------------------------------------------

  async recordQaRun(input: {
    projectId: string;
    candidateId: string;
    checks: ProductionQaCheckResult[];
  }): Promise<ProductionQaRunRecord> {
    const candidate = await this.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw productionError("production_candidate_not_found", "Candidate not found.");
    if (candidate.state !== "built" && candidate.state !== "qa_passed" && candidate.state !== "qa_failed") {
      throw productionError("production_qa_not_found", "Candidate has no completed build to QA.");
    }
    const overall = qaOverallVerdict(input.checks);
    const data = {
      schemaVersion: "production-v1" as const,
      candidateId: candidate.id,
      checks: input.checks,
      overall,
    };
    parseProductionQaReportData(data);
    const id = `pqa-${randomUUID()}`;
    const [row] = await this.db
      .insert(productionQaRuns)
      .values({
        id,
        projectId: input.projectId,
        candidateId: candidate.id,
        candidateArtifactDigest: candidate.artifactDigest,
        data,
        overall,
      })
      .returning();
    // QA state transition: qa_passed/qa_failed. Stale candidates are frozen:
    // guard against the DB-level state space (recordQaRun only allows built/
    // qa_passed/qa_failed candidates, but re-check defensively at runtime).
    const nextState = overall === "PASS" ? "qa_passed" : overall === "FAIL" ? "qa_failed" : null;
    if (nextState !== null && (candidate.state as string) !== "stale") {
      await this.db
        .update(productionCandidates)
        .set({ state: nextState })
        .where(eq(productionCandidates.id, candidate.id));
    }
    return row!;
  }

  async latestQaRun(projectId: string, candidateId: string): Promise<ProductionQaRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(productionQaRuns)
      .where(
        and(
          eq(productionQaRuns.projectId, projectId),
          eq(productionQaRuns.candidateId, candidateId),
        ),
      )
      .orderBy(desc(productionQaRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async listQaRuns(projectId: string, candidateId: string): Promise<ProductionQaRunRecord[]> {
    return await this.db
      .select()
      .from(productionQaRuns)
      .where(
        and(
          eq(productionQaRuns.projectId, projectId),
          eq(productionQaRuns.candidateId, candidateId),
        ),
      )
      .orderBy(desc(productionQaRuns.createdAt));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRoute(pageSlug: string): string {
  const trimmed = pageSlug.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function productionError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}

// Re-export digest helper for deterministic candidate artifact digests.
export { deterministicDigest as productionArtifactDigestOf };
