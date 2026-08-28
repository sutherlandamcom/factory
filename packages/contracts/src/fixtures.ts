import type { SiteTask } from "./site-task.js";

/** Example SiteTask: a service page for a fictional local-service business. */
export const exampleSiteTask: SiteTask = {
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair services",
    sections: ["hero", "benefits", "faq", "cta"],
  },
};
