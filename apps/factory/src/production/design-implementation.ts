import {
  DESIGN_IMPLEMENTATION_SCHEMA_VERSION,
  parseDesignImplementationContract,
  type ComponentFamily,
  type DesignCandidateDataV2,
  type DesignImplementationContract,
} from "@factory/contracts";
import { deterministicDigest } from "../intelligence/digest.js";
import { FactoryError } from "../executor/errors.js";

/**
 * DETERMINISTIC DIC COMPILER — Pre-Run-12 hardening.
 *
 * Derives the DesignImplementationContract from the exact accepted design
 * authority (design-v2) plus the versioned renderer implementation policy.
 * This is a PURE function of its inputs: same accepted design + same policy
 * -> canonical-equivalent contract -> identical digest. There is no LLM, no
 * manual design judgment and no screenshot/HTML inspection anywhere in this
 * derivation.
 *
 * Authority status: the produced contract is derived, non-authoritative,
 * digest-bound evidence. It is never persisted as mutable state and never
 * carries its own approval lifecycle.
 */

/** Versioned registry data this policy consumes (must match the registry). */
export const PRODUCTION_COMPONENT_REGISTRY_VERSION = "production-component-registry-v1";
export const SEMANTIC_TOKEN_PROJECTION_VERSION = "semantic-token-projection-v1";

/**
 * Approved font delivery compatibility map. The accepted design names font
 * families; this versioned policy maps each APPROVED family to a
 * deterministic delivery. A family without an entry FAILS derivation —
 * the browser never silently chooses an unrelated fallback while the
 * accepted design claims that font.
 */
