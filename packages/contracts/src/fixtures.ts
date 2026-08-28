import type { SiteTask } from "./site-task.js";

/** Example SiteTask: a service page for a fictional local-service business. */
export const exampleSiteTask: SiteTask = {
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair and replacement services in Boulder, Colorado.",
    sections: ["hero", "benefits", "faq", "cta"],
  },
};
