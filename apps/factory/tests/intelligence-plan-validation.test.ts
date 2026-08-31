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
  loadFixtureRequestJsonSync,
  loadFixtureResearchJsonSync,
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

test("mixed plans accept general pages without treating them as service coverage", async () => {
  const { rawRequest, rawResearch } = await context();
  const plan = makeValidPlan(rawRequest, rawResearch);
  (rawRequest.planning as AnyRecord).maxInitialPages = 7;
  const homepage = (plan.pages as AnyRecord[])[0] as AnyRecord;
  (plan.pages as AnyRecord[]).push(
    {
      ...homepage,
      type: "general",
      slug: "/about",
      title: "About Summit Roofing",
      description: "A synthetic company trust page used to validate the general page contract.",
      primaryTopic: "company leadership",
      rationale: "A company trust page is neither a service nor an editorial article.",
    },
    {
      ...homepage,
      type: "general",
      slug: "/research/methodology",
      title: "Research Methodology",
      description: "A synthetic methodology page used to validate hierarchical general routes.",
      primaryTopic: "research methodology",
      rationale: "A methodology page has a distinct institutional purpose outside service and blog namespaces.",
    },
  );
  const result = validate(plan, rawRequest, rawResearch);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));

  const noServices = deepClone(plan);
  noServices.pages = (noServices.pages as AnyRecord[]).filter((page) => page.type !== "service");
  const rejected = validate(noServices, rawRequest, rawResearch);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some((issue) => /no service page/.test(issue)));
  assert.ok(rejected.issues.some((issue) => /mustCoverServices/.test(issue)));
});

test("planned general pages reuse reserved route invariants including 404 and terminal index", async () => {
  const { rawRequest, rawResearch } = await context();
  for (const slug of [
    "/",
    "/services",
    "/services/x",
    "/blog",
    "/blog/x",
    "/404",
    "/index",
    "/private-office/index",
    "/foo/bar/index",
  ]) {
    const plan = makeValidPlan(rawRequest, rawResearch);
    const page = (plan.pages as AnyRecord[])[4] as AnyRecord;
    page.type = "general";
    page.slug = slug;
    page.primaryTopic = `general route ${slug}`;
    const result = validate(plan, rawRequest, rawResearch);
    assert.equal(result.ok, false, slug);
    assert.ok(result.issues.some((issue) => /general page slug/.test(issue)), `${slug}: ${result.issues.join("\n")}`);
  }
});

test("planned general pages accept valid index-bearing compound slugs", async () => {
  const { rawRequest, rawResearch } = await context();
  for (const slug of [
    "/index-methodology",
    "/private-office/index-strategy",
    "/index/approach",
  ]) {
    const plan = makeValidPlan(rawRequest, rawResearch);
    const page = (plan.pages as AnyRecord[])[4] as AnyRecord;
    page.type = "general";
    page.slug = slug;
    page.primaryTopic = `general route ${slug}`;
    const result = validate(plan, rawRequest, rawResearch);
    assert.equal(result.ok, true, `${slug}: ${(result as any).issues?.join("\n")}`);
  }
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

// ---------------------------------------------------------------------------
// P1-2: service-topic support may come ONLY from cited facts/evidence
// ---------------------------------------------------------------------------

function makeCoatingScenario() {
  // Request copy with an extra, matching-but-initially-uncited operator
  // fact. mustCover stays unchanged so the coating page's support must come
  // from its OWN citations, not from seeds/mustCover containment.
  const request = deepClone(loadFixtureRequestJsonSync());
  (request.business as AnyRecord).operatorFacts = [
    ...((request.business as AnyRecord).operatorFacts as AnyRecord[]),
    { id: "fact-commercial", text: "We provide commercial roof coating for flat and low-slope roofs" },
  ];
  return { request, research: deepClone(loadFixtureResearchJsonSync()) };
}

function coatingPage(plan: AnyRecord, operatorFactIds: string[]): AnyRecord {
  // Convert the fixture's article slot into a coating service page supported
  // (or not) only by what it cites.
  const page = (plan.pages as AnyRecord[])[4] as AnyRecord;
  page.type = "service";
  page.slug = "/services/commercial-roof-coating";
  page.title = "Commercial Roof Coating in Denver | Summit Roofing LLC";
  page.description =
    "Protective commercial roof coating for flat and low-slope Denver roofs, explained without price claims.";
  page.intent = "transactional";
  page.priority = "low";
  page.primaryTopic = "commercial roof coating";
  page.evidenceIds = ["kw-roof-repair-vs-replace", "comp-peak-article"]; // unrelated to coating
  page.operatorFactIds = operatorFactIds;
  return page;
}

test("P1-2: uncited matching operator fact cannot support a service topic", async () => {
  const { request, research } = makeCoatingScenario();
  const plan = makeValidPlan(request, research);
  coatingPage(plan, []); // fact-commercial exists in request but is NOT cited
  const result = validate(plan, request, research);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => /primary topic "commercial roof coating" is unsupported/.test(issue)),
    result.issues.join("\n"),
  );
});

