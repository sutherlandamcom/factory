import type { SiteTask } from "@factory/contracts";

export const QA_ORIGIN = "https://test.example.com";
export const SITE_TITLE_SUFFIX = " | Summit Roofing Co.";

export interface TaskQaSpec {
  route: string;
  title: string;
  documentTitle: string;
  description: string;
  pageType: SiteTask["page"]["type"];
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
    sections: task.page.sections,
    canonicalUrl: `${QA_ORIGIN}${route}`,
  };
}
