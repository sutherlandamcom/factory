import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BLUEPRINT_BYTES,
  SITE_BLUEPRINT_METHODOLOGY_VERSION,
  blueprintPageIdentityMatches,
  parseBlueprintResult,
  parseSiteBlueprint,
} from "@factory/contracts";
import {
  loadBlueprintFixtureInputs,
  makeValidBlueprint,
  makeValidBlueprintJson,
} from "./blueprint-fixtures.js";

const { request, plan } = loadBlueprintFixtureInputs();

test("valid fixture blueprint parses strictly", () => {
  const blueprint = parseSiteBlueprint(makeValidBlueprintJson(request, plan));
  assert.equal(blueprint.methodologyVersion, SITE_BLUEPRINT_METHODOLOGY_VERSION);
  assert.equal(blueprint.pages.length, 5);
  assert.ok(blueprint.pages.every((page) => page.readiness === "ready"));
  const homepage = blueprint.pages.find((page) => page.slug === "/");
  assert.ok(homepage);
  assert.equal(homepage.structuredDataType, "local_business");
  assert.equal(blueprint.site.navigation.length, 4);
});

test("ready page requires sections and forbids missingInputs", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  (pages[0] as Record<string, unknown>).missingInputs = ["verified biography"];
  assert.throws(() => parseSiteBlueprint(invalid), /ready page cannot declare missingInputs/);
});

test("ready page with zero sections is rejected", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  (pages[0] as Record<string, unknown>).sections = [];
  assert.throws(() => parseSiteBlueprint(invalid), /at least one section/);
});

test("non-ready page requires missingInputs", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  (pages[1] as Record<string, unknown>).readiness = "insufficient_evidence";
  assert.throws(() => parseSiteBlueprint(invalid), /requires at least one missingInput/);
});

test("structured data type must be coherent with page type", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  (pages[0] as Record<string, unknown>).structuredDataType = "article";
  assert.throws(() => parseSiteBlueprint(invalid), /not coherent with page type/);
});

test("duplicate page slugs are rejected", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  pages[1]!.slug = "/";
  assert.throws(() => parseSiteBlueprint(invalid), /duplicate page slugs/);
});

test("duplicate section ids within a page are rejected", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const sections = pages[0]!.sections as Array<Record<string, unknown>>;
  sections[1]!.id = sections[0]!.id;
  assert.throws(() => parseSiteBlueprint(invalid), /section ids must be unique/);
});

test("internal links to unknown slugs are rejected", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const links = pages[0]!.internalLinks as Array<Record<string, unknown>>;
  links[0]!.targetSlug = "/services/does-not-exist";
  assert.throws(() => parseSiteBlueprint(invalid), /targets unknown slug/);
});

test("self links are rejected", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const links = pages[0]!.internalLinks as Array<Record<string, unknown>>;
  links[0]!.targetSlug = "/";
  assert.throws(() => parseSiteBlueprint(invalid), /self-links are not permitted/);
});

test("navigation entries must target existing pages", () => {
  const invalid = makeValidBlueprint(request, plan);
  (invalid.site as Record<string, unknown>).navigation = [
    { label: "Ghost", targetSlug: "/services/ghost" },
  ];
  assert.throws(() => parseSiteBlueprint(invalid), /targets unknown slug/);
});

test("visual requirement: required demands purpose and kind", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const sections = pages[1]!.sections as Array<Record<string, unknown>>;
  (sections[2] as Record<string, unknown>).visualRequirement = { required: true };
  assert.throws(() => parseSiteBlueprint(invalid), /visualRequirement.purpose is required/);
});

test("visual requirement: not required forbids purpose and kind", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const sections = pages[1]!.sections as Array<Record<string, unknown>>;
  (sections[2] as Record<string, unknown>).visualRequirement = { required: false, purpose: "decorative banner" };
  assert.throws(() => parseSiteBlueprint(invalid), /purpose must be omitted/);
});

test("cta carries a job, never a URL field", () => {
  const invalid = makeValidBlueprint(request, plan);
  const pages = invalid.pages as Array<Record<string, unknown>>;
  const sections = pages[0]!.sections as Array<Record<string, unknown>>;
  (sections[3] as Record<string, unknown>).cta = { role: "primary", job: "Book", href: "https://example.com" };
  assert.throws(() => parseSiteBlueprint(invalid), /unrecognized_keys|Unrecognized key/);
});

test("unknown fields fail closed everywhere", () => {
  const invalid = makeValidBlueprint(request, plan);
  (invalid as Record<string, unknown>).sutherlandSpecialField = true;
  assert.throws(() => parseSiteBlueprint(invalid), /unrecognized_keys|Unrecognized key/);
});

test("payload bounds are enforced", () => {
  const huge = makeValidBlueprint(request, plan);
  (huge as Record<string, unknown>).warnings = ["x".repeat(MAX_BLUEPRINT_BYTES)];
  assert.throws(() => parseSiteBlueprint(JSON.stringify(huge).repeat(2)), /exceeds maximum allowed/);
});

test("identity comparison uses normalized primary topics", () => {
  assert.equal(
    blueprintPageIdentityMatches(
      { type: "homepage", slug: "/", primaryTopic: "Roofing  Contractor   Denver" },
      { type: "homepage", slug: "/", primaryTopic: "roofing contractor denver" },
    ),
    true,
  );
  assert.equal(
    blueprintPageIdentityMatches(
      { type: "homepage", slug: "/", primaryTopic: "roofing contractor denver" },
      { type: "service", slug: "/", primaryTopic: "roofing contractor denver" },
    ),
    false,
  );
});

test("BlueprintResult parses and validates provenance shape", () => {
  const result = parseBlueprintResult({
    version: "v0",
    status: "succeeded",
    runId: "20260901T010203Z-abcdef01",
    siteId: "summit-roofing",
    factorySourceCommit: "a".repeat(40),
    methodologyVersion: SITE_BLUEPRINT_METHODOLOGY_VERSION,
    requestDigest: "b".repeat(64),
    researchDigest: "c".repeat(64),
    planDigest: "d".repeat(64),
    blueprintDigest: "e".repeat(64),
    attemptCount: 1,
    modelInvocation: {
      roleId: "blueprint_architect",
      requestedModel: "anthropic/claude-test",
      respondedModel: "anthropic/claude-test",
      provider: "Anthropic",
      gateway: "openrouter",
      durationMs: 1234,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      costUsd: 0.01,
      fallback: false,
    },
    modelInvocations: [],
    artifacts: {
      runDirectory: ".factory/blueprint/20260901T010203Z-abcdef01",
      manifest: "manifest.json",
      blueprint: "site-blueprint.json",
      result: "blueprint-result.json",
    },
    pageCount: 5,
    readyCount: 5,
    blockedCount: 0,
    warnings: [],
    error: null,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.modelInvocation?.gateway, "openrouter");

  assert.throws(
    () =>
      parseBlueprintResult({
        version: "v0",
        status: "succeeded",
        runId: "20260901T010203Z-abcdef01",
        siteId: "summit-roofing",
        factorySourceCommit: null,
        methodologyVersion: SITE_BLUEPRINT_METHODOLOGY_VERSION,
        requestDigest: null,
        researchDigest: null,
        planDigest: null,
        blueprintDigest: null,
        attemptCount: 1,
        modelInvocation: null,
        modelInvocations: [],
        artifacts: null,
        pageCount: 5,
        readyCount: 5,
        blockedCount: 0,
        warnings: [],
        error: null,
        // Unknown field:
        secret: "sk-or-abc",
      }),
    /unrecognized_keys|Unrecognized key/,
  );
});
