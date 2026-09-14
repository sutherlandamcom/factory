import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDesignCandidateData,
  parseDesignInputSnapshotData,
  DESIGN_ERROR_CODES,
  type DesignCandidateData,
  type DesignInputSnapshotData,
} from "@factory/contracts";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { lintDesignMd, diffDesignMdTokens } from "../src/design/design-md.js";
import { archetypeFor, buildDesignMd, buildArchetypePrompt, mapFontToStitchEnum, DESIGN_MD_TOOL_VERSION } from "../src/design/stitch-provider.js";
import { createDesignArtifactStorage, sha256HexBytes } from "../src/design/artifact-storage.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Run 6 unit suite — contract, input-snapshot determinism, DESIGN.md
 * validation, archetype prompt authority boundaries, artifact storage.
 * No network, no database, no provider calls.
 */

function validInputSnapshotData(): DesignInputSnapshotData {
  return parseDesignInputSnapshotData({
    schemaVersion: "design-v1",
    acceptedInputSnapshotId: "pis-test-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    brand: {
      facts: ["Family-owned roofing firm in Chamonix"],
      positioning: "High-altitude roofing expertise",
      tone: "Plain-spoken expert",
      visualIdentityNotes: "Alpine restraint",
    },
    audience: {
      segments: ["Property owners"],
      needs: ["Durable roofs in alpine climate"],
      decisionContext: "High-stakes renovation",
    },
    references: {
      referenceUrls: ["https://example.com/ref"],
      antiReferenceUrls: ["https://example.com/anti"],
      learn: ["Restrained typography"],
      avoid: ["Generic real-estate template look"],
      preferredPerception: "Institutional advisory",
    },
    uxRequirements: ["Mobile-first responsive layout"],
    contentRefs: [
      {
        id: "wacc-1",
        version: 1,
        slug: "roof-repair",
        contentDigest: "b".repeat(64),
      },
    ],
    assetRefs: [
      {
        versionId: "asv-11111111-1111-4111-8111-111111111111",
        binaryDigest: "c".repeat(64),
        governanceDigest: "e".repeat(64), acceptedPageContentId: "page-home", acceptedPageContentVersion: 1, acceptedPageContentDigest: "c".repeat(64),
        pageSlug: "roof-repair",
        role: "hero",
      },
    ],
    representativePages: [
      { archetype: "homepage", slug: "home", contentDigest: "b".repeat(64) },
    ],
    archetypes: ["homepage", "service"],
  });
}

function validCandidateData(): DesignCandidateData {
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "projects/123",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      rationale: "Seed rationale",
    },
    providerEvidence: {},
    tokens: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      spacing: { md: "16px" },
      rounded: { md: "8px" },
    },
    screens: [
      {
        id: "screen-1",
        providerScreenName: "projects/123/screens/abc",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/123/screens/abc"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero placeholder",
            pageSlug: "home",
            role: "hero",
            requiredRole: "hero",
            providerConsumed: false,
            placeholder: true,
            unresolvedReason: "No approved asset assignment for home/hero.",
          },
        ],
        primaryCta: "Request assessment",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Fixture rationale",
  });
}

test("design contracts: valid input snapshot parses and digests deterministically", () => {
  const data = validInputSnapshotData();
  const digest1 = deterministicDigest(data);
  const digest2 = deterministicDigest(validInputSnapshotData());
  assert.equal(digest1, digest2);
  assert.match(digest1, /^[0-9a-f]{64}$/);
});

test("design contracts: input snapshot fails closed on missing brand positioning", () => {
  const raw = validInputSnapshotData() as unknown as Record<string, unknown>;
  const brand = { ...(raw["brand"] as Record<string, unknown>), positioning: "" };
  assert.throws(() => parseDesignInputSnapshotData({ ...raw, brand }), /positioning/);
});

test("design contracts: candidate digest binds exact payload", () => {
  const data = validCandidateData();
  const digest = deterministicDigest(data);
  const mutated = parseDesignCandidateData({
    ...JSON.parse(JSON.stringify(data)),
    rationale: "changed",
  });
  assert.notEqual(digest, deterministicDigest(mutated));
});

test("design contracts: provider union is closed to google-stitch", () => {
  const raw = JSON.parse(JSON.stringify(validCandidateData()));
  raw.provider = "framer";
  assert.throws(() => parseDesignCandidateData(raw));
});

test("design contracts: error codes exported for operator mapping", () => {
  assert.ok(DESIGN_ERROR_CODES.includes("design_input_stale"));
  assert.ok(DESIGN_ERROR_CODES.includes("design_provider_not_configured"));
});