const APPROVED_FONT_DELIVERY: Readonly<Record<string, { mode: "approved_system_stack"; family: string }>> =
  Object.freeze({
    // Institutional serif display: accepted design authority names
    // "Source Serif 4"; the approved delivery is the governed local serif
    // stack (Iowan/Palatino/Georgia lineage) already established as the
    // site's typographic identity in the trusted site profile.
    "source serif 4": { mode: "approved_system_stack", family: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif' },
    // Humanist sans body: accepted design authority names "Public Sans";
    // the approved delivery is the governed system sans stack.
    "public sans": { mode: "approved_system_stack", family: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' },
  });

function resolveFontDelivery(family: string): { mode: "approved_system_stack"; family: string } {
  const normalized = family.trim().toLowerCase();
  const delivery = APPROVED_FONT_DELIVERY[normalized];
  if (!delivery) {
    throw new FactoryError(
      "design_font_delivery_unresolved",
      `Accepted design font family "${family}" has no deterministic approved delivery in the renderer policy; production is BLOCKED rather than silently falling back.`,
    );
  }
  return delivery;
}

/**
 * The production component registry entries available to governed
 * implementation. Each entry mirrors the reviewed Component API Review
 * (docs/design-system/production-component-registry.md): semantic ID,
 * variants, required tokens, visual roles, allowed archetypes/patterns,
 * responsive profile and accessibility contract. Registration and
 * implementation are enforced bidirectionally by design-drift QA.
 */
const REGISTRY_FAMILIES: ReadonlyArray<ComponentFamily> = Object.freeze([
  {
    componentId: "page-hero",
    purpose: "Page-opening band carrying the page's single H1, introduction and the probable-LCP hero visual.",
    variants: [
      { id: "split", purpose: "Two-column text + visual hero for homepage and service entry." },
      { id: "stacked", purpose: "Full-width stacked hero for editorial and advisory entry." },
    ],
    requiredTokens: ["color.background.primary", "color.text.primary", "typography.display", "spacing.page-x", "spacing.section-y", "radius.surface"],
    visualRoles: ["hero-primary"],
    allowedArchetypes: ["homepage", "service", "location", "editorial", "investment_advisory"],
    allowedPatterns: ["hero", "page-header", "article-header"],
    responsiveProfile: "Single column on mobile; two-column split at md for the split variant; visual never overlaps text.",
    accessibilityContract: "Renders exactly one h1 (the page title); hero img carries accepted alt authority; no text over image without contrast review.",
  },
  {
    componentId: "content-section",
    purpose: "Headed prose section rendering accepted section content verbatim with governed typography.",
    variants: [
      { id: "plain", purpose: "Default background prose section." },
      { id: "evidence", purpose: "Surface-band treatment for evidence/trust patterns." },
      { id: "structured", purpose: "Two-column treatment for structured overview patterns." },
    ],
    requiredTokens: ["color.background.primary", "color.background.surface", "color.text.primary", "typography.heading", "typography.body", "spacing.section-y", "spacing.stack-md"],
    visualRoles: [],
    allowedArchetypes: ["homepage", "service", "location", "editorial", "investment_advisory"],
    allowedPatterns: ["value-statement", "service-overview", "location-intro", "article-body", "approach", "evidence", "local-evidence", "trust-signals", "methodology", "sources", "assumptions", "disclaimer", "services-overview", "process", "faq", "coverage", "byline", "related", "scenarios", "contact"],
    responsiveProfile: "Single column on mobile; structured variant becomes two-column at md.",
    accessibilityContract: "h2 heading per section; readable body measure; no interactive elements.",
  },
  {
    componentId: "page-conclusion",
    purpose: "Closing prose band rendering the accepted conclusion verbatim.",
    variants: [{ id: "surface", purpose: "Surface-band closing section." }],
    requiredTokens: ["color.background.surface", "color.text.primary", "typography.body", "spacing.section-y"],
    visualRoles: [],
    allowedArchetypes: ["homepage", "service", "location", "editorial", "investment_advisory"],
    allowedPatterns: ["conclusion"],
    responsiveProfile: "Single column, centered measure at all breakpoints.",
    accessibilityContract: "No heading; body copy only; part of main landmark.",
  },
  {
    componentId: "page-cta",
    purpose: "Full-width conversion band rendering the accepted CTA text verbatim.",
    variants: [{ id: "text", purpose: "Text-first CTA band (text-only CTA hierarchy)." }],
    requiredTokens: ["color.background.surface", "color.text.primary", "color.action.primary", "typography.heading", "spacing.section-y"],
    visualRoles: [],
    allowedArchetypes: ["homepage", "service", "location", "editorial", "investment_advisory"],
    allowedPatterns: ["cta"],
    responsiveProfile: "Single column, centered at all breakpoints.",
    accessibilityContract: "CTA text is plain content; link semantics come from accepted content links.",
  },
  {
    componentId: "related-links",
    purpose: "Related-pages navigation list rendering accepted internal links verbatim.",
    variants: [{ id: "list", purpose: "Vertical list of accepted internal links." }],
    requiredTokens: ["color.action.primary", "typography.body", "spacing.stack-sm"],
    visualRoles: [],
    allowedArchetypes: ["homepage", "service", "location", "editorial", "investment_advisory"],
    allowedPatterns: ["related"],
    responsiveProfile: "Single column list at all breakpoints.",
    accessibilityContract: "nav with aria-label='Related pages'; links are keyboard reachable with visible focus.",
  },
]);

/** Deterministic pattern -> component binding per archetype (grammar). */
const ARCHETYPE_GRAMMAR_INPUT: Readonly<
  Record<
    DesignCandidateDataV2["archetypes"][number]["kind"],
    Array<{ componentId: string; variant: string; pattern: string; repetition: "once" | "per_section"; required: boolean }>
  >
> = Object.freeze({
  homepage: [
    { componentId: "page-hero", variant: "split", pattern: "hero", repetition: "once", required: true },
    { componentId: "content-section", variant: "plain", pattern: "value-statement", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "evidence", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "services-overview", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "trust-signals", repetition: "per_section", required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false },
  ],
  service: [
    { componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once", required: true },
    { componentId: "content-section", variant: "plain", pattern: "service-overview", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "process", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "evidence", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "faq", repetition: "per_section", required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false },
  ],
  location: [
    { componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once", required: true },
    { componentId: "content-section", variant: "plain", pattern: "location-intro", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "coverage", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "local-evidence", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "contact", repetition: "per_section", required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false },
  ],
  editorial: [
    { componentId: "page-hero", variant: "stacked", pattern: "article-header", repetition: "once", required: true },
    { componentId: "content-section", variant: "plain", pattern: "article-body", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "methodology", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "sources", repetition: "per_section", required: false },
    { componentId: "related-links", variant: "list", pattern: "related", repetition: "once", required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false },
  ],
  investment_advisory: [
    { componentId: "page-hero", variant: "stacked", pattern: "page-header", repetition: "once", required: true },
    { componentId: "content-section", variant: "plain", pattern: "approach", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "assumptions", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "structured", pattern: "scenarios", repetition: "per_section", required: false },
    { componentId: "content-section", variant: "evidence", pattern: "disclaimer", repetition: "per_section", required: false },
    { componentId: "page-conclusion", variant: "surface", pattern: "conclusion", repetition: "once", required: true },
    { componentId: "page-cta", variant: "text", pattern: "cta", repetition: "once", required: false },
  ],
});

/** Deterministic semantic token projection from accepted design tokens. */
function projectSemanticTokens(design: DesignCandidateDataV2) {
  const colors = design.tokens.colors;
  return {
    "color.background.primary": colors.background || "#ffffff",
    "color.background.surface": colors.surface || colors.neutral || colors.background || "#ffffff",
    "color.text.primary": colors.textPrimary || colors.primary,
    "color.text.muted": colors.textSecondary || colors.secondary || colors.neutral || colors.primary,
    "color.action.primary": colors.accent || colors.primary,
    "color.border.subtle": colors.secondary || colors.neutral || colors.primary,
    "spacing.page-x": design.tokens.spacing.md ?? "1rem",
    "spacing.section-y": design.tokens.spacing.lg ?? "2rem",
    "spacing.stack-sm": design.tokens.spacing.xs ?? design.tokens.spacing.sm ?? "0.5rem",
    "spacing.stack-md": design.tokens.spacing.sm ?? design.tokens.spacing.md ?? "1rem",
    "spacing.stack-lg": design.tokens.spacing.md ?? design.tokens.spacing.lg ?? "2rem",
    "radius.surface": design.tokens.rounded.md ?? "0px",
    "radius.control": design.tokens.rounded.sm ?? "0px",
    "typography.display": resolveFontDelivery(design.tokens.typography.headingFont).family,
    "typography.heading": resolveFontDelivery(design.tokens.typography.headingFont).family,
    "typography.body": resolveFontDelivery(design.tokens.typography.bodyFont).family,
  } as const;
}

/**
 * Derive the DIC. Fails closed on: unsupported design schema (v1 designs
 * need a new accepted design-v2 authority), unresolved font delivery, or a
 * grammar binding referencing an unregistered component/variant.
 */
export function deriveDesignImplementationContract(input: {
  design: DesignCandidateDataV2;
  acceptedDesign: { id: string; version: number; digest: string };
  rendererPolicyVersion: string;
}): DesignImplementationContract {
  const design = input.design;

  // Grammar bindings must reference registered families/variants only.
  const grammar = (Object.keys(ARCHETYPE_GRAMMAR_INPUT) as Array<keyof typeof ARCHETYPE_GRAMMAR_INPUT>)
    .filter((kind) => design.archetypes.some((entry) => entry.kind === kind))
    .map((kind) => ({
      archetype: kind,
      bindings: ARCHETYPE_GRAMMAR_INPUT[kind].map((binding) => {
        const family = REGISTRY_FAMILIES.find((entry) => entry.componentId === binding.componentId);
        if (!family) {
          throw new FactoryError("design_implementation_policy_invalid", `Grammar binding references unregistered component ${binding.componentId}.`);
        }
        if (!family.variants.some((variant) => variant.id === binding.variant)) {
          throw new FactoryError("design_implementation_policy_invalid", `Grammar binding references unregistered variant ${binding.componentId}/${binding.variant}.`);
        }
        if (!family.allowedArchetypes.includes(kind)) {
          throw new FactoryError("design_implementation_policy_invalid", `Component ${binding.componentId} is not allowed in archetype ${kind}.`);
        }
        if (!family.allowedPatterns.includes(binding.pattern)) {
          throw new FactoryError("design_implementation_policy_invalid", `Component ${binding.componentId} does not realize pattern ${binding.pattern}.`);
        }
        return binding;
      }),
    }));

  const families = REGISTRY_FAMILIES.filter((family) =>
    grammar.some((entry) => entry.bindings.some((binding) => binding.componentId === family.componentId)),
  );
  if (families.length === 0) {
    throw new FactoryError("design_implementation_unsupported", "Accepted design derives no registered component usage.");
  }

  const contract: DesignImplementationContract = {
    schemaVersion: DESIGN_IMPLEMENTATION_SCHEMA_VERSION,
    sourceDesign: {
      id: input.acceptedDesign.id,
      version: input.acceptedDesign.version,
      digest: input.acceptedDesign.digest,
      schemaVersion: design.schemaVersion,
    },
    renderer: { id: "astro-static", policyVersion: input.rendererPolicyVersion },
    policy: {
      registryVersion: PRODUCTION_COMPONENT_REGISTRY_VERSION,
      tokenProjectionVersion: SEMANTIC_TOKEN_PROJECTION_VERSION,
    },
    semanticTokens: projectSemanticTokens(design),
    fontDelivery: [
      { ...resolveFontDelivery(design.tokens.typography.headingFont), sourceToken: "typography.display" },
      { ...resolveFontDelivery(design.tokens.typography.headingFont), sourceToken: "typography.heading" },
      { ...resolveFontDelivery(design.tokens.typography.bodyFont), sourceToken: "typography.body" },
    ],
    componentFamilies: families.map((family) => ({ ...family })),
    archetypeGrammar: grammar,
    visualRoleRequirements: design.visualRoleRequirements.map((entry) => ({
      archetype: entry.archetype,
      roles: entry.roles.map((role) => ({ role: role.role, requiredRole: role.requiredRole, required: role.required })),
    })),
    implementationContractDigest: "",
  };
  contract.implementationContractDigest = deterministicDigest({
    ...contract,
    implementationContractDigest: "",
  });
  return parseDesignImplementationContract(contract);
}
