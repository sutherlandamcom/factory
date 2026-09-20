import { z } from "zod";

/**
 * DESIGN IMPLEMENTATION CONTRACT (DIC) — Pre-Run-12 hardening.
 *
 * The DIC is the deterministic, typed bridge between the sole design
 * authority (AcceptedDesignArtifact) and the Astro production renderer:
 *
 *   AcceptedDesignArtifact (design-v2) + renderer implementation policy
 *     -> deterministic derivation (apps/factory/src/production/design-implementation.ts)
 *     -> DesignImplementationContract
 *     -> implementationContractDigest
 *     -> ProductionRenderManifest (production-v3) evidence lineage
 *
 * Authority status: the DIC is DERIVED, NON-AUTHORITATIVE, digest-bound
 * evidence. It has NO human approval lifecycle, NO mutable independent
 * state, and is NEVER a second design authority. Same accepted design +
 * same renderer policy version MUST derive a canonical-equivalent DIC with
 * the identical digest. It contains no raw Tailwind classes and no raw
 * provider HTML: every visual decision is expressed as governed semantic
 * tokens, registered component identities, or bounded composition grammar.
 */

export const DESIGN_IMPLEMENTATION_SCHEMA_VERSION = "design-implementation-v1" as const;

/** Bounded text helpers (mirroring the design contract conventions). */
const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const designImplementationDigestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Semantic token projection
// ---------------------------------------------------------------------------

/**
 * Governed semantic token roles. Components consume ONLY these roles;
 * inventing arbitrary colors/fonts/spacing/radii/shadows in production code
 * is a blocking design-drift violation.
 */
export const semanticTokensSchema = z
  .object({
    "color.background.primary": boundedText(60),
    "color.background.surface": boundedText(60),
    "color.text.primary": boundedText(60),
    "color.text.muted": boundedText(60),
    "color.action.primary": boundedText(60),
    "color.border.subtle": boundedText(60),
    "spacing.page-x": boundedText(40),
    "spacing.section-y": boundedText(40),
    "spacing.stack-sm": boundedText(40),
    "spacing.stack-md": boundedText(40),
    "spacing.stack-lg": boundedText(40),
    "radius.surface": boundedText(40),
    "radius.control": boundedText(40),
    "typography.display": boundedText(120),
    "typography.heading": boundedText(120),
    "typography.body": boundedText(120),
  })
  .strict();
export type SemanticTokens = z.infer<typeof semanticTokensSchema>;

/**
 * Deterministic font delivery: an accepted font-family string does not prove
 * the browser can render that exact font. The DIC records the resolved
 * delivery mechanism explicitly; unknown families FAIL derivation.
 */
export const fontDeliverySchema = z
  .object({
    /** Delivery mechanism: approved system stack or bundled local asset. */
    mode: z.enum(["approved_system_stack", "bundled_local_asset"]),
    /** Resolved CSS font-family stack (deterministic, accepted). */
    family: boundedText(300),
    /** Which accepted design token this delivery resolves. */
    sourceToken: z.enum(["typography.display", "typography.heading", "typography.body"]),
  })
  .strict();
export type FontDelivery = z.infer<typeof fontDeliverySchema>;

// ---------------------------------------------------------------------------
// Production component registry (versioned implementation policy data)
// ---------------------------------------------------------------------------

export const componentVariantSchema = z
  .object({
    /** Variant identity within the family (e.g. "bordered", "plain"). */
    id: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Bounded description of when this variant applies. */
    purpose: boundedText(300),
  })
  .strict();
export type ComponentVariant = z.infer<typeof componentVariantSchema>;

/** One registered production component family (semantic API record). */
export const componentFamilySchema = z
  .object({
    /** Semantic component ID (registry key; never a filename). */
    componentId: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** What the family is for (bounded, reviewable). */
    purpose: boundedText(300),
    /** Implemented variants (registered == implemented, bidirectionally). */
    variants: z.array(componentVariantSchema).max(10),
    /** Required semantic token roles this family consumes. */
    requiredTokens: z.array(boundedText(60)).max(16),
    /** Visual roles this family can carry (e.g. "hero-primary"). */
    visualRoles: z.array(boundedText(60)).max(10),
    /** Archetypes this family may appear in. */
    allowedArchetypes: z.array(boundedText(40)).max(8),
    /** Accepted design section patterns this family realizes. */
    allowedPatterns: z.array(boundedText(60)).max(20),
    /** Responsive behavior summary (bounded, reviewable). */
    responsiveProfile: boundedText(500),
    /** Accessibility contract summary (landmarks/headings/keyboard). */
    accessibilityContract: boundedText(500),
  })
  .strict();
