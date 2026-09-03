import { z } from "zod";
import { stableIdSchema } from "./site-intelligence.js";
import { pageTypeSchema, siteIdSchema, slugSchema } from "./site-task.js";

/**
 * SiteProductionSpec contracts (Production Input Contract v0).
 *
 * Pipeline position:
 *
 *   Accepted SiteBlueprint + SiteProfile + Research Evidence
 *     + SiteProductionSpec (strict, versioned production overlay)
 *     → validation
 *     → readiness
 *     → compilePageProductionPacket (bounded projection per page)
 *     → future Factory executor
 *
 * A SiteProductionSpec specifies HOW the accepted Blueprint should be produced
 * (visual direction, references, anti-references, approved assets, page-specific
 * production treatment, ordered section composition, CTA configuration,
 * objective quality criteria). It does NOT duplicate upstream business truth
 * (positioning, audience, business proposition, prohibited claims).
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed.
 */

export const SITE_PRODUCTION_SPEC_VERSION = "v0" as const;
export const siteProductionSpecVersionSchema = z.literal(SITE_PRODUCTION_SPEC_VERSION);

/** Serialized Production Spec payload ceiling for parsing and storage. */
export const MAX_PRODUCTION_SPEC_BYTES = 256 * 1024; // 256 KB

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "digest must be a lowercase hex SHA-256 string",
});

const ABSOLUTE_HTTP_URL_PATTERN =
  /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[^\s]*)?(?:\?[^\s]*)?(?:#[^\s]*)?$/;

function isHttpOrHttpsUrl(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  return ABSOLUTE_HTTP_URL_PATTERN.test(value);
}

const absoluteHttpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((url, ctx) => {
    if (!isHttpOrHttpsUrl(url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `URL must be an absolute http:// or https:// URL (got "${url}")`,
      });
    }
  });

/**
 * Safe relative filesystem path for assets and local references.
 * Must be relative, non-empty, forward-slash separated, with safe segment characters,
 * and completely free from traversal ("..", "."), leading/trailing slashes, and backslashes.
 */
export const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1, "path cannot be empty")
  .max(300, "path cannot exceed 300 characters")
  .superRefine((val, ctx) => {
    if (val.startsWith("/") || val.startsWith("\\")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `path must be relative, not absolute (got "${val}")`,
      });
      return;
    }
    if (val.includes("\\")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `path must use forward slashes only (got "${val}")`,
      });
      return;
    }
    const segments = val.split("/");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg === "" || seg === "." || seg === ".." || !/^[a-zA-Z0-9_.-]+$/.test(seg)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `path segment "${seg}" is invalid (must be non-empty alphanumeric with [._-], no traversal)`,
        });
        return;
      }
    }
  });

const boundedText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^<>]*$/, { message: "must not contain HTML" });

// ---------------------------------------------------------------------------
// Source Blueprint Anchor
// ---------------------------------------------------------------------------

export const sourceBlueprintAnchorSchema = z
  .object({
    runId: z
      .string()
      .trim()
      .min(1, "sourceBlueprint.runId cannot be empty")
      .max(100, "sourceBlueprint.runId cannot exceed 100 characters"),
    digest: sha256HexSchema.optional(),
  })
  .strict();

export type SourceBlueprintAnchor = z.infer<typeof sourceBlueprintAnchorSchema>;

// ---------------------------------------------------------------------------
// Creative Direction
// ---------------------------------------------------------------------------

export const creativeQualityBarSchema = z
  .object({
    mustFeelLike: z.array(boundedText(1, 300)).min(1).max(20),
    mustNotFeelLike: z.array(boundedText(1, 300)).min(1).max(20),
  })
  .strict();

export type CreativeQualityBar = z.infer<typeof creativeQualityBarSchema>;

export const creativeEditorialSchema = z
  .object({
    rules: z.array(boundedText(1, 300)).min(1).max(20),
    avoid: z.array(boundedText(1, 300)).min(1).max(20),
  })
  .strict();

export type CreativeEditorial = z.infer<typeof creativeEditorialSchema>;

export const creativeLayoutSchema = z
  .object({
    principles: z.array(boundedText(1, 300)).min(1).max(20),
    avoid: z.array(boundedText(1, 300)).min(1).max(20),
  })
  .strict();

export type CreativeLayout = z.infer<typeof creativeLayoutSchema>;

export const creativeTypographySchema = z
  .object({
    direction: boundedText(1, 1000),
    avoid: z.array(boundedText(1, 300)).max(20).default([]),
  })
  .strict();

export type CreativeTypography = z.infer<typeof creativeTypographySchema>;

export const creativeColorSchema = z
  .object({
    direction: boundedText(1, 1000),
    avoid: z.array(boundedText(1, 300)).max(20).default([]),
  })
  .strict();

export type CreativeColor = z.infer<typeof creativeColorSchema>;

export const creativeImagerySchema = z
  .object({
    direction: boundedText(1, 1000),
    avoid: z.array(boundedText(1, 300)).max(20).default([]),
  })
  .strict();

export type CreativeImagery = z.infer<typeof creativeImagerySchema>;

