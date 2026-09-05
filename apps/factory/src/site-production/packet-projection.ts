import {
  MAX_SECTION_TYPE_INSTANCES,
  parseSiteTask,
  type PageSectionBlueprint,
  type PageBlueprint,
  type SiteTask,
} from "@factory/contracts";
import type { PageProductionPacket } from "./packet.js";
import { FactoryError } from "../executor/errors.js";

/**
 * PageProductionPacket → create_page SiteTask projection (trusted compiler).
 *
 * The packet is the bounded one-page production truth; the SiteTask is the
 * machine-readable unit of work the executor accepts. This projection is
 * deliberately NARROW: it maps the packet onto the EXISTING SiteTask contract
 * (title/description/sections/contentBrief) instead of embedding the packet
 * wholesale. Provenance and bounds are preserved:
 *
 * - page type/slug come from the Blueprint page (never from spec content);
 * - sections list is derived from the packet's ordered production sections,
 *   each mapped through the Blueprint component type it realizes;
 * - contentBrief sections are positionally matched (one entry per section
 *   instance) and carry the accepted business truth: heading intent,
 *   evidence-backed key points, prohibited claims, and the section's
 *   layout/editorial direction as bounded production guidance;
 * - planned internal links are copied from the Blueprint page;
 * - the projected task re-parses through parseSiteTask so contract bounds
 *   (payload bytes, brief bounds, section instance bound) always apply.
 */


interface SectionRealization {
  readonly sectionType: SiteTask["page"]["sections"][number];
  readonly blueprintSection: PageSectionBlueprint;
}

/** Map one Blueprint section to the SiteTask section type that realizes it. */
function realizeBlueprintSection(section: PageSectionBlueprint): SiteTask["page"]["sections"][number] {
  const componentType = section.componentType;
  switch (componentType) {
    case "hero":
      return "hero";
    case "feature_cards":
      return "feature_cards";
    case "content_section":
      return "content_section";
    case "faq":
      return "faq";
    case "cta":
      return "cta";
    default: {
      const exhaustive: never = componentType;
      throw new FactoryError(
        "packet_projection_failed",
        `blueprint section "${section.id}" has unmapped component type ${String(exhaustive)}`,
      );
    }
  }
}


export interface ProjectPacketToSiteTaskInput {
  readonly packet: PageProductionPacket;
  /** Run id of the accepted Blueprint run the packet was compiled from. */
  readonly sourceBlueprintRunId: string;
}

/**
 * Project a compiled PageProductionPacket into a validated create_page task.
 * Throws FactoryError("packet_projection_failed") on structural mismatch and
 * lets parseSiteTask Zod errors propagate on contract-bound violations.
 */
