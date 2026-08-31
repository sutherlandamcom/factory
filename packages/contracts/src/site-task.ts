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
 * Shared page invariants (unique sections + coherent page-type/slug
 * relationship). Used by the SiteTask page schema and by the Intelligence
 * planned-page schema so both can never drift apart.
 */
export function addSitePageInvariantIssues(
  data: { type: PageType; slug: string; sections: SectionType[] },
  ctx: z.RefinementCtx,
): void {
  // 1. Enforce unique sections (no duplicates)
  const seen = new Set<string>();
  for (let i = 0; i < data.sections.length; i++) {
    const section = data.sections[i]!;
    if (seen.has(section)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate section "${section}" is forbidden`,
        path: ["sections", i],
      });
    }
    seen.add(section);
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
    }
  }
}

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
