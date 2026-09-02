import assert from "node:assert/strict";
import test from "node:test";
import { exampleSiteTask, parseSiteProfile, type SiteProfile } from "@factory/contracts";
import { createTaskQaSpec } from "../src/executor/task-qa.js";
import { FACTORY_QA_ORIGIN } from "../src/executor/site-profile.js";

// The QA expectation source is the repository-owned profile (parsed with the
// shared contract), never a hard-coded demo suffix.
const profile = parseSiteProfile({
  version: "v0",
  siteId: "starter",
  siteName: "Summit Roofing Co.",
  canonicalOrigin: "http://localhost:4321",
  language: "en",
  navigation: [{ label: "Home", targetSlug: "/" }],
});

test("task QA spec contains only deterministic validated page data", () => {
  assert.deepEqual(createTaskQaSpec(exampleSiteTask, profile, { canonicalOriginOverride: FACTORY_QA_ORIGIN }), {
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
  const spec = createTaskQaSpec(
    {
      ...exampleSiteTask,
      page: { ...exampleSiteTask.page, type: "homepage", slug: "/" },
    },
    profile,
    { canonicalOriginOverride: FACTORY_QA_ORIGIN },
  );
  assert.equal(spec.route, "/");
  assert.equal(spec.canonicalUrl, "https://test.example.com/");
});

test("general QA spec preserves hierarchical route and WebPage identity inputs", () => {
  const spec = createTaskQaSpec(
    {
      ...exampleSiteTask,
      page: {
        ...exampleSiteTask.page,
        type: "general",
        slug: "/private-office/approach",
        title: "Private Office Approach",
      },
    },
    profile,
    { canonicalOriginOverride: FACTORY_QA_ORIGIN },
  );
  assert.equal(spec.pageType, "general");
  assert.equal(spec.jsonLdType, "WebPage");
  assert.equal(spec.route, "/private-office/approach/");
  assert.equal(spec.title, "Private Office Approach");
  assert.equal(spec.canonicalUrl, "https://test.example.com/private-office/approach/");
});

test("document title suffix and default canonical derive from the profile", () => {
  const synthetic: SiteProfile = parseSiteProfile({
    version: "v0",
    siteId: "acme",
    siteName: "Acme Anvils",
    canonicalOrigin: "https://acme.example.com",
    language: "en",
    navigation: [{ label: "Home", targetSlug: "/" }],
  });
  const spec = createTaskQaSpec(exampleSiteTask, synthetic);
  assert.equal(spec.documentTitle, "Roof Repair | Acme Anvils");
  assert.equal(spec.canonicalUrl, "https://acme.example.com/services/roof-repair/");
});
