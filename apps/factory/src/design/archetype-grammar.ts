import type { ArchetypeGrammar, ArchetypeComponentBinding, DesignArchetypeKind } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/** Governed composition grammar template per archetype. */
export const APPROVED_GRAMMAR_BY_ARCHETYPE: Readonly<
  Record<
    DesignArchetypeKind,
    ReadonlyArray<ArchetypeComponentBinding>
  >
> = Object.freeze({
  homepage: Object.freeze([
    { componentId: "page-hero", variant: "split", pattern: "hero", repetition: "once" as const, required: true },
    { componentId: "content-section", variant: "plain", pattern: "value-statement", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "evidence", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "services-overview", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "trust-signals", repetition: "per_section" as const, required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once" as const, required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once" as const, required: false },
  ]),
  service: Object.freeze([
    { componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once" as const, required: true },
    { componentId: "content-section", variant: "plain", pattern: "service-overview", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "process", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "evidence", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "faq", repetition: "per_section" as const, required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once" as const, required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once" as const, required: false },
  ]),
  location: Object.freeze([
    { componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once" as const, required: true },
    { componentId: "content-section", variant: "plain", pattern: "location-intro", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "coverage", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "local-evidence", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "contact", repetition: "per_section" as const, required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once" as const, required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once" as const, required: false },
  ]),
  editorial: Object.freeze([
    { componentId: "page-hero", variant: "stacked", pattern: "article-header", repetition: "once" as const, required: true },
    { componentId: "content-section", variant: "plain", pattern: "article-body", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "methodology", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "sources", repetition: "per_section" as const, required: false },
    { componentId: "related-links", variant: "list", pattern: "related", repetition: "once" as const, required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once" as const, required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once" as const, required: false },
  ]),
  investment_advisory: Object.freeze([
    { componentId: "page-hero", variant: "stacked", pattern: "page-header", repetition: "once" as const, required: true },
    { componentId: "content-section", variant: "plain", pattern: "approach", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "assumptions", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "structured", pattern: "scenarios", repetition: "per_section" as const, required: false },
    { componentId: "content-section", variant: "evidence", pattern: "disclaimer", repetition: "per_section" as const, required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once" as const, required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once" as const, required: false },
  ]),
});

function patternToBinding(kind: DesignArchetypeKind, pattern: string): ArchetypeComponentBinding {
  const approved = APPROVED_GRAMMAR_BY_ARCHETYPE[kind];
  const exact = approved.find((b) => b.pattern === pattern);
  if (exact) return { ...exact };
  // Check allowable aliases across archetypes
  if (pattern === "hero" && (kind === "service" || kind === "location")) {
    return { componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once", required: true };
  }
  if (pattern === "hero" && (kind === "editorial" || kind === "investment_advisory")) {
    return { componentId: "page-hero", variant: "stacked", pattern: kind === "editorial" ? "article-header" : "page-header", repetition: "once", required: true };
  }
  if (pattern === "evidence") {
    return { componentId: "content-section", variant: "evidence", pattern: "evidence", repetition: "per_section", required: false };
  }
  if (pattern === "cta") {
    return { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false };
  }
  if (pattern === "conclusion") {
    return { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true };
  }
  throw new FactoryError(
    "design_provider_output_invalid",
    `Provider emitted unsupported section pattern '${pattern}' for archetype '${kind}'. Supported patterns: ${approved.map((b) => b.pattern).join(", ")}.`,
  );
}

/**
 * Normalizes provider screen section patterns into approved archetype grammar.
 * Fails closed with `design_provider_output_invalid` if any pattern cannot map
 * to approved components and variants.
 */
export function normalizeArchetypeGrammar(
  archetypes: Array<{ kind: DesignArchetypeKind; sectionPatterns: string[] }>,
): ArchetypeGrammar[] {
  return archetypes.map(({ kind, sectionPatterns }) => {
    const approved = APPROVED_GRAMMAR_BY_ARCHETYPE[kind];
    if (!approved) {
      throw new FactoryError("design_provider_output_invalid", `Unsupported archetype '${kind}' in provider output.`);
    }
    const bindings: ArchetypeComponentBinding[] = [];
    for (const pattern of sectionPatterns) {
      if (pattern === "byline") {
        // metadata pattern handled by article-header
        continue;
      }
      const binding = patternToBinding(kind, pattern);
      if (!bindings.some((b) => b.pattern === binding.pattern && b.componentId === binding.componentId)) {
        bindings.push(binding);
      }
    }
    // Ensure required components (page-hero and page-conclusion) are included
    for (const req of approved.filter((b) => b.required)) {
      if (!bindings.some((b) => b.componentId === req.componentId)) {
        if (req.componentId === "page-hero") {
          bindings.unshift({ ...req });
        } else {
          const ctaIdx = bindings.findIndex((b) => b.componentId === "page-cta");
          if (ctaIdx >= 0) {
            bindings.splice(ctaIdx, 0, { ...req });
          } else {
            bindings.push({ ...req });
          }
        }
      }
    }
    return {
      archetype: kind,
      bindings,
    };
  });
}
