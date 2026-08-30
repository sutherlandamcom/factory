import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** This file lives at <repo>/apps/factory/tests/, so the repo root is three levels up. */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const wranglerConfigPath = path.join(repoRoot, "sites", "starter", "wrangler.jsonc");

/** Tolerant JSONC parse: strip line/block comments and trailing commas, then parse. */
function parseJsonc(raw: string): Record<string, unknown> {
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(withoutTrailingCommas) as Record<string, unknown>;
}

function objectField(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.ok(!Array.isArray(value), `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

test("Workers static assets target keeps its build directory", async () => {
  const config = parseJsonc(await readFile(wranglerConfigPath, "utf8"));
  const assets = objectField(config.assets, "assets");
  assert.equal(assets.directory, "./dist");
});

test("Unknown routes serve the generated 404 page with HTTP 404, not an SPA fallback", async () => {
  const config = parseJsonc(await readFile(wranglerConfigPath, "utf8"));
  const assets = objectField(config.assets, "assets");
  assert.equal(assets.not_found_handling, "404-page");
  assert.notEqual(assets.not_found_handling, "single-page-application");
  assert.equal("serve_single_page_app" in assets, false);
});

test("Version preview URLs stay enabled so delivery preview QA can reach uploads", async () => {
  const config = parseJsonc(await readFile(wranglerConfigPath, "utf8"));
  assert.equal(config.preview_urls, true);
});