export const creativeDensitySchema = z
  .object({
    direction: boundedText(1, 500),
  })
  .strict();

export type CreativeDensity = z.infer<typeof creativeDensitySchema>;

export const creativeMotionSchema = z
  .object({
    direction: boundedText(1, 500),
  })
  .strict();

export type CreativeMotion = z.infer<typeof creativeMotionSchema>;

export const siteCreativeDirectionSchema = z
  .object({
    qualityBar: creativeQualityBarSchema,
    editorial: creativeEditorialSchema,
    layout: creativeLayoutSchema,
    typography: creativeTypographySchema,
    color: creativeColorSchema,
    imagery: creativeImagerySchema,
    density: creativeDensitySchema,
    motion: creativeMotionSchema,
  })
  .strict();

export type SiteCreativeDirection = z.infer<typeof siteCreativeDirectionSchema>;

// ---------------------------------------------------------------------------
// Reference Library
// ---------------------------------------------------------------------------

export const referenceRoleSchema = z.enum(["reference", "anti_reference"]);
export type ReferenceRole = z.infer<typeof referenceRoleSchema>;

export const referenceKindSchema = z.enum(["website", "page", "screenshot", "image"]);
export type ReferenceKind = z.infer<typeof referenceKindSchema>;

export const referenceDimensionSchema = z.enum([
  "layout",
  "typography",
  "color",
  "imagery",
  "density",
  "navigation",
  "interaction",
  "section_composition",
  "editorial",
]);
export type ReferenceDimension = z.infer<typeof referenceDimensionSchema>;

export const referenceEntrySchema = z
  .object({
    id: stableIdSchema,
    role: referenceRoleSchema,
    kind: referenceKindSchema,
    sourceUrl: absoluteHttpUrlSchema.optional(),
    localArtifactPath: safeRelativePathSchema.optional(),
    dimensions: z.array(referenceDimensionSchema).min(1).max(9),
    learn: z.array(boundedText(1, 300)).max(15).default([]),
    avoid: z.array(boundedText(1, 300)).max(15).default([]),
    notes: boundedText(1, 1000).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (!ref.sourceUrl && !ref.localArtifactPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reference "${ref.id}" requires at least one of sourceUrl or localArtifactPath`,
        path: ["sourceUrl"],
      });
    }
    const uniqueDimensions = new Set(ref.dimensions);
    if (uniqueDimensions.size !== ref.dimensions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reference "${ref.id}" contains duplicate dimensions`,
        path: ["dimensions"],
      });
    }
  });

export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;

// ---------------------------------------------------------------------------
// Approved Asset Library
// ---------------------------------------------------------------------------

export const assetKindSchema = z.enum(["logo", "photo", "illustration", "chart", "icon"]);
export type AssetKind = z.infer<typeof assetKindSchema>;

export const assetUsageStatusSchema = z.enum(["approved", "reference_only", "blocked"]);
export type AssetUsageStatus = z.infer<typeof assetUsageStatusSchema>;

export const assetRightsStatusSchema = z.enum([
  "operator_owned",
  "licensed",
  "public_domain",
  "unknown",
]);
export type AssetRightsStatus = z.infer<typeof assetRightsStatusSchema>;

export const assetEntrySchema = z
  .object({
    id: stableIdSchema,
    kind: assetKindSchema,
    localPath: safeRelativePathSchema,
    usageStatus: assetUsageStatusSchema,
    rightsStatus: assetRightsStatusSchema,
    provenanceNote: boundedText(1, 1000).optional(),
    altIntent: boundedText(1, 500).optional(),
    usageNotes: boundedText(1, 1000).optional(),
  })
  .strict();

export type AssetEntry = z.infer<typeof assetEntrySchema>;

// ---------------------------------------------------------------------------
// Page Production Brief
// ---------------------------------------------------------------------------

export const pageRequirementsSchema = z
  .object({
    seoTargetingRequired: z.boolean(),
    primaryCtaRequired: z.boolean(),
    localVisualReferenceRequired: z.boolean(),
    approvedAssetRequired: z.boolean(),
  })
  .strict();

export type PageRequirements = z.infer<typeof pageRequirementsSchema>;

export const pageSeoTargetingSchema = z
  .object({
    searchIntent: boundedText(1, 300),
    primaryKeyword: boundedText(1, 200),
    secondaryKeywords: z.array(boundedText(1, 200)).max(20).default([]),
    notes: boundedText(1, 500).optional(),
  })
  .strict();

export type PageSeoTargeting = z.infer<typeof pageSeoTargetingSchema>;

export const pageQualityBarSchema = z
  .object({
    must: z.array(boundedText(1, 300)).max(20).default([]),
    avoid: z.array(boundedText(1, 300)).max(20).default([]),
  })
  .strict();

export type PageQualityBar = z.infer<typeof pageQualityBarSchema>;

export const pageEditorialEmphasisSchema = z
  .object({
    emphasis: z.array(boundedText(1, 300)).max(15).default([]),
    avoid: z.array(boundedText(1, 300)).max(15).default([]),
    guidance: boundedText(1, 1000).optional(),
  })
  .strict();

