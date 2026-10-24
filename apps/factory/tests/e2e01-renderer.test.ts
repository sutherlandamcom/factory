import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { parse } from "node-html-parser";
import { createIsolatedProductionRoot } from "./fixtures/project-site-binding.js";
import { computeRenderManifestDigest, assertManifest, type ProductionRenderManifest } from "../src/production/render-manifest.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { loadProjectSiteBinding } from "../src/production/site-binding.js";
import { validateContentIntegrity } from "../src/production/qa/content-integrity.js";
import { computeArtifactDigest } from "../src/production/build-service.js";
import type { SiteProfile } from "@factory/contracts";
const exec = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "../../..");

/** Renderer fixtures prove output mechanics, not live provider authority or human acceptance. */
for (const company of ["Sutherland", "Stark"]) {
  test(`E2E-P0-01/P1-03 renderer fixture: isolated ${company} build and keyboard-actionable CTA`, { timeout: 300_000 }, async () => {
    const root = await createIsolatedProductionRoot(sourceRoot);
    const repositorySha = (await exec("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
    const sourceWorkingTreeClean = !(await exec("git", ["status", "--porcelain"], { cwd: sourceRoot })).stdout.trim();
    const russian = company === "Stark";
    const projectKey = company.toLowerCase();
    const identity = { siteName: russian ? "Stark Engineering" : "Sutherland Private Office", language: russian ? "ru-RU" : "en", locale: russian ? "ru-RU" : "en-GB", candidateDomain: russian ? "stark.example.test" : "sutherlandam.com" };
    const profile: SiteProfile = { version: "v0", siteId: projectKey, siteName: identity.siteName, canonicalOrigin: `https://${identity.candidateDomain}`, language: identity.language, navigation: [{ label: "Home", targetSlug: "/" }, { label: "Contact", targetSlug: "/contact" }] };
    const binding = { version: "project-site-binding-v1", projectKey, siteKey: projectKey, profileDigest: deterministicDigest(profile), acceptedSiteIdentityDigest: deterministicDigest(identity), delivery: { workerName: `fixture-${projectKey}`, productionUrl: `https://${projectKey}.example.test` } };
    await writeFile(path.join(root, "sites/starter/site-profile.json"), JSON.stringify(profile));
    await writeFile(path.join(root, "sites/starter/project-site-binding.json"), JSON.stringify(binding));
    const verified = await loadProjectSiteBinding(root, profile, { projectKey, siteKey: projectKey, acceptedSiteIdentity: identity });
    const manifestDir = path.join(root, "fixture-manifests"); const dist = path.join(root, "fixture-dist");
    await mkdir(manifestDir);
    const manifests: ProductionRenderManifest[] = [];
    for (const route of ["/", "/contact"]) {
      const fixture = JSON.parse(await readFile(path.join(sourceRoot, "sites/starter/tests/fixtures/run9-root.json"), "utf8")) as ProductionRenderManifest;
      fixture.input.id = `fixture-${projectKey}-${route === "/" ? "home" : "contact"}`;
      fixture.input.projectId = `fixture-${projectKey}`; fixture.input.route = route; fixture.input.pageIdentity = route;
      fixture.input.siteIdentity = { siteId: profile.siteId, siteName: profile.siteName, language: profile.language, canonicalOrigin: profile.canonicalOrigin, profileDigest: binding.profileDigest, bindingDigest: verified.bindingDigest };
      fixture.content.title = russian ? (route === "/" ? "Модернизация промышленного производства" : "Обсудить производственную задачу") : (route === "/" ? "Independent advisory" : "Contact the advisory team");
      fixture.content.introduction = russian ? "Изолированный тестовый пример для проверки производственного рендерера." : "An isolated renderer fixture with no live publication authority.";
      fixture.content.cta = russian ? "Обсудить производственную задачу" : "Discuss an advisory question";
      fixture.seo.fullTitle = `${fixture.content.title} | ${profile.siteName}`;
      fixture.seo.ogTitle = fixture.seo.fullTitle;
      fixture.seo.description = `${fixture.content.introduction} ${route}`;
      fixture.content.metaDescription = fixture.seo.description; fixture.seo.ogDescription = fixture.seo.description;
      fixture.content.acceptedDigest = deterministicDigest(fixture.content);
      fixture.seo.canonicalUrl = new URL(route, profile.canonicalOrigin).href; fixture.seo.ogUrl = fixture.seo.canonicalUrl;
      fixture.input.acceptedContent = { id: fixture.content.acceptedId, version: fixture.content.acceptedVersion, digest: fixture.content.acceptedDigest };
      fixture.conversion = { projectId: fixture.input.projectId, acceptedInput: { id: "fixture-input", version: 1, digest: "e".repeat(64) }, acceptedContentDigest: fixture.content.acceptedDigest, ctaText: fixture.content.cta, mode: "action", href: "/contact" };
      fixture.navigation = profile.navigation;
      fixture.manifestDigest = computeRenderManifestDigest(fixture);
      assertManifest(fixture);
      await writeFile(path.join(manifestDir, `${fixture.input.id}.json`), JSON.stringify(fixture));
      manifests.push(fixture);
    }
    await exec("pnpm", ["run", "build"], { cwd: path.join(root, "sites/starter"), timeout: 180_000, maxBuffer: 4_000_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir, FACTORY_PRODUCTION_OUT_DIR: dist, FACTORY_PRODUCTION_SITE_PROFILE_DIGEST: binding.profileDigest, PUBLIC_SITE_URL: profile.canonicalOrigin } }).catch(error => { throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`); });
    const html = await readFile(path.join(dist, "index.html"), "utf8");
    const dom = parse(html);
    assert.equal(dom.querySelector("html")?.getAttribute("lang"), identity.language);
    assert.equal(dom.querySelector("title")?.text, manifests[0]!.seo.fullTitle);
    assert.equal(dom.querySelector('link[rel="canonical"]')?.getAttribute("href"), `${profile.canonicalOrigin}/`);
    assert.equal(dom.querySelector('nav[aria-label="Primary"]')?.querySelectorAll('a[href="/contact"]').length, 1);
    assert.ok(dom.querySelectorAll('script[type="application/ld+json"]').some(node => node.text.includes(profile.siteName)));
    const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes(`${profile.canonicalOrigin}/contact`));
    assert.ok(!sitemap.includes(russian ? "sutherlandam.com" : "stark.example.test"));
    assert.equal(validateContentIntegrity({ route: "/", html, manifest: manifests[0]! }).checks.find(c => c.checkId === "content.cta_intent")?.verdict, "PASS");
    const server = http.createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const file = path.resolve(dist, `.${pathname}`, pathname.endsWith("/") || !path.extname(pathname) ? "index.html" : "");
        if (!file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
        response.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
        response.end(await readFile(file));
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      const cta = page.locator('[data-component="page-cta"] a');
      assert.equal(await cta.textContent(), manifests[0]!.content.cta);
      await cta.focus(); await cta.press("Enter");
      assert.equal(new URL(page.url()).pathname, "/contact");
      const evidence = path.join(sourceRoot, ".factory/e2e01/renderer", projectKey);
      await mkdir(evidence, { recursive: true });
      await cp(dist, path.join(evidence, "dist"), { recursive: true });
      await writeFile(path.join(evidence, "evidence.json"), JSON.stringify({ classification: "SYNTHETIC_RENDERER_FIXTURE_NOT_PUBLICATION_AUTHORITY", projectKey, profile, bindingDigest: verified.bindingDigest, manifestDigests: manifests.map(m => m.manifestDigest), repositorySha, sourceWorkingTreeClean, artifactDigest: await computeArtifactDigest(dist), htmlPath: path.join(evidence, "dist/index.html"), rendererAssertions: "PASS", keyboardNavigation: "/contact", productionQaVerdict: "NOT_RUN_FIXTURE_ONLY" }, null, 2));
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
