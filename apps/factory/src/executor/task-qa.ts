import type { SiteTask } from "@factory/contracts";

export const QA_ORIGIN = "https://test.example.com";
export const SITE_TITLE_SUFFIX = " | Summit Roofing Co.";

const JSON_LD_TYPE_BY_PAGE = {
  homepage: "LocalBusiness",
  general: "WebPage",
  service: "Service",
  article: "Article",
} as const satisfies Record<SiteTask["page"]["type"], string>;

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

export function normalizedRoute(slug: string): string {
  return slug === "/" ? "/" : `${slug}/`;
}

export function createTaskQaSpec(task: SiteTask): TaskQaSpec {
  const route = normalizedRoute(task.page.slug);
  return {
    route,
    title: task.page.title,
    documentTitle: `${task.page.title}${SITE_TITLE_SUFFIX}`,
    description: task.page.description,
    pageType: task.page.type,
    jsonLdType: JSON_LD_TYPE_BY_PAGE[task.page.type],
    sections: task.page.sections,
    canonicalUrl: `${QA_ORIGIN}${route}`,
  };
}
