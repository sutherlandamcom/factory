import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Run 11 §91 — routing contract tests (static).
 *
 * Pins the required route structure, the /projects/:projectId → overview
 * redirect, deep-linkable areas, and the removal of the old 25-tab shell.
 * Runtime router behavior is covered by the Playwright E2E journeys.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(path.join(here, "../src/App.tsx"), "utf8");

test("router: required project workspace routes exist", () => {
  for (const area of [
    "overview",
    "intake",
    "research",
    "content",
    "assets",
    "design",
    "production",
    "qa",
    "versions",
    "costs",
    "deployment",
  ]) {
    assert.match(appSrc, new RegExp(`path="${area}"`), `missing route: ${area}`);
  }
});

test("router: /projects/:projectId redirects to overview", () => {
  assert.match(appSrc, /<Route index element=\{<Navigate to="overview" replace \/>\} \/>/);
});

test("router: deep links are URL-addressable (no manual view state)", () => {
  assert.match(appSrc, /<Routes>/);
  assert.doesNotMatch(appSrc, /useState<"projects" \| "detail">/);
});

test("router: the 25-tab ProjectDetailPage shell is gone", () => {
  let exists = false;
  try {
    readFileSync(path.join(here, "../src/pages/ProjectDetailPage.tsx"));
    exists = true;
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "ProjectDetailPage.tsx must be removed (§75)");
});

test("router: navigation is link-based with aria-current, not click-only divs", () => {
  const layout = readFileSync(path.join(here, "../src/layouts/ProjectWorkspaceLayout.tsx"), "utf8");
  assert.match(layout, /NavLink/);
  assert.match(layout, /aria-current/);
  assert.match(layout, /aria-label="Project areas"/);
});
