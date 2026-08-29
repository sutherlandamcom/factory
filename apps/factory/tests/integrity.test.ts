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
