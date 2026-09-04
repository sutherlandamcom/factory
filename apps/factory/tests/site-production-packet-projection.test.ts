import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePageProductionPacket,
  projectPacketToSiteTask,
} from "../src/site-production/index.js";
import {
  makeGenericBlueprint,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "./fixtures/site-production-fixtures.js";

/**
 * Packet → SiteTask projection tests (trusted compiler, D7).
 *
 * The projection must map the bounded packet onto the EXISTING SiteTask
 * contract without embedding the packet, preserving provenance and bounds.
 */

test("projection maps packet sections positionally onto SiteTask with per-instance briefs", async () => {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);

  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });

  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "20260901T114820Z-8976f5e5" });

  assert.equal(task.type, "create_page");
  assert.equal(task.siteId, "meridian-advisory");
  assert.equal(task.page.slug, "/");
  assert.equal(task.page.type, "homepage");
  // Title/meta come from the Blueprint page identity, never from spec content.
  assert.equal(task.page.title, blueprint.pages[0]!.h1);
  assert.equal(task.page.description, blueprint.pages[0]!.metaDescription);

  // Sections mirror the packet's ordered production sections 1:1.
  assert.equal(task.page.sections.length, packet.pageProduction.orderedSections.length);
  const brief = task.page.contentBrief!;
  assert.equal(brief.sections.length, task.page.sections.length);

  // Positional matching: brief section i describes page section i.
  for (let i = 0; i < brief.sections.length; i++) {
    assert.equal(brief.sections[i]!.sectionType, task.page.sections[i]);
  }

  // Accepted business truth reaches the brief: key points, prohibited
  // claims, blueprint provenance, and bounded production guidance.
  const heroBrief = brief.sections[0]!;
  assert.equal(heroBrief.blueprintSectionId, "sec-home-hero");
  assert.ok(heroBrief.keyPoints.length > 0);
  assert.ok(heroBrief.productionGuidance!.includes("Layout:"));
  assert.ok(heroBrief.productionGuidance!.includes("Editorial:"));

  // Internal links are copied from the Blueprint page.
  assert.deepEqual(
    brief.internalLinks?.map((l) => l.targetSlug),
    blueprint.pages[0]!.internalLinks.map((l) => l.targetSlug),
  );
});

test("projection fails closed when a production section cites zero or multiple blueprint sections", async () => {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections[0]!.sourceBlueprintSectionIds = [];

  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });

  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /must cite exactly one sourceBlueprintSectionId/,
  );
});

test("projection fails closed when a production section cites an unknown blueprint section", async () => {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections[0]!.sourceBlueprintSectionIds = ["sec-does-not-exist"];

  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });

  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /cites unknown blueprint section/,
  );
});

test("projection enforces the per-type section instance bound", async () => {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);

  // Push one instance past the bound: 5 hero-realizing production sections.
  const blueprintSectionIds = blueprint.pages[0]!.sections.map((s) => s.id);
  const heroSectionId = blueprintSectionIds[0]!;
  spec.pages[0]!.sections = Array.from({ length: 5 }, (_, i) => ({
    id: `hero-instance-${i}`,
    purpose: `Establish positioning (instance ${i})`,
    headingIntent: "State the firm's primary focus",
    editorialDirection: "Concise declarative prose",
    layoutDirection: "Asymmetric split viewport",
    referenceIds: [],
    assets: [],
    evidenceRefs: [],
    sourceBlueprintSectionIds: [heroSectionId],
  }));

  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });

  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /contract bound is 4/,
  );
});

test("projection output re-parses through parseSiteTask (all contract bounds apply)", async () => {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);

  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });

  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "20260901T114820Z-8976f5e5" });
  // A valid round trip is the assertion: parseSiteTask threw otherwise, and
  // the result carries no packet-specific fields beyond the contract.
  const serialized = JSON.stringify(task);
  assert.ok(serialized.length < 64 * 1024);
  assert.ok(!serialized.includes("creativeDirection"));
  assert.ok(!serialized.includes("orderedSections"));
});