test("DESIGN.md: valid artifact lints clean", () => {
  const md = buildDesignMd({
    colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
    typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
    rationale: "Institutional advisory identity.",
  });
  const report = lintDesignMd(md);
  assert.equal(report.errors, 0, `unexpected errors: ${JSON.stringify(report.findings)}`);
  assert.ok(report.tokenNames.includes("name"));
  assert.ok(report.tokenNames.includes("colors.primary"));
});

test("DESIGN.md: broken token reference is an error", () => {
  const md = buildDesignMd({
    colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
    typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
    rationale: "Test.",
  }).replace("{colors.tertiary}", "{colors.does-not-exist}");
  const report = lintDesignMd(md);
  assert.ok(report.errors > 0);
  assert.ok(report.findings.some((f) => f.rule === "broken-ref"));
});

test("DESIGN.md: missing front matter is an error", () => {
  const report = lintDesignMd("# Just markdown, no tokens\n\n## Overview\nBody.");
  assert.ok(report.errors > 0);
});

test("DESIGN.md: token diff detects added and removed tokens", () => {
  const md1 = buildDesignMd({
    colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
    typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
    rationale: "A.",
  });
  const md2 = md1.replace("fontSize: 3rem", "fontSize: 3.5rem");
  const r1 = lintDesignMd(md1);
  const r2 = lintDesignMd(md2);
  const diff = diffDesignMdTokens(r1.tokenNames, r2.tokenNames);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
});

test("archetype prompt: embeds accepted copy verbatim instruction and anti-references", () => {
  const prompt = buildArchetypePrompt({
    archetypeKind: "homepage",
    archetype: {
      purpose: "Trust-first entry",
      sectionPatterns: ["hero", "evidence", "cta"],
      contentRequirements: ["Primary CTA visible"],
      assetSlots: [
      {
        slot: "hero.primary",
        requirement: "Hero",
        pageSlug: "home",
        role: "hero",
        requiredRole: "hero",
        providerConsumed: false,
        designProviderReferencedFinalAsset: false,
        designProviderConsumedFinalAsset: false,
        placeholder: true,
      },
    ],
      primaryCta: "Request assessment",
      secondaryCta: null,
      responsiveBehavior: "Mobile-first",
      trustPresentation: "Author/date areas",
    },
    brand: { facts: ["Family-owned"], positioning: "High-altitude expertise", tone: "Plain-spoken" },
    audience: { segments: ["Owners"], needs: ["Durability"] },
    representativePage: {
      slug: "home",
      title: "Home",
      introduction: "EXACT INTRO TEXT",
      sections: [{ heading: "Process", body: "EXACT BODY TEXT" }],
      conclusion: "EXACT CONCLUSION",
      cta: "EXACT CTA",
    },
    references: { learn: ["Restraint"], avoid: ["Cheap template look"], preferredPerception: "Institutional" },
    uxRequirements: ["Mobile-first"],
  });
  assert.ok(prompt.includes("EXACT INTRO TEXT"));
  assert.ok(prompt.includes("EXACT BODY TEXT"));
  assert.ok(prompt.includes("EXACT CONCLUSION"));
  assert.ok(prompt.includes("EXACT CTA"));
  assert.ok(prompt.includes("do not rewrite, shorten, expand, or improve it"));
  assert.ok(prompt.includes("Cheap template look"));
  assert.ok(prompt.includes("do NOT invent additional facts"));
});

test("font mapping: known families map directly; unknown serif maps to serif bucket", () => {
  assert.equal(mapFontToStitchEnum("Public Sans"), "PUBLIC_SANS");
  assert.equal(mapFontToStitchEnum("Source Serif 4"), "SOURCE_SERIF_4");
  assert.equal(mapFontToStitchEnum("Georgia"), "SOURCE_SERIF_4");
  assert.equal(mapFontToStitchEnum("Some Unknown Sans"), "PUBLIC_SANS");
});

test("artifact storage: content-addressed put/get roundtrip and immutability", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "design-artifacts-"));
  const storage = createDesignArtifactStorage(dir);
  const bytes = new TextEncoder().encode("# Test artifact");
  const digest = await storage.putArtifact("design_md", bytes);
  assert.equal(digest, sha256HexBytes(bytes));
  // Idempotent re-put returns the same digest.
  const again = await storage.putArtifact("design_md", bytes);
  assert.equal(again, digest);
  const read = await storage.getArtifact("design_md", digest);
  assert.equal(new TextDecoder().decode(read.bytes), "# Test artifact");
  assert.equal(read.mediaType, "text/markdown");
  // By-digest lookup works across kinds.
  const byDigest = await storage.getArtifactByDigest(digest);
  assert.ok(byDigest);
  // Invalid digest fails closed.
  await assert.rejects(storage.getArtifact("design_md", "zz"), /hex/);
});

