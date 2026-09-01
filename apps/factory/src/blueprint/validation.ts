import {
  normalizeScalarText,
  type NormalizedResearchEvidenceBundle,
  type SiteBlueprint,
  type SiteIntelligencePlan,
  type SiteIntelligenceRequest,
} from "@factory/contracts";
import {
  PLAN_SECTION_TO_COMPONENTS,
  componentRealizesPlanSection,
} from "./component-registry.js";

/**
 * Deterministic semantic validation for a structurally valid SiteBlueprint.
 * The blueprint model must NEVER be allowed to redesign the accepted IA, so
 * every gate here fails closed: an invalid blueprint is never accepted.
 */
export type BlueprintValidationResult =
  | { readonly ok: true; readonly blueprint: SiteBlueprint }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface BlueprintValidationContext {
  plan: SiteIntelligencePlan;
  request: SiteIntelligenceRequest;
  research: NormalizedResearchEvidenceBundle;
}

const MAX_ISSUES = 30;

function issueText(blueprint: SiteBlueprint, message: string): string {
  return `blueprint ${blueprint.siteId}: ${message}`;
}

export function validateSiteBlueprint(
  blueprint: SiteBlueprint,
  context: BlueprintValidationContext,
): BlueprintValidationResult {
  const issues: string[] = [];
  const add = (message: string): void => {
    if (issues.length < MAX_ISSUES) {
      issues.push(issueText(blueprint, message));
    }
  };

  const { plan, request, research } = context;

  // --- 1. IA preservation: the blueprint mirrors the accepted plan ---------
  if (blueprint.siteId !== plan.siteId) {
    add(`siteId "${blueprint.siteId}" does not match the accepted plan siteId "${plan.siteId}"`);
  }

  const planBySlug = new Map(plan.pages.map((page) => [page.slug, page]));
  const blueprintSlugs = new Set(blueprint.pages.map((page) => page.slug));

  if (blueprintSlugs.size !== blueprint.pages.length) {
    add("blueprint contains duplicate page slugs");
  }

  if (blueprint.pages.length !== plan.pages.length) {
    add(
      `page count ${blueprint.pages.length} does not match the accepted plan page count ${plan.pages.length} — the accepted IA cannot be resized`,
    );
  }

  for (const planPage of plan.pages) {
    const blueprintPage = blueprint.pages.find((page) => page.slug === planPage.slug);
    if (!blueprintPage) {
      add(`accepted plan page "${planPage.slug}" is missing from the blueprint`);
      continue;
    }
    if (blueprintPage.type !== planPage.type) {
      add(
        `page "${planPage.slug}" type "${blueprintPage.type}" does not match the accepted plan type "${planPage.type}"`,
      );
    }
    if (normalizeScalarText(blueprintPage.primaryTopic) !== normalizeScalarText(planPage.primaryTopic)) {
      add(
        `page "${planPage.slug}" primaryTopic "${blueprintPage.primaryTopic}" does not match the accepted plan topic "${planPage.primaryTopic}"`,
      );
    }
    if (blueprintPage.intent !== planPage.intent) {
      add(
        `page "${planPage.slug}" intent "${blueprintPage.intent}" does not match the accepted plan intent "${planPage.intent}"`,
      );
    }
  }

  for (const blueprintPage of blueprint.pages) {
    if (!planBySlug.has(blueprintPage.slug)) {
      add(`blueprint page "${blueprintPage.slug}" does not exist in the accepted plan — no page may be added`);
    }
  }

  // --- 2. Reference integrity ----------------------------------------------
  const evidenceIds = new Set(research.items.map((item) => item.id));
  const operatorFactIds = new Set((request.business.operatorFacts ?? []).map((fact) => fact.id));
  const planSlugs = new Set(plan.pages.map((page) => page.slug));

  const checkEvidenceRef = (ref: string, where: string): void => {
    if (!evidenceIds.has(ref)) {
      add(`${where} cites unknown evidence id "${ref}"`);
    }
  };
  const checkFactRef = (ref: string, where: string): void => {
    if (!operatorFactIds.has(ref)) {
      add(`${where} cites unknown operator fact id "${ref}"`);
    }
  };

  /**
   * Metric-bearing evidence requires at least one ACTUAL observed numeric
   * metric value. The accepted Intelligence contract deliberately allows
   * `metrics: {}` on a valid evidence item when another substantive field
   * (title/text/query/sourceUrl) carries the evidence — so an empty metrics
   * object or absent metrics is NOT numerical evidence. A planned chart must
   * cite at least one evidence record with a real observed number.
   */
  const metricBearingEvidenceIds = new Set(
    research.items
      .filter((item) => {
        if (item.metrics === undefined) return false;
        return Object.values(item.metrics).some(
          (value) => typeof value === "number" && Number.isFinite(value),
        );
      })
      .map((item) => item.id),
  );

  for (const page of blueprint.pages) {
    const where = `page "${page.slug}"`;

    // Page-level refs.
    for (const ref of page.sections.flatMap((section) => section.evidenceIds)) {
      checkEvidenceRef(ref, where);
    }
    for (const ref of page.sections.flatMap((section) => section.operatorFactIds)) {
      checkFactRef(ref, where);
    }

    // --- 3. Section structure vs the accepted plan page ---------------------
    const planPage = planBySlug.get(page.slug);
    if (planPage) {
      const planSectionTypes = new Set(planPage.sections);

      for (const section of page.sections) {
        const realizing = planPage.sections.filter((planSection) =>
          componentRealizesPlanSection(section.componentType, planSection),
        );
        if (realizing.length === 0) {
          add(
            `${where} section "${section.id}" (${section.componentType}) realizes no accepted plan section type (${planPage.sections.join(", ")}) — invented page structure is invalid`,
          );
        }
      }

      // Every accepted plan section type must be realized at least once.
      const realizedTypes = new Set<string>();
      for (const planSection of planPage.sections) {
        const covered = page.sections.some((section) =>
          PLAN_SECTION_TO_COMPONENTS[planSection].includes(section.componentType),
        );
        if (covered) realizedTypes.add(planSection);
      }
      for (const planSection of planPage.sections) {
        if (!realizedTypes.has(planSection)) {
          add(
            `${where} accepted plan section type "${planSection}" is not realized by any blueprint section (allowed: ${PLAN_SECTION_TO_COMPONENTS[planSection].join(" or ")})`,
          );
        }
      }
      // planSectionTypes is intentionally used only for the non-empty check above.
      if (planSectionTypes.size === 0) {
        add(`${where} accepted plan page declares no sections`);
      }
    }

    // --- 4. Section provenance (claim grounding at section level) -----------
    for (const section of page.sections) {
      const sectionWhere = `${where} section "${section.id}"`;
      for (const ref of section.evidenceIds) {
        checkEvidenceRef(ref, sectionWhere);
      }
      for (const ref of section.operatorFactIds) {
        checkFactRef(ref, sectionWhere);
      }
      if (page.readiness === "ready" && section.keyPoints.length > 0) {
        if (section.evidenceIds.length === 0 && section.operatorFactIds.length === 0) {
          add(
            `${sectionWhere} declares ${section.keyPoints.length} keyPoint(s) but cites no evidence or operator facts`,
          );
        }
      }
      // --- 5. Chart data policy ---------------------------------------------
      if (section.visualRequirement.required && section.visualRequirement.kind === "chart") {
        const hasMetricEvidence = section.evidenceIds.some((ref) => metricBearingEvidenceIds.has(ref));
        if (!hasMetricEvidence) {
          add(
            `${sectionWhere} requires a chart but cites no evidence carrying an observed numeric metric — lower the readiness or drop the visual instead of inventing data`,
          );
        }
      }
    }

    // --- 6. Internal link integrity ------------------------------------------
    for (const link of page.internalLinks) {
      if (!planSlugs.has(link.targetSlug)) {
        add(`${where} internalLinks target unknown slug "${link.targetSlug}"`);
      }
      if (link.targetSlug === page.slug) {
        add(`${where} internalLinks self-link to "${link.targetSlug}"`);
      }
    }
  }

  // --- 7. Navigation integrity ----------------------------------------------
  blueprint.site.navigation.forEach((entry, index) => {
    if (!planSlugs.has(entry.targetSlug)) {
      add(`site.navigation[${index}] targets slug "${entry.targetSlug}" outside the accepted plan`);
    }
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, blueprint };
}
