import { z } from "zod";

/**
 * SiteTask — the machine-readable unit of work the Factory control plane
 * hands to an executor. v0 supports exactly one task type: create_page.
 *
 * Schemas are the source of truth; TypeScript types are derived from them so
 * runtime validation and static types can never drift apart.
 */

export const MAX_TASK_PAYLOAD_BYTES = 64 * 1024; // 64 KB

export const pageTypeSchema = z.enum(["homepage", "general", "service", "article"]);

export const sectionTypeSchema = z.enum([
  "hero",
  "feature_cards",
  "content_section",
  "benefits",
  "faq",
  "cta",
]);

/**
 * Logical identifier for the target site configuration.
 * Must be lowercase alphanumeric words separated by single hyphens.
 * No path traversal, slashes, backslashes, dots, or spaces.
 */
export const siteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'siteId must be lowercase alphanumeric words separated by single hyphens (e.g. "demo", "summit-roofing")',
  });

/**
 * Conservative slug rule:
 * - Rooted normalized lowercase path starting with "/".
 * - Exactly "/" or lowercase alphanumerics separated by single "/" or "-".
 * - Rules out scheme, host, query ("?"), fragment ("#"), backslashes ("\\"),
 *   traversal ("..", "."), consecutive slashes ("//"), and trailing slashes.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/(?:|[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)$/, {
    message:
      'slug must be a rooted lowercase path like "/" or "/services/roof-repair" (only [a-z0-9], single "/" or "-" separators)',
  });

/**
 * Maximum occurrences of one section type on a single page. Repeated
 * semantic instances (e.g. several editorial `content_section` bands) are
 * permitted within this bound so pages can carry variable rhythm instead of
 * the one-hero-one-grid uniform shape; beyond it a page must use different
 * section types. The bound keeps prompts, briefs, and QA expectations small.
 */
export const MAX_SECTION_TYPE_INSTANCES = 4;

/**
 * Shared page invariants (bounded repeated sections + coherent page-type/slug
 * relationship). Used by the SiteTask page schema and by the Intelligence
 * planned-page schema so both can never drift apart.
 */
