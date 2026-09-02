import { resolveCanonicalOrigin, type SiteProfile, type SiteTask } from "@factory/contracts";

export interface TaskQaOptions {
  /**
   * Trusted canonical-origin override (Factory pins FACTORY_QA_ORIGIN for
   * deterministic QA). Validated with the same rules as the profile value.
   */
  canonicalOriginOverride?: string;
}

export interface TaskQaSpec {
  route: string;
  title: string;
  documentTitle: string;
  description: string;
  pageType: SiteTask["page"]["type"];
  jsonLdType: (typeof JSON_LD_TYPE_BY_PAGE)[SiteTask["page"]["type"]];
  sections: SiteTask["page"]["sections"];
  canonicalUrl: string;
}

const JSON_LD_TYPE_BY_PAGE = {
  homepage: "LocalBusiness",
  general: "WebPage",
  service: "Service",
  article: "Article",
} as const satisfies Record<SiteTask["page"]["type"], string>;

export function normalizedRoute(slug: string): string {
  return slug === "/" ? "/" : `${slug}/`;
}

/**
 * Build the deterministic QA expectation for one SiteTask against a
 * validated SiteProfile. Site identity (title suffix) and canonical origin
 * come from the profile (with the trusted validated override), never from
 * task content or hard-coded demo values.
 */
export function createTaskQaSpec(task: SiteTask, profile: SiteProfile, options?: TaskQaOptions): TaskQaSpec {
  const route = normalizedRoute(task.page.slug);
  return {
    route,
    title: task.page.title,
    documentTitle: `${task.page.title} | ${profile.siteName}`,
    description: task.page.description,
    pageType: task.page.type,
    jsonLdType: JSON_LD_TYPE_BY_PAGE[task.page.type],
    sections: task.page.sections,
    canonicalUrl: `${resolveCanonicalOrigin({
      override: options?.canonicalOriginOverride,
      profile,
    })}${route}`,
  };
}
