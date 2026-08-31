import assert from "node:assert/strict";
import test from "node:test";
import { parseSiteBlueprint } from "@factory/contracts";
import { validateSiteBlueprint } from "../src/blueprint/validation.js";
import {
  loadBlueprintFixtureInputsTyped,
  makeValidBlueprint,
  makeValidBlueprintTyped,
} from "./blueprint-fixtures.js";

const { request, research, plan } = loadBlueprintFixtureInputsTyped();

function validatedBlueprint() {
  const blueprint = makeValidBlueprintTyped(request, plan);
  return validateSiteBlueprint(blueprint, { plan, request, research });
}

test("valid fixture blueprint passes every deterministic gate", () => {
  const result = validatedBlueprint();
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
});

test("cannot add a page that is not in the accepted plan", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const added = structuredClone(clone.pages[0]!);
  added.slug = "/services/brand-new";
  added.internalLinks = [];
  clone.pages.push(added);
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("does not exist in the accepted plan")));
});

test("duplicate blueprint slugs are rejected defensively", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const duplicate = structuredClone(clone.pages[0]!);
  duplicate.internalLinks = [];
  clone.pages.push(duplicate);
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("duplicate page slugs")));
});

test("cannot delete an accepted plan page", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages = clone.pages.filter((page) => page.slug !== "/services/gutter-installation");
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("is missing from the blueprint")));
  assert.ok(result.issues.some((issue) => issue.includes("page count")));
});

test("cannot change a page type", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages.find((page) => page.slug === "/services/emergency-roof-repair")!.type = "general";
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('type "general" does not match')));
});

test("cannot change a slug", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages.find((page) => page.slug === "/services/gutter-installation")!.slug = "/services/gutters";
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("is missing from the blueprint")));
  assert.ok(result.issues.some((issue) => issue.includes("does not exist in the accepted plan")));
});

test("cannot replace a primary topic (semantic distortion)", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages.find((page) => page.slug === "/services/asset-review");
  const target = clone.pages.find((page) => page.slug === "/services/gutter-installation")!;
  target.primaryTopic = "gutter cleaning subscription";
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("primaryTopic")));
});

test("cannot change page intent", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages.find((page) => page.slug === "/blog/hail-damage-roof-inspection-guide")!.intent = "transactional";
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("intent")));
});

test("invented component types cannot appear (registry gate)", () => {
  // The contract enum rejects unknown component types at parse time.
  const raw = makeValidBlueprint(request, plan) as Record<string, unknown>;
  const pages = raw.pages as Array<Record<string, unknown>>;
  const sections = pages[0]!.sections as Array<Record<string, unknown>>;
  sections[0]!.componentType = "accordion";
  assert.throws(() => parseSiteBlueprint(raw), /invalid_value|Invalid enum/);
});

test("invented page structure is rejected: section realizing no plan section", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  // The article plan has [content_section, faq, cta]; add a hero section that
  // realizes none of them.
  const article = clone.pages.find((page) => page.slug === "/blog/hail-damage-roof-inspection-guide")!;
  article.sections.push({
    id: "sec-invented-hero",
    componentType: "hero",
    purpose: "invented structure",
    heading: "Invented hero",
    keyPoints: [],
    evidenceIds: [],
    operatorFactIds: [],
    prohibitedClaims: [],
    visualRequirement: { required: false },
  });
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("realizes no accepted plan section type")));
});

test("dropping an accepted plan section type is rejected", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  // Remove every section realizing faq on the emergency service page.
  const service = clone.pages.find((page) => page.slug === "/services/emergency-roof-repair")!;
  service.sections = service.sections.filter((section) => section.componentType !== "faq");
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('type "faq" is not realized')));
});

test("unknown evidence ids fail closed (page and section level)", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  section.evidenceIds.push("ev-does-not-exist");
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('unknown evidence id "ev-does-not-exist"')));
});

test("unknown operator fact ids fail closed", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  section.operatorFactIds.push("fact-invented");
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('unknown operator fact id "fact-invented"')));
});

test("research text cannot become an operator fact: fact ids namespace is separate", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  // Evidence ids are NOT valid operator fact references even when the id exists.
  section.operatorFactIds = ["kw-best-roofer"];
  section.evidenceIds = [];
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('unknown operator fact id "kw-best-roofer"')));
});

test("ready pages: every keyPoint section must cite provenance", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  section.evidenceIds = [];
  section.operatorFactIds = [];
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("declares") && issue.includes("keyPoint")));
});

test("required chart without metric evidence is rejected (no invented chart data)", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  section.visualRequirement = { required: true, purpose: "seasonal demand chart", kind: "chart" };
  // mkt-seasonal-demand has no metrics; section still cites it → must fail.
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("requires a chart")));
});

test("required chart with metric evidence passes", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  const section = clone.pages[0]!.sections.find((entry) => entry.id === "sec-home-capabilities")!;
  // kw-emergency-repair carries observed search volume metrics in the fixture.
  section.visualRequirement = { required: true, purpose: "search demand level", kind: "chart" };
  section.evidenceIds = [...section.evidenceIds.filter((id) => id !== "mkt-seasonal-demand"), "kw-emergency-repair"];
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues));
});

test("internal links to slugs outside the accepted plan fail", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.pages[0]!.internalLinks[0]!.targetSlug = "/services/ghost-service";
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('target unknown slug "/services/ghost-service"')));
});

test("navigation targets outside the accepted plan fail", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  clone.site.navigation = [...clone.site.navigation, { label: "Ghost", targetSlug: "/ghost" }];
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('/ghost" outside the accepted plan')));
});

test("issue list is bounded (no unbounded blowup)", () => {
  const blueprint = makeValidBlueprintTyped(request, plan);
  const clone = structuredClone(blueprint);
  for (const page of clone.pages) {
    for (const section of page.sections) {
      section.evidenceIds.push("ev-unknown-1", "ev-unknown-2");
    }
  }
  const result = validateSiteBlueprint(clone, { plan, request, research });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length <= 30);
});
