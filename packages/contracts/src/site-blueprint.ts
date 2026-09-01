import { z } from "zod";
import {
  evidenceMetricsSchema,
  intelligenceIntentSchema,
  isoDateTimeSchema,
  normalizeScalarText,
  stableIdSchema,
} from "./site-intelligence.js";
import {
  pageTypeSchema,
  siteIdSchema,
  slugSchema,
} from "./site-task.js";

/**
 * SiteBlueprint contracts (Autonomy v0 vertical slice).
 *
 * Pipeline position:
 *
 *   accepted/candidate-valid SiteIntelligencePlan
 *     + SiteIntelligenceRequest + normalized ResearchEvidenceBundle
 *     → isolated blueprint synthesis (bounded repair)
 *     → SiteBlueprint (strictly validated, IA-preserving)
 *
 * A SiteBlueprint preserves the accepted Information Architecture exactly
 * (same page set, same types, same primary topics) and refines each page
 * into machine-readable intent: content jobs, section-level provenance,
 * prohibited claims, internal links, media requirements, and honest page
 * readiness. It deliberately does NOT contain final website copy.
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed.
 */

/** The one methodology identifier for this vertical slice. */
export const SITE_BLUEPRINT_METHODOLOGY_VERSION = "site-blueprint-v0";

/** Raw model output ceiling (single strict JSON document). */
export const MAX_BLUEPRINT_MODEL_OUTPUT_BYTES = 256 * 1024; // 256 KB
/** Serialized blueprint payload ceiling for artifacts and parsing. */
export const MAX_BLUEPRINT_BYTES = 256 * 1024; // 256 KB
/** Blueprint-specific synthesis attempt ceiling. */
export const MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS = 3;

/**
 * Page readiness is mandatory and honest: Factory must be allowed to say
 * "NOT READY TO PUBLISH" instead of inventing content. A page whose support
 * (operator facts, evidence, verified business input) is insufficient must
 * never claim `ready`.
 */
export const blueprintReadinessSchema = z.enum([
  "ready",
  "missing_operator_input",
  "insufficient_evidence",
  "blocked",
]);

export type BlueprintReadiness = z.infer<typeof blueprintReadinessSchema>;

/**
 * Conceptual media kinds a planned visual may belong to. `required: true`
 * demands a truthful purpose and kind; a chart additionally demands cited
 * numerical evidence (validated deterministically). NO IMAGE is always
 * preferable to a useless image.
 */
export const blueprintVisualKindSchema = z.enum([
  "photo",
  "diagram",
  "chart",
  "map",
  "product-ui",
  "illustration",
  "other",
]);

export type BlueprintVisualKind = z.infer<typeof blueprintVisualKindSchema>;

export const blueprintVisualRequirementSchema = z
  .object({
    required: z.boolean(),
    /** 1-300 chars: what the visual must add (information, understanding, trust, context). */
    purpose: z.string().trim().min(1).max(300).optional(),
    kind: blueprintVisualKindSchema.optional(),
  })
  .strict()
  .superRefine((visual, ctx) => {
    if (visual.required) {
      if (visual.purpose === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "visualRequirement.purpose is required when required is true",
          path: ["purpose"],
        });
      }
      if (visual.kind === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "visualRequirement.kind is required when required is true",
          path: ["kind"],
        });
      }
    } else {
      // required=false means "no visual": decorative or unspecified visuals
      // must not smuggle in a purpose/kind.
      if (visual.purpose !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "visualRequirement.purpose must be omitted when required is false",
          path: ["purpose"],
        });
      }
      if (visual.kind !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "visualRequirement.kind must be omitted when required is false",
          path: ["kind"],
        });
      }
    }
  });

export type BlueprintVisualRequirement = z.infer<typeof blueprintVisualRequirementSchema>;

/**
 * A CTA JOB on a section — never a URL. Href resolution belongs to later
 * bounded layers; the blueprint only decides that a conversion job exists,
 * its role on the page, and what the CTA must accomplish.
 */
export const blueprintSectionCtaSchema = z
  .object({
    role: z.enum(["primary", "secondary"]),
    /** 1-200 chars: the job this CTA performs for the visitor. */
    job: z.string().trim().min(1).max(200),
  })
  .strict();