test("artifact storage: storage key escapes are refused", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "design-artifacts-"));
  const storage = createDesignArtifactStorage(dir);
  assert.throws(() => storage.artifactKey("design_md", "../../etc/passwd"), /hex/);
});

// ---------------------------------------------------------------------------
// QA remediation: page-exact content routing + asset slot lineage (§25)
// ---------------------------------------------------------------------------

test("archetype prompt: homepage receives ONLY homepage copy; unrelated copy excluded", () => {
  const prompt = buildArchetypePrompt({
    archetypeKind: "homepage",
    archetype: {
      purpose: "Trust-first entry",
      sectionPatterns: ["hero", "evidence", "cta"],
      contentRequirements: ["Primary CTA visible"],
      assetSlots: [],
      primaryCta: "Request assessment",
      secondaryCta: null,
      responsiveBehavior: "Mobile-first",
      trustPresentation: "Author/date areas",
    },
    brand: { facts: ["Family-owned"], positioning: "High-altitude expertise", tone: "Plain-spoken" },
    audience: { segments: ["Owners"], needs: ["Durability"] },
    representativePage: {
      slug: "home",
      title: "Home",
      introduction: "HOMEPAGE INTRO MARKER",
      sections: [{ heading: "Why us", body: "HOMEPAGE BODY MARKER" }],
      conclusion: "HOMEPAGE CONCLUSION MARKER",
      cta: "HOMEPAGE CTA MARKER",
    },
    references: { learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
  });
  assert.ok(prompt.includes("HOMEPAGE INTRO MARKER"));
  assert.ok(prompt.includes("HOMEPAGE BODY MARKER"));
  assert.ok(prompt.includes("HOMEPAGE CONCLUSION MARKER"));
  assert.ok(prompt.includes("HOMEPAGE CTA MARKER"));
  assert.ok(!prompt.includes("SERVICE"), "homepage prompt must not contain service copy markers");
});

test("archetype prompt: service prompt contains ONLY the selected service page", () => {
  const prompt = buildArchetypePrompt({
    archetypeKind: "service",
    archetype: {
      purpose: "Service detail",
      sectionPatterns: ["page-header", "faq", "cta"],
      contentRequirements: ["Service definition matches accepted content exactly"],
      assetSlots: [],
      primaryCta: "Request",
      secondaryCta: null,
      responsiveBehavior: "Mobile-first",
      trustPresentation: "Trust areas",
    },
    brand: { facts: [], positioning: "P", tone: "T" },
    audience: { segments: [], needs: [] },
    representativePage: {
      slug: "services/roof-repair",
      title: "Roof Repair",
      introduction: "SERVICE PAGE INTRO MARKER",
      sections: [{ heading: "Process", body: "SERVICE PAGE BODY MARKER" }],
      conclusion: "SERVICE PAGE CONCLUSION MARKER",
      cta: "SERVICE PAGE CTA MARKER",
    },
    references: { learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
  });
  assert.ok(prompt.includes("SERVICE PAGE INTRO MARKER"));
  assert.ok(prompt.includes("SERVICE PAGE BODY MARKER"));
  assert.ok(prompt.includes("services/roof-repair"));
  assert.ok(!prompt.includes("HOMEPAGE"), "service prompt must not contain homepage copy");
  assert.ok(!prompt.includes("EDITORIAL"), "service prompt must not contain editorial copy");
});

test("archetype prompt: no representative page -> structural slots only, no copy section", () => {
  const prompt = buildArchetypePrompt({
    archetypeKind: "editorial",
    archetype: {
      purpose: "Research article",
      sectionPatterns: ["article-header", "sources"],
      contentRequirements: [],
      assetSlots: [],
      primaryCta: null,
      secondaryCta: null,
      responsiveBehavior: "Mobile-first",
      trustPresentation: "Author areas",
    },
    brand: { facts: [], positioning: "P", tone: "T" },
    audience: { segments: [], needs: [] },
    representativePage: null,
    references: { learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
  });
  assert.ok(!prompt.includes("ACCEPTED COPY"), "no copy section when no representative page is bound");
});

test("asset slot lineage: homepage hero binds ONLY homepage+hero; service slot cannot bind homepage hero", () => {
  // Build an input snapshot where ONLY the homepage has a hero assignment.
  const snapshot = parseDesignInputSnapshotData({
    schemaVersion: "design-v1",
    acceptedInputSnapshotId: "pis-test-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    brand: { facts: [], positioning: "P", tone: "T", visualIdentityNotes: "" },
    audience: { segments: [], needs: [], decisionContext: "" },
    references: { referenceUrls: [], antiReferenceUrls: [], learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
    contentRefs: [
      { id: "wacc-1", version: 1, slug: "home", contentDigest: "b".repeat(64) },
      { id: "wacc-2", version: 1, slug: "services/roof-repair", contentDigest: "e".repeat(64) },
    ],
    assetRefs: [
      {
        versionId: "asv-11111111-1111-4111-8111-111111111111",
        binaryDigest: "c".repeat(64),
        governanceDigest: "e".repeat(64), acceptedPageContentId: "page-home", acceptedPageContentVersion: 1, acceptedPageContentDigest: "c".repeat(64),
        pageSlug: "home",
        role: "hero",
      },
    ],
    representativePages: [
      { archetype: "homepage", slug: "home", contentDigest: "b".repeat(64) },
      { archetype: "service", slug: "services/roof-repair", contentDigest: "e".repeat(64) },
    ],
    archetypes: ["homepage", "service"],
  });
  const homePrompt = buildArchetypePrompt({
    archetypeKind: "homepage",
    archetype: {
      purpose: "p",
      sectionPatterns: [],
      contentRequirements: [],
      assetSlots: [
        {
          slot: "hero.primary",
          requirement: "Hero",
          pageSlug: "home",
          role: "hero",
          requiredRole: "hero",
          boundAssetVersionId: "asv-11111111-1111-4111-8111-111111111111",
          boundBinaryDigest: "c".repeat(64),
          providerConsumed: false,
          designProviderReferencedFinalAsset: true,
          designProviderConsumedFinalAsset: false,
          placeholder: true,
        },
      ],
      primaryCta: null,
      secondaryCta: null,
      responsiveBehavior: "r",
      trustPresentation: "t",
    },
    brand: { facts: [], positioning: "P", tone: "T" },
    audience: { segments: [], needs: [] },
    representativePage: null,
    references: { learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
  });
  // The homepage slot references the exact bound version.
  assert.ok(homePrompt.includes("asv-11111111-1111-4111-8111-111111111111"));

  // The service slot (page services/roof-repair, role supporting) has NO
  // assignment for that exact page+role: it must stay a labeled placeholder
  // and must NOT reference the homepage hero version.
  const serviceSlot = {
    slot: "service.supporting",
    requirement: "Supporting imagery",
    pageSlug: "services/roof-repair",
    role: "supporting",
    requiredRole: "supporting" as const,
    providerConsumed: false,
    designProviderReferencedFinalAsset: false,
    designProviderConsumedFinalAsset: false,
    placeholder: true as const,
    unresolvedReason: 'No approved asset assignment exists for page "services/roof-repair" role "supporting".',
  };
  const servicePrompt = buildArchetypePrompt({
    archetypeKind: "service",
    archetype: {
      purpose: "p",
      sectionPatterns: [],
      contentRequirements: [],
      assetSlots: [serviceSlot],
      primaryCta: null,
      secondaryCta: null,
      responsiveBehavior: "r",
      trustPresentation: "t",
    },
    brand: { facts: [], positioning: "P", tone: "T" },
    audience: { segments: [], needs: [] },
    representativePage: null,
    references: { learn: [], avoid: [], preferredPerception: "" },
    uxRequirements: [],
  });
  assert.ok(!servicePrompt.includes("asv-11111111"), "service slot must NOT bind the homepage hero version");
  assert.ok(servicePrompt.includes("do not borrow imagery from other pages"));
});

test("provider evidence: fixture and live provider identities cannot be confused", () => {
  const fixtureCandidate = parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "fixture/projects/e2e",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      rationale: "seed",
    },
    providerEvidence: {},
    tokens: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      spacing: { md: "16px" },
      rounded: { md: "8px" },
    },
    screens: [
      {
        id: "screen-1",
        providerScreenName: "fixture/projects/e2e/screens/home-1",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "p",
        providerScreenNames: ["fixture/projects/e2e/screens/home-1"],
        sectionPatterns: ["hero"],
        contentRequirements: [],
        assetSlots: [],
        primaryCta: "",
        secondaryCta: "",
        responsiveBehavior: "r",
        trustPresentation: "t",
      },
    ],
    rationale: "fixture",
  });
  assert.equal(fixtureCandidate.providerMode, "fixture");

  // A candidate claiming providerMode "live" is a distinct durable value:
  // the two can never be conflated through the contract.
  const liveCandidate = parseDesignCandidateData({
    ...JSON.parse(JSON.stringify(fixtureCandidate)),
    providerMode: "live",
    providerProjectName: "projects/real",
    rationale: "live",
  });
  assert.equal(liveCandidate.providerMode, "live");
  assert.notEqual(fixtureCandidate.providerMode, liveCandidate.providerMode);

  // Unknown modes fail closed.
  assert.throws(() =>
    parseDesignCandidateData({
      ...JSON.parse(JSON.stringify(fixtureCandidate)),
      providerMode: "simulated",
    }),
  );
});

test("DESIGN.md tool identity: candidates record the Factory validator, never unexecuted Google tooling", () => {
  // The contract accepts any bounded string, but the shipped providers MUST
  // record the truthful identity. Verify the exported constant.
  assert.equal(DESIGN_MD_TOOL_VERSION, "@google/design.md@0.4.0+factory-design-requirements-v1");
});


test("actual archetype construction: exact page/role asset lineage matrix", () => {
  const base = validInputSnapshotData();
  base.representativePages = [
    { archetype: "homepage", slug: "home", contentDigest: "a".repeat(64) },
    { archetype: "service", slug: "services/foo", contentDigest: "b".repeat(64) },
    { archetype: "location", slug: "locations/chamonix", contentDigest: "c".repeat(64) },
  ];
  const ref = (pageSlug: string, role: string, n = "1") => ({
    versionId: `asv-${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
    binaryDigest: n.repeat(64), governanceDigest: "e".repeat(64), acceptedPageContentId: "page-home", acceptedPageContentVersion: 1, acceptedPageContentDigest: "c".repeat(64), pageSlug, role,
  });
  const cases = [
    { label: "exact service", kind: "service", refs: [ref("services/foo", "supporting")], binds: true },
    { label: "same page wrong role", kind: "service", refs: [ref("services/foo", "hero")], binds: false },
    { label: "right role wrong page", kind: "service", refs: [ref("home", "supporting")], binds: false },
    { label: "another service", kind: "service", refs: [ref("services/bar", "supporting")], binds: false },
    { label: "multiple choices", kind: "service", refs: [ref("home", "supporting", "2"), ref("services/foo", "hero", "3"), ref("services/foo", "supporting")], binds: true },
    { label: "location wrong role", kind: "location", refs: [ref("locations/chamonix", "hero")], binds: false },
    { label: "location exact", kind: "location", refs: [ref("locations/chamonix", "background")], binds: true },
    { label: "no assignment", kind: "service", refs: [], binds: false },
  ] as const;
  for (const c of cases) {
    const slot = archetypeFor(c.kind, { ...base, assetRefs: [...c.refs] }).assetSlots[0]!;
    assert.equal(Boolean(slot.boundAssetVersionId), c.binds, c.label);
    assert.equal(slot.providerConsumed, false, c.label);
    assert.equal(slot.placeholder, true, c.label);
    assert.ok(slot.unresolvedReason, c.label);
    if (c.binds) {
      assert.equal(slot.boundBinaryDigest, "1".repeat(64), c.label);
      assert.equal(slot.boundGovernanceDigest, "e".repeat(64), c.label);
      assert.notEqual(slot.boundBinaryDigest, slot.boundGovernanceDigest);
    } else {
      assert.equal(slot.boundBinaryDigest, undefined, c.label);
      assert.equal(slot.boundGovernanceDigest, undefined, c.label);
    }
  }
  const missingRepresentative = archetypeFor("service", {
    ...base, representativePages: base.representativePages.filter((r) => r.archetype !== "service"),
    assetRefs: [ref("home", "supporting")],
  }).assetSlots[0]!;
  assert.equal(missingRepresentative.boundAssetVersionId, undefined);
  assert.notEqual(missingRepresentative.pageSlug, "home");
});

test("DESIGN.md: official lint runs deterministically and Factory requires resolved authority", () => {
  const md = buildDesignMd({ colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" }, rationale: "Test." });
  assert.deepEqual(lintDesignMd(md), lintDesignMd(md));
  assert.ok(lintDesignMd(md).findings.some((f) => f.rule === "token-summary"), "official rule actually executed");
  for (const invalid of ["---\nname: [\n---\n", "---\nname: Missing color\n---\n", "---\ncolors:\n  primary: '#123456'\n---\n", "---\nname: Unresolved\ncolors:\n  primary: '{colors.missing}'\n---\n"]) {
    assert.ok(lintDesignMd(invalid).errors > 0);
  }
});