test("P1-2: the same operator fact supports the page once explicitly cited", async () => {
  const { request, research } = makeCoatingScenario();
  const plan = makeValidPlan(request, research);
  coatingPage(plan, ["fact-commercial"]); // explicitly cited → support
  const result = validate(plan, request, research);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});

test("P1-2: unrelated operator facts elsewhere in the request never support a page", async () => {
  const { request, research } = makeCoatingScenario();
  const plan = makeValidPlan(request, research);
  const page = coatingPage(plan, ["fact-local"]); // cited but unrelated
  page.primaryTopic = "solar-ready roof preparation";
  page.slug = "/services/solar-ready-roofs";
  page.title = "Solar-Ready Roof Preparation in Denver | Summit Roofing LLC";
  const result = validate(plan, request, research);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /is unsupported/.test(issue)));
});

// ---------------------------------------------------------------------------
// P1-3: excludedTopics are deterministically enforced
// ---------------------------------------------------------------------------

test("P1-3: exact excluded page topic and cluster topic are rejected", async () => {
  const { rawRequest, rawResearch } = await context();
  const request = deepClone(rawRequest);
  (request.planning as AnyRecord).excludedTopics = ["gutter installation"];
  const result = validate(makeValidPlan(request, rawResearch), request, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /page ".*" primary topic .* operator-excluded topic "gutter installation"/.test(issue)));
  assert.ok(result.issues.some((issue) => /keywordCluster "cluster-gutter-installation" primary topic .* operator-excluded topic "gutter installation"/.test(issue)));
});

test("P1-3: normalized containment either way is rejected (broader and narrower)", async () => {
  const { rawRequest, rawResearch } = await context();
  const request = deepClone(rawRequest);
  const plan = makeValidPlan(request, rawResearch);
  // Broader excluded value contains a page topic.
  ((request.planning as AnyRecord).excludedTopics = ["emergency roof repair denver colorado"]);
  const emergencyPage = (plan.pages as AnyRecord[])[1] as AnyRecord;
  emergencyPage.primaryTopic = "emergency roof repair";
  let result = validate(plan, request, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /operator-excluded topic "emergency roof repair denver colorado"/.test(issue)));

  // Narrower excluded value inside a cluster topic.
  const request2 = deepClone(rawRequest);
  ((request2.planning as AnyRecord).excludedTopics = ["insurance claims"]);
  const result2 = validate(makeValidPlan(request2, rawResearch), request2, rawResearch);
  assert.equal(result2.ok, true, "fixture topics do not touch insurance claims"); // unrelated excluded topic passes

  const plan2 = makeValidPlan(request2, rawResearch);
  (plan2.keywordClusters as AnyRecord[])[0]!.supportingTerms = ["roof insurance claims help"];
  // primaryTopic of the cluster is what matters — change it.
  (plan2.keywordClusters as AnyRecord[])[0]!.primaryTopic = "roof insurance claims";
  const result3 = validate(plan2, request2, rawResearch);
  assert.equal(result3.ok, false);
  assert.ok(result3.issues.some((issue) => /keywordCluster .* operator-excluded topic "insurance claims"/.test(issue)));
});

test("P1-3: case and whitespace are normalized before matching", async () => {
  const { rawRequest, rawResearch } = await context();
  const request = deepClone(rawRequest);
  ((request.planning as AnyRecord).excludedTopics = ["GUTTER   Installation"]);
  const result = validate(makeValidPlan(request, rawResearch), request, rawResearch);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /operator-excluded topic "GUTTER   Installation"/.test(issue)));
});

test("P1-3: unrelated excluded topics keep existing behavior", async () => {
  const { rawRequest, rawResearch } = await context();
  // Fixture excludedTopics ["solar panel installation"] overlaps nothing.
  const result = validate(makeValidPlan(rawRequest, rawResearch), rawRequest, rawResearch);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));

  // Omitted excludedTopics behaves as empty.
  const request = deepClone(rawRequest);
  delete (request.planning as AnyRecord).excludedTopics;
  const result2 = validate(makeValidPlan(request, rawResearch), request, rawResearch);
  assert.equal(result2.ok, true, result2.ok ? "" : result2.issues.join("\n"));
});
