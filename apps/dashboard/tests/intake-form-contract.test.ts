import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Run 11 §90 — intake dirty-state safety (static-analysis contract test).
 *
 * The IntakePage binds server values ONLY through explicit authority
 * transitions. These assertions pin the implementation contract that:
 *  1. RHF `values` is NOT reactive (background refetch cannot clobber).
 *  2. reset() is called only on adoption transitions (initial load,
 *     project change, successful save, explicit reload).
 *  3. The stale-revision conflict renders a banner with an explicit
 *     "Reload latest server draft" action.
 *
 * A full behavioral React test would need a DOM test runner the dashboard
 * does not have; these guards keep the contract visible and checkable
 * until such a runner is adopted.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../src/pages/IntakePage.tsx"), "utf8");

test("intake: form values are not reactively bound to server data", () => {
  // values: undefined — the RHF reactive binding is deliberately unused.
  assert.match(src, /values:\s*undefined/);
});

test("intake: reset happens only on adoption transitions", () => {
  const resets = [...src.matchAll(/form\.reset\(/g)].length;
  // One inside the adoption effect, one after successful save, one in the
  // explicit conflict reload handler. Exactly these three transitions.
  assert.ok(resets === 3, `expected 3 reset() call sites, found ${resets}`);
  assert.match(src, /adoptedRevisionRef/);
});

test("intake: stale revision conflict shows a reload action, never silent overwrite", () => {
  assert.match(src, /intake_stale_revision/);
  assert.match(src, /intake_revision_mismatch|intake_digest_mismatch/);
  assert.match(src, /Reload latest server draft/);
  assert.match(src, /role="alert"/);
});

test("intake: no `form: any` remains as the central form model", () => {
  // The comment mentioning the banned pattern is fine; actual usage is not.
  assert.doesNotMatch(src, /form:\s*any[,;)]/);
  assert.match(src, /useForm<IntakeForm>/);
});