export type BlueprintSectionCta = z.infer<typeof blueprintSectionCtaSchema>;

/**
 * Conceptual component capability types the planner may reference. These
 * mirror REAL starter capabilities (the registry in apps/factory describes
 * their semantics); a plan-level `benefits` section is realized through
 * `feature_cards` or `content_section`, because no benefits component
 * exists. Inventing arbitrary UI components is invalid.
 */
export const blueprintComponentTypeSchema = z.enum([
  "hero",
  "feature_cards",
  "content_section",
  "faq",
  "cta",
]);

export type BlueprintComponentType = z.infer<typeof blueprintComponentTypeSchema>;

/**
 * One semantic section instance of a blueprint page. Repeated instances of
 * the same component type are allowed (richer than SiteTask v0); each
 * instance carries its own content jobs and section-level provenance.
 */
export const pageSectionBlueprintSchema = z
  .object({
    /** Unique within the page (stableId syntax). */
    id: stableIdSchema,
    componentType: blueprintComponentTypeSchema,
    /** 1-500 chars: what this section must accomplish for the visitor. */
    purpose: z.string().trim().min(1).max(500),
    /** 1-200 chars: the section heading JOB (not keyword insertion). */
    heading: z.string().trim().min(1).max(200),
    /** 0-10 key points this section must communicate. */
    keyPoints: z.array(z.string().trim().min(1).max(400)).max(10),
    /** Evidence supporting this section's claims (must resolve to research). */
    evidenceIds: z.array(stableIdSchema).max(50),
    /** Operator facts supporting this section (must resolve to request). */
    operatorFactIds: z.array(stableIdSchema).max(30),
    /** Explicit prohibited/unsupported claims for this section's scope. */
    prohibitedClaims: z.array(z.string().trim().min(1).max(300)).max(10),
    visualRequirement: blueprintVisualRequirementSchema,
    cta: blueprintSectionCtaSchema.optional(),
  })
  .strict();

export type PageSectionBlueprint = z.infer<typeof pageSectionBlueprintSchema>;

/**
 * Bounded structured-data INTENT for a page (coherence with page type is
 * validated deterministically). Actual JSON-LD generation remains a later
 * bounded layer; the blueprint only records the truthful intent.
 */
export const blueprintStructuredDataTypeSchema = z.enum([
  "local_business",
  "service",
  "article",
  "web_page",
  "none",
]);

export type BlueprintStructuredDataType = z.infer<typeof blueprintStructuredDataTypeSchema>;

/** A meaningful internal link: target page + purpose. Never keyword-stuffed. */
export const blueprintInternalLinkSchema = z
  .object({
    targetSlug: slugSchema,
    /** 1-300 chars: why this link exists for the visitor. */
    purpose: z.string().trim().min(1).max(300),
  })
  .strict();

export type BlueprintInternalLink = z.infer<typeof blueprintInternalLinkSchema>;

/**
 * A blueprint page. The identity triple (type, slug, primaryTopic) MUST
 * match the accepted intelligence plan page exactly (deterministically
 * enforced); the blueprint may refine everything below it but may never
 * redesign the accepted IA.
 */
