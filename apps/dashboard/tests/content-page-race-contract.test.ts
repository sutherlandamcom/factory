import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Run 11 Remediation — ContentPage initial-load race contract test.
 *
 * ContentPage must never permit brief actions to submit before initial
 * /writer/workspace data has been loaded and adopted into the form.
 *
 * Invariants:
 *  1. Tracks initialWorkspaceLoaded state, initialized false and reset on projectId change.
 *  2. loadWorkspace sets initialWorkspaceLoaded true only after server brief values are adopted.
 *  3. Brief submission buttons and inputs are disabled/gated when !initialWorkspaceLoaded.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../src/pages/ContentPage.tsx"), "utf8");

test("content page: initialWorkspaceLoaded state exists and resets on project change", () => {
  assert.match(src, /const\s+\[initialWorkspaceLoaded,\s*setInitialWorkspaceLoaded\]\s*=\s*useState\(false\)/);
  assert.match(src, /setInitialWorkspaceLoaded\(false\)/);
});

test("content page: loadWorkspace sets initialWorkspaceLoaded only after form adoption", () => {
  const adoptionIdx = src.indexOf("ctaIntent: pt.ctaIntent");
  const loadedIdx = src.indexOf("setInitialWorkspaceLoaded(true)");
  assert.ok(adoptionIdx > 0, "expected form adoption to exist");
  assert.ok(loadedIdx > adoptionIdx, "expected initialWorkspaceLoaded to be set after form adoption");
});

test("content page: brief submit action is disabled until initial workspace is loaded and adopted", () => {
  assert.match(src, /disabled=\{busy\s*\|\|\s*!initialWorkspaceLoaded\}/);
  assert.match(src, /<fieldset[^>]*disabled=\{busy\s*\|\|\s*!initialWorkspaceLoaded\}/);
});
