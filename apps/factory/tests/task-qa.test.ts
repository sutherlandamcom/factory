import assert from "node:assert/strict";
import test from "node:test";
import { exampleSiteTask } from "@factory/contracts";
import { createTaskQaSpec } from "../src/executor/task-qa.js";

test("task QA spec contains only deterministic validated page data", () => {
  assert.deepEqual(createTaskQaSpec(exampleSiteTask), {
    route: "/services/roof-repair/",
    title: "Roof Repair",
    documentTitle: "Roof Repair | Summit Roofing Co.",
    description: "Professional roof repair and replacement services in Boulder, Colorado.",
    pageType: "service",
    jsonLdType: "Service",
    sections: ["hero", "benefits", "faq", "cta"],
    canonicalUrl: "https://test.example.com/services/roof-repair/",
  });
});

test("homepage QA route and canonical remain rooted", () => {
  const spec = createTaskQaSpec({
    ...exampleSiteTask,
    page: { ...exampleSiteTask.page, type: "homepage", slug: "/" },
  });
  assert.equal(spec.route, "/");
  assert.equal(spec.canonicalUrl, "https://test.example.com/");
});

test("general QA spec preserves hierarchical route and WebPage identity inputs", () => {
  const spec = createTaskQaSpec({
    ...exampleSiteTask,
    page: {
      ...exampleSiteTask.page,
      type: "general",
      slug: "/private-office/approach",
      title: "Private Office Approach",
    },
  });
  assert.equal(spec.pageType, "general");
  assert.equal(spec.jsonLdType, "WebPage");
  assert.equal(spec.route, "/private-office/approach/");
  assert.equal(spec.title, "Private Office Approach");
  assert.equal(spec.canonicalUrl, "https://test.example.com/private-office/approach/");
});
