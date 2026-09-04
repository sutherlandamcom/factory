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

const MAX_PRODUCTION_GUIDANCE_CHARS = 280;

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

function boundedGuidance(text: string | undefined, label: string): string | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PRODUCTION_GUIDANCE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PRODUCTION_GUIDANCE_CHARS - 1)}…`;
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
  const briefSections = realizations.map((realization, index) => {
    const productionSection = packet.pageProduction.orderedSections[index]!;
    const blueprintSection = realization.blueprintSection;
    const guidanceParts: string[] = [];
    const layout = boundedGuidance(productionSection.layoutDirection, "layout");
    const editorial = boundedGuidance(productionSection.editorialDirection, "editorial");
    if (layout) guidanceParts.push(`Layout: ${layout}`);
    if (editorial) guidanceParts.push(`Editorial: ${editorial}`);

    let keyPoints = blueprintSection.keyPoints.slice(0, 8);
    if (keyPoints.length === 0) {
      keyPoints = [boundedGuidance(productionSection.purpose, "purpose")!];
    }

    return {
      sectionType: realization.sectionType,
      heading: blueprintSection.heading,
      keyPoints,
      prohibitedClaims: blueprintSection.prohibitedClaims.slice(0, 6),
      blueprintSectionId: blueprintSection.id,
      ...(guidanceParts.length > 0 ? { productionGuidance: guidanceParts.join(" ") } : {}),
      ...(productionSection.purpose ? { purpose: boundedGuidance(productionSection.purpose, "purpose") } : {}),
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
