import {
  type PageProductionBrief,
  type SiteBlueprint,
  type SiteProfile,
  type SiteProductionSpec,
} from "@factory/contracts";
import { resolveContainedPath } from "./path-safety.js";
import {
  validateSiteProductionSpec,
  type EvidenceIndex,
} from "./validation.js";

/**
 * Deterministic readiness evaluator for SiteProductionSpec v0.
 *
 * Evaluates objective production requirements:
 * - primaryCtaRequired -> CTA presence and destination validity
 * - seoTargetingRequired -> primaryKeyword and searchIntent presence
 * - localVisualReferenceRequired -> at least one assigned reference with inspectable local file
 * - approvedAssetRequired -> at least one assigned approved asset with known rights and existing file
 * - All assigned production assets -> approved, rights != unknown, file exists on disk
 * - All assigned local reference files -> file exists on disk
 * - Dangling references/assets/evidence -> BLOCKED
 *
 * Subjective quality bar criteria are NOT evaluated here (zero fake scores).
 */

export interface ReadinessContext {
  readonly inputRoot: string;
  readonly blueprint?: SiteBlueprint | undefined;
  readonly blueprintDigest?: string | undefined;
  readonly siteProfile?: SiteProfile | undefined;
  readonly evidenceIndex?: EvidenceIndex | undefined;
}

export interface PageReadinessResult {
  readonly slug: string;
  readonly status: "READY" | "BLOCKED";
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface SiteReadinessResult {
  readonly siteId: string;
  readonly status: "READY" | "BLOCKED";
  readonly readyPageCount: number;
  readonly blockedPageCount: number;
  readonly pages: readonly PageReadinessResult[];
  readonly siteBlockers: readonly string[];
  readonly siteWarnings: readonly string[];
}

export async function evaluatePageReadiness(
  page: PageProductionBrief,
  spec: SiteProductionSpec,
  context: ReadinessContext,
): Promise<PageReadinessResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const addBlocker = (msg: string): void => {
    blockers.push(`page ${page.slug}: ${msg}`);
  };

  const { inputRoot, blueprint } = context;

  const referencesById = new Map(spec.references.map((r) => [r.id, r]));
  const assetsById = new Map(spec.assets.map((a) => [a.id, a]));

