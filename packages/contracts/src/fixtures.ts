import { siteTaskSchema, type SiteTask } from "./site-task.js";

/**
 * Example SiteTask: a service page for a fictional local-service business.
 * Kept in sync with the canonical JSON fixture at
 * `packages/contracts/fixtures/create-roof-repair.json`.
 */
export const exampleSiteTask: SiteTask = siteTaskSchema.parse({
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair and replacement services in Boulder, Colorado.",
    sections: ["hero", "benefits", "faq", "cta"],
  },
});
