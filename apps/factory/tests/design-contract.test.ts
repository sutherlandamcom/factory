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
import { buildDesignMd, buildArchetypePrompt, mapFontToStitchEnum } from "../src/design/stitch-provider.js";
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
        pageSlug: "roof-repair",
        role: "hero",
      },
    ],
    archetypes: ["homepage", "service"],
  });
}

function validCandidateData(): DesignCandidateData {
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerProjectName: "projects/123",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "@google/design.md 0.4.0",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
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
        assetSlots: [{ slot: "hero.primary", requirement: "Hero placeholder", placeholder: true }],
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
      assetSlots: [{ slot: "hero.primary", requirement: "Hero", placeholder: true }],
      primaryCta: "Request assessment",
      secondaryCta: null,
      responsiveBehavior: "Mobile-first",
      trustPresentation: "Author/date areas",
    },
    brand: { facts: ["Family-owned"], positioning: "High-altitude expertise", tone: "Plain-spoken" },
    audience: { segments: ["Owners"], needs: ["Durability"] },
    pageContent: [
      {
        slug: "roof-repair",
        title: "Roof Repair",
        introduction: "EXACT INTRO TEXT",
        sections: [{ heading: "Process", body: "EXACT BODY TEXT" }],
        conclusion: "EXACT CONCLUSION",
        cta: "EXACT CTA",
      },
    ],
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
