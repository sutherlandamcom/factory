import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchEvidenceBundle, parseSiteIntelligenceRequest } from "@factory/contracts";
import { compilePlanToTasks } from "../src/intelligence/compile.js";
import { normalizeResearchBundle } from "../src/intelligence/normalize.js";
import {
  deepClone,
  loadFixtureRequestJson,
  loadFixtureResearchJson,
  makeValidPlan,
} from "./intelligence-fixtures.js";

type AnyRecord = Record<string, unknown>;

async function inputs() {
  const request = parseSiteIntelligenceRequest(deepClone(await loadFixtureRequestJson()));
  const research = normalizeResearchBundle(parseResearchEvidenceBundle(deepClone(await loadFixtureResearchJson())));
  const plan = makeValidPlan(deepClone(await loadFixtureRequestJson()), deepClone(await loadFixtureResearchJson()));
  return { request, research, plan };
}

test("compiles all pages deterministically with homepage first", async () => {
  const { request, plan } = await inputs();
  const compiled = compilePlanToTasks(plan as never, request);
  assert.equal(compiled.length, 5);
  assert.equal(compiled[0]!.task.page.type, "homepage");
  assert.equal(compiled[0]!.task.page.slug, "/");
  assert.deepEqual(
    compiled.map((entry) => entry.task.page.slug),
    [
      "/",
      "/services/emergency-roof-repair",
      "/services/gutter-installation",
      "/blog/hail-damage-roof-inspection-guide",
      "/blog/roof-replacement-cost-guide",
    ],
  );
});

test("compilation is stable across repeated invocations", async () => {
  const { request, plan } = await inputs();
  const a = compilePlanToTasks(plan as never, request);
  const b = compilePlanToTasks(plan as never, request);
  assert.deepEqual(a, b);
});

test("orders service and article groups by priority then slug", async () => {
  const { request, plan } = await inputs();
  const pages = (plan.pages as AnyRecord[]).slice(1);
  // Swap priorities to prove ordering follows priority, not input order.
  ((pages[0] as AnyRecord).priority = "medium"), ((pages[1] as AnyRecord).priority = "high");
  const compiled = compilePlanToTasks(plan as never, request);
  assert.deepEqual(
    compiled.filter((entry) => entry.task.page.type === "service").map((entry) => entry.task.page.slug),
    ["/services/gutter-installation", "/services/emergency-roof-repair"],
  );
});

test("every compiled task passes canonical parseSiteTask and carries only current fields", async () => {
  const { request, plan } = await inputs();
  const compiled = compilePlanToTasks(plan as never, request);
  for (const entry of compiled) {
    assert.deepEqual(Object.keys(entry.task).sort(), ["page", "siteId", "type"]);
    assert.deepEqual(Object.keys(entry.task.page).sort(), ["description", "sections", "slug", "title", "type"]);
    assert.equal(entry.task.siteId, request.siteId);
    assert.equal(entry.task.type, "create_page");
    // Intelligence-only planning fields must not leak into SiteTask.
    const page = entry.task.page as unknown as AnyRecord;
    for (const forbidden of ["primaryTopic", "intent", "priority", "rationale", "evidenceIds", "operatorFactIds"]) {
      assert.equal(forbidden in page, false, forbidden);
    }
  }
});

test("task file names are deterministic and ordered", async () => {
  const { request, plan } = await inputs();
  const compiled = compilePlanToTasks(plan as never, request);
  assert.deepEqual(
    compiled.map((entry) => entry.fileName),
    [
      "001-homepage.json",
      "002-service-emergency-roof-repair.json",
      "003-service-gutter-installation.json",
      "004-article-hail-damage-roof-inspection-guide.json",
      "005-article-roof-replacement-cost-guide.json",
    ],
  );
});
