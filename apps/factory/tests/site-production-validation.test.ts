import assert from "node:assert/strict";
import test from "node:test";
import {
  makeGenericBlueprint,
  makeGenericEvidenceBundle,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "./fixtures/site-production-fixtures.js";
import {
  validateSiteProductionSpec,
  type EvidenceIndex,
} from "../src/site-production/validation.js";
import { deterministicDigest } from "../src/intelligence/digest.js";

function setupContext() {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const { evidence, operatorFacts } = makeGenericEvidenceBundle();
  const evidenceIndex: EvidenceIndex = {
    evidenceIds: new Set(evidence.items.map((i) => i.id)),
    operatorFactIds: new Set(operatorFacts.map((f) => f.id)),
  };
  const blueprintDigest = deterministicDigest(blueprint);
  const spec = makeGenericProductionSpec(blueprint);

  return { blueprint, siteProfile, evidenceIndex, blueprintDigest, spec };
}

test("valid spec against matching blueprint, profile, and evidence passes semantic validation", () => {
  const { spec, blueprint, siteProfile, evidenceIndex, blueprintDigest } = setupContext();
  const result = validateSiteProductionSpec(spec, {
    blueprint,
    blueprintDigest,
    siteProfile,
    evidenceIndex,
  });

  assert.equal(result.ok, true);
});

test("production spec covering only a subset of blueprint pages is valid", () => {
  const { spec, blueprint } = setupContext();
  assert.equal(blueprint.pages.length, 3);
  assert.equal(spec.pages.length, 1); // Only 1 page (homepage) in production spec

  const result = validateSiteProductionSpec(spec, { blueprint });
  assert.equal(result.ok, true);
});

test("production spec introducing page absent from blueprint fails closed", () => {
  const { spec, blueprint } = setupContext();
  spec.pages.push({
    ...spec.pages[0]!,
    slug: "/non-existent-page",
  });

  const result = validateSiteProductionSpec(spec, { blueprint });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("does not exist in blueprint")));
});

test("page type mismatch between production spec and blueprint fails", () => {
  const { spec, blueprint } = setupContext();
  spec.pages[0]!.blueprintPageType = "service"; // Blueprint declares it as homepage

  const result = validateSiteProductionSpec(spec, { blueprint });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("does not match blueprint page type")));
});

test("siteId mismatch between spec and blueprint fails", () => {
  const { spec, blueprint } = setupContext();
  const mismatchedBlueprint = { ...blueprint, siteId: "other-site" };

  const result = validateSiteProductionSpec(spec, { blueprint: mismatchedBlueprint });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("does not match blueprint siteId")));
});

test("siteId mismatch between spec and siteProfile fails", () => {
  const { spec, siteProfile } = setupContext();
  const mismatchedProfile = { ...siteProfile, siteId: "other-site" };

  const result = validateSiteProductionSpec(spec, { siteProfile: mismatchedProfile });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("does not match siteProfile siteId")));
});

test("blueprint digest mismatch fails closed", () => {
  const { spec, blueprint } = setupContext();
  const wrongDigest = "0".repeat(64);

  const result = validateSiteProductionSpec(spec, {
    blueprint,
    blueprintDigest: wrongDigest,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("does not match provided blueprint digest")));
});

test("unknown sourceBlueprintSectionId fails closed", () => {
  const { spec, blueprint } = setupContext();
  spec.pages[0]!.sections[0]!.sourceBlueprintSectionIds = ["sec-fake-blueprint-section"];

  const result = validateSiteProductionSpec(spec, { blueprint });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("cites unknown sourceBlueprintSectionId")));
});

test("dangling page-level and section-level reference IDs fail closed", () => {
  const { spec } = setupContext();
  spec.pages[0]!.referenceIds.push("ref-dangling");
  spec.pages[0]!.sections[0]!.referenceIds.push("ref-dangling-sec");

  const result = validateSiteProductionSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("cites unknown reference id \"ref-dangling\"")));
  assert.ok(result.issues.some((i) => i.includes("cites unknown reference id \"ref-dangling-sec\"")));
});

test("dangling page-level and section-level asset IDs fail closed", () => {
  const { spec } = setupContext();
  spec.pages[0]!.assets.push({ assetId: "asset-ghost", role: "inline" });
  spec.pages[0]!.sections[0]!.assets.push({ assetId: "asset-ghost-sec", role: "inline" });

  const result = validateSiteProductionSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("assigns unknown asset id \"asset-ghost\"")));
  assert.ok(result.issues.some((i) => i.includes("assigns unknown asset id \"asset-ghost-sec\"")));
});

test("assigning blocked asset for production fails closed", () => {
  const { spec } = setupContext();
  // asset-unverified-chart is blocked in the fixture
  spec.pages[0]!.assets.push({ assetId: "asset-unverified-chart", role: "chart" });

  const result = validateSiteProductionSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("assigns blocked asset")));
});

test("assigning reference_only asset as production asset fails closed", () => {
  const { spec } = setupContext();
  // asset-stock-broker is reference_only in the fixture
  spec.pages[0]!.assets.push({ assetId: "asset-stock-broker", role: "hero" });

  const result = validateSiteProductionSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("assigns reference-only asset")));
});

test("internal CTA destination targeting unknown blueprint page fails closed", () => {
  const { spec, blueprint } = setupContext();
  spec.pages[0]!.primaryCta = {
    label: "Unknown Destination",
    destination: {
      kind: "internal",
      targetSlug: "/non-existent-page",
    },
  };

  const result = validateSiteProductionSpec(spec, { blueprint });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("targets unknown internal slug")));
});

test("known evidence IDs pass and dangling evidence IDs fail closed", () => {
  const { spec, evidenceIndex } = setupContext();

  // Known passes
  const good = validateSiteProductionSpec(spec, { evidenceIndex });
  assert.equal(good.ok, true);

  // Dangling discovery evidence
  spec.pages[0]!.evidenceRefs.push({
    kind: "discovery_evidence",
    id: "ev-ghost-market-data",
  });
  // Dangling operator fact
  spec.pages[0]!.evidenceRefs.push({
    kind: "operator_fact",
    id: "fact-ghost-founder",
  });

  const bad = validateSiteProductionSpec(spec, { evidenceIndex });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.includes("unknown discovery evidence id \"ev-ghost-market-data\"")));
  assert.ok(bad.issues.some((i) => i.includes("unknown operator fact id \"fact-ghost-founder\"")));
});

test("spec does not duplicate SiteProfile fields (siteName, canonicalOrigin, navigation)", () => {
  const { spec } = setupContext();
  const specKeys = Object.keys(spec);
  assert.ok(!specKeys.includes("siteName"));
  assert.ok(!specKeys.includes("canonicalOrigin"));
  assert.ok(!specKeys.includes("navigation"));
});
