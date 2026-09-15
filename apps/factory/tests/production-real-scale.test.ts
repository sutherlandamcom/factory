import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { collectHtmlRoutes, computeArtifactDigest } from "../src/production/build-service.js";
import { emitSitemapAndRobots } from "../src/production/seo-engine.js";
import { runSiteWideQa } from "../src/production/qa/site-wide.js";
import type { ProductionRenderManifest } from "../src/production/render-manifest.js";

const repoRoot = process.cwd().replace(/\/apps\/factory$/, "");
const siteDir = path.join(repoRoot, "sites", "starter");
const siteIdentity = { siteId: "run9-scale", siteName: "Run 9 Scale", canonicalOrigin: "https://scale.example", language: "en", profileDigest: "f".repeat(64) };
const kinds = ["homepage", "service", "location", "editorial", "investment_advisory"] as const;

function manifestFor(index: number, route = index === 0 ? "/" : `/page-${index}`): ProductionRenderManifest {
  const title = `Run 9 authority page ${index}`;
  const fullTitle = `${title} | ${siteIdentity.siteName}`;
  const canonicalUrl = `${siteIdentity.canonicalOrigin}${route === "/" ? "/" : route}`;
  const manifest: ProductionRenderManifest = {
    schemaVersion: "production-v1",
    input: { id: `ppin-real-${index}`, version: 1, digest: deterministicDigest({ index, route }), projectId: "proj-real-scale", pageIdentity: index === 0 ? "home" : `page-${index}`, pageType: kinds[index % kinds.length]!, route, siteIdentity },
    seo: { fullTitle, description: `Unique accepted description for Run 9 authority page ${index}.`, canonicalUrl, ogTitle: fullTitle, ogDescription: `Unique accepted description for Run 9 authority page ${index}.`, ogUrl: canonicalUrl },
    content: { acceptedId: `wacc-${index}`, acceptedVersion: 1, acceptedDigest: deterministicDigest({ content: index }), title, metaDescription: `Unique accepted description for Run 9 authority page ${index}.`, introduction: `RUN9_REAL_SCALE_${index} accepted introduction.`, sections: [{ heading: `Evidence ${index}`, body: `Unique accepted evidence body for page ${index}.` }], conclusion: `Unique accepted conclusion ${index}.`, cta: `Accepted CTA text ${index}.`, internalLinks: index === 0 ? [] : ["/"] },
    design: { acceptedId: `dacc-${index}`, acceptedVersion: 1, acceptedDigest: deterministicDigest({ design: index }), tokens: { colors: { primary: "#1a2e35", background: "#ffffff", surface: "#f6f5f2" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "fixture" }, spacing: { md: "16px", lg: "32px" }, rounded: { md: "8px" }, ctaHierarchy: "text only", navigationLanguage: "plain", imageryTreatment: "none", sectionRhythm: "measured" }, archetype: { kind: kinds[index % kinds.length]!, sectionPatterns: ["hero", "evidence", "cta"], contentRequirements: ["accepted evidence"], assetSlots: [], primaryCta: "", secondaryCta: "", responsiveBehavior: "stack", trustPresentation: "visible", rendererPrimitives: ["hero", "evidence", "cta"] } },
    links: index === 0 ? [] : [{ href: "/", title: "Run 9 authority page 0" }],
    breadcrumbs: index === 0 ? [] : [{ name: "Run 9 authority page 0", url: `${siteIdentity.canonicalOrigin}/` }, { name: title, url: "" }],
    assets: [], manifestDigest: "",
  };
  manifest.manifestDigest = deterministicDigest({ input: manifest.input, seo: manifest.seo, content: manifest.content, design: manifest.design, links: manifest.links, breadcrumbs: manifest.breadcrumbs, assets: manifest.assets });
  return manifest;
}

