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
  productionCandidateInputs,
  productionCandidateRedirects,
  productionCandidates,
  productionPageInputs,
  productionQaRunChecks,
  productionQaEvidence,
  productionQaRuns,
  productionRouteAuthorities,
} from "../persistence/schema.js";
import type {
  AcceptedDesignArtifactRecord,
  ProductionCandidateRecord,
  ProductionPageInputRecord,
  ProductionQaRunRecord,
} from "../persistence/schema.js";
import {
  parseProductionPageInputData,
  parseProductionPageInputV2Data,
  type ProductionPageInputV2Data,
  type AcceptedDerivativeSetData,
  parseProductionQaReportData,
  qaOverallVerdict,
  type ProductionPageInputData,
  type ProductionQaCheckResult,
  type ProductionSiteIdentity,
  type DesignArchetypeKind,
  type PageArchetypeAuthorityRef,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { acceptedDerivativeSets } from "../persistence/schema.js";
import { DerivativesStore } from "../derivatives/store.js";
import { resolveEffectiveDerivativeSettings } from "../derivatives/core.js";
import { requireProductionDerivativeSet } from "../derivatives/production-verifier.js";
import type { ProjectDerivativePolicyData, PageDerivativeOverrideData } from "@factory/contracts";
import { assertCompleteProductionQa, hasValidQaExecutionDigest, TRUSTED_PRODUCTION_QA_GATES } from "./qa/registry.js";
import { PageAuthorityReader } from "../writer/page-authority.js";
import { PageArchetypeStore } from "../page-authority/store.js";
import { DesignStore } from "../design/design-store.js";
import { VisualStore } from "../visual/store.js";
import { AssetStore } from "../assets/asset-store.js";
import { derivePageArchetype, PageArchetypeError } from "./page-archetype.js";

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

export interface CreateProductionCandidateInput {
  projectId: string;
  productionInputId: string;
  currentEnvironment: {
    siteIdentity?: { profileDigest?: string | null };
    siteProfileDigest?: string | null;
    rendererVersion: string;
    rendererPolicyVersion: string;
  };
  repositorySha: string;
  lockfileDigest: string;
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
    siteIdentity: ProductionSiteIdentity;
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
    siteIdentity: ProductionSiteIdentity;
    rendererVersion: string;
    rendererPolicyVersion: string;
  }): Promise<ProductionPageInputRecord> {
    const bundle = await new ProductionStore(this.db).deriveAuthorityBundle({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
    });

    // Pre-Run-12 page→archetype authority: design-v2 classifies every page
    // through the durable typed PageArchetypeAuthority (requireAuthority).
    // Representative pages are provider-generation evidence only and are
    // NEVER consulted for production classification. Fail-closed: a missing
    // or unsupported durable authority blocks derivation.
    //
    // The slug-pattern derivation policy (derivePageArchetype) is NOT
    // design-v2 runtime authority; it remains only as the legacy design-v1
    // compatibility classification path below.
    const designData = bundle.design.data as { archetypes?: Array<{ kind?: string }> };
    const supportedKinds = (designData.archetypes ?? [])
      .map((entry) => entry.kind)
      .filter((kind): kind is DesignArchetypeKind =>
        typeof kind === "string" &&
        ["homepage", "service", "location", "editorial", "investment_advisory"].includes(kind),
      );
    const designSchemaVersion = (bundle.design.data as { schemaVersion?: string }).schemaVersion;
    let pageType: DesignArchetypeKind;
    let pageArchetypeAuthorityRef: PageArchetypeAuthorityRef | undefined;
    try {
      // design-v2 requires exact durable authority; design-v1 remains
      // historical compatibility and classifies via the legacy slug-pattern
      // helper (never inferred for v2/v3).
      if (designSchemaVersion === "design-v2") {
        const auth = await new PageArchetypeStore(this.db).requireAuthority(input.projectId, input.pageSlug, supportedKinds);
        pageType = auth.archetype as DesignArchetypeKind;
        pageArchetypeAuthorityRef = {
          id: auth.id,
          version: auth.version,
          digest: auth.authorityDigest,
          pageIdentity: auth.pageIdentity,
          archetype: auth.archetype as DesignArchetypeKind,
        };
      } else {
        pageType = derivePageArchetype(input.pageSlug, supportedKinds).archetype;
      }
    } catch (error) {
      if (error instanceof PageArchetypeError) {
        throw productionError(error.code, error.message);
      }
      throw error;
    }
    if (designSchemaVersion === "design-v2" && !pageArchetypeAuthorityRef) {
      throw productionError(
        "page_archetype_authority_missing",
        "design-v2 production derivation requires an exact page archetype authority binding.",
      );
    }

    const route = normalizeRoute(input.pageSlug);
    // Route authority invariant: the route must not already belong to a
    // different page identity.
    const [routeOwner] = await this.db
      .select()
      .from(productionRouteAuthorities)
      .where(and(eq(productionRouteAuthorities.projectId, input.projectId), eq(productionRouteAuthorities.route, route)));
    if (routeOwner && routeOwner.pageIdentity !== input.pageSlug) {
      throw productionError(
        "production_route_conflict",
        `Route ${route} is already claimed by page ${routeOwner.pageIdentity}.`,
      );
    }
    if (!routeOwner) {
      await this.db.insert(productionRouteAuthorities).values({
        projectId: input.projectId,
        route,
        pageIdentity: input.pageSlug,
      });
    }

    // Run 10: bind the exact current AcceptedDerivativeSet. Absence of any
    // derivative policy resolves to explicit disabled (pre-Run-10 projects
    // keep building unchanged); enabled-but-missing-current derivative
    // artifacts FAIL derivation (readiness rule).
    const currentDerivativePolicy = await new DerivativesStore(this.db).currentPolicy(input.projectId);
    const currentDerivativeOverride = await new DerivativesStore(this.db).currentOverride(input.projectId, input.pageSlug);
    const effectiveDerivatives = resolveEffectiveDerivativeSettings({
      projectPolicy: currentDerivativePolicy ? (currentDerivativePolicy.data as ProjectDerivativePolicyData) : null,
      pageOverride: currentDerivativeOverride ? (currentDerivativeOverride.data as PageDerivativeOverrideData) : null,
    });
    const [derivativeSet] = await this.db
      .select()
      .from(acceptedDerivativeSets)
      .where(
        and(
          eq(acceptedDerivativeSets.projectId, input.projectId),
          eq(acceptedDerivativeSets.pageIdentity, input.pageSlug),
        ),
      )
      .orderBy(desc(acceptedDerivativeSets.version))
      .limit(1);
    let derivativeSetRef: { id: string; version: number; digest: string } | null = null;
    if (derivativeSet) {
      const verified = await requireProductionDerivativeSet({
        db: this.db,
        projectId: input.projectId,
        pageIdentity: input.pageSlug,
        setId: derivativeSet.id,
        setVersion: derivativeSet.version,
        setDigest: derivativeSet.setDigest,
        currentContent: {
          id: bundle.content.id,
          version: bundle.content.version,
          digest: bundle.content.digest,
        },
      });
      derivativeSetRef = {
        id: verified.set.id,
        version: verified.set.version,
        digest: verified.set.setDigest,
      };
    } else if (effectiveDerivatives.summary.state === "enabled" || effectiveDerivatives.audio.state === "enabled") {
      // Readiness rule: enabled policy with NO accepted derivative set at all
      // fails derivation — a required derivative must not be silently omitted.
      throw productionError(
        "derivative_required_artifact_missing",
        `Effective derivative policy enables ${effectiveDerivatives.summary.state === "enabled" ? "summary" : "audio"} but no accepted derivative set exists for this page.`,
      );
    }

    const hasDerivativeSet = derivativeSetRef !== null;
    const data: ProductionPageInputData | ProductionPageInputV2Data = hasDerivativeSet
      ? {
          schemaVersion: "production-v2",
          projectId: input.projectId,
          pageIdentity: input.pageSlug,
          pageType: pageType as ProductionPageInputData["pageType"],
          route,
          siteIdentity: input.siteIdentity,
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
          acceptedDerivativeSet: derivativeSetRef!,
          renderer: {
            id: "astro-static",
            version: input.rendererVersion,
            policyVersion: input.rendererPolicyVersion,
          },
          ...(pageArchetypeAuthorityRef ? { pageArchetypeAuthority: pageArchetypeAuthorityRef } : {}),
        }
      : {
          schemaVersion: "production-v1",
          projectId: input.projectId,
          pageIdentity: input.pageSlug,
          pageType: pageType as ProductionPageInputData["pageType"],
          route,
          siteIdentity: input.siteIdentity,
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
          ...(pageArchetypeAuthorityRef ? { pageArchetypeAuthority: pageArchetypeAuthorityRef } : {}),
        };
    if (hasDerivativeSet) {
      parseProductionPageInputV2Data(data);
    } else {
      parseProductionPageInputData(data);
    }
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
          canonicalOrigin: input.siteIdentity.canonicalOrigin,
          siteId: input.siteIdentity.siteId,
          siteName: input.siteIdentity.siteName,
          siteLanguage: input.siteIdentity.language,
          siteProfileDigest: input.siteIdentity.profileDigest,
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
    currentEnvironment?: {
      siteIdentity?: { profileDigest?: string | null };
      siteProfileDigest?: string | null;
      rendererVersion?: string | null;
      rendererPolicyVersion?: string | null;
    },
  ): Promise<{ stale: boolean; reason: string | null }> {
    const profileDigest = currentEnvironment?.siteIdentity?.profileDigest ?? currentEnvironment?.siteProfileDigest;
    if (profileDigest && input.siteProfileDigest && profileDigest !== input.siteProfileDigest) {
      return { stale: true, reason: "Site profile changed or was superseded." };
    }
    if (currentEnvironment?.rendererVersion && input.rendererVersion && currentEnvironment.rendererVersion !== input.rendererVersion) {
      return { stale: true, reason: "Renderer version changed or was superseded." };
    }
    if (currentEnvironment?.rendererPolicyVersion && input.rendererPolicyVersion && currentEnvironment.rendererPolicyVersion !== input.rendererPolicyVersion) {
      return { stale: true, reason: "Renderer policy version changed or was superseded." };
    }

    // Content: exact id/version/digest must still be the current accepted page.
    const pages = await new PageAuthorityReader(this.db).currentPages(input.projectId);
    const page = pages.find((row) => row.slug === input.pageIdentity);
    if (!page || page.id !== input.acceptedContentId || page.version !== input.acceptedContentVersion || page.contentDigest !== input.acceptedContentDigest) {
      return { stale: true, reason: "AcceptedPageContent changed or was superseded." };
    }

    // Design: historical existence is insufficient; compare with the exact
    // latest accepted production authority and execute its full verifier.
    const latestDesign = await new DesignStore(this.db).latestAcceptedDesign(input.projectId);
    const design = latestDesign?.artifact;
    if (!design || latestDesign.staleness.stale || design.id !== input.acceptedDesignId || design.version !== input.acceptedDesignVersion || design.candidateDigest !== input.acceptedDesignDigest) {
      return { stale: true, reason: "AcceptedDesignArtifact changed or was superseded." };
    }
    try {
      await new DesignStore(this.db).requireProductionDesign(input.projectId, design.id, input.acceptedDesignDigest);
    } catch {
      return { stale: true, reason: "AcceptedDesignArtifact is no longer valid production authority." };
    }

    // Visual set: require the latest exact set and its current design binding.
    const visualStore = new VisualStore(this.db);
    const set = await visualStore.latestAcceptedSet(input.projectId);
    if (!set || set.id !== input.acceptedVisualSetId || set.version !== input.acceptedVisualSetVersion || set.setDigest !== input.acceptedVisualSetDigest) {
      return { stale: true, reason: "AcceptedVisualAssetSet changed or was superseded." };
    }
    if (set.designArtifactId !== design.id || set.designArtifactVersion !== design.version || set.designCandidateDigest !== design.candidateDigest) {
      return { stale: true, reason: "AcceptedVisualAssetSet no longer binds the current accepted design." };
    }
    let verifiedSlots;
    try {
      verifiedSlots = (await visualStore.requireProductionVisualSet(input.projectId, set.id, set.setDigest)).slots;
    } catch {
      return { stale: true, reason: "AcceptedVisualAssetSet is no longer valid production authority." };
    }

    // Per-slot lineage for this page must still match the accepted slots.
    const pageSlots = verifiedSlots.filter((slot) => slot.pageSlug === input.pageIdentity);
    for (const slot of pageSlots) {
      const version = await new AssetStore(this.db).getVersion(input.projectId, slot.resolvedVersionId);
      if (!version || version.binaryDigest !== slot.binaryDigest || version.governanceDigest !== slot.governanceDigest) {
        return { stale: true, reason: `Visual slot ${slot.slot} no longer resolves to its bound asset version.` };
      }
    }

    // Page archetype authority: verify exact binding against current durable authority in PageArchetypeStore.
    const inputData = input.data as {
      schemaVersion?: string;
      pageArchetypeAuthority?: PageArchetypeAuthorityRef;
    };
    const designData = design.data as { schemaVersion?: string };
    if (designData.schemaVersion === "design-v2" && !inputData.pageArchetypeAuthority) {
      return {
        stale: true,
        reason: "design-v2 ProductionPageInput is missing exact page archetype authority binding.",
      };
    }
    if (inputData.pageArchetypeAuthority) {
      const boundAuth = inputData.pageArchetypeAuthority;
      const currentAuth = await new PageArchetypeStore(this.db).getAuthority(input.projectId, input.pageIdentity);
      if (
        !currentAuth ||
        currentAuth.id !== boundAuth.id ||
        currentAuth.version !== boundAuth.version ||
        currentAuth.authorityDigest !== boundAuth.digest ||
        boundAuth.pageIdentity !== input.pageIdentity ||
        currentAuth.archetype !== boundAuth.archetype
      ) {
        return {
          stale: true,
          reason: `Page archetype authority changed or was superseded for "${input.pageIdentity}".`,
        };
      }
    } else {
      if (designData?.schemaVersion === "design-v2") {
        const currentArch = await new PageArchetypeStore(this.db).getArchetype(input.projectId, input.pageIdentity);
        if (currentArch && currentArch !== input.pageType) {
          return {
            stale: true,
            reason: `Page archetype changed from ${input.pageType} to ${currentArch} for "${input.pageIdentity}".`,
          };
        }
      }
    }

    // Run 10: a derivative-aware (production-v2) input is stale when its bound
    // AcceptedDerivativeSet is superseded or no longer current. No hidden
    // exceptions: staleness propagates through the existing candidate rules.
    if (inputData.schemaVersion === "production-v2") {
      const boundSet = (input.data as { acceptedDerivativeSet?: { id: string; version: number; digest: string } }).acceptedDerivativeSet;
      if (!boundSet) {
        return { stale: true, reason: "production-v2 input missing acceptedDerivativeSet binding." };
      }
      try {
        await requireProductionDerivativeSet({
          db: this.db,
          projectId: input.projectId,
          pageIdentity: input.pageIdentity,
          setId: boundSet.id,
          setVersion: boundSet.version,
          setDigest: boundSet.digest,
          currentContent: {
            id: input.acceptedContentId,
            version: input.acceptedContentVersion,
            digest: input.acceptedContentDigest,
          },
        });
      } catch (err) {
        return { stale: true, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    return { stale: false, reason: null };
  }

  /**
   * Check whether a candidate has become stale against the build identity
   * (repositorySha, lockfileDigest, siteProfileDigest, rendererVersion).
   */
  candidateStaleness(
    candidate: ProductionCandidateRecord,
    currentIdentity: {
      siteIdentity?: { profileDigest?: string | null };
      siteProfileDigest?: string | null;
      rendererVersion?: string | null;
      repositorySha?: string | null;
      lockfileDigest?: string | null;
    },
  ): { stale: boolean; reason: string | null } {
    return candidateBuildStaleness(candidate, currentIdentity);
  }

  // ---- ProductionCandidate ---------------------------------------------------

  /**
   * Create a new immutable ProductionCandidate for an input. Serialized by
   * the shared project advisory lock. Stale inputs are refused: caller must
   * supply current environment identity (site profile, renderer version,
   * renderer policy version) and upstream authority (content, design, visual set)
   * must remain fresh. Upstream mutation requires re-derivation (a new input),
   * never a silent rebuild.
   */
  async createCandidate(input: CreateProductionCandidateInput): Promise<ProductionCandidateRecord> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      return new ProductionStore(tx as unknown as FactoryDb).createCandidateLocked(input);
    });
    return result;
  }

  private async createCandidateLocked(input: CreateProductionCandidateInput): Promise<ProductionCandidateRecord> {
    const profileDigest =
      input.currentEnvironment?.siteProfileDigest ??
      input.currentEnvironment?.siteIdentity?.profileDigest;
    if (
      !input.currentEnvironment ||
      !profileDigest ||
      !input.currentEnvironment.rendererVersion ||
      !input.currentEnvironment.rendererPolicyVersion
    ) {
      throw productionError(
        "production_authority_stale",
        "Candidate creation requires current site profile, renderer version, and renderer policy version.",
      );
    }
    if (!input.repositorySha || !input.lockfileDigest) {
      throw productionError(
        "production_build_rejected",
        "Candidate creation requires repository SHA and lockfile digest.",
      );
    }

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
    const staleness = await new ProductionStore(this.db).inputStaleness(productionInput, input.currentEnvironment);
    if (staleness.stale) {
      throw productionError("production_authority_stale", staleness.reason ?? "Production input is stale.");
    }

    if (!productionInput.siteProfileDigest) {
      throw productionError("production_build_rejected", "Production input predates immutable site identity; derive a new input.");
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
        siteProfileDigest: productionInput.siteProfileDigest,
        rendererVersion: productionInput.rendererVersion,
        repositorySha: input.repositorySha,
        lockfileDigest: input.lockfileDigest,
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
    manifestSetDigest: string;
    candidateInputs: Array<{
      productionInputId: string;
      productionInputVersion: number;
      productionInputDigest: string;
      pageIdentity: string;
      route: string;
      manifestDigest: string;
    }>;
    redirectRules: Array<{ source: string; destination: string; kind: "permanent" | "temporary" }>;
    redirectSnapshotDigest: string;
  }): Promise<ProductionCandidateRecord> {
    const result = await this.db.transaction(async (tx) => {
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
        return { staleReason: staleness.reason ?? "Authority changed during build." } as const;
      }
      for (const binding of input.candidateInputs) {
        const [boundInput] = await tx.select().from(productionPageInputs).where(and(
          eq(productionPageInputs.projectId, input.projectId),
          eq(productionPageInputs.id, binding.productionInputId),
        ));
        if (!boundInput || boundInput.version !== binding.productionInputVersion || boundInput.inputDigest !== binding.productionInputDigest) {
          throw productionError("production_authority_digest_mismatch", `Candidate input ${binding.productionInputId} drifted.`);
        }
        const boundStaleness = await new ProductionStore(tx as unknown as FactoryDb).inputStaleness(boundInput);
        if (boundStaleness.stale) {
          await tx.update(productionCandidates).set({ state: "stale" }).where(eq(productionCandidates.id, candidate.id));
          return { staleReason: boundStaleness.reason ?? "A site input changed during build." } as const;
        }
      }
      if (input.candidateInputs.length === 0 || !input.candidateInputs.some((entry) => entry.productionInputId === candidate.productionInputId)) {
        throw productionError("production_build_rejected", "Candidate site snapshot does not include its target input.");
      }
      await tx.insert(productionCandidateInputs).values(input.candidateInputs.map((binding) => ({
        candidateId: candidate.id,
        projectId: input.projectId,
        ...binding,
      })));
      if (input.redirectRules.length > 0) {
        await tx.insert(productionCandidateRedirects).values(input.redirectRules.map((rule) => ({
          candidateId: candidate.id,
          projectId: input.projectId,
          ...rule,
        })));
      }
      const [updated] = await tx
        .update(productionCandidates)
        .set({
          artifactDigest: input.artifactDigest,
          artifactRef: input.artifactRef,
          assetReferences: input.assetReferences as never,
          manifestSetDigest: input.manifestSetDigest,
          redirectSnapshotDigest: input.redirectSnapshotDigest,
          state: "built",
        })
        .where(eq(productionCandidates.id, candidate.id))
        .returning();
      return { row: updated! } as const;
    });
    if ("staleReason" in result) throw productionError("production_authority_stale", result.staleReason ?? "Candidate authority is stale.");
    return result.row;
  }

  async listCandidateInputs(projectId: string, candidateId: string) {
    return await this.db.select().from(productionCandidateInputs).where(and(
      eq(productionCandidateInputs.projectId, projectId),
      eq(productionCandidateInputs.candidateId, candidateId),
    )).orderBy(productionCandidateInputs.route);
  }

  async listCandidateRedirects(projectId: string, candidateId: string) {
    return await this.db.select().from(productionCandidateRedirects).where(and(
      eq(productionCandidateRedirects.projectId, projectId),
      eq(productionCandidateRedirects.candidateId, candidateId),
    )).orderBy(productionCandidateRedirects.source);
  }

  async recordTrustedQaEvidence(input: {
    projectId: string;
    candidateId: string;
    check: ProductionQaCheckResult;
    artifactDigest?: string;
    repositorySha?: string;
    lockfileDigest?: string;
  }) {
    if (!hasValidQaExecutionDigest(input.check)) {
      throw productionError("production_qa_failed", "Trusted QA evidence is missing execution identity.");
    }
    const gate = TRUSTED_PRODUCTION_QA_GATES.find((entry) => entry.checkId === input.check.checkId);
    if (!gate || input.check.scope !== gate.scope) throw productionError("production_qa_failed", "Unsupported trusted QA gate or scope.");
    const candidate = await this.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw productionError("production_candidate_not_found", "Candidate not found.");
    const expectedSubject = gate.scope === "site" ? candidate.manifestSetDigest : gate.scope === "repository" ? candidate.repositorySha : input.check.subject;
    if (!expectedSubject || input.check.subject !== expectedSubject) throw productionError("production_qa_failed", "Trusted QA evidence subject does not match candidate identity.");
    if (gate.scope === "page") {
      const bindings = await this.listCandidateInputs(input.projectId, input.candidateId);
      if (!bindings.some((binding) => binding.route === input.check.subject)) throw productionError("production_qa_failed", "Page evidence route is not in the candidate snapshot.");
    }
    if (input.check.scope === "repository") {
      if (input.repositorySha !== candidate.repositorySha || input.lockfileDigest !== candidate.lockfileDigest) throw productionError("production_qa_failed", "Repository evidence identity mismatch.");
    } else if (input.artifactDigest !== candidate.artifactDigest) {
      throw productionError("production_qa_failed", "Artifact evidence identity mismatch.");
    }
    const [row] = await this.db.insert(productionQaEvidence).values({
      id: `pqae-${randomUUID()}`,
      projectId: input.projectId,
      candidateId: input.candidateId,
      checkId: input.check.checkId,
      scope: input.check.scope,
      subject: input.check.subject,
      tool: input.check.tool,
      toolVersion: input.check.toolVersion,
      executionDigest: input.check.executionDigest,
      artifactDigest: input.artifactDigest,
      repositorySha: input.repositorySha,
      lockfileDigest: input.lockfileDigest,
      verdict: input.check.verdict,
      data: input.check,
    }).onConflictDoNothing().returning();
    return row ?? null;
  }

  async listTrustedQaEvidence(projectId: string, candidateId: string): Promise<ProductionQaCheckResult[]> {
    const rows = await this.db.select().from(productionQaEvidence).where(and(eq(productionQaEvidence.projectId, projectId), eq(productionQaEvidence.candidateId, candidateId)));
    return rows.map((row) => row.data as ProductionQaCheckResult);
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
    evaluatedArtifactDigest: string;
    manifestSetDigest: string;
    redirectSnapshotDigest: string;
    repositorySha: string;
    lockfileDigest: string;
    pageRoutes: string[];
  }): Promise<ProductionQaRunRecord> {
    const completeness = assertCompleteProductionQa({ checks: input.checks, pageRoutes: input.pageRoutes, manifestSetDigest: input.manifestSetDigest, repositorySha: input.repositorySha });
    if (!completeness.complete) throw productionError("production_qa_failed", `Required QA evidence missing or duplicated: ${completeness.missing.join(", ")}`);
    const overall = qaOverallVerdict(input.checks);
    const data = {
      schemaVersion: "production-v1" as const,
      candidateId: input.candidateId,
      checks: input.checks,
      overall,
    };
    parseProductionQaReportData(data);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [candidate] = await tx.select().from(productionCandidates).where(and(eq(productionCandidates.projectId, input.projectId), eq(productionCandidates.id, input.candidateId)));
      if (!candidate) throw productionError("production_candidate_not_found", "Candidate not found.");
      if (candidate.state !== "built" && candidate.state !== "qa_passed" && candidate.state !== "qa_failed") throw productionError("production_qa_not_found", "Candidate has no completed build to QA.");
      if (candidate.artifactDigest !== input.evaluatedArtifactDigest || candidate.manifestSetDigest !== input.manifestSetDigest || candidate.redirectSnapshotDigest !== input.redirectSnapshotDigest || candidate.repositorySha !== input.repositorySha || candidate.lockfileDigest !== input.lockfileDigest) {
        throw productionError("production_qa_failed", "QA evidence does not bind the candidate artifact, manifest, redirect, repository, and lockfile identities exactly.");
      }
      const bindings = await tx.select().from(productionCandidateInputs).where(and(eq(productionCandidateInputs.projectId, input.projectId), eq(productionCandidateInputs.candidateId, candidate.id)));
      if (bindings.length === 0 || bindings.length !== input.pageRoutes.length || [...bindings.map((entry) => entry.route)].sort().join("\0") !== [...input.pageRoutes].sort().join("\0")) {
        throw productionError("production_qa_failed", "Candidate input snapshot is incomplete for the evaluated route set.");
      }
      for (const binding of bindings) {
        const [boundInput] = await tx.select().from(productionPageInputs).where(and(eq(productionPageInputs.projectId, input.projectId), eq(productionPageInputs.id, binding.productionInputId)));
        if (!boundInput || boundInput.version !== binding.productionInputVersion || boundInput.inputDigest !== binding.productionInputDigest) throw productionError("production_authority_digest_mismatch", `Candidate input ${binding.productionInputId} no longer matches its immutable binding.`);
        const staleness = await new ProductionStore(tx as unknown as FactoryDb).inputStaleness(boundInput);
        if (staleness.stale) {
          await tx.update(productionCandidates).set({ state: "stale" }).where(eq(productionCandidates.id, candidate.id));
          return { staleReason: staleness.reason ?? `Candidate input ${binding.productionInputId} is stale.` } as const;
        }
      }
      const trustedRows = await tx.select().from(productionQaEvidence).where(and(eq(productionQaEvidence.projectId, input.projectId), eq(productionQaEvidence.candidateId, candidate.id)));
      const trustedCheckIds = new Set<ProductionQaCheckResult["checkId"]>(TRUSTED_PRODUCTION_QA_GATES.map((entry) => entry.checkId));
      for (const check of input.checks.filter((entry) => trustedCheckIds.has(entry.checkId))) {
        if (!hasValidQaExecutionDigest(check)) throw productionError("production_qa_failed", `Trusted QA execution digest is invalid for ${check.checkId}.`);
        const evidence = trustedRows.find((row) => row.checkId === check.checkId && row.scope === check.scope && row.subject === check.subject);
        if (!evidence || evidence.executionDigest !== check.executionDigest || evidence.verdict !== check.verdict) throw productionError("production_qa_failed", `Trusted QA evidence is not the persisted candidate-bound execution for ${check.checkId}@${check.subject}.`);
        if (check.scope === "repository") {
          if (evidence.repositorySha !== candidate.repositorySha || evidence.lockfileDigest !== candidate.lockfileDigest) throw productionError("production_qa_failed", `Repository evidence binding mismatch for ${check.checkId}.`);
        } else if (evidence.artifactDigest !== candidate.artifactDigest) {
          throw productionError("production_qa_failed", `Artifact evidence binding mismatch for ${check.checkId}.`);
        }
      }
      const id = `pqa-${randomUUID()}`;
      const [row] = await tx.insert(productionQaRuns).values({ id, projectId: input.projectId, candidateId: candidate.id, candidateArtifactDigest: candidate.artifactDigest, data, overall }).returning();
      await tx.insert(productionQaRunChecks).values(input.checks.map((entry) => ({ qaRunId: id, checkId: entry.checkId, scope: entry.scope!, subject: entry.subject!, verdict: entry.verdict, data: entry })));
      const nextState = overall === "PASS" ? "qa_passed" : overall === "FAIL" ? "qa_failed" : "built";
      await tx.update(productionCandidates).set({ state: nextState }).where(eq(productionCandidates.id, candidate.id));
      return { row: row! } as const;
    });
    if ("staleReason" in result) throw productionError("production_authority_stale", result.staleReason ?? "Candidate authority is stale.");
    return result.row;
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

