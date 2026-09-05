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
import type { SiteProductionSpec } from "@factory/contracts";

/**
 * PR #16 P2 regression acceptance (Macro Run 1 Part H):
 *
 * P2-1 headingIntent — the accepted per-instance ProductionSpec
 * `headingIntent` is the production heading instruction for that section
 * instance. Repeated instances of one Blueprint section must be able to
 * carry DISTINCT heading intents; missing intent falls back to the
 * Blueprint heading; boundary overflow fails closed deterministically.
 *
 * P2-2 semantic integrity — keyPoints, prohibitedClaims, and production
 * guidance reach the SiteTask brief VERBATIM when valid. Any overflow of a
 * downstream contract bound FAILS CLOSED with a typed diagnostic. Silent
 * slice()/ellipsis/drop of accepted semantics is prohibited.
 */

function twoInstanceSpec(headingIntents: [string | undefined, string | undefined]): {
  spec: SiteProductionSpec;
} {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);
  const blueprintSectionIds = blueprint.pages[0]!.sections.map((s) => s.id);
  const heroSectionId = blueprintSectionIds[0]!;
  spec.pages[0]!.sections = [
    {
      id: "hero-instance-a",
      purpose: "Establish positioning (instance A)",
      ...(headingIntents[0] !== undefined ? { headingIntent: headingIntents[0] } : {}),
      editorialDirection: "Concise declarative prose",
      layoutDirection: "Asymmetric split viewport",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [heroSectionId],
    },
    {
      id: "hero-instance-b",
      purpose: "Reinforce positioning for returning visitors (instance B)",
      ...(headingIntents[1] !== undefined ? { headingIntent: headingIntents[1] } : {}),
      editorialDirection: "Shorter reinforcement copy",
      layoutDirection: "Full-bleed band",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [heroSectionId],
    },
  ];
  return { spec };
}

async function compileSpec(spec: SiteProductionSpec) {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  return await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile,
    pageSlug: "/",
  });
}

const heroBriefOf = (task: ReturnType<typeof projectPacketToSiteTask>) =>
  task.page.contentBrief!.sections[0]!;

test("P2-1: repeated instances keep their DISTINCT accepted headingIntents verbatim", async () => {
  const { spec } = twoInstanceSpec([
    "Institutional authority headline for first-time visitors",
    "Reinforcement headline focused on current refinancing windows",
  ]);
  const packet = await compileSpec(spec);
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const briefs = task.page.contentBrief!.sections;
  assert.equal(briefs.length, 2);
  assert.equal(briefs[0]!.heading, "Institutional authority headline for first-time visitors");
  assert.equal(briefs[1]!.heading, "Reinforcement headline focused on current refinancing windows");
  assert.notEqual(briefs[0]!.heading, briefs[1]!.heading);
});

test("P2-1: missing headingIntent falls back to the Blueprint section heading", async () => {
  const blueprint = makeGenericBlueprint();
  const blueprintHeading = blueprint.pages[0]!.sections[0]!.heading;
  const { spec } = twoInstanceSpec([undefined, undefined]);
  const packet = await compileSpec(spec);
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const briefs = task.page.contentBrief!.sections;
  assert.equal(briefs[0]!.heading, blueprintHeading);
  assert.equal(briefs[1]!.heading, blueprintHeading);
});

test("P2-1: headingIntent exactly at the 120-char contract bound projects verbatim", async () => {
  const exact120 = "H".repeat(120);
  const { spec } = twoInstanceSpec([exact120, undefined]);
  const packet = await compileSpec(spec);
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  assert.equal(heroBriefOf(task).heading, exact120);
  assert.equal(heroBriefOf(task).heading.length, 120);
});

test("P2-1: headingIntent one char over the bound fails closed (deterministic, no truncation)", async () => {
  const over = "H".repeat(121);
  const { spec } = twoInstanceSpec([over, undefined]);
  const packet = await compileSpec(spec);
  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /bound is 120/);
      assert.match(err.message, /121 characters/);
      assert.match(err.message, /instead of truncating/);
      return true;
    },
  );
  // Deterministic: the same input throws the same way again.
  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /bound is 120/,
  );
});

test("P2-2: keyPoints survive verbatim at the exact 280-char bound", async () => {
  const exact280 = "K".repeat(280);
  const blueprint = makeGenericBlueprint();
  blueprint.pages[0]!.sections[0]!.keyPoints = [exact280];
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const brief = heroBriefOf(task);
  assert.equal(brief.keyPoints.length, 1);
  assert.equal(brief.keyPoints[0], exact280);
  assert.ok(!brief.keyPoints[0]!.includes("…"), "no ellipsis may appear");
});

