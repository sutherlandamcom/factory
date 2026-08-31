import type { BlueprintComponentType, SectionType } from "@factory/contracts";

/**
 * Component capability registry — Factory-owned truth about what the site
 * runtime can actually render.
 *
 * The registry represents CONCEPTUAL capabilities, not filenames; blueprint
 * output may only reference these component types, so the planner can never
 * invent arbitrary UI. Filesystem paths are deliberately not exposed to
 * model-facing output.
 */

export interface ComponentCapability {
  componentType: BlueprintComponentType;
  /** What this capability is for, in planner-facing language. */
  purpose: string;
  supportsImage: boolean;
  supportsHeading: boolean;
  supportsCards: boolean;
  supportsCTA: boolean;
  /** May appear as multiple semantic instances on one page. */
  repeatable: boolean;
}

export const COMPONENT_CAPABILITY_REGISTRY: readonly ComponentCapability[] = Object.freeze([
  {
    componentType: "hero",
    purpose:
      "Page-opening band with the page's single H1, a short supporting statement, and optional leading CTA; the only component that renders the H1.",
    supportsImage: true,
    supportsHeading: true,
    supportsCards: false,
    supportsCTA: true,
    repeatable: false,
  },
  {
    componentType: "feature_cards",
    purpose:
      "A heading plus a bordered grid of 2-6 titled cards, each with a short explanation; the generic card primitive for capability/service/concern groupings.",
    supportsImage: false,
    supportsHeading: true,
    supportsCards: true,
    supportsCTA: false,
    repeatable: true,
  },
  {
    componentType: "content_section",
    purpose:
      "A headed prose section for substantive explanation, methodology, evidence-backed narrative, or long-form answers.",
    supportsImage: false,
    supportsHeading: true,
    supportsCards: false,
    supportsCTA: false,
    repeatable: true,
  },
  {
    componentType: "faq",
    purpose:
      "A headed list of question/answer disclosure items answering the page's real visitor questions without JavaScript.",
    supportsImage: false,
    supportsHeading: true,
    supportsCards: false,
    supportsCTA: false,
    repeatable: true,
  },
  {
    componentType: "cta",
    purpose:
      "Full-width conversion band closing the page with one clear call to action; reserved for the page's primary conversion job.",
    supportsImage: false,
    supportsHeading: true,
    supportsCards: false,
    supportsCTA: true,
    repeatable: false,
  },
]);

const REGISTRY_TYPES: readonly BlueprintComponentType[] = COMPONENT_CAPABILITY_REGISTRY.map(
  (capability) => capability.componentType,
);

export function isRegisteredComponentType(value: string): value is BlueprintComponentType {
  return (REGISTRY_TYPES as readonly string[]).includes(value);
}

/**
 * Documented mapping from plan-level section types to the component
 * capability that can realize them. `benefits` has NO dedicated component in
 * the current starter, so a plan `benefits` section is realized through
 * `feature_cards` (grouped value points) or `content_section` (narrative
 * argument) — the blueprint must cover it with one of those.
 */
export const PLAN_SECTION_TO_COMPONENTS: Readonly<Record<SectionType, readonly BlueprintComponentType[]>> =
  Object.freeze({
    hero: ["hero"],
    feature_cards: ["feature_cards"],
    content_section: ["content_section"],
    benefits: ["feature_cards", "content_section"],
    faq: ["faq"],
    cta: ["cta"],
  });

/**
 * Every plan section type must be realizable by at least one blueprint
 * section, and every blueprint section must realize at least one plan
 * section type (no invented page structure).
 */
export function componentRealizesPlanSection(
  componentType: BlueprintComponentType,
  planSectionType: SectionType,
): boolean {
  return PLAN_SECTION_TO_COMPONENTS[planSectionType].includes(componentType);
}

/** Planner-facing registry description (inert DATA for prompts). */
export function registryForPlanner(): Array<Record<string, unknown>> {
  return COMPONENT_CAPABILITY_REGISTRY.map((capability) => ({
    componentType: capability.componentType,
    purpose: capability.purpose,
    supportsImage: capability.supportsImage,
    supportsHeading: capability.supportsHeading,
    supportsCards: capability.supportsCards,
    supportsCTA: capability.supportsCTA,
    repeatable: capability.repeatable,
  }));
}
