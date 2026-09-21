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
const APPROVED_FONT_DELIVERY: Readonly<Record<string, { mode: "bundled_local_asset"; family: string }>> =
  Object.freeze({
    "source serif 4": { mode: "bundled_local_asset", family: "'Source Serif 4', serif" },
    "public sans": { mode: "bundled_local_asset", family: "'Public Sans', sans-serif" },
  });

function resolveFontDelivery(family: string): { mode: "bundled_local_asset"; family: string } {
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

function requireToken(value: string | undefined, name: string): string {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new FactoryError("design_implementation_unsupported", `Accepted design is missing required design token '${name}'.`);
  }
  return value.trim();
}

/** Deterministic semantic token projection from accepted design tokens. */
function projectSemanticTokens(design: DesignCandidateDataV2) {
  const colors = design.tokens.colors;
  const spacing = design.tokens.spacing;
  const rounded = design.tokens.rounded;

  const bgPrimary = requireToken(colors.background, "colors.background");
  const bgSurface = requireToken(colors.surface, "colors.surface");
  const textPrimary = requireToken(colors.textPrimary, "colors.textPrimary");
  const textMuted = requireToken(colors.textSecondary, "colors.textSecondary");
  const actionPrimary = requireToken(colors.accent, "colors.accent");
  const borderSubtle = requireToken(colors.secondary, "colors.secondary");

  const spacingPageX = requireToken(spacing.md, "spacing.md");
  const spacingSectionY = requireToken(spacing.lg, "spacing.lg");
  const spacingStackSm = requireToken(spacing.sm, "spacing.sm");
  const spacingStackMd = requireToken(spacing.md, "spacing.md");
  const spacingStackLg = requireToken(spacing.lg, "spacing.lg");

  const radiusSurface = requireToken(rounded.md, "rounded.md");
  const radiusControl = requireToken(rounded.sm, "rounded.sm");

  const headingFont = requireToken(design.tokens.typography.headingFont, "typography.headingFont");
  const bodyFont = requireToken(design.tokens.typography.bodyFont, "typography.bodyFont");

  return {
    "color.background.primary": bgPrimary,
    "color.background.surface": bgSurface,
    "color.text.primary": textPrimary,
    "color.text.muted": textMuted,
    "color.action.primary": actionPrimary,
    "color.border.subtle": borderSubtle,
    "spacing.page-x": spacingPageX,
    "spacing.section-y": spacingSectionY,
    "spacing.stack-sm": spacingStackSm,
    "spacing.stack-md": spacingStackMd,
    "spacing.stack-lg": spacingStackLg,
    "radius.surface": radiusSurface,
    "radius.control": radiusControl,
    "typography.display": resolveFontDelivery(headingFont).family,
    "typography.heading": resolveFontDelivery(headingFont).family,
    "typography.body": resolveFontDelivery(bodyFont).family,
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
  const grammar = design.archetypeGrammar.map((entry) => ({
    archetype: entry.archetype,
    bindings: entry.bindings.map((binding) => {
      const family = REGISTRY_FAMILIES.find((candidate) => candidate.componentId === binding.componentId);
      if (!family) {
        throw new FactoryError("design_implementation_policy_invalid", `Grammar binding references unregistered component ${binding.componentId}.`);
      }
      if (!family.variants.some((variant) => variant.id === binding.variant)) {
        throw new FactoryError("design_implementation_policy_invalid", `Grammar binding references unregistered variant ${binding.componentId}/${binding.variant}.`);
      }
      if (!family.allowedArchetypes.includes(entry.archetype)) {
        throw new FactoryError("design_implementation_policy_invalid", `Component ${binding.componentId} is not allowed in archetype ${entry.archetype}.`);
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
