/**
 * SiteTask — the machine-readable unit of work the Factory control plane
 * hands to an executor. v0 supports exactly one task type: create_page.
 *
 * PR #1 defines plain TypeScript types. External JSON inputs at the PR #2
 * trust boundary must be strictly validated before execution according to the
 * validation rules documented below.
 */

/**
 * Valid page types supported by the starter site template.
 *
 * Page type semantics:
 * - "homepage": Root landing page. Must map to slug "/". Generates LocalBusiness JSON-LD.
 * - "service": Commercial service page. Slug must start with "/services/" or be a rooted single-level path (e.g. "/services/roof-repair"). Generates Service JSON-LD.
 * - "article": Informational article. Slug must start with "/blog/" (e.g. "/blog/signs-of-roof-damage"). Generates Article JSON-LD.
 */
export type PageType = "homepage" | "service" | "article";

/**
 * Finite section vocabulary supported by the starter template component library.
 * Sections are rendered in the exact array sequence specified.
 * Duplicate section identifiers are forbidden within a single page definition.
 */
export type SectionType =
  | "hero"
  | "feature_cards"
  | "content_section"
  | "benefits"
  | "faq"
  | "cta";

/**
 * Logical identifier for the target site configuration.
 *
 * VALIDATION CONTRACT for siteId:
 * - Must be an allowlisted logical string identifier (e.g. "demo", "summit-roofing").
 * - Must NEVER be a filesystem path (no "/", "\\", ".", "..").
 * - Allowed format: lowercase alphanumeric words separated by single hyphens: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (length: 1-64 chars).
 */
export type SiteId = string;

/**
 * Normalized origin-relative URL path.
 *
 * VALIDATION CONTRACT for slug:
 * - Must be a rooted, normalized origin-relative URL path starting with a single "/".
 * - Must NOT contain a scheme (http://, https://), host, port, query string (?foo), fragment (#bar), or backslash (\).
 * - Must NOT contain path traversal segments (/../ or /./) or consecutive slashes (//).
 * - For page.type === "homepage", slug MUST be "/".
 * - For page.type === "service", slug MUST be under "/services/" (e.g. "/services/roof-repair").
 * - For page.type === "article", slug MUST be under "/blog/" (e.g. "/blog/roof-care").
 * - Allowed format: lowercase alphanumeric segments separated by single hyphens and slashes: `^/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$`
 */
export type Slug = string;

export interface SitePage {
  /** Page type determining layout, route conventions, and structured data. */
  type: PageType;

  /** Normalized origin-relative URL path (e.g. "/" or "/services/roof-repair"). */
  slug: Slug;

  /**
   * Primary title of the page.
   * - Drives the single `<h1>` on the page.
   * - Used as the base HTML `<title>` (formatted as `${title} | ${siteName}`).
   * - Non-empty string, maximum 200 characters.
   */
  title: string;

  /**
   * Meta description for search engines and social cards (OG description).
   * - Non-empty string, maximum 500 characters.
   */
  description: string;

  /**
   * Ordered, unique list of section identifiers composing the page body.
   * - Rendered in the specified sequence.
   * - Must contain at least one section.
   * - Duplicate section identifiers are forbidden.
   */
  sections: readonly SectionType[];
}

export interface CreatePageTask {
  type: "create_page";
  siteId: SiteId;
  page: SitePage;
}

export type SiteTask = CreatePageTask;
