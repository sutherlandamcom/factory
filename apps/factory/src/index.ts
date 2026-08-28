import { exampleSiteTask } from "@factory/contracts";
import pkg from "../package.json" with { type: "json" };

console.log(`Factory control plane v${pkg.version} is running.`);
console.log(
  `Loaded example SiteTask from @factory/contracts: type=${exampleSiteTask.type} site=${exampleSiteTask.siteId} slug=${exampleSiteTask.page.slug}`,
);