export type ComponentFamily = z.infer<typeof componentFamilySchema>;

// ---------------------------------------------------------------------------
// Archetype composition grammar
// ---------------------------------------------------------------------------

/** One ordered composition binding for an archetype. */
export const archetypeComponentBindingSchema = z
  .object({
    /** Registered componentId (must exist in the registry). */
    componentId: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Variant id within the family (must be registered). */
    variant: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Which accepted design section pattern this binding realizes. */
    pattern: boundedText(60),
    /** Cardinality: exactly once or repeatable over content sections. */
    repetition: z.enum(["once", "per_section"]),
    /** Required bindings must appear; optional bindings may be omitted. */
    required: z.boolean(),
  })
  .strict();
export type ArchetypeComponentBinding = z.infer<typeof archetypeComponentBindingSchema>;

/** Bounded composition grammar for one archetype. */
export const archetypeGrammarSchema = z
  .object({
    archetype: z.enum(["homepage", "service", "location", "editorial", "investment_advisory"]),
    /** Ordered component bindings (the ONLY permitted page composition). */
    bindings: z.array(archetypeComponentBindingSchema).min(1).max(12),
  })
  .strict();
export type ArchetypeGrammar = z.infer<typeof archetypeGrammarSchema>;

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

export const designImplementationContractSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_IMPLEMENTATION_SCHEMA_VERSION),
    /** Exact accepted design authority this contract derives from. */
    sourceDesign: z
      .object({
        id: z.string().trim().min(1).max(128),
        version: z.number().int().min(1),
        digest: z.string().trim().regex(/^[0-9a-f]{64}$/),
        schemaVersion: z.string().trim().min(1).max(40),
      })
      .strict(),
    /** Renderer implementation policy identity. */
    renderer: z
      .object({
        id: z.literal("astro-static"),
        policyVersion: boundedText(60),
      })
      .strict(),
    /** Versioned registry/policy data the derivation consumed. */
    policy: z
      .object({
        registryVersion: boundedText(60),
        tokenProjectionVersion: boundedText(60),
      })
      .strict(),
    /** Governed semantic token projection. */
    semanticTokens: semanticTokensSchema,
    /** Deterministic font delivery per typography token. */
    fontDelivery: z.array(fontDeliverySchema).min(1).max(3),
    /** Registered component families available to this design. */
    componentFamilies: z.array(componentFamilySchema).min(1).max(20),
    /** Bounded per-archetype composition grammar. */
    archetypeGrammar: z.array(archetypeGrammarSchema).min(1).max(5),
    /** Generic per-archetype visual-role requirements (from design-v2). */
    visualRoleRequirements: z
      .array(
        z.object({
          archetype: z.enum(["homepage", "service", "location", "editorial", "investment_advisory"]),
          roles: z
            .array(
              z.object({
                role: z
                  .string()
                  .trim()
                  .min(1)
                  .max(60)
                  .regex(/^[a-z0-9][a-z0-9-]*$/),
                requiredRole: z.enum(["hero", "background", "inline", "chart", "illustration", "logo", "supporting"]),
                required: z.boolean(),
              })
              .strict(),
            )
            .max(10),
        }).strict(),
      )
      .min(1)
      .max(5),
    /** Deterministic contract digest (canonical JSON sha256). */
    implementationContractDigest: designImplementationDigestSchema,
  })
  .strict();
export type DesignImplementationContract = z.infer<typeof designImplementationContractSchema>;

export function parseDesignImplementationContract(input: unknown): DesignImplementationContract {
  return designImplementationContractSchema.parse(input);
}

export const DESIGN_IMPLEMENTATION_ERROR_CODES = [
  /** Accepted design cannot be projected into the supported vocabulary. */
  "design_implementation_unsupported",
  /** Accepted font family has no deterministic approved delivery. */
  "design_font_delivery_unresolved",
  /** Registry/policy data referenced by the derivation is invalid. */
  "design_implementation_policy_invalid",
] as const;
export type DesignImplementationErrorCode = (typeof DESIGN_IMPLEMENTATION_ERROR_CODES)[number];