/**
 * Check whether a candidate has become stale against the build identity
 * (repositorySha, lockfileDigest, siteProfileDigest, rendererVersion).
 */
export function candidateBuildStaleness(
  candidate: ProductionCandidateRecord,
  currentIdentity: {
    siteIdentity?: { profileDigest?: string | null };
    siteProfileDigest?: string | null;
    rendererVersion?: string | null;
    repositorySha?: string | null;
    lockfileDigest?: string | null;
  },
): { stale: boolean; reason: string | null } {
  const profileDigest = currentIdentity.siteIdentity?.profileDigest ?? currentIdentity.siteProfileDigest;
  if (profileDigest && candidate.siteProfileDigest && profileDigest !== candidate.siteProfileDigest) {
    return { stale: true, reason: "Site profile changed after candidate preparation." };
  }
  if (currentIdentity.rendererVersion && candidate.rendererVersion && currentIdentity.rendererVersion !== candidate.rendererVersion) {
    return { stale: true, reason: "Renderer version changed after candidate preparation." };
  }
  if (currentIdentity.repositorySha && candidate.repositorySha && currentIdentity.repositorySha !== candidate.repositorySha) {
    return { stale: true, reason: "Repository SHA changed after candidate preparation." };
  }
  if (currentIdentity.lockfileDigest && candidate.lockfileDigest && currentIdentity.lockfileDigest !== candidate.lockfileDigest) {
    return { stale: true, reason: "Lockfile digest changed after candidate preparation." };
  }
  return { stale: false, reason: null };
}

// Re-export digest helper for deterministic candidate artifact digests.
export { deterministicDigest as productionArtifactDigestOf };