export type PageEditorialEmphasis = z.infer<typeof pageEditorialEmphasisSchema>;

export const evidenceReferenceSchema = z
  .object({
    kind: z.enum(["discovery_evidence", "operator_fact"]),
    id: stableIdSchema,
  })
  .strict();

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const assetRoleSchema = z.enum([
  "hero",
  "background",
  "inline",
  "chart",
  "illustration",
  "logo",
  "supporting",
]);

export type AssetRole = z.infer<typeof assetRoleSchema>;

export const pageAssetAssignmentSchema = z
  .object({
    assetId: stableIdSchema,
    role: assetRoleSchema,
    guidance: boundedText(1, 500).optional(),
  })
  .strict();

export type PageAssetAssignment = z.infer<typeof pageAssetAssignmentSchema>;

export const ctaDestinationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("internal"),
      targetSlug: slugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      url: absoluteHttpUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("email"),
      address: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/, {
          message: "address must be a valid email address",
        }),
    })
    .strict(),
]);

export type CtaDestination = z.infer<typeof ctaDestinationSchema>;

export const pageCtaConfigSchema = z
  .object({
    label: boundedText(1, 100),
    destination: ctaDestinationSchema,
  })
  .strict();

export type PageCtaConfig = z.infer<typeof pageCtaConfigSchema>;

export const pageProductionSectionSchema = z
  .object({
    id: stableIdSchema,
    purpose: boundedText(1, 500),
    headingIntent: boundedText(1, 200).optional(),
    editorialDirection: boundedText(1, 500).optional(),
    layoutDirection: boundedText(1, 500).optional(),
    referenceIds: z.array(stableIdSchema).max(10).default([]),
    assets: z.array(pageAssetAssignmentSchema).max(10).default([]),
    evidenceRefs: z.array(evidenceReferenceSchema).max(15).default([]),
    sourceBlueprintSectionIds: z.array(stableIdSchema).max(10).default([]),
  })
  .strict();

export type PageProductionSection = z.infer<typeof pageProductionSectionSchema>;

export const pageProductionBriefSchema = z
  .object({
    slug: slugSchema,
    blueprintPageType: pageTypeSchema,
    requirements: pageRequirementsSchema,
    seo: pageSeoTargetingSchema.optional(),
    qualityBar: pageQualityBarSchema.optional(),
    editorialEmphasis: pageEditorialEmphasisSchema.optional(),
    evidenceRefs: z.array(evidenceReferenceSchema).max(30).default([]),
    referenceIds: z.array(stableIdSchema).max(20).default([]),
    assets: z.array(pageAssetAssignmentSchema).max(20).default([]),
    sections: z.array(pageProductionSectionSchema).min(1).max(20),
    primaryCta: pageCtaConfigSchema.optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    // Section id uniqueness within page
    const sectionIds = page.sections.map((s) => s.id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: duplicate section ids are forbidden`,
        path: ["sections"],
      });
    }

    // Check duplicate referenceIds on page
    if (new Set(page.referenceIds).size !== page.referenceIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: duplicate referenceIds are forbidden`,
        path: ["referenceIds"],
      });
    }

    // Check duplicate assets on page
    const assetIds = page.assets.map((a) => a.assetId);
    if (new Set(assetIds).size !== assetIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${page.slug}: duplicate asset assignments are forbidden`,
        path: ["assets"],
      });
    }
  });

export type PageProductionBrief = z.infer<typeof pageProductionBriefSchema>;

// ---------------------------------------------------------------------------
// SiteProductionSpec Top-Level Schema
// ---------------------------------------------------------------------------

export const siteProductionSpecSchema = z
  .object({
    version: siteProductionSpecVersionSchema,
    siteId: siteIdSchema,
    sourceBlueprint: sourceBlueprintAnchorSchema,
    creativeDirection: siteCreativeDirectionSchema,
    references: z.array(referenceEntrySchema).max(50).default([]),
    assets: z.array(assetEntrySchema).max(50).default([]),
    pages: z.array(pageProductionBriefSchema).min(1).max(20),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Unique reference ids across the spec
    const refIds = spec.references.map((r) => r.id);
    if (new Set(refIds).size !== refIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "spec contains duplicate reference ids in references library",
        path: ["references"],
      });
    }

    // Unique asset ids across the spec
    const assetIds = spec.assets.map((a) => a.id);
    if (new Set(assetIds).size !== assetIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "spec contains duplicate asset ids in assets library",
        path: ["assets"],
      });
    }

    // Unique page slugs across the spec
    const slugs = spec.pages.map((p) => p.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "spec contains duplicate page slugs",
        path: ["pages"],
      });
    }
  });

export type SiteProductionSpec = z.infer<typeof siteProductionSpecSchema>;

// ---------------------------------------------------------------------------
// Bounded Parse Helper
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

/** Parse bounded operator input into a structurally valid SiteProductionSpec. */
export function parseSiteProductionSpec(input: unknown): SiteProductionSpec {
  return siteProductionSpecSchema.parse(
    parseJsonWithinLimit(input, MAX_PRODUCTION_SPEC_BYTES, "SiteProductionSpec"),
  );
}
