import {
  parseSiteTask,
  type CreatePageTask,
  type PlannedPage,
  type SiteIntelligencePlan,
  type SiteIntelligenceRequest,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/**
 * Deterministic compilation of a validated SiteIntelligencePlan into the
 * CURRENT create_page SiteTask contract. The model never produces SiteTask
 * JSON — this trusted compiler does — and every compiled task must pass the
 * canonical parseSiteTask validation.
 */

export interface CompiledIntelligenceTask {
  fileName: string;
  task: CreatePageTask;
}

const PRIORITY_RANK: Record<PlannedPage["priority"], number> = { high: 0, medium: 1, low: 2 };

function byPriorityThenSlug(left: PlannedPage, right: PlannedPage): number {
  const priorityDelta = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0;
}

function taskFileName(index: number, page: PlannedPage): string {
  const ordinal = String(index + 1).padStart(3, "0");
  if (page.type === "homepage") return `${ordinal}-homepage.json`;
  if (page.type === "general") {
    const slugBase = page.slug.split("/").filter(Boolean).join("-");
    return `${ordinal}-general-${slugBase}.json`;
  }
  // Drop the fixed first path segment ("/services/" or "/blog/") so the
  // file name does not duplicate the page-type prefix.
  const slugBase = page.slug.split("/").filter(Boolean).slice(1).join("-");
  return `${ordinal}-${page.type}-${slugBase}.json`;
}

export function compilePlanToTasks(
  plan: SiteIntelligencePlan,
  request: SiteIntelligenceRequest,
): CompiledIntelligenceTask[] {
  const homepagePages = plan.pages.filter((page) => page.type === "homepage");
  const generalPages = plan.pages.filter((page) => page.type === "general").sort(byPriorityThenSlug);
  const servicePages = plan.pages.filter((page) => page.type === "service").sort(byPriorityThenSlug);
  const articlePages = plan.pages.filter((page) => page.type === "article").sort(byPriorityThenSlug);
  const orderedPages = [...homepagePages, ...generalPages, ...servicePages, ...articlePages];

  return orderedPages.map((page, index) => {
    // Only CURRENT create_page fields may flow into SiteTask; planning-only
    // fields (primaryTopic, intent, priority, rationale, provenance) stay out.
    const task = {
      type: "create_page" as const,
      siteId: request.siteId,
      page: {
        type: page.type,
        slug: page.slug,
        title: page.title,
        description: page.description,
        sections: [...page.sections],
      },
    };
    try {
      parseSiteTask(task);
    } catch (error) {
      throw new FactoryError(
        "intelligence_task_compilation_failed",
        `compiled task for page "${page.slug}" failed canonical SiteTask validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { fileName: taskFileName(index, page), task };
  });
}
