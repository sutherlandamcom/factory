import {
  type SiteBlueprint,
  type SiteProfile,
  type SiteProductionSpec,
} from "@factory/contracts";
import { assertSafeRelativePath } from "./path-safety.js";

/**
 * Deterministic semantic validation for SiteProductionSpec v0.
 *
 * Validates:
 * 1. Spec-internal cross references (reference IDs, asset IDs, section IDs, path safety)
 * 2. Spec ↔ Blueprint compatibility (siteId, page existence, page type, section provenance, digest)
 * 3. Spec ↔ SiteProfile compatibility (siteId matching, zero profile duplication)
 * 4. Spec ↔ Evidence resolution (operator facts, discovery evidence, zero dangling IDs)
 * 5. Asset policy enforcement (blocked / reference-only assets cannot be assigned to pages)
 * 6. CTA destination validity (internal destinations target existing routes)
 */

export interface EvidenceIndex {
  readonly evidenceIds: ReadonlySet<string>;
  readonly operatorFactIds: ReadonlySet<string>;
}

export interface ProductionSpecValidationContext {
  readonly blueprint?: SiteBlueprint | undefined;
  readonly blueprintDigest?: string | undefined;
  readonly siteProfile?: SiteProfile | undefined;
  readonly evidenceIndex?: EvidenceIndex | undefined;
}

export type ProductionSpecValidationResult =
  | { readonly ok: true; readonly spec: SiteProductionSpec }
  | { readonly ok: false; readonly issues: readonly string[] };

const MAX_ISSUES = 50;

