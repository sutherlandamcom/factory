import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exampleSiteTask } from "@factory/contracts";
import { verifyCreatePage } from "../src/executor/verify.js";

async function makeSiteDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "factory-verify-"));
}

function validHtml(overrides: { title?: string; h1?: string; description?: string; canonical?: string; extra?: string } = {}) {
  return `<!doctype html><html><head><title>${overrides.title ?? "Roof Repair | Summit Roofing Co."}</title><meta name="description" content="${overrides.description ?? exampleSiteTask.page.description}"><link href="${overrides.canonical ?? "https://test.example.com/services/roof-repair/"}" rel="canonical"></head><body><main><h1>${overrides.h1 ?? "Roof Repair"}</h1><p>Meaningful content</p></main>${overrides.extra ?? ""}</body></html>`;
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
  await writeBuiltPage(dir, validHtml({ title: "Roof &amp; Gutter Repair | Summit Roofing Co.", h1: "Roof &amp; Gutter Repair" }));
  assert.equal((await verifyCreatePage(dir, task)).passed, true);
});
