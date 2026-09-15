import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { runSiteWideQa } from "../src/production/qa/site-wide.js";
import { emitSitemapAndRobots } from "../src/production/seo-engine.js";
import type { ProductionRenderManifest } from "../src/production/render-manifest.js";

/**
 * BUILD SEAM TEST — Macro Run 9.
 *
 * Manifest -> REAL Astro build -> authority sitemap -> site-wide QA.
 * Runs the actual Astro static build against a synthetic production
 * manifest (zero model/provider calls) and proves the built output passes
 * the full deterministic gate set against production output, not sources.
 */

const repoRoot = process.cwd().replace(/\/apps\/factory$/, "");
const siteDir = `${repoRoot}/sites/starter`;
const manifestDir = `${siteDir}/.factory-production`;
const distDir = `${siteDir}/dist`;

const manifest: ProductionRenderManifest = {
  schemaVersion: "production-v1",
  input: {
    id: "ppin-seam-1",
    version: 1,
    digest: deterministicDigest({ seam: 1 }),
    projectId: "proj-seam",
    pageIdentity: "asset-review",
    pageType: "service",
    route: "/",
    siteIdentity: { siteId: "sutherland-private-office", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "f".repeat(64) },
  },
  seo: { fullTitle: "Asset Review — structured evidence for a specific property | Sutherland Private Office", description: "A documented, buyer-side assessment of a specific Alpine property through structured evidence and risk review.", canonicalUrl: "https://sutherlandam.com/", ogTitle: "Asset Review — structured evidence for a specific property | Sutherland Private Office", ogDescription: "A documented, buyer-side assessment of a specific Alpine property through structured evidence and risk review.", ogUrl: "https://sutherlandam.com/" },
  content: {
    acceptedId: "wprp-seam",
    acceptedVersion: 1,
    acceptedDigest: deterministicDigest({ content: "seam" }),
    title: "Asset Review — structured evidence for a specific property",
    metaDescription: "A documented, buyer-side assessment of a specific Alpine property through structured evidence and risk review.",
    introduction: "RUN9_ROOT_AUTHORITY_PROOF — an Asset Review addresses a specific property through structured evidence and risk review.",
    sections: [
      { heading: "What the review examines", body: "The review examines the specific asset: its documents, its measured condition, and its market context." },
      { heading: "What the review produces", body: "The review produces a documented assessment that supports the go or no-go decision." },
    ],
    conclusion: "The review ends with a documented assessment, not a sales pitch.",
    cta: "Begin with a scoping conversation.",
    internalLinks: [],
  },
  design: { acceptedId: "dacc-seam", acceptedVersion: 1, acceptedDigest: "9".repeat(64), tokens: { colors: { primary: "#1A2E35" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "fixture" }, spacing: { md: "16px", lg: "32px" }, rounded: { md: "8px" }, ctaHierarchy: "text only", navigationLanguage: "plain", imageryTreatment: "documentary", sectionRhythm: "measured" }, archetype: { kind: "service", sectionPatterns: ["page-header", "service-overview", "cta"], contentRequirements: [], assetSlots: [], primaryCta: "", secondaryCta: "", responsiveBehavior: "stack", trustPresentation: "visible", rendererPrimitives: ["page-header", "narrative", "cta"] } },
  links: [],
  breadcrumbs: [],
  assets: [],
  manifestDigest: "",
};
manifest.manifestDigest = deterministicDigest({ input: manifest.input, seo: manifest.seo, content: manifest.content, design: manifest.design, links: manifest.links, breadcrumbs: manifest.breadcrumbs, assets: manifest.assets });

function astroBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", "build"], {
      cwd: siteDir,
      env: { ...process.env, FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir, FACTORY_PRODUCTION_OUT_DIR: distDir, FACTORY_PRODUCTION_SITE_PROFILE_DIGEST: manifest.input.siteIdentity.profileDigest, PUBLIC_SITE_URL: manifest.input.siteIdentity.canonicalOrigin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`astro build failed (${code}): ${out.slice(-1500)}`));
      else resolve();
    });
    child.on("error", reject);
  });
}

test("BUILD SEAM: manifest -> Astro build -> site-wide QA PASS on built output", async () => {
  await mkdir(manifestDir, { recursive: true });
  await writeFile(`${manifestDir}/asset-review.json`, JSON.stringify(manifest, null, 2));
  try {
    await astroBuild();
    const rootHtml = await readFile(`${distDir}/index.html`, "utf8");
    assert.match(rootHtml, /RUN9_ROOT_AUTHORITY_PROOF/);
    assert.doesNotMatch(rootHtml, /Independent advice for consequential French Alps property decisions/);
    await emitSitemapAndRobots({ manifests: [manifest], distDir, siteName: "Sutherland Private Office" });
    const qa = await runSiteWideQa({
      distDir,
      manifests: [manifest],
      redirectRules: [],
      siteName: "Sutherland Private Office",
      manifestSetDigest: deterministicDigest([{ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest }]),
      repositorySha: "1".repeat(40),
    });
    const failures = qa.checks.filter((check) => check.verdict === "FAIL");
    assert.deepEqual(
      failures.map((failure) => failure.checkId),
      [],
      `QA failures: ${failures.map((failure) => `${failure.checkId}: ${failure.detail}`).join(" | ")}`,
    );
    assert.equal(qa.overall, "PASS");
    assert.ok(qa.checks.length >= 30, `expected comprehensive checks, got ${qa.checks.length}`);
  } finally {
    await rm(`${manifestDir}/asset-review.json`, { force: true });
  }
});
