import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { captureIntegritySnapshot, compareIntegritySnapshots } from "../src/executor/integrity.js";
import { makeTempRepo } from "./helpers.js";

test("unchanged dependency baseline passes", async () => {
  const repo = await makeTempRepo();
  const dependency = path.join(repo, "node_modules", "pkg", "index.js");
  await mkdir(path.dirname(dependency), { recursive: true });
  await writeFile(dependency, "safe\n");
  const baseline = await captureIntegritySnapshot(repo);
  assert.deepEqual(compareIntegritySnapshots(baseline, await captureIntegritySnapshot(repo)), { passed: true, violations: [] });
});

test("new env and ignored configuration mutations fail", async () => {
  const repo = await makeTempRepo();
  const baseline = await captureIntegritySnapshot(repo);
  await writeFile(path.join(repo, ".env"), "PUBLIC_SITE_URL=https://attacker.invalid\n");
  const result = compareIntegritySnapshots(baseline, await captureIntegritySnapshot(repo));
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((value) => value.startsWith(".env:")));
});

test("dependency tampering fails", async () => {
  const repo = await makeTempRepo();
  const dependency = path.join(repo, "node_modules", "pkg", "index.js");
  await mkdir(path.dirname(dependency), { recursive: true });
  await writeFile(dependency, "safe\n");
  const baseline = await captureIntegritySnapshot(repo);
  await writeFile(dependency, "tampered\n");
  const result = compareIntegritySnapshots(baseline, await captureIntegritySnapshot(repo));
  assert.ok(result.violations.some((value) => value.includes("node_modules/pkg/index.js")));
});

test("Factory-owned build and QA outputs are excluded", async () => {
  const repo = await makeTempRepo();
  const baseline = await captureIntegritySnapshot(repo);
  for (const relative of ["sites/starter/dist/page.html", "sites/starter/test-results/result.json", "sites/starter/qa-artifacts/page.png"]) {
    const file = path.join(repo, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "generated");
  }
  assert.deepEqual(compareIntegritySnapshots(baseline, await captureIntegritySnapshot(repo)), { passed: true, violations: [] });
});

test("isFactoryOutput only matches exact anchored output roots", async () => {
  const { isFactoryOutput, TRUSTED_FACTORY_OUTPUT_ROOTS } = await import("../src/executor/integrity.js");

  // All defined trusted roots are present
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes(".factory"));
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes("sites/starter/dist"));
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes("sites/starter/.astro"));
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes("sites/starter/test-results"));
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes("sites/starter/playwright-report"));
  assert.ok(TRUSTED_FACTORY_OUTPUT_ROOTS.includes("sites/starter/qa-artifacts"));

  // Positives (exact root or child)
  assert.equal(isFactoryOutput(".factory"), true);
  assert.equal(isFactoryOutput(".factory/runs/123/task.json"), true);
  assert.equal(isFactoryOutput("sites/starter/dist"), true);
  assert.equal(isFactoryOutput("sites/starter/dist/index.html"), true);
  assert.equal(isFactoryOutput("sites/starter/.astro/types.d.ts"), true);
  assert.equal(isFactoryOutput("sites/starter/test-results/results.json"), true);
  assert.equal(isFactoryOutput("sites/starter/playwright-report/index.html"), true);
  assert.equal(isFactoryOutput("sites/starter/qa-artifacts/service.png"), true);

  // Negatives (nested in source or unanchored root names)
  assert.equal(isFactoryOutput("sites/starter/src/pages/services/dist/helper.ts"), false);
  assert.equal(isFactoryOutput("sites/starter/src/pages/services/.factory/hidden.ts"), false);
  assert.equal(isFactoryOutput("sites/starter/src/pages/services/qa-artifacts/helper.ts"), false);
  assert.equal(isFactoryOutput("sites/starter/src/pages/services/test-results/helper.ts"), false);
  assert.equal(isFactoryOutput("sites/starter/src/pages/services/playwright-report/helper.ts"), false);
  assert.equal(isFactoryOutput("dist/helper.ts"), false);
  assert.equal(isFactoryOutput("test-results/helper.ts"), false);
  assert.equal(isFactoryOutput("qa-artifacts/helper.ts"), false);
});

test("nested ignored file inside source tree is NOT excluded and triggers integrity violation", async () => {
  const repo = await makeTempRepo();
  const baseline = await captureIntegritySnapshot(repo);

  // An attacker creates an ignored nested helper in source
  const helper = path.join(repo, "sites", "starter", "src", "pages", "services", "dist", "helper.ts");
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(helper, "export const secret = 42;\n");

  // Force-ignore helper via git info/exclude to simulate an ignored nested source helper
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await writeFile(path.join(repo, ".git", "info", "exclude"), "sites/starter/src/pages/services/dist/\n", "utf8");

  const current = await captureIntegritySnapshot(repo);
  const comparison = compareIntegritySnapshots(baseline, current);

  assert.equal(comparison.passed, false);
  assert.ok(
    comparison.violations.some((v) => v.includes("sites/starter/src/pages/services/dist/helper.ts")),
    `Expected violation for nested helper, got: ${JSON.stringify(comparison.violations)}`,
  );
});

