import { z } from "zod";
import { siteIdSchema, slugSchema } from "./site-task.js";

/**
 * SiteProfile — the trusted, repository-owned, site-level identity and shell
 * configuration for one generated site (v0).
 *
 * SiteProfile is NOT SiteTask input: it is version-controlled configuration
 * that Layout, Header, Footer, canonical resolution, and Factory QA must all
 * derive from. A create_page worker may READ it but can never WRITE it.
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Unknown fields fail closed (strict objects).
 */

export const MAX_SITE_PROFILE_PAYLOAD_BYTES = 16 * 1024; // 16 KB

/** SiteProfile contract version. Exactly "v0" for this MVP. */
export const siteProfileVersionSchema = z.literal("v0");

/**
 * Display name of the site. Trimmed, non-empty, bounded.
 */
export const siteNameSchema = z
  .string()
  .trim()
  .min(1, "siteName cannot be empty")
  .max(100, "siteName cannot exceed 100 characters");

/**
 * Absolute HTTP(S) origin only: no credentials, no query, no fragment, and a
 * root (or empty) pathname. Normalized to `url.origin` so equivalent inputs
 * (`https://example.com` and `https://example.com/`) produce one value.
 */
export const canonicalOriginSchema = z
  .string()
  .min(1, "canonicalOrigin cannot be empty")
  .max(200, "canonicalOrigin cannot exceed 200 characters")
  .superRefine((value, ctx): void => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `canonicalOrigin must be an absolute URL (got ${JSON.stringify(value)})`,
      });
      return;
    }
    const reject = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `canonicalOrigin ${message}` });
    };
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      reject(`must use http or https (got ${JSON.stringify(url.protocol)})`);
    }
    if (url.username || url.password) {
      reject("must not contain credentials");
    }
    if (url.search) {
      reject(`must not contain a query (got ${JSON.stringify(url.search)})`);
    }
    if (url.hash) {
      reject(`must not contain a fragment (got ${JSON.stringify(url.hash)})`);
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      reject(`must be an origin without a path (got pathname ${JSON.stringify(url.pathname)})`);
    }
  })
  .transform((value) => new URL(value).origin);

/**
 * Bounded BCP47-compatible language tag. Examples: "en", "en-GB".
 */
export const siteProfileLanguageSchema = z
  .string()
  .trim()
  .min(1, "language cannot be empty")
  .max(35, "language cannot exceed 35 characters")
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, {
    message: 'language must be a simple BCP47-compatible tag like "en" or "en-GB"',
  });

/** Maximum number of internal navigation entries (MVP bound). */
export const MAX_SITE_PROFILE_NAVIGATION_ENTRIES = 12;

/**
 * One internal navigation entry. Label is plain text (no HTML); targetSlug
 * reuses the existing Factory slug semantics (rooted, lowercase path).
 */
export const siteProfileNavigationEntrySchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "navigation label cannot be empty")
      .max(50, "navigation label cannot exceed 50 characters")
      .regex(/^[^<>]*$/, { message: "navigation label must not contain HTML" }),
    targetSlug: slugSchema,
  })
  .strict();

/** Optional postal address lines. Plain strings only; no HTML. */
export const siteProfileAddressLineSchema = z
  .string()
  .trim()
  .min(1, "address line cannot be empty")
  .max(200, "address line cannot exceed 200 characters")
  .regex(/^[^<>]*$/, { message: "address line must not contain HTML" });

export const siteProfileSchema = z
  .object({
    version: siteProfileVersionSchema,
    siteId: siteIdSchema,
    siteName: siteNameSchema,
    canonicalOrigin: canonicalOriginSchema,
    language: siteProfileLanguageSchema,
    navigation: z
      .array(siteProfileNavigationEntrySchema)
      .min(1, "at least one navigation entry is required")
      .max(
        MAX_SITE_PROFILE_NAVIGATION_ENTRIES,
        `navigation cannot exceed ${MAX_SITE_PROFILE_NAVIGATION_ENTRIES} entries`,
      ),
    addressLines: z.array(siteProfileAddressLineSchema).max(10, "addressLines cannot exceed 10 lines").optional(),
  })
  .strict();

export type SiteProfileNavigationEntry = z.infer<typeof siteProfileNavigationEntrySchema>;
export type SiteProfile = z.infer<typeof siteProfileSchema>;

/** Parse unknown JSON or object into a SiteProfile; throws ZodError or Error on invalid input. */
export function parseSiteProfile(input: unknown): SiteProfile {
  if (input === null || input === undefined) {
    throw new Error("SiteProfile input cannot be null or undefined");
  }

  let parsedObj: unknown;
  if (typeof input === "string") {
    if (input.length > MAX_SITE_PROFILE_PAYLOAD_BYTES) {
      throw new Error(
        `SiteProfile payload size (${input.length} bytes) exceeds maximum allowed ${MAX_SITE_PROFILE_PAYLOAD_BYTES} bytes`,
      );
    }
    parsedObj = JSON.parse(input);
  } else {
    parsedObj = input;
  }

  return siteProfileSchema.parse(parsedObj);
}

export interface ResolveCanonicalOriginInput {
  /**
   * Trusted deployment/test override (e.g. PUBLIC_SITE_URL). When explicitly
   * configured it must pass the SAME validation as the profile value; an
   * invalid override throws instead of silently falling back.
   */
  override?: string | undefined;
  /** Validated SiteProfile (or any object carrying its canonical origin). */
  profile: Pick<SiteProfile, "canonicalOrigin">;
}

/**
 * Effective canonical origin:
 *   PUBLIC_SITE_URL (when explicitly configured and valid)
 *   ELSE SiteProfile.canonicalOrigin
 *
 * Both branches use the same canonicalOriginSchema validation by construction.
 * SiteTask content, page content, and model output have no way to influence
 * either input.
 */
export function resolveCanonicalOrigin(input: ResolveCanonicalOriginInput): string {
  const override = input.override?.trim();
  if (override !== undefined && override !== "") {
    return canonicalOriginSchema.parse(override);
  }
  return canonicalOriginSchema.parse(input.profile.canonicalOrigin);
}
