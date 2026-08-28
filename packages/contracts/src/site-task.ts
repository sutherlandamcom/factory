/**
 * SiteTask — the machine-readable unit of work the Factory control plane
 * hands to an executor. v0 supports exactly one task type: create_page.
 */

export type PageType = "homepage" | "service" | "article";

export interface SitePage {
  type: PageType;
  /** Absolute URL path, e.g. "/roof-repair". */
  slug: string;
  title: string;
  /** Meta description for the page. */
  description: string;
  /** Ordered list of section identifiers the page is composed of. */
  sections: string[];
}

export interface CreatePageTask {
  type: "create_page";
  siteId: string;
  page: SitePage;
}

export type SiteTask = CreatePageTask;
