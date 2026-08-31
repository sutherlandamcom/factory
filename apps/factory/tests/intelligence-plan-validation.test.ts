import assert from "node:assert/strict";
import test from "node:test";
import {
  parseResearchEvidenceBundle,
  parseSiteIntelligenceRequest,
} from "@factory/contracts";
import { validateSiteIntelligencePlan } from "../src/intelligence/plan-validation.js";
import { normalizeResearchBundle } from "../src/intelligence/normalize.js";
import {
  deepClone,
  loadFixtureRequestJson,
  loadFixtureResearchJson,
  makeValidPlan,
} from "./intelligence-fixtures.js";

type AnyRecord = Record<string, unknown>;

async function context() {
  const request = parseSiteIntelligenceRequest(deepClone(await loadFixtureRequestJson()));
  const research = normalizeResearchBundle(parseResearchEvidenceBundle(deepClone(await loadFixtureResearchJson())));
  return { request, research, rawRequest: deepClone(await loadFixtureRequestJson()), rawResearch: deepClone(await loadFixtureResearchJson()) };
}

function validate(rawPlan: AnyRecord, request: AnyRecord, research: AnyRecord) {
  return validateSiteIntelligencePlan(rawPlan, {
    request: parseSiteIntelligenceRequest(deepClone(request)),
    research: normalizeResearchBundle(parseResearchEvidenceBundle(deepClone(research))),
  });
}

test("the canonical fixture plan passes all deterministic gates", async () => {
  const { rawRequest, rawResearch } = await context();
  const result = validate(makeValidPlan(rawRequest, rawResearch), rawRequest, rawResearch);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});

test("rejects missing homepage", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  (plan.pages as AnyRecord[]).splice(0, 1);
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /exactly one homepage/.test(issue)));
});

test("rejects two homepages", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  (plan.pages as AnyRecord[]).push({ ...(plan.pages as AnyRecord[])[0]! });
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /exactly one homepage/.test(issue)));
});

test("rejects homepage with wrong slug", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[0] as AnyRecord).slug = "/home";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /homepage slug/.test(issue)));
});

test("rejects invalid service and article slugs", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[1] as AnyRecord).slug = "/repair";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /service page slug/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.pages as AnyRecord[])[3] as AnyRecord).slug = "/news/hail";
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /article page slug/.test(issue)));
});

test("rejects duplicate slugs", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[2] as AnyRecord).slug = "/services/emergency-roof-repair";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /duplicate page slug/.test(issue)));
});

test("rejects unknown page type and unknown section", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[1] as AnyRecord).type = "landing";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /schema violation/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.pages as AnyRecord[])[1] as AnyRecord).sections = ["hero", "pricing_table"];
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /schema violation/.test(issue)));
});

test("rejects duplicate sections within a page", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[1] as AnyRecord).sections = ["hero", "hero", "faq"];
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /duplicate section/.test(issue)));
});

test("rejects title and description outside current SiteTask bounds", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[0] as AnyRecord).title = "x".repeat(201);
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /title cannot exceed/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.pages as AnyRecord[])[0] as AnyRecord).description = "x".repeat(501);
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /description cannot exceed/.test(issue)));
});

test("rejects page count above the request budget", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  (plan.pages as AnyRecord[]).push({
    type: "article",
    slug: "/blog/winter-roof-maintenance",
    title: "Winter Roof Maintenance Checklist for Denver Homes",
    description: "Seasonal maintenance guidance for Denver roofs covering ice dams, snow load, and ventilation.",
    sections: ["content_section", "faq"],
    primaryTopic: "winter roof maintenance",
    intent: "informational",
    priority: "low",
    rationale: "Extends informational coverage into the off-season without overlapping existing topics.",
    evidenceIds: ["mkt-seasonal-demand"],
  });
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /exceeds request planning\.maxInitialPages/.test(issue)));
});