export const pageBlueprintSchema = z
  .object({
    type: pageTypeSchema,
    slug: slugSchema,
    /** Must equal the accepted plan page primaryTopic (normalized comparison). */
    primaryTopic: z.string().trim().min(1).max(200),
    /** 1-100 chars: the role this page plays (e.g. "conversion_landing", "trust", "reference"). */
    pageRole: z.string().trim().min(1).max(100),
    /** 1-200 chars: the audience this page primarily serves. */
    audience: z.string().trim().min(1).max(200),
    intent: intelligenceIntentSchema,
    /** Search-engine-facing title. Distinct function from the visible H1. */
    seoTitle: z.string().trim().min(1).max(200),
    metaDescription: z.string().trim().min(1).max(500),
    /** The page's single visible H1. May be similar to seoTitle but serves a different function. */
    h1: z.string().trim().min(1).max(200),
    /** 1-1000 chars: why this page exists. */
    purpose: z.string().trim().min(1).max(1000),
    /** 1-500 chars: the business goal this page advances. */
    businessGoal: z.string().trim().min(1).max(500),
    /** 0-10 questions this page must answer for the visitor. */
    userQuestions: z.array(z.string().trim().min(1).max(300)).max(10),
    /** 0-10 objections this page must address honestly. */
    objections: z.array(z.string().trim().min(1).max(300)).max(10),
    sections: z.array(pageSectionBlueprintSchema).max(20),
    internalLinks: z.array(blueprintInternalLinkSchema).max(15),
    structuredDataType: blueprintStructuredDataTypeSchema,
    readiness: blueprintReadinessSchema,
    /** Required when not ready: what verified business input is missing. */
    missingInputs: z.array(z.string().trim().min(1).max(300)).max(10),
  })
  .strict()
  .superRefine((page, ctx) => {
    // Readiness semantics (page-local part). `ready` demands at least one
    // section and NO missing inputs; any non-ready state demands honest
    // missing inputs. Cross-record rules live in blueprint validation.
    if (page.readiness === "ready") {
      if (page.missingInputs.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `page ${page.slug}: a ready page cannot declare missingInputs`,
          path: ["missingInputs"],
        });
      }
      if (page.sections.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `page ${page.slug}: a ready page requires at least one section`,
          path: ["sections"],
        });
      }
    } else if (page.missingInputs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: readiness "${page.readiness}" requires at least one missingInput`,
        path: ["missingInputs"],
      });
    }

    // Structured-data intent coherence with the page type (starter capabilities).
    const allowed: Record<string, readonly BlueprintStructuredDataType[]> = {
      homepage: ["local_business"],
      service: ["service"],
      article: ["article"],
      general: ["web_page", "none"],
    };
    const allowedForType = allowed[page.type] ?? [];
    if (!allowedForType.includes(page.structuredDataType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: structuredDataType "${page.structuredDataType}" is not coherent with page type "${page.type}" (allowed: ${allowedForType.join(", ")})`,
        path: ["structuredDataType"],
      });
    }

    // Duplicate section ids within the page fail closed.
    const sectionIds = page.sections.map((section) => section.id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: section ids must be unique within the page`,
        path: ["sections"],
      });
    }
  });

export type PageBlueprint = z.infer<typeof pageBlueprintSchema>;

/**
 * Minimal bounded site-level design direction. This is direction, not a
 * design-token framework: short bounded statements that a later design/
 * coding layer must respect. Omit entirely when no accepted design
 * direction exists.
 */
export const siteDesignDirectionSchema = z
  .object({
    visualCharacter: z.string().trim().min(1).max(400),
    density: z.string().trim().min(1).max(100),
    typographyMood: z.string().trim().min(1).max(200),
    colorMood: z.string().trim().min(1).max(200),
    imageryPolicy: z.string().trim().min(1).max(300),
    ctaTreatment: z.string().trim().min(1).max(200),
  })
  .strict();

export type SiteDesignDirection = z.infer<typeof siteDesignDirectionSchema>;

export const siteNavigationEntrySchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    targetSlug: slugSchema,
  })
  .strict();

export type SiteNavigationEntry = z.infer<typeof siteNavigationEntrySchema>;

export const siteBlueprintSiteSchema = z
  .object({
    /** 1-1000 chars: how the business is positioned for this site. */
    positioningSummary: z.string().trim().min(1).max(1000),
    /** 1-300 chars: the primary audience the site serves. */
    primaryAudience: z.string().trim().min(1).max(300),
    /** 0-12 planned header navigation entries (targets validated). */
    navigation: z.array(siteNavigationEntrySchema).max(12),
    /** 1-500 chars: the primary conversion path the site drives toward. */
    primaryConversionGoal: z.string().trim().min(1).max(500),
    designDirection: siteDesignDirectionSchema.optional(),
  })
  .strict();

export type SiteBlueprintSite = z.infer<typeof siteBlueprintSiteSchema>;

export const siteBlueprintSchema = z
  .object({
    version: z.literal("v0"),
    methodologyVersion: z.literal(SITE_BLUEPRINT_METHODOLOGY_VERSION),
    siteId: siteIdSchema,
    site: siteBlueprintSiteSchema,
    pages: z.array(pageBlueprintSchema).min(1).max(20),
    warnings: z.array(z.string().trim().min(1).max(1000)).max(20),
    /** Site-level missing inputs (independent of per-page readiness). */
    missingInputs: z.array(z.string().trim().min(1).max(300)).max(20),
  })
  .strict()
  .superRefine((blueprint, ctx) => {
    // Unique slugs across the blueprint.
    const slugs = blueprint.pages.map((page) => page.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blueprint contains duplicate page slugs",
        path: ["pages"],
      });
    }

    const slugSet = new Set(slugs);

    // Navigation entries must target pages that exist in this blueprint.
    blueprint.site.navigation.forEach((entry, index) => {
      if (!slugSet.has(entry.targetSlug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `site.navigation[${index}] targets unknown slug "${entry.targetSlug}"`,
          path: ["site", "navigation", index],
        });
      }
    });

    // Internal links must target pages that exist in this blueprint and must
    // not self-link (self-promotion loops carry no visitor purpose).
    blueprint.pages.forEach((page, pageIndex) => {
      page.internalLinks.forEach((link, linkIndex) => {
        if (!slugSet.has(link.targetSlug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `page ${page.slug} internalLinks[${linkIndex}] targets unknown slug "${link.targetSlug}"`,
            path: ["pages", pageIndex, "internalLinks", linkIndex],
          });
          return;
        }
        if (link.targetSlug === page.slug) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `page ${page.slug} internalLinks[${linkIndex}] self-links are not permitted`,
            path: ["pages", pageIndex, "internalLinks", linkIndex],
          });
        }
      });
    });
  });

export type SiteBlueprint = z.infer<typeof siteBlueprintSchema>;

// ---------------------------------------------------------------------------
// BlueprintResult
// ---------------------------------------------------------------------------

export const BLUEPRINT_ERROR_CODES = [
  "blueprint_input_invalid",
  "blueprint_research_invalid",
  "blueprint_plan_invalid",
  "blueprint_source_unverified",
  "blueprint_credentials_unavailable",
  "blueprint_policy_violation",
  "blueprint_model_failed",
  "blueprint_model_timeout",
  "blueprint_output_invalid",
  "blueprint_no_progress",
  "blueprint_attempts_exhausted",
  "blueprint_artifact_failed",
] as const;

export const blueprintErrorCodeSchema = z.enum(BLUEPRINT_ERROR_CODES);

export type BlueprintErrorCode = (typeof BLUEPRINT_ERROR_CODES)[number];

export const modelGatewaySchema = z.enum(["openrouter"]);

export type ModelGateway = z.infer<typeof modelGatewaySchema>;

/**
 * Provenance record for one model invocation through the Factory gateway.
 * The exact requested and responded model identities are always recorded;
 * usage/cost are recorded when the gateway exposes them. Credentials never
 * appear anywhere in this record.
 */
export const modelInvocationSchema = z
  .object({
    roleId: z.string().min(1).max(100),
    requestedModel: z.string().min(1).max(200),
    /** Model identity reported by the gateway, or null when truthfully unavailable. */
    respondedModel: z.string().min(1).max(200).nullable(),
    /** Provider attribution reported by the gateway, or null when unavailable. */
    provider: z.string().min(1).max(100).nullable(),
    gateway: modelGatewaySchema,
    /** The Factory Model Policy version authoritative for this invocation. */
    policyVersion: z.string().min(1).max(100).optional(),
    durationMs: z.number().int().min(0),
    promptTokens: z.number().int().min(0).nullable(),
    completionTokens: z.number().int().min(0).nullable(),
    totalTokens: z.number().int().min(0).nullable(),
    /** Cost in USD as reported by the gateway, or null when unavailable. */
    costUsd: z.number().min(0).nullable(),
    /** Whether this invocation was a fallback to a configured challenger. */
    fallback: z.boolean(),
  })
  .strict();

export type ModelInvocation = z.infer<typeof modelInvocationSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "digest must be a lowercase hex SHA-256 string",
});

export const blueprintArtifactsSchema = z
  .object({
    /** Repo-relative run directory, e.g. ".factory/blueprint/<runId>". */
    runDirectory: z.string().min(1).max(500),
    manifest: z.string().max(500).nullable(),
    blueprint: z.string().max(500).nullable(),
    result: z.string().max(500).nullable(),
  })
  .strict();

export type BlueprintArtifacts = z.infer<typeof blueprintArtifactsSchema>;

export const blueprintErrorSchema = z
  .object({
    code: blueprintErrorCodeSchema,
    message: z.string().min(1).max(2000),
  })
  .strict();

export type BlueprintError = z.infer<typeof blueprintErrorSchema>;

export const blueprintResultSchema = z
  .object({
    version: z.literal("v0"),
    status: z.enum(["succeeded", "failed", "needs_review"]),
    runId: z.string().min(1).max(100),
    siteId: siteIdSchema.nullable(),
    factorySourceCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    methodologyVersion: z.string().min(1).max(100),
    requestDigest: sha256HexSchema.nullable(),
    researchDigest: sha256HexSchema.nullable(),
    planDigest: sha256HexSchema.nullable(),
    blueprintDigest: sha256HexSchema.nullable(),
    attemptCount: z.number().int().min(0).max(MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS),
    /** The invocation that produced the ACCEPTED artifact (exact model identity). */
    modelInvocation: modelInvocationSchema.nullable(),
    /** Every model invocation attempted by this run, in order. */
    modelInvocations: z.array(modelInvocationSchema).max(10),
    artifacts: blueprintArtifactsSchema.nullable(),
    pageCount: z.number().int().min(0).max(20),
    readyCount: z.number().int().min(0).max(20),
    blockedCount: z.number().int().min(0).max(20),
    warnings: z.array(z.string().min(1).max(1000)).max(50),
    error: blueprintErrorSchema.nullable(),
  })
  .strict();

export type BlueprintResult = z.infer<typeof blueprintResultSchema>;

// ---------------------------------------------------------------------------
// Bounded parse helpers (mirror parseSiteIntelligencePlan semantics)
// ---------------------------------------------------------------------------

function parseJsonWithinLimit(input: unknown, maxBytes: number, label: string): unknown {
  if (input === null || input === undefined) {
    throw new Error(`${label} input cannot be null or undefined`);
  }
  let parsedObj: unknown;
  if (typeof input === "string") {
    if (input.length > maxBytes) {
      throw new Error(`${label} payload size (${input.length}) exceeds maximum allowed ${maxBytes}`);
    }
    parsedObj = JSON.parse(input);
  } else {
    const serialized = JSON.stringify(input);
    if (serialized.length > maxBytes) {
      throw new Error(`${label} payload size (${serialized.length}) exceeds maximum allowed ${maxBytes}`);
    }
    parsedObj = input;
  }
  return parsedObj;
}

/** Parse bounded model/operator input into a structurally valid SiteBlueprint. */
export function parseSiteBlueprint(input: unknown): SiteBlueprint {
  return siteBlueprintSchema.parse(
    parseJsonWithinLimit(input, MAX_BLUEPRINT_BYTES, "SiteBlueprint"),
  );
}

/** Parse a BlueprintResult (used for artifact verification and tests). */
export function parseBlueprintResult(input: unknown): BlueprintResult {
  return blueprintResultSchema.parse(input);
}

/**
 * Deterministic identity comparison used for IA preservation: the blueprint
 * page must carry the accepted plan page identity triple exactly (after the
 * documented scalar normalization).
 */
export function blueprintPageIdentityMatches(
  planPage: { type: string; slug: string; primaryTopic: string },
  blueprintPage: { type: string; slug: string; primaryTopic: string },
): boolean {
  return (
    planPage.type === blueprintPage.type &&
    planPage.slug === blueprintPage.slug &&
    normalizeScalarText(planPage.primaryTopic) === normalizeScalarText(blueprintPage.primaryTopic)
  );
}

/** Exported for reuse by blueprint repair diagnostics in apps/factory. */
export { normalizeScalarText };

export const blueprintTimestampSchema = isoDateTimeSchema;
export const blueprintEvidenceMetricsSchema = evidenceMetricsSchema;