async function astroBuild(manifestDir: string, distDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["run", "build"], { cwd: siteDir, env: { ...process.env, FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir, FACTORY_PRODUCTION_OUT_DIR: distDir, FACTORY_PRODUCTION_SITE_PROFILE_DIGEST: siteIdentity.profileDigest, PUBLIC_SITE_URL: siteIdentity.canonicalOrigin }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Astro scale build failed (${code}): ${output.slice(-2000)}`)));
  });
}

async function runBuild(count: number) {
  return runManifestBuild(Array.from({ length: count }, (_, index) => manifestFor(index)), String(count));
}

async function runManifestBuild(manifests: ProductionRenderManifest[], label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `run9-real-${label}-`));
  const manifestDir = path.join(root, "manifests");
  const distDir = path.join(root, "dist");
  await mkdir(manifestDir);
  for (const manifest of manifests) await writeFile(path.join(manifestDir, `${manifest.input.id}.json`), JSON.stringify(manifest));
  await astroBuild(manifestDir, distDir);
  await emitSitemapAndRobots({ manifests, distDir, siteName: siteIdentity.siteName });
  return { root, distDir, manifests, routes: await collectHtmlRoutes(distDir), digest: await computeArtifactDigest(distDir) };
}

for (const count of [4, 20, 100]) {
  test(`REAL ASTRO SCALE: ${count} immutable manifests produce exact routes and complete deterministic QA`, async () => {
    const result = await runBuild(count);
    try {
      assert.equal(result.routes.filter((route) => route !== "/404").length, count);
      const qa = await runSiteWideQa({ distDir: result.distDir, manifests: result.manifests, redirectRules: [], siteName: siteIdentity.siteName, manifestSetDigest: deterministicDigest(result.manifests.map((manifest) => ({ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest }))), repositorySha: "1".repeat(40) });
      assert.deepEqual(qa.checks.filter((check) => check.verdict === "FAIL").map((check) => `${check.checkId}:${check.subject}`), []);
    } finally { await rm(result.root, { recursive: true, force: true }); }
  });
}

test("REAL ASTRO DETERMINISM: two isolated builds have identical recursive byte digests", async () => {
  const [a, b] = [await runBuild(4), await runBuild(4)];
  try {
    assert.equal(a.digest, b.digest);
    assert.equal(await computeArtifactDigest(a.distDir), a.digest, "Candidate B must not alter Candidate A bytes");
  }
  finally { await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); }
});

test("REAL ASTRO ROUTING: /a/b and /a-b coexist without manifest-name collision", async () => {
  const routes = ["/", "/a", "/a/b", "/a-b"];
  const manifests = routes.map((route, index) => manifestFor(index, route));
  manifests[2]!.breadcrumbs = [
    { name: manifests[0]!.content.title, url: `${siteIdentity.canonicalOrigin}/` },
    { name: manifests[1]!.content.title, url: `${siteIdentity.canonicalOrigin}/a` },
    { name: manifests[2]!.content.title, url: "" },
  ];
  manifests[3]!.breadcrumbs = [
    { name: manifests[0]!.content.title, url: `${siteIdentity.canonicalOrigin}/` },
    { name: manifests[3]!.content.title, url: "" },
  ];
  for (const manifest of manifests.slice(2)) {
    manifest.manifestDigest = deterministicDigest({ input: manifest.input, seo: manifest.seo, content: manifest.content, design: manifest.design, links: manifest.links, breadcrumbs: manifest.breadcrumbs, assets: manifest.assets });
  }
  const result = await runManifestBuild(manifests, "nested-routes");
  try {
    assert.deepEqual(result.routes.filter((route) => route !== "/404"), routes.sort());
    assert.match(await readFile(path.join(result.distDir, "a", "b", "index.html"), "utf8"), /RUN9_REAL_SCALE_2/);
    assert.match(await readFile(path.join(result.distDir, "a-b", "index.html"), "utf8"), /RUN9_REAL_SCALE_3/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test("REAL ASTRO DESIGN MUTATION: supported accepted design changes manifest and rendered CSS without changing copy", async () => {
  const first = manifestFor(0);
  const second: ProductionRenderManifest = structuredClone(first);
  second.design.acceptedId = "dacc-design-v2";
  second.design.acceptedVersion = 2;
  second.design.acceptedDigest = deterministicDigest({ design: "v2" });
  second.design.tokens.colors.primary = "#7a2e1d";
  second.design.tokens.spacing.lg = "48px";
  second.design.tokens.rounded.md = "20px";
  second.design.archetype.sectionPatterns = ["page-header", "service-overview", "cta"];
  second.design.archetype.rendererPrimitives = ["page-header", "narrative", "cta"];
  second.manifestDigest = deterministicDigest({ input: second.input, seo: second.seo, content: second.content, design: second.design, links: second.links, breadcrumbs: second.breadcrumbs, assets: second.assets });
  const [a, b] = [await runManifestBuild([first], "design-v1"), await runManifestBuild([second], "design-v2")];
  try {
    const [htmlA, htmlB] = await Promise.all([readFile(path.join(a.distDir, "index.html"), "utf8"), readFile(path.join(b.distDir, "index.html"), "utf8")]);
    assert.notEqual(first.manifestDigest, second.manifestDigest);
    assert.notEqual(a.digest, b.digest);
    assert.match(htmlA, /RUN9_REAL_SCALE_0 accepted introduction\./);
    assert.match(htmlB, /RUN9_REAL_SCALE_0 accepted introduction\./);
    assert.match(htmlA, /--design-primary:\s*#1a2e35/i);
    assert.match(htmlB, /--design-primary:\s*#7a2e1d/i);
    assert.notEqual(htmlA, htmlB);
  } finally { await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); }
});