export function addSitePageInvariantIssues(
  data: { type: PageType; slug: string; sections: SectionType[] },
  ctx: z.RefinementCtx,
): void {
  // 1. Bound repeated section instances (variable rhythm within a ceiling)
  const counts = new Map<SectionType, number>();
  for (let i = 0; i < data.sections.length; i++) {
    const section = data.sections[i]!;
    const next = (counts.get(section) ?? 0) + 1;
    counts.set(section, next);
    if (next > MAX_SECTION_TYPE_INSTANCES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `section "${section}" occurs more than ${MAX_SECTION_TYPE_INSTANCES} times on one page (instance bound exceeded at index ${i})`,
        path: ["sections", i],
      });
    }
  }

  // 2. Coherent page-type / slug relationships
  if (data.type === "homepage") {
    if (data.slug !== "/") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `homepage slug must be exactly "/" (got "${data.slug}")`,
        path: ["slug"],
      });
    }
  } else if (data.type === "service") {
    if (!data.slug.startsWith("/services/") || data.slug === "/services/") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `service page slug must start with "/services/<name>" (got "${data.slug}")`,
        path: ["slug"],
      });
    }
  } else if (data.type === "article") {
    if (!data.slug.startsWith("/blog/") || data.slug === "/blog/") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `article page slug must start with "/blog/<name>" (got "${data.slug}")`,
        path: ["slug"],
      });
    }
  } else if (data.type === "general") {
    const segments = data.slug.split("/").filter(Boolean);
    const finalSegment = segments[segments.length - 1];
    const ownsReservedNamespace =
      data.slug === "/" ||
      data.slug === "/services" ||
      data.slug.startsWith("/services/") ||
      data.slug === "/blog" ||
      data.slug.startsWith("/blog/") ||
      data.slug === "/404";
    if (ownsReservedNamespace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `general page slug must be non-root and outside reserved homepage, service, blog, and 404 routes (got "${data.slug}")`,
        path: ["slug"],
      });
    } else if (finalSegment === "index") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `general page slug cannot end in reserved Astro directory segment "index" (got "${data.slug}")`,
        path: ["slug"],
      });
    }
  }

  // 3. Content brief (when present) must cover exactly the page's section set:
  //    one brief entry per section INSTANCE (matched positionally by index),
  //    so repeated section types carry distinct briefs.
  const withBrief = data as typeof data & {
    contentBrief?: { sections: Array<{ sectionType: SectionType }> };
  };
  if (withBrief.contentBrief) {
    for (let i = 0; i < withBrief.contentBrief.sections.length; i++) {
      const brief = withBrief.contentBrief.sections[i]!;
      if (data.sections[i] !== brief.sectionType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `contentBrief section ${i} ("${brief.sectionType}") does not match the page section at the same position ("${data.sections[i] ?? "none"}") — briefs must be listed in the page's section order`,
          path: ["contentBrief", "sections", i],
        });
      }
    }
    if (withBrief.contentBrief.sections.length !== data.sections.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contentBrief must have exactly one entry per page section (expected ${data.sections.length}, got ${withBrief.contentBrief.sections.length})`,
        path: ["contentBrief", "sections"],
      });
    }
  }
}

/**
 * One brief entry for one section INSTANCE of the page
 * (contentBrief.sections, positionally matched to page.sections).
 * Bounded plain text only.
 */
export const contentBriefSectionSchema = z
  .object({
    /** Section component type this brief applies to (must exist on the page). */
    sectionType: sectionTypeSchema,
    /** Visible heading for the section (plain text, no HTML). */
    heading: z
      .string()
      .trim()
      .min(1, "brief section heading cannot be empty")
      .max(120, "brief section heading cannot exceed 120 characters")
      .regex(/^[^<>]*$/, { message: "brief section heading must not contain HTML" }),
    /** Accepted business-truth key points the worker must implement faithfully. */
    keyPoints: z
      .array(
        z
          .string()
          .trim()
          .min(1, "key point cannot be empty")
          .max(280, "key point cannot exceed 280 characters"),
      )
      .min(1, "brief section requires at least one key point")
      .max(8, "brief section cannot exceed 8 key points"),
    /** Optional short lead paragraph for the section. */
    leadProse: z
      .string()
      .trim()
      .min(1)
      .max(400, "leadProse cannot exceed 400 characters")
      .optional(),
    /** Claims the page must NOT make (from accepted Blueprint prohibitedClaims). */
    prohibitedClaims: z
      .array(z.string().trim().min(1).max(240))
      .max(6, "brief section cannot exceed 6 prohibited claims")
      .optional(),
    /** Stable identifier of the originating accepted Blueprint section. */
    blueprintSectionId: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9-]+$/, {
        message: 'blueprintSectionId must be lowercase alphanumeric words separated by hyphens',
      })
      .optional(),
    /** Bounded production guidance for this instance (layout/editorial direction from the accepted Production Spec). */
    productionGuidance: z
      .string()
      .trim()
      .min(1)
      .max(600, "productionGuidance cannot exceed 600 characters")
      .regex(/^[^<>]*$/, { message: "productionGuidance must not contain HTML" })
      .optional(),
    /** Bounded purpose statement for this instance (why the section exists, from the accepted Production Spec). */
    purpose: z
      .string()
      .trim()
      .min(1)
      .max(300, "purpose cannot exceed 300 characters")
      .regex(/^[^<>]*$/, { message: "purpose must not contain HTML" })
      .optional(),
  })
  .strict();

/** One planned internal link from the page to an existing route. */
export const contentBriefLinkSchema = z
  .object({
    targetSlug: slugSchema,
    purpose: z
      .string()
      .trim()
      .min(1, "link purpose cannot be empty")
      .max(160, "link purpose cannot exceed 160 characters"),
  })
  .strict();

/**
 * Optional, strictly bounded content brief for a create_page task (v0).
 *
 * PROVEN_MVP_CAPABILITY_GAP C1: the accepted SiteBlueprint holds per-section
 * accepted business truth (key points, prohibited claims, planned internal
 * links), but the v0 task schema carried none of it — page workers received
 * only title/description/section type names and had to invent copy, which
 * guarantees unsupported business claims. The brief is trusted upstream
 * content (Factory/Blueprint-compiled), embedded in the worker prompt, and
 * bounded so it can never become a prompt-injection or payload channel.
 * Absent contentBrief means exactly the pre-existing behavior.
 */
export const pageContentBriefSchema = z
  .object({
    /** Page purpose from the accepted Blueprint. */
    purpose: z
      .string()
      .trim()
      .min(1, "brief purpose cannot be empty")
      .max(300, "brief purpose cannot exceed 300 characters"),
    /** Primary audience from the accepted Blueprint. */
    audience: z
      .string()
      .trim()
      .min(1, "brief audience cannot be empty")
      .max(200, "brief audience cannot exceed 200 characters"),
    /** Run id of the accepted Blueprint run this brief was compiled from. */
    sourceBlueprintRunId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, {
        message: "sourceBlueprintRunId must be alphanumeric with . _ - only",
      }),
    /** One entry per section of the page; see addSitePageInvariantIssues. */
    sections: z
      .array(contentBriefSectionSchema)
      .min(1, "contentBrief requires at least one section")
      .max(20, "contentBrief cannot exceed 20 sections"),
    /** Planned internal links (targets must exist as site routes at QA time). */
    internalLinks: z.array(contentBriefLinkSchema).max(8, "contentBrief cannot exceed 8 internal links").optional(),
  })
  .strict();

export const sitePageSchema = z
  .object({
    type: pageTypeSchema,
    /** Absolute URL path, e.g. "/services/roof-repair" or "/". */
    slug: slugSchema,
    /** Primary title of the page (1-200 chars). */
    title: z.string().trim().min(1, "title cannot be empty").max(200, "title cannot exceed 200 characters"),
    /** Meta description for the page (1-500 chars). */
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .max(500, "description cannot exceed 500 characters"),
    /** Ordered list of unique section identifiers the page is composed of (1-20 sections). */
    sections: z
      .array(sectionTypeSchema)
      .min(1, "at least one section is required")
      .max(20, "maximum 20 sections allowed"),
    /** Optional bounded content brief compiled from the accepted Blueprint. */
    contentBrief: pageContentBriefSchema.optional(),
  })
  .strict()
  .superRefine(addSitePageInvariantIssues);

export const createPageTaskSchema = z
  .object({
    type: z.literal("create_page"),
    siteId: siteIdSchema,
    page: sitePageSchema,
  })
  .strict();

export const siteTaskSchema = createPageTaskSchema;

export type PageType = z.infer<typeof pageTypeSchema>;
export type SectionType = z.infer<typeof sectionTypeSchema>;
export type SiteId = z.infer<typeof siteIdSchema>;
export type Slug = z.infer<typeof slugSchema>;
export type SitePage = z.infer<typeof sitePageSchema>;
export type PageContentBrief = z.infer<typeof pageContentBriefSchema>;
export type CreatePageTask = z.infer<typeof createPageTaskSchema>;
export type SiteTask = z.infer<typeof siteTaskSchema>;

/** Parse unknown JSON or object into a SiteTask; throws ZodError or Error on invalid input. */
export function parseSiteTask(input: unknown): SiteTask {
  if (input === null || input === undefined) {
    throw new Error("SiteTask input cannot be null or undefined");
  }

  let rawJson: string;
  let parsedObj: unknown;

  if (typeof input === "string") {
    if (input.length > MAX_TASK_PAYLOAD_BYTES) {
      throw new Error(`SiteTask payload size (${input.length} bytes) exceeds maximum allowed ${MAX_TASK_PAYLOAD_BYTES} bytes`);
    }
    rawJson = input;
    parsedObj = JSON.parse(input);
  } else {
    rawJson = JSON.stringify(input);
    if (rawJson.length > MAX_TASK_PAYLOAD_BYTES) {
      throw new Error(`SiteTask payload size (${rawJson.length} bytes) exceeds maximum allowed ${MAX_TASK_PAYLOAD_BYTES} bytes`);
    }
    parsedObj = input;
  }

  return siteTaskSchema.parse(parsedObj);
}
