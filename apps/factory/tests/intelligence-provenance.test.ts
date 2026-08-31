import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { INTELLIGENCE_METHODOLOGY_VERSION } from "@factory/contracts";
import type { ProcessResult } from "../src/executor/process.js";
import { gitIn, makeTempRepo } from "./helpers.js";
import { runIntelligence } from "../src/intelligence/driver.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import {
  fakeCodexRunner,
  loadFixtureRequestJson,
  loadFixtureResearchJson,
} from "./intelligence-fixtures.js";

const FIXED_NOW = new Date("2026-08-31T10:15:00Z");

async function successfulRunWithRunner(
  repoRoot: string,
  requestInput: unknown,
  researchInput: unknown,
  suffix = "abc12345",
  codexRunner?: unknown,
) {
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
    {
      now: () => FIXED_NOW,
      runIdSuffix: () => suffix,
      synthesisTimeoutMs: 5_000,
      codexRunner: (codexRunner ?? runner) as never,
    },
  );
}

async function successfulRun(repoRoot: string, requestInput: unknown, researchInput: unknown, suffix = "abc12345") {
  return successfulRunWithRunner(repoRoot, requestInput, researchInput, suffix);
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

test("nonignored dirty working tree fails closed BEFORE any model invocation", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  // Dirty a TRACKED file.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repoRoot, "uncommitted.txt"), "dirty", "utf8");
  const { runner, calls } = fakeCodexRunner({ outputs: [JSON.stringify({ hijacked: true })] });
  const result = await successfulRunWithRunner(repoRoot, JSON.stringify(request), JSON.stringify(research), "eeee0001", runner);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "intelligence_source_unverified");
  assert.match(result.error!.message, /nonignored uncommitted changes/);
  assert.equal(calls.length, 0, "model must never be invoked on unverified source provenance");
  // A failed provenance run must never publish a successful result.
  const intelligenceRoot = path.join(repoRoot, ".factory", "intelligence");
  const published = await readFile(
    path.join(intelligenceRoot, result.runId, "intelligence-result.json"),
    "utf8",
  ).catch(() => null);
  assert.ok(published === null || JSON.parse(published).status !== "succeeded");
  await rm(repoRoot, { recursive: true, force: true });
});

test("untracked nonignored files also fail closed source provenance", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(repoRoot, "notes"), { recursive: true });
  await writeFile(path.join(repoRoot, "notes", "untracked.txt"), "untracked", "utf8");
  const { runner, calls } = fakeCodexRunner({ outputs: [JSON.stringify({ hijacked: true })] });
  const result = await successfulRunWithRunner(repoRoot, JSON.stringify(request), JSON.stringify(research), "eeee0002", runner);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "intelligence_source_unverified");
  assert.equal(calls.length, 0);
  await rm(repoRoot, { recursive: true, force: true });
});

test("gitignored Factory runtime artifacts do not invalidate clean provenance", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const { mkdir, writeFile } = await import("node:fs/promises");
  // Pre-existing gitignored runtime state must not spurious-fail a clean source.
  await mkdir(path.join(repoRoot, ".factory", "agent"), { recursive: true });
  await writeFile(path.join(repoRoot, ".factory", "agent", "journal.json"), "{}", "utf8");
  const result = await successfulRun(repoRoot, JSON.stringify(request), JSON.stringify(research), "eeee0003");
  assert.equal(result.status, "succeeded", result.error?.message ?? "");
  assert.equal(result.factorySourceCommit, gitIn(repoRoot, ["rev-parse", "HEAD"]));
  await rm(repoRoot, { recursive: true, force: true });
});

test("unresolvable HEAD and unverifiable status fail closed; resolver failures map to source_unverified", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();

  const runWith = (resolver: (repoRoot: string) => Promise<unknown>) =>
    runIntelligence(
      { repoRoot, requestInput: JSON.stringify(request), researchInput: JSON.stringify(research) },
      {
        now: () => FIXED_NOW,
        runIdSuffix: () => "eeee0004",
        synthesisTimeoutMs: 5_000,
        sourceCommitResolver: resolver as never,
      },
    );

  const headFailure = await runWith(async () => ({ ok: false, reason: "HEAD commit could not be resolved via git" }));
  assert.equal(headFailure.status, "failed");
  assert.equal(headFailure.error?.code, "intelligence_source_unverified");
  assert.match(headFailure.error!.message, /HEAD commit could not be resolved/);

  const statusFailure = await runWith(async () => ({
    ok: false,
    reason: "working-tree cleanliness could not be verified via git",
  }));
  assert.equal(statusFailure.status, "failed");
  assert.equal(statusFailure.error?.code, "intelligence_source_unverified");

  // Resolver throwing (e.g. process abstraction crash) must also fail closed
  // under the provenance error code, never collapse into "clean".
  const throwingResolver = await runWith(async () => {
    throw new Error("git process abstraction exploded");
  });
  assert.equal(throwingResolver.status, "failed");
  assert.equal(throwingResolver.error?.code, "intelligence_source_unverified");
  assert.match(throwingResolver.error!.message, /could not be verified/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("resolveFactorySourceCommit itself fails closed on git failures, timeouts, and garbage output", async () => {
  const { resolveFactorySourceCommit } = await import("../src/intelligence/driver.js");
  const okResult: ProcessResult = { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" };

  // Happy path.
  const clean = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "a".repeat(40) + "\n" };
    return { ...okResult, stdout: "" };
  });
  assert.deepEqual(clean, { ok: true, commit: "a".repeat(40) });

  // HEAD resolution failure.
  const headFailed = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, exitCode: 128, stdout: "", stderr: "fatal" };
    return { ...okResult, stdout: "" };
  });
  assert.equal(headFailed.ok, false);
  assert.match((headFailed as { reason: string }).reason, /HEAD commit could not be resolved/);

  // HEAD timeout.
  const headTimeout = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, timedOut: true, stdout: "" };
    return { ...okResult, stdout: "" };
  });
  assert.equal(headTimeout.ok, false);

  // Garbage SHA (not exactly 40 hex chars).
  const garbageSha = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "not-a-sha\n" };
    return { ...okResult, stdout: "" };
  });
  assert.equal(garbageSha.ok, false);
  assert.match((garbageSha as { reason: string }).reason, /exact commit SHA/);

  // git status failure fails closed (never maps to clean).
  const statusFailed = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "a".repeat(40) + "\n" };
    return { ...okResult, exitCode: 1, stdout: "", stderr: "fatal" };
  });
  assert.equal(statusFailed.ok, false);
  assert.match((statusFailed as { reason: string }).reason, /cleanliness could not be verified/);

  // git status timeout fails closed.
  const statusTimeout = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "a".repeat(40) + "\n" };
    return { ...okResult, timedOut: true, stdout: "" };
  });
  assert.equal(statusTimeout.ok, false);

  // git status throwing fails closed.
  const statusThrows = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "a".repeat(40) + "\n" };
    throw new Error("spawn failure");
  });
  assert.equal(statusThrows.ok, false);

  // Dirty output fails closed.
  const dirty = await resolveFactorySourceCommit("/repo", async (args) => {
    if (args.includes("rev-parse")) return { ...okResult, stdout: "a".repeat(40) + "\n" };
    return { ...okResult, stdout: " M src/changed.ts\n?? notes/untracked.txt\n" };
  });
  assert.equal(dirty.ok, false);
  assert.match((dirty as { reason: string }).reason, /nonignored uncommitted changes/);
});
