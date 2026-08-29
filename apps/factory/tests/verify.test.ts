import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exampleSiteTask } from "@factory/contracts";
import { verifyCreatePage } from "../src/executor/verify.js";

async function makeSiteDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "factory-verify-"));
}

test("create_page verification passes when dist HTML exists with the title and canonical URL", async () => {
  const dir = await makeSiteDir();
  const pageDir = path.join(dir, "sites", "starter", "dist", "services", "roof-repair");
  await mkdir(pageDir, { recursive: true });
  await writeFile(
    path.join(pageDir, "index.html"),
    '<html><head><title>Roof Repair</title><link rel="canonical" href="https://example.com/services/roof-repair/"></head><body><h1>Roof Repair</h1></body></html>',
  );
  const result = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(result.passed, true);
});

test("create_page verification fails when dist HTML is missing", async () => {
  const dir = await makeSiteDir();
  const result = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(result.passed, false);
  assert.match(result.details, /missing/);
});

test("create_page verification fails when the title is absent from the HTML", async () => {
  const dir = await makeSiteDir();
  const pageDir = path.join(dir, "sites", "starter", "dist", "services", "roof-repair");
  await mkdir(pageDir, { recursive: true });
  await writeFile(
    path.join(pageDir, "index.html"),
    '<html><head><link rel="canonical" href="https://example.com/services/roof-repair/"></head><body><h1>Something Else</h1></body></html>',
  );
  const result = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(result.passed, false);
  assert.match(result.details, /does not contain the SiteTask title/);
});

test("create_page verification fails when canonical link is missing or incorrect", async () => {
  const dir = await makeSiteDir();
  const pageDir = path.join(dir, "sites", "starter", "dist", "services", "roof-repair");
  await mkdir(pageDir, { recursive: true });
  await writeFile(
    path.join(pageDir, "index.html"),
    '<html><head><title>Roof Repair</title></head><body><h1>Roof Repair</h1></body></html>',
  );
  const missingCanonical = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(missingCanonical.passed, false);
  assert.match(missingCanonical.details, /missing canonical/);

  await writeFile(
    path.join(pageDir, "index.html"),
    '<html><head><title>Roof Repair</title><link rel="canonical" href="https://example.com/wrong-path/"></head><body><h1>Roof Repair</h1></body></html>',
  );
  const wrongCanonical = await verifyCreatePage(dir, exampleSiteTask);
  assert.equal(wrongCanonical.passed, false);
  assert.match(wrongCanonical.details, /canonical href/);
});