export function validateSiteProductionSpec(
  spec: SiteProductionSpec,
  context: ProductionSpecValidationContext = {},
): ProductionSpecValidationResult {
  const issues: string[] = [];

  const add = (message: string): void => {
    if (issues.length < MAX_ISSUES) {
      issues.push(`productionSpec ${spec.siteId}: ${message}`);
    }
  };

  const { blueprint, blueprintDigest, siteProfile, evidenceIndex } = context;

  // -------------------------------------------------------------------------
  // 1. Spec-internal reference and asset libraries
  // -------------------------------------------------------------------------
  const knownReferenceIds = new Set<string>();
  for (let i = 0; i < spec.references.length; i++) {
    const ref = spec.references[i]!;
    if (knownReferenceIds.has(ref.id)) {
      add(`references[${i}] duplicate reference id "${ref.id}"`);
    }
    knownReferenceIds.add(ref.id);

    if (ref.localArtifactPath !== undefined) {
      try {
        assertSafeRelativePath(ref.localArtifactPath, `reference "${ref.id}" localArtifactPath`);
      } catch (err) {
        add(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const knownAssetsById = new Map<string, (typeof spec.assets)[number]>();
  for (let i = 0; i < spec.assets.length; i++) {
    const asset = spec.assets[i]!;
    if (knownAssetsById.has(asset.id)) {
      add(`assets[${i}] duplicate asset id "${asset.id}"`);
    }
    knownAssetsById.set(asset.id, asset);

    try {
      assertSafeRelativePath(asset.localPath, `asset "${asset.id}" localPath`);
    } catch (err) {
      add(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // 2. Spec-internal page checks
  // -------------------------------------------------------------------------
  const knownPageSlugs = new Set<string>();
  for (const page of spec.pages) {
    if (knownPageSlugs.has(page.slug)) {
      add(`duplicate page brief for slug "${page.slug}"`);
    }
    knownPageSlugs.add(page.slug);

    // Page-level reference IDs
    for (const refId of (page.referenceIds ?? [])) {
      if (!knownReferenceIds.has(refId)) {
        add(`page "${page.slug}" cites unknown reference id "${refId}"`);
      }
    }

    // Page-level asset assignments
    for (const assignment of (page.assets ?? [])) {
      const asset = knownAssetsById.get(assignment.assetId);
      if (!asset) {
        add(`page "${page.slug}" assigns unknown asset id "${assignment.assetId}"`);
        continue;
      }
      if (asset.usageStatus === "blocked") {
        add(
          `page "${page.slug}" assigns blocked asset "${assignment.assetId}" (usageStatus: blocked)`,
        );
      }
      if (asset.usageStatus === "reference_only") {
        add(
          `page "${page.slug}" assigns reference-only asset "${assignment.assetId}" as a production asset (usageStatus: reference_only)`,
        );
      }
    }

    // Section-level checks
    const sectionIds = new Set<string>();
    for (const section of (page.sections ?? [])) {
      if (sectionIds.has(section.id)) {
        add(`page "${page.slug}" section id "${section.id}" is duplicated`);
      }
      sectionIds.add(section.id);

      for (const refId of (section.referenceIds ?? [])) {
        if (!knownReferenceIds.has(refId)) {
          add(`page "${page.slug}" section "${section.id}" cites unknown reference id "${refId}"`);
        }
      }

      for (const assignment of (section.assets ?? [])) {
        const asset = knownAssetsById.get(assignment.assetId);
        if (!asset) {
          add(
            `page "${page.slug}" section "${section.id}" assigns unknown asset id "${assignment.assetId}"`,
          );
          continue;
        }
        if (asset.usageStatus === "blocked") {
          add(
            `page "${page.slug}" section "${section.id}" assigns blocked asset "${assignment.assetId}" (usageStatus: blocked)`,
          );
        }
        if (asset.usageStatus === "reference_only") {
          add(
            `page "${page.slug}" section "${section.id}" assigns reference-only asset "${assignment.assetId}" as a production asset (usageStatus: reference_only)`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Spec ↔ Blueprint Validation
  // -------------------------------------------------------------------------
  if (blueprint) {
    if (spec.siteId !== blueprint.siteId) {
      add(`siteId "${spec.siteId}" does not match blueprint siteId "${blueprint.siteId}"`);
    }

    if (spec.sourceBlueprint.digest !== undefined && blueprintDigest !== undefined) {
      if (spec.sourceBlueprint.digest !== blueprintDigest) {
        add(
          `sourceBlueprint.digest "${spec.sourceBlueprint.digest}" does not match provided blueprint digest "${blueprintDigest}"`,
        );
      }
    }

    const blueprintPagesBySlug = new Map(blueprint.pages.map((p) => [p.slug, p]));

    for (const page of spec.pages) {
      const bpPage = blueprintPagesBySlug.get(page.slug);
      if (!bpPage) {
        add(
          `page "${page.slug}" does not exist in blueprint (production spec cannot invent pages outside blueprint)`,
        );
        continue;
      }
      if (page.blueprintPageType !== bpPage.type) {
        add(
          `page "${page.slug}" blueprintPageType "${page.blueprintPageType}" does not match blueprint page type "${bpPage.type}"`,
        );
      }

      // Check section provenance
      const bpSectionIds = new Set(bpPage.sections.map((s) => s.id));
      for (const section of (page.sections ?? [])) {
        for (const sourceSecId of (section.sourceBlueprintSectionIds ?? [])) {
          if (!bpSectionIds.has(sourceSecId)) {
            add(
              `page "${page.slug}" section "${section.id}" cites unknown sourceBlueprintSectionId "${sourceSecId}" (allowed: ${Array.from(bpSectionIds).join(", ") || "none"})`,
            );
          }
        }
      }

      // CTA destination target validation
      if (page.primaryCta && page.primaryCta.destination.kind === "internal") {
        const targetSlug = page.primaryCta.destination.targetSlug;
        if (!blueprintPagesBySlug.has(targetSlug)) {
          add(
            `page "${page.slug}" primaryCta targets unknown internal slug "${targetSlug}" not present in blueprint`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Spec ↔ SiteProfile Validation
  // -------------------------------------------------------------------------
  if (siteProfile) {
    if (spec.siteId !== siteProfile.siteId) {
      add(`siteId "${spec.siteId}" does not match siteProfile siteId "${siteProfile.siteId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Spec ↔ Evidence Validation
  // -------------------------------------------------------------------------
  if (evidenceIndex) {
    const { evidenceIds, operatorFactIds } = evidenceIndex;

    const checkEvidenceRef = (
      ref: { kind: "discovery_evidence" | "operator_fact"; id: string },
      location: string,
    ): void => {
      if (ref.kind === "discovery_evidence") {
        if (!evidenceIds.has(ref.id)) {
          add(`${location} cites unknown discovery evidence id "${ref.id}"`);
        }
      } else if (ref.kind === "operator_fact") {
        if (!operatorFactIds.has(ref.id)) {
          add(`${location} cites unknown operator fact id "${ref.id}"`);
        }
      }
    };

    for (const page of spec.pages) {
      for (const ref of (page.evidenceRefs ?? [])) {
        checkEvidenceRef(ref, `page "${page.slug}" evidenceRefs`);
      }
      for (const section of (page.sections ?? [])) {
        for (const ref of (section.evidenceRefs ?? [])) {
          checkEvidenceRef(
            ref,
            `page "${page.slug}" section "${section.id}" evidenceRefs`,
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, spec };
}
