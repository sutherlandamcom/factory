import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { INTELLIGENCE_METHODOLOGY_VERSION } from "@factory/contracts";
import { gitIn, makeTempRepo } from "./helpers.js";
import { runIntelligence } from "../src/intelligence/driver.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import {
  fakeCodexRunner,
  loadFixtureRequestJson,
  loadFixtureResearchJson,
} from "./intelligence-fixtures.js";

const FIXED_NOW = new Date("2026-08-31T10:15:00Z");

async function successfulRun(repoRoot: string, requestInput: unknown, researchInput: unknown, suffix = "abc12345") {
  const plan = JSON.stringify(
    await (async () => {
      const request = await loadFixtureRequestJson();
      const research = await loadFixtureResearchJson();
      const { makeValidPlan } = await import("./intelligence-fixtures.js");
      return makeValidPlan(request, research);
    })(),
  );
  const { runner } = fakeCodexRunner({ outputs: [plan] });
  return runIntelligence(
    { repoRoot, requestInput, researchInput },
    { now: () => FIXED_NOW, runIdSuffix: () => suffix, synthesisTimeoutMs: 5_000, codexRunner: runner },
  );
}

test("result and manifest record full provenance bound to the exact source commit", async () => {
  const repoRoot = await makeTempRepo();
  const head = gitIn(repoRoot, ["rev-parse", "HEAD"]);
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const result = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research));

  assert.equal(result.status, "succeeded", result.error?.message ?? "");
  assert.equal(result.factorySourceCommit, head);
  assert.equal(result.methodologyVersion, INTELLIGENCE_METHODOLOGY_VERSION);
  assert.equal(result.siteId, "summit-roofing");
  assert.ok(result.modelRuntime);
  assert.equal(result.modelRuntime!.provider, "openai");
  assert.equal(result.modelRuntime!.runtime, "codex-cli");

  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, ".factory", "intelligence", result.runId, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.factorySourceCommit, result.factorySourceCommit);
  assert.equal(manifest.methodologyVersion, result.methodologyVersion);
  assert.equal(manifest.requestDigest, result.requestDigest);
  assert.equal(manifest.researchDigest, result.researchDigest);
  assert.equal(manifest.planDigest, result.planDigest);
  await rm(repoRoot, { recursive: true, force: true });
});

test("plan file canonical digest equals planDigest; digests bind to this run", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const result = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research));
  const planRaw = await readFile(
    path.join(repoRoot, ".factory", "intelligence", result.runId, "site-intelligence.json"),
    "utf8",
  );
  assert.equal(deterministicDigest(JSON.parse(planRaw)), result.planDigest);
  await rm(repoRoot, { recursive: true, force: true });
});

test("changing request content changes requestDigest but not researchDigest", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const first = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "aaaa0001");
  const changedRequest = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  (changedRequest.business as Record<string, unknown>).name = "Summit Roofing Partners LLC";
  const second = await successfulRun(repoRoot, JSON.stringify(changedRequest), JSON.stringify(research), "aaaa0002");
  assert.notEqual(first.requestDigest, second.requestDigest);
  assert.equal(first.researchDigest, second.researchDigest);
  await rm(repoRoot, { recursive: true, force: true });
});

test("changing evidence changes researchDigest", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const first = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "bbbb0001");
  const changed = JSON.parse(JSON.stringify(research)) as Record<string, unknown>;
  (changed.items as { id: string; text?: string }[])[0]!.text = "Mutated evidence observation.";
  const second = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(changed), "bbbb0002");
  assert.notEqual(first.researchDigest, second.researchDigest);
  await rm(repoRoot, { recursive: true, force: true });
});

test("runId and timestamps never leak into deterministic digests", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const first = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "cccc0001");
  const second = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "cccc0002");
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.requestDigest, second.requestDigest);
  assert.equal(first.researchDigest, second.researchDigest);
  assert.equal(first.planDigest, second.planDigest);
  await rm(repoRoot, { recursive: true, force: true });
});

test("model runtime provenance is truthful: no model event means model is null", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const plan = JSON.stringify(
    await (async () => {
      const { makeValidPlan } = await import("./intelligence-fixtures.js");
      return makeValidPlan(request, research);
    })(),
  );
  const { runner } = fakeCodexRunner({
    outputs: [plan],
    stdout: `${JSON.stringify({ type: "thread.started" })}\n`,
  });
  const result = await runIntelligence(
    { repoRoot, requestInput: JSON.stringify(request), researchInput: JSON.stringify(research) },
    { now: () => FIXED_NOW, runIdSuffix: () => "dddd0001", synthesisTimeoutMs: 5_000, codexRunner: runner },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.modelRuntime!.model, null);
  await rm(repoRoot, { recursive: true, force: true });
});

test("working-tree dirtiness is surfaced as a warning without breaking provenance", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  // Dirty the tree.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repoRoot, "uncommitted.txt"), "dirty", "utf8");
  const result = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "eeee0001");
  assert.equal(result.status, "succeeded", result.error?.message ?? "");
  assert.ok(result.warnings.some((warning) => warning.includes("uncommitted changes")));
  await rm(repoRoot, { recursive: true, force: true });
});