test("rejects unknown evidence ids and unknown operator fact ids", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.pages as AnyRecord[])[0] as AnyRecord).evidenceIds = ["not-a-real-evidence-id"];
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /unknown evidence id "not-a-real-evidence-id"/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.pages as AnyRecord[])[0] as AnyRecord).operatorFactIds = ["fact-fabricated"];
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /unknown operator fact id "fact-fabricated"/.test(issue)));
});

test("rejects pages without provenance", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  const homepage = (plan.pages as AnyRecord[])[0] as AnyRecord;
  homepage.evidenceIds = [];
  delete homepage.operatorFactIds;
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /no provenance/.test(issue)));
});

test("rejects wrong siteId", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  plan.siteId = "other-site";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /must equal request siteId/.test(issue)));
});

test("rejects wrong methodologyVersion via schema", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  plan.methodologyVersion = "generic-seo-v9";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /schema violation/.test(issue)));
});

test("rejects duplicate normalized primary topics and article/service cannibalization", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  const pages = plan.pages as AnyRecord[];
  (pages[3] as AnyRecord).primaryTopic = "EMERGENCY  roof   repair";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /duplicates primary topic/.test(issue)));
  assert.ok(result.issues.some((issue) => /duplicates the service page/.test(issue)));
});

test("rejects fabricated keyword metrics", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.keywordClusters as AnyRecord[])[0] as AnyRecord).metrics = { searchVolume: 999_999 };
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /is not observed in any referenced evidence/.test(issue)));
});

test("rejects unknown output properties", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  plan.backdoorField = { write: "apps/factory" };
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /schema violation/.test(issue)));
});

test("rejects mustCoverServices values not represented by service pages", async () => {
  const { rawRequest, rawResearch } = await context();
  const request = deepClone(rawRequest);
  ((request.planning as AnyRecord).mustCoverServices as string[]).push("siding installation");
  const result = validate(makeValidPlan(request, rawResearch), request, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /"siding installation" is not represented/.test(issue)));
});

test("rejects service topics unsupported by inputs or evidence", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  const service = (plan.pages as AnyRecord[])[1] as AnyRecord;
  service.primaryTopic = "kitchen remodeling";
  service.slug = "/services/kitchen-remodeling";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /primary topic "kitchen remodeling" is unsupported/.test(issue)));
});

test("rejects a launch plan with no service page despite non-empty serviceSeeds", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  const pages = plan.pages as AnyRecord[];
  plan.pages = pages.filter((page) => page.type !== "service");
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /no service page/.test(issue)));
  assert.ok(result.issues.some((issue) => /mustCoverServices/.test(issue)));
});

test("rejects missing or insufficient rationales", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  const page = (plan.pages as AnyRecord[])[0] as AnyRecord;
  page.rationale = "";
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /rationale/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.pages as AnyRecord[])[0] as AnyRecord).rationale = "Too short.";
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /at least 20 characters/.test(issue)));
});

test("rejects evidence-free competitor insights and keyword clusters", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  ((plan.competitorInsights as AnyRecord[])[0] as AnyRecord).evidenceIds = [];
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /schema violation/.test(issue)));

  const plan2 = makeValidPlan(rawRequest, rawResearch);
  ((plan2.keywordClusters as AnyRecord[])[0] as AnyRecord).evidenceIds = [];
  const result2 = validate(plan2, rawRequest, rawResearch);
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((issue) => /schema violation/.test(issue)));
});

test("service topics supported by operator facts or evidence text pass", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  // "roof repair denver" is not itself a seed/mustCover value, but the
  // referenced emergency-repair evidence text contains it, so the topic is
  // deterministically supported. mustCoverServices is adjusted in the
  // request copy so coverage continues to hold for the remaining pages.
  const request = deepClone(rawRequest);
  (request.planning as AnyRecord).mustCoverServices = ["roof repair denver", "gutter installation"];
  const service = (plan.pages as AnyRecord[])[1] as AnyRecord;
  service.primaryTopic = "roof repair denver";
  service.slug = "/services/roof-repair";
  const result = validate(plan, request, rawResearch);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});
