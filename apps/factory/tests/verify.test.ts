import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exampleSiteTask, parseSiteProfile } from "@factory/contracts";
import { verifyCreatePage } from "../src/executor/verify.js";

// Demo profile fixture mirrors the repository-owned starter profile; the
// suffix in the built-page fixtures derives from it (single identity source).
const demoProfile = parseSiteProfile({
  version: "v0",
  siteId: "starter",
  siteName: "Summit Roofing Co.",
  canonicalOrigin: "http://localhost:4321",
  language: "en",
  navigation: [{ label: "Home", targetSlug: "/" }],
});

async function makeSiteDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "factory-verify-"));
  // verifyCreatePage loads site identity from the worktree's SiteProfile; the
  // fixture mirrors the repository-owned demo profile.
  const profileDir = path.join(dir, "sites", "starter");
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, "site-profile.json"), JSON.stringify(demoProfile), "utf8");
  return dir;
}

function validHtml(overrides: { title?: string; h1?: string; description?: string; canonical?: string; extra?: string } = {}) {
  return `<!doctype html><html><head><title>${overrides.title ?? `Roof Repair | ${demoProfile.siteName}`}</title><meta name="description" content="${overrides.description ?? exampleSiteTask.page.description}"><link href="${overrides.canonical ?? "https://test.example.com/services/roof-repair/"}" rel="canonical"></head><body><main><h1>${overrides.h1 ?? "Roof Repair"}</h1><p>Meaningful content</p></main>${overrides.extra ?? ""}</body></html>`;
}

async function writeBuiltPage(dir: string, html: string) {
  const pageDir = path.join(dir, "sites", "starter", "dist", "services", "roof-repair");
  await mkdir(pageDir, { recursive: true });
  await writeFile(path.join(pageDir, "index.html"), html);
}

test("semantic verification passes exact title, H1, description, and canonical", async () => {
  const dir = await makeSiteDir();
  await writeBuiltPage(dir, validHtml());
  assert.equal((await verifyCreatePage(dir, exampleSiteTask)).passed, true);
});

test("missing built route fails", async () => {
  const result = await verifyCreatePage(await makeSiteDir(), exampleSiteTask);
  assert.equal(result.passed, false);
  assert.match(result.details, /requirement=route/);
});

test("missing or invalid SiteProfile fails closed", async () => {
  const missing = await mkdtemp(path.join(os.tmpdir(), "factory-verify-noprofile-"));
  await writeBuiltPage(missing, validHtml());
  const result = await verifyCreatePage(missing, exampleSiteTask);
  assert.equal(result.passed, false);
  assert.match(result.details, /site_profile/);

  const invalid = await makeSiteDir();
  await writeFile(path.join(invalid, "sites", "starter", "site-profile.json"), '{"version":"v0"}', "utf8");
  await writeBuiltPage(invalid, validHtml());
  const invalidResult = await verifyCreatePage(invalid, exampleSiteTask);
  assert.equal(invalidResult.passed, false);
  assert.match(invalidResult.details, /site_profile/);
});

for (const [name, html, requirement] of [
  ["wrong title", validHtml({ title: "Wrong" }), "title"],
  ["wrong H1", validHtml({ h1: "Wrong" }), "h1"],
  ["wrong description", validHtml({ description: "Wrong" }), "description"],
  ["wrong canonical origin", validHtml({ canonical: "https://evil.invalid/services/roof-repair/" }), "canonical"],
  ["wrong canonical path", validHtml({ canonical: "https://test.example.com/services/wrong/" }), "canonical"],
] as const) {
  test(`${name} fails semantic verification`, async () => {
    const dir = await makeSiteDir();
    await writeBuiltPage(dir, html);
    const result = await verifyCreatePage(dir, exampleSiteTask);
    assert.equal(result.passed, false);
    assert.match(result.details, new RegExp(`requirement=${requirement}`));
  });
}

for (const [location, extra] of [
  ["comment", "<!-- Roof Repair -->"],
  ["footer", "<footer>Roof Repair</footer>"],
  ["script", '<script>const title = "Roof Repair"</script>'],
  ["JSON", '<script type="application/json">{"title":"Roof Repair"}</script>'],
  ["body", "<p>Roof Repair</p>"],
] as const) {
  test(`task title appearing only in ${location} does not satisfy title or H1`, async () => {
    const dir = await makeSiteDir();
    await writeBuiltPage(dir, validHtml({ title: "Wrong", h1: "Wrong", extra }));
    assert.equal((await verifyCreatePage(dir, exampleSiteTask)).passed, false);
  });
}

test("duplicate H1 and duplicate metadata fail", async () => {
  const dir = await makeSiteDir();
  await writeBuiltPage(
    dir,
    validHtml().replace("</main>", "<h1>Roof Repair</h1></main>").replace("</head>", `<meta name="description" content="${exampleSiteTask.page.description}"></head>`),
  );
  const result = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(result.passed, false);
  assert.match(result.details, /h1-count|description-count/);
});

test("HTML entities are decoded before exact comparison", async () => {
  const dir = await makeSiteDir();
  const task = { ...exampleSiteTask, page: { ...exampleSiteTask.page, title: "Roof & Gutter Repair" } };
  await writeBuiltPage(dir, validHtml({ title: `Roof &amp; Gutter Repair | ${demoProfile.siteName}`, h1: "Roof &amp; Gutter Repair" }));
  assert.equal((await verifyCreatePage(dir, task)).passed, true);
});

test("profile identity drives the expected title suffix", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "factory-verify-profile-"));
  const profileDir = path.join(dir, "sites", "starter");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, "site-profile.json"),
    JSON.stringify(
      parseSiteProfile({
        version: "v0",
        siteId: "acme",
        siteName: "Acme Anvils",
        canonicalOrigin: "https://acme.example.com",
        language: "en",
        navigation: [{ label: "Home", targetSlug: "/" }],
      }),
    ),
    "utf8",
  );
  await writeBuiltPage(dir, validHtml({ title: "Roof Repair | Acme Anvils" }));
  assert.equal((await verifyCreatePage(dir, exampleSiteTask)).passed, true);
});
