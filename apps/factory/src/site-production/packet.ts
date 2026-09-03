import {
  type PageBlueprint,
  type PageCtaConfig,
  type PageEditorialEmphasis,
  type PageProductionSection,
  type PageQualityBar,
  type PageRequirements,
  type PageSeoTargeting,
  type ReferenceDimension,
  type ReferenceKind,
  type ReferenceRole,
  type SiteBlueprint,
  type SiteCreativeDirection,
  type SiteProfile,
  type SiteProductionSpec,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { computeFileSha256AndSize, resolveContainedPath } from "./path-safety.js";

/**
 * PageProductionPacket — the bounded, one-page projection compiler for SiteProductionSpec.
 *
 * It combines:
 * 1. Upstream business truth from Blueprint and Evidence
 * 2. Production instructions from SiteProductionSpec
 *
 * It filters out ALL irrelevant pages, references, assets, and evidence to maintain
 * strict token discipline and zero information leakage across pages.
 */

export interface PacketSiteIdentity {
  readonly siteId: string;
  readonly siteName: string;
  readonly canonicalOrigin: string;
  readonly language: string;
}

export interface PacketReference {
  readonly id: string;
  readonly role: ReferenceRole;
  readonly kind: ReferenceKind;
  readonly dimensions: readonly ReferenceDimension[];
  readonly sourceUrl?: string | undefined;
  readonly localArtifactPath?: string | undefined;
  readonly artifactDigest?: string | undefined;
  readonly artifactByteSize?: number | undefined;
  readonly learn: readonly string[];
  readonly avoid: readonly string[];
  readonly notes?: string | undefined;
}

export interface PacketAsset {
  readonly id: string;
  readonly kind: string;
  readonly localPath: string;
  readonly role: string;
  readonly guidance?: string | undefined;
  readonly usageStatus: string;
  readonly rightsStatus: string;
  readonly fileDigest?: string | undefined;
  readonly byteSize?: number | undefined;
  readonly altIntent?: string | undefined;
  readonly provenanceNote?: string | undefined;
}

export interface PacketEvidenceItem {
  readonly kind: "discovery_evidence" | "operator_fact";
  readonly id: string;
  readonly data?: unknown;
}

export interface PageProductionPacket {
  readonly site: PacketSiteIdentity;
  readonly blueprintPage: PageBlueprint;
  readonly creativeDirection: SiteCreativeDirection;
  readonly pageProduction: {
    readonly requirements: PageRequirements;
    readonly seo?: PageSeoTargeting | undefined;
    readonly qualityBar?: PageQualityBar | undefined;
    readonly editorialEmphasis?: PageEditorialEmphasis | undefined;
    readonly orderedSections: readonly PageProductionSection[];
    readonly primaryCta?: PageCtaConfig | undefined;
  };
  readonly references: readonly PacketReference[];
  readonly assets: readonly PacketAsset[];
  readonly evidence: readonly PacketEvidenceItem[];
}

export interface CompilePageProductionPacketInput {
  readonly productionSpec: SiteProductionSpec;
  readonly blueprint: SiteBlueprint;
  readonly siteProfile: SiteProfile;
  readonly evidenceIndex?: {
    readonly evidenceMap?: ReadonlyMap<string, unknown> | undefined;
    readonly operatorFactsMap?: ReadonlyMap<string, unknown> | undefined;
  } | undefined;
  readonly pageSlug: string;
  readonly inputRoot?: string | undefined;
}

export async function compilePageProductionPacket(
  input: CompilePageProductionPacketInput,
): Promise<PageProductionPacket> {
  const { productionSpec, blueprint, siteProfile, evidenceIndex, pageSlug, inputRoot } = input;

  if (productionSpec.siteId !== blueprint.siteId) {
    throw new FactoryError(
      "production_spec_site_mismatch",
      `productionSpec.siteId "${productionSpec.siteId}" does not match blueprint.siteId "${blueprint.siteId}"`,
    );
  }
  if (productionSpec.siteId !== siteProfile.siteId) {
    throw new FactoryError(
      "production_spec_site_mismatch",
      `productionSpec.siteId "${productionSpec.siteId}" does not match siteProfile.siteId "${siteProfile.siteId}"`,
    );
  }

  const blueprintPage = blueprint.pages.find((p) => p.slug === pageSlug);
  if (!blueprintPage) {
    throw new FactoryError(
      "production_spec_page_not_found",
      `page "${pageSlug}" not found in blueprint`,
    );
  }

  const specPage = productionSpec.pages.find((p) => p.slug === pageSlug);
  if (!specPage) {
    throw new FactoryError(
      "production_spec_page_not_found",
      `page "${pageSlug}" not found in production spec`,
    );
  }

  if (specPage.blueprintPageType !== blueprintPage.type) {
    throw new FactoryError(
      "production_spec_type_mismatch",
      `productionSpec page "${pageSlug}" type "${specPage.blueprintPageType}" does not match blueprint page type "${blueprintPage.type}"`,
    );
  }

  // -------------------------------------------------------------------------
  // 1. Site Identity context
  // -------------------------------------------------------------------------
  const site: PacketSiteIdentity = {
    siteId: siteProfile.siteId,
    siteName: siteProfile.siteName,
    canonicalOrigin: siteProfile.canonicalOrigin,
    language: siteProfile.language,
  };

  // -------------------------------------------------------------------------
  // 2. Filter Relevant References (deterministic sort by ID)
  // -------------------------------------------------------------------------
  const relevantRefIds = new Set<string>([
    ...(specPage.referenceIds ?? []),
    ...(specPage.sections ?? []).flatMap((s) => s.referenceIds ?? []),
  ]);

  const allRefsById = new Map(productionSpec.references.map((r) => [r.id, r]));
  const references: PacketReference[] = [];

  const sortedRefIds = Array.from(relevantRefIds).sort();
  for (const refId of sortedRefIds) {
    const ref = allRefsById.get(refId);
    if (!ref) {
      throw new FactoryError(
        "production_spec_dangling_reference",
        `page "${pageSlug}" references missing reference ID "${refId}"`,
      );
    }

    let artifactDigest: string | undefined;
    let artifactByteSize: number | undefined;

    if (inputRoot && ref.localArtifactPath) {
      const resolved = await resolveContainedPath(
        inputRoot,
        ref.localArtifactPath,
        `reference "${ref.id}"`,
      );
      if (resolved.exists) {
        const metrics = await computeFileSha256AndSize(resolved.absolutePath);
        artifactDigest = metrics.digest;
        artifactByteSize = metrics.byteSize;
      }
    }

    references.push({
      id: ref.id,
      role: ref.role,
      kind: ref.kind,
      dimensions: ref.dimensions,
      sourceUrl: ref.sourceUrl,
      localArtifactPath: ref.localArtifactPath,
      artifactDigest,
      artifactByteSize,
      learn: ref.learn,
      avoid: ref.avoid,
      notes: ref.notes,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Filter Relevant Assets (deterministic sort by ID)
  // -------------------------------------------------------------------------
  const relevantAssetAssignments = new Map<string, { role: string; guidance?: string }>();

  for (const a of (specPage.assets ?? [])) {
    relevantAssetAssignments.set(a.assetId, { role: a.role, guidance: a.guidance });
  }
  for (const s of (specPage.sections ?? [])) {
    for (const a of (s.assets ?? [])) {
      if (!relevantAssetAssignments.has(a.assetId)) {
        relevantAssetAssignments.set(a.assetId, { role: a.role, guidance: a.guidance });
      }
    }
  }

  const allAssetsById = new Map(productionSpec.assets.map((a) => [a.id, a]));
  const assets: PacketAsset[] = [];

  const sortedAssetIds = Array.from(relevantAssetAssignments.keys()).sort();
  for (const assetId of sortedAssetIds) {
    const asset = allAssetsById.get(assetId);
    if (!asset) {
      throw new FactoryError(
        "production_spec_dangling_asset",
        `page "${pageSlug}" references missing asset ID "${assetId}"`,
      );
    }

    const assignment = relevantAssetAssignments.get(assetId)!;

    let fileDigest: string | undefined;
    let byteSize: number | undefined;

    if (inputRoot) {
      const resolved = await resolveContainedPath(
        inputRoot,
        asset.localPath,
        `asset "${asset.id}"`,
      );
      if (resolved.exists) {
        const metrics = await computeFileSha256AndSize(resolved.absolutePath);
        fileDigest = metrics.digest;
        byteSize = metrics.byteSize;
      }
    }

    assets.push({
      id: asset.id,
      kind: asset.kind,
      localPath: asset.localPath,
      role: assignment.role,
      guidance: assignment.guidance,
      usageStatus: asset.usageStatus,
      rightsStatus: asset.rightsStatus,
      fileDigest,
      byteSize,
      altIntent: asset.altIntent,
      provenanceNote: asset.provenanceNote,
    });
  }

  // -------------------------------------------------------------------------
  // 4. Filter Relevant Evidence (deterministic sort by ID)
  // -------------------------------------------------------------------------
  const relevantEvidenceRefs = new Map<string, "discovery_evidence" | "operator_fact">();

  for (const ref of (specPage.evidenceRefs ?? [])) {
    relevantEvidenceRefs.set(ref.id, ref.kind);
  }
  for (const sec of (specPage.sections ?? [])) {
    for (const ref of (sec.evidenceRefs ?? [])) {
      relevantEvidenceRefs.set(ref.id, ref.kind);
    }
  }

  const evidence: PacketEvidenceItem[] = [];
  const sortedEvidenceIds = Array.from(relevantEvidenceRefs.keys()).sort();

  for (const id of sortedEvidenceIds) {
    const kind = relevantEvidenceRefs.get(id)!;
    let data: unknown = undefined;

    if (evidenceIndex) {
      if (kind === "discovery_evidence" && evidenceIndex.evidenceMap) {
        data = evidenceIndex.evidenceMap.get(id);
      } else if (kind === "operator_fact" && evidenceIndex.operatorFactsMap) {
        data = evidenceIndex.operatorFactsMap.get(id);
      }
    }

    evidence.push({
      kind,
      id,
      data,
    });
  }

  return {
    site,
    blueprintPage,
    creativeDirection: productionSpec.creativeDirection,
    pageProduction: {
      requirements: specPage.requirements,
      seo: specPage.seo,
      qualityBar: specPage.qualityBar,
      editorialEmphasis: specPage.editorialEmphasis,
      orderedSections: specPage.sections,
      primaryCta: specPage.primaryCta,
    },
    references,
    assets,
    evidence,
  };
}