  // -------------------------------------------------------------------------
  // 1. CTA Requirement
  // -------------------------------------------------------------------------
  if (page.requirements.primaryCtaRequired) {
    if (!page.primaryCta) {
      addBlocker("primaryCtaRequired is true but primaryCta is not configured");
    } else {
      if (page.primaryCta.destination.kind === "internal" && blueprint) {
        const targetSlug = page.primaryCta.destination.targetSlug;
        const exists = blueprint.pages.some((p) => p.slug === targetSlug);
        if (!exists) {
          addBlocker(
            `primaryCta targets unknown internal slug "${targetSlug}" not found in blueprint`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. SEO Requirement
  // -------------------------------------------------------------------------
  if (page.requirements.seoTargetingRequired) {
    if (!page.seo) {
      addBlocker("seoTargetingRequired is true but seo configuration is absent");
    } else {
      if (!page.seo.primaryKeyword || page.seo.primaryKeyword.trim().length === 0) {
        addBlocker("seoTargetingRequired is true but primaryKeyword is missing or blank");
      }
      if (!page.seo.searchIntent || page.seo.searchIntent.trim().length === 0) {
        addBlocker("seoTargetingRequired is true but searchIntent is missing or blank");
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Collect all assigned references and assets for the page
  // -------------------------------------------------------------------------
  const assignedRefIds = new Set<string>([
    ...(page.referenceIds ?? []),
    ...(page.sections ?? []).flatMap((s) => s.referenceIds ?? []),
  ]);

  const assignedAssetAssignments = [
    ...(page.assets ?? []),
    ...(page.sections ?? []).flatMap((s) => s.assets ?? []),
  ];

  // -------------------------------------------------------------------------
  // 4. Local Visual Reference Requirement
  // -------------------------------------------------------------------------
  let hasInspectableLocalVisualRef = false;
  for (const refId of assignedRefIds) {
    const ref = referencesById.get(refId);
    if (!ref) {
      addBlocker(`assigned reference "${refId}" not found in reference library`);
      continue;
    }
    if (ref.localArtifactPath) {
      try {
        const resolved = await resolveContainedPath(
          inputRoot,
          ref.localArtifactPath,
          `reference "${refId}"`,
        );
        if (resolved.exists) {
          hasInspectableLocalVisualRef = true;
        } else {
          addBlocker(
            `reference "${refId}" localArtifactPath "${ref.localArtifactPath}" does not exist on disk`,
          );
        }
      } catch (err) {
        addBlocker(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (page.requirements.localVisualReferenceRequired && !hasInspectableLocalVisualRef) {
    addBlocker(
      "localVisualReferenceRequired is true but no inspectable local visual reference exists on disk (all assigned references are URL-only or missing)",
    );
  }

  // -------------------------------------------------------------------------
  // 5. Asset Checks & Approved Asset Requirement
  // -------------------------------------------------------------------------
  let hasApprovedUsableAsset = false;

  for (const assignment of assignedAssetAssignments) {
    const asset = assetsById.get(assignment.assetId);
    if (!asset) {
      addBlocker(`assigned asset "${assignment.assetId}" not found in asset library`);
      continue;
    }

    if (asset.usageStatus === "blocked") {
      addBlocker(
        `assigned asset "${assignment.assetId}" is blocked from production (usageStatus: blocked)`,
      );
    } else if (asset.usageStatus === "reference_only") {
      addBlocker(
        `assigned asset "${assignment.assetId}" is marked reference_only and cannot be used in production`,
      );
    }

    if (asset.rightsStatus === "unknown") {
      addBlocker(
        `assigned asset "${assignment.assetId}" has rightsStatus "unknown" (unlicensed or unverified rights)`,
      );
    }

    let fileExists = false;
    try {
      const resolved = await resolveContainedPath(
        inputRoot,
        asset.localPath,
        `asset "${assignment.assetId}"`,
      );
      if (resolved.exists) {
        fileExists = true;
      } else {
        addBlocker(
          `assigned asset "${assignment.assetId}" localPath "${asset.localPath}" does not exist on disk`,
        );
      }
    } catch (err) {
      addBlocker(err instanceof Error ? err.message : String(err));
    }

    if (
      asset.usageStatus === "approved" &&
      asset.rightsStatus !== "unknown" &&
      fileExists
    ) {
      hasApprovedUsableAsset = true;
    }
  }

  if (page.requirements.approvedAssetRequired && !hasApprovedUsableAsset) {
    addBlocker(
      "approvedAssetRequired is true but no approved production asset with known rights exists on disk",
    );
  }

  return {
    slug: page.slug,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    blockers,
    warnings,
  };
}

export async function evaluateSiteReadiness(
  spec: SiteProductionSpec,
  context: ReadinessContext,
): Promise<SiteReadinessResult> {
  const validationResult = validateSiteProductionSpec(spec, {
    blueprint: context.blueprint,
    blueprintDigest: context.blueprintDigest,
    siteProfile: context.siteProfile,
    evidenceIndex: context.evidenceIndex,
  });

  const siteBlockers: string[] = [];
  const siteWarnings: string[] = [];

  if (!validationResult.ok) {
    for (const issue of validationResult.issues) {
      siteBlockers.push(issue);
    }
  }

  const pageResults: PageReadinessResult[] = [];
  for (const page of spec.pages) {
    const pageRes = await evaluatePageReadiness(page, spec, context);
    pageResults.push(pageRes);
  }

  const readyPageCount = pageResults.filter((p) => p.status === "READY").length;
  const blockedPageCount = pageResults.length - readyPageCount;

  const status = siteBlockers.length === 0 && blockedPageCount === 0 ? "READY" : "BLOCKED";

  return {
    siteId: spec.siteId,
    status,
    readyPageCount,
    blockedPageCount,
    pages: pageResults,
    siteBlockers,
    siteWarnings,
  };
}