test("P2-2: keyPoints overflow (281 chars) fails closed instead of slicing", async () => {
  const blueprint = makeGenericBlueprint();
  blueprint.pages[0]!.sections[0]!.keyPoints = ["K".repeat(281)];
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /281 characters/);
      assert.match(err.message, /bound is 280/);
      return true;
    },
  );
});

test("P2-2: prohibitedClaims survive verbatim at the exact 240-char bound", async () => {
  const exact240 = "P".repeat(240);
  const blueprint = makeGenericBlueprint();
  blueprint.pages[0]!.sections[0]!.prohibitedClaims = [exact240];
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const brief = heroBriefOf(task);
  assert.deepEqual(brief.prohibitedClaims, [exact240]);
});

test("P2-2: prohibitedClaims overflow (241 chars) fails closed", async () => {
  const blueprint = makeGenericBlueprint();
  blueprint.pages[0]!.sections[0]!.prohibitedClaims = ["P".repeat(241)];
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /bound is 240/,
  );
});

test("P2-2: production guidance survives verbatim at the exact 600-char combined bound", async () => {
  // "Layout: " (8) + layout (296) + " " + "Editorial: " (11) + editorial (284) = 600
  const layout = "L".repeat(296);
  const editorial = "E".repeat(284);
  const blueprint = makeGenericBlueprint();
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: editorial,
      layoutDirection: layout,
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const guidance = heroBriefOf(task).productionGuidance!;
  const expected = `Layout: ${layout} Editorial: ${editorial}`;
  assert.equal(guidance, expected, "combined guidance must reach the brief verbatim");
  assert.equal(guidance.length, 600);
  assert.ok(!guidance.includes("…"));
});

test("P2-2: production guidance overflow (601 chars) fails closed", async () => {
  const layout = "L".repeat(297);
  const editorial = "E".repeat(284);
  const blueprint = makeGenericBlueprint();
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "Establish positioning",
      editorialDirection: editorial,
      layoutDirection: layout,
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  assert.throws(
    () => projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" }),
    /bound is 600/,
  );
});

test("P2-2: purpose survives verbatim at the exact 300-char bound; overflow fails closed", async () => {
  const exact300 = "U".repeat(300);
  const blueprint = makeGenericBlueprint();
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: exact300,
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  assert.equal(heroBriefOf(task).purpose, exact300);

  // Overflow: 301 chars.
  const spec2 = makeGenericProductionSpec(blueprint);
  spec2.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose: "U".repeat(301),
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet2 = await compilePageProductionPacket({
    productionSpec: spec2,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  assert.throws(
    () => projectPacketToSiteTask({ packet: packet2, sourceBlueprintRunId: "run" }),
    /bound is 300/,
  );
});

test("P2-2: purpose promoted into empty keyPoints slot survives verbatim", async () => {
  const purpose = "Promoted accepted purpose for the section instance";
  const blueprint = makeGenericBlueprint();
  blueprint.pages[0]!.sections[0]!.keyPoints = [];
  const spec = makeGenericProductionSpec(blueprint);
  spec.pages[0]!.sections = [
    {
      id: "hero-only",
      purpose,
      editorialDirection: "",
      layoutDirection: "",
      referenceIds: [],
      assets: [],
      evidenceRefs: [],
      sourceBlueprintSectionIds: [blueprint.pages[0]!.sections[0]!.id],
    },
  ];
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  const brief = heroBriefOf(task);
  assert.ok(brief.keyPoints.length >= 1, "brief invariant: at least one key point");
  assert.equal(brief.keyPoints[0], purpose);
  assert.equal(brief.purpose, purpose);
});

test("P2-2: no accepted value is ever ellipsized — brief fields contain no ellipsis character", async () => {
  const blueprint = makeGenericBlueprint();
  const spec = makeGenericProductionSpec(blueprint);
  const packet = await compilePageProductionPacket({
    productionSpec: spec,
    blueprint,
    siteProfile: makeGenericSiteProfile(),
    pageSlug: "/",
  });
  const task = projectPacketToSiteTask({ packet, sourceBlueprintRunId: "run" });
  for (const section of task.page.contentBrief!.sections) {
    assert.ok(!section.heading.includes("…"));
    for (const kp of section.keyPoints) assert.ok(!kp.includes("…"));
    for (const pc of section.prohibitedClaims ?? []) assert.ok(!pc.includes("…"));
    if (section.productionGuidance) assert.ok(!section.productionGuidance.includes("…"));
    if (section.purpose) assert.ok(!section.purpose.includes("…"));
  }
});