export function projectPacketToSiteTask(input: ProjectPacketToSiteTaskInput): SiteTask {
  const { packet, sourceBlueprintRunId } = input;
  const blueprintPage: PageBlueprint = packet.blueprintPage;

  // 1. Ordered section instances from the packet's production sections.
  //    Every production section must cite exactly one source Blueprint
  //    section so the worker always receives accepted business truth.
  const realizations: SectionRealization[] = [];
  const blueprintSectionsById = new Map<string, PageSectionBlueprint>(
    blueprintPage.sections.map((s) => [s.id, s]),
  );

  for (const productionSection of packet.pageProduction.orderedSections) {
    if (productionSection.sourceBlueprintSectionIds.length !== 1) {
      throw new FactoryError(
        "packet_projection_failed",
        `production section "${productionSection.id}" must cite exactly one sourceBlueprintSectionId (got ${productionSection.sourceBlueprintSectionIds.length})`,
      );
    }
    const blueprintSection = blueprintSectionsById.get(productionSection.sourceBlueprintSectionIds[0]!);
    if (!blueprintSection) {
      throw new FactoryError(
        "packet_projection_failed",
        `production section "${productionSection.id}" cites unknown blueprint section "${productionSection.sourceBlueprintSectionIds[0]}"`,
      );
    }
    realizations.push({
      sectionType: realizeBlueprintSection(blueprintSection),
      blueprintSection,
    });
  }

  if (realizations.length === 0) {
    throw new FactoryError(
      "packet_projection_failed",
      `packet for page "${blueprintPage.slug}" contains no production sections`,
    );
  }

  const sectionInstances = realizations.map((r) => r.sectionType);
  const instanceCounts = new Map<string, number>();
  for (const sectionType of sectionInstances) {
    instanceCounts.set(sectionType, (instanceCounts.get(sectionType) ?? 0) + 1);
  }
  for (const [sectionType, count] of instanceCounts) {
    if (count > MAX_SECTION_TYPE_INSTANCES) {
      throw new FactoryError(
        "packet_projection_failed",
        `page "${blueprintPage.slug}" projects ${count} "${sectionType}" sections; the contract bound is ${MAX_SECTION_TYPE_INSTANCES}`,
      );
    }
  }

  // 2. Positional content brief: one entry per section instance, carrying
  //    accepted business truth + bounded production guidance. Blueprint
  //    conversion sections may legitimately carry zero keyPoints (their
  //    truth lives in purpose + cta job); the projection promotes that
  //    accepted purpose into the keyPoints slot so the brief invariant
  //    (>=1 key point per section) holds without inventing claims.
  //
  //    NO SILENT SEMANTIC LOSS: the projection never slices, ellipsizes, or
  //    drops accepted values. Where an upstream bound exceeds the downstream
  //    contract bound (contract §PR16-P2), the projection FAILS CLOSED with a
  //    typed diagnostic instead of silently shortening accepted meaning.
  const briefSections = realizations.map((realization, index) => {
    const productionSection = packet.pageProduction.orderedSections[index]!;
    const blueprintSection = realization.blueprintSection;

    // headingIntent (accepted per-instance production intent) wins over the
    // Blueprint's generic heading; repeated instances keep distinct intents.
    const heading = (productionSection.headingIntent ?? blueprintSection.heading).trim();
    if (heading.length > 120) {
      throw new FactoryError(
        "packet_projection_failed",
        `resolved heading for production section "${productionSection.id}" is ${heading.length} characters; the SiteTask contract bound is 120 — shorten the accepted heading intent instead of truncating it`,
      );
    }

    if (blueprintSection.keyPoints.length > 8) {
      throw new FactoryError(
        "packet_projection_failed",
        `blueprint section "${blueprintSection.id}" carries ${blueprintSection.keyPoints.length} key points; the SiteTask contract bound is 8 — narrow the accepted Blueprint instead of dropping points`,
      );
    }
    for (const point of blueprintSection.keyPoints) {
      if (point.length > 280) {
        throw new FactoryError(
          "packet_projection_failed",
          `key point in blueprint section "${blueprintSection.id}" is ${point.length} characters; the SiteTask contract bound is 280 — narrow the accepted Blueprint instead of truncating it`,
        );
      }
    }

    if (blueprintSection.prohibitedClaims.length > 6) {
      throw new FactoryError(
        "packet_projection_failed",
        `blueprint section "${blueprintSection.id}" carries ${blueprintSection.prohibitedClaims.length} prohibited claims; the SiteTask contract bound is 6 — narrow the accepted Blueprint instead of dropping claims`,
      );
    }
    for (const claim of blueprintSection.prohibitedClaims) {
      if (claim.length > 240) {
        throw new FactoryError(
          "packet_projection_failed",
          `prohibited claim in blueprint section "${blueprintSection.id}" is ${claim.length} characters; the SiteTask contract bound is 240 — narrow the accepted Blueprint instead of truncating it`,
        );
      }
    }

    const guidanceParts: string[] = [];
    if (productionSection.layoutDirection?.trim()) {
      guidanceParts.push(`Layout: ${productionSection.layoutDirection.trim()}`);
    }
    if (productionSection.editorialDirection?.trim()) {
      guidanceParts.push(`Editorial: ${productionSection.editorialDirection.trim()}`);
    }
    const productionGuidance = guidanceParts.length > 0 ? guidanceParts.join(" ") : undefined;
    if (productionGuidance && productionGuidance.length > 600) {
      throw new FactoryError(
        "packet_projection_failed",
        `combined production guidance for section "${productionSection.id}" is ${productionGuidance.length} characters; the SiteTask contract bound is 600 — narrow the accepted Production Spec instead of truncating it`,
      );
    }

    if (productionSection.purpose && productionSection.purpose.length > 300) {
      throw new FactoryError(
        "packet_projection_failed",
        `purpose for production section "${productionSection.id}" is ${productionSection.purpose.length} characters; the SiteTask contract bound is 300 — narrow the accepted Production Spec instead of truncating it`,
      );
    }

    const keyPoints = [...blueprintSection.keyPoints];
    if (keyPoints.length === 0) {
      keyPoints.push(productionSection.purpose.trim());
    }

    return {
      sectionType: realization.sectionType,
      heading,
      keyPoints,
      prohibitedClaims: [...blueprintSection.prohibitedClaims],
      blueprintSectionId: blueprintSection.id,
      ...(productionGuidance !== undefined ? { productionGuidance } : {}),
      ...(productionSection.purpose ? { purpose: productionSection.purpose } : {}),
    };
  });

  // 3. Assemble the task. Title/meta come from the Blueprint page identity.
  const taskInput = {
    type: "create_page" as const,
    siteId: packet.site.siteId,
    page: {
      type: blueprintPage.type,
      slug: blueprintPage.slug,
      title: blueprintPage.h1,
      description: blueprintPage.metaDescription,
      sections: sectionInstances,
      contentBrief: {
        purpose: blueprintPage.purpose,
        audience: blueprintPage.audience,
        sourceBlueprintRunId,
        sections: briefSections,
        ...(blueprintPage.internalLinks.length > 0
          ? {
              internalLinks: blueprintPage.internalLinks.map((link) => ({
                targetSlug: link.targetSlug,
                purpose: link.purpose,
              })),
            }
          : {}),
      },
    },
  };

  // 4. Re-parse through the canonical contract so every bound applies.
  return parseSiteTask(taskInput);
}
