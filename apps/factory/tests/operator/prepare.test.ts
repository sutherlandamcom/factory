import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  preparePageProductionExecution,
  executePreparedPageProduction,
  type PreparedPageProduction,
} from "../../src/operator/prepare.js";
import {
  makeGenericBlueprint,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "../fixtures/site-production-fixtures.js";
import { parseSiteTask } from "@factory/contracts";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import type { SiteProductionSpec } from "@factory/contracts";

/**
 * Preparation seam acceptance (Macro Run 1 Part I):
 *
 * accepted/resolved production inputs -> readiness -> page packet -> trusted
 * SiteTask projection -> digests -> execution eligibility.
 *
 * - Blocked input NEVER reaches execution (fail closed before the executor).
 * - Eligible input reaches the EXISTING executor boundary (injected spy here;
 *   no new executor, no live provider/model calls, zero paid spend).
 */

async function createMockInputRoot(): Promise<{ tempDir: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "operator-prepare-"));
  await mkdir(path.join(tempDir, "references"), { recursive: true });
  await mkdir(path.join(tempDir, "assets"), { recursive: true });
  await writeFile(path.join(tempDir, "references", "swiss-banking-annual-report.png"), "png");
  await writeFile(path.join(tempDir, "assets", "meridian-headquarters-exterior.jpg"), "jpg");
  await writeFile(path.join(tempDir, "assets", "meridian-mark.svg"), "<svg/>");
  return {
    tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test("prepare: eligible page yields digests, a re-parseable SiteTask, and eligibility", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const prepared = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: tempDir,
      sourceBlueprintRunId: "20260901T120000Z-abcd1234",
    });

    assert.equal(prepared.eligible, true, "generic fixture page must be eligible");
    assert.equal(prepared.ineligibleReason, undefined);
    assert.equal(prepared.pageReadiness.status, "READY");
    assert.match(prepared.packetDigest, /^[0-9a-f]{64}$/);
    assert.match(prepared.taskDigest, /^[0-9a-f]{64}$/);

    // The projected task must round-trip through the authoritative contract.
    const reparsed = parseSiteTask(JSON.parse(JSON.stringify(prepared.siteTask)));
    assert.equal(reparsed.type, "create_page");
    assert.equal(deterministicDigest(reparsed), prepared.taskDigest);
  } finally {
    await cleanup();
  }
});

test("prepare: digests are deterministic for identical inputs", async () => {
  const a = await createMockInputRoot();
  const b = await createMockInputRoot();
  try {
    const first = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: a.tempDir,
      sourceBlueprintRunId: "run-1",
    });
    const second = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: b.tempDir,
      sourceBlueprintRunId: "run-1",
    });
    assert.equal(first.packetDigest, second.packetDigest);
    assert.equal(first.taskDigest, second.taskDigest);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("prepare: unknown page slug fails closed", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    await assert.rejects(
      () =>
        preparePageProductionExecution({
          productionSpec: makeGenericProductionSpec(),
          blueprint: makeGenericBlueprint(),
          siteProfile: makeGenericSiteProfile(),
          pageSlug: "/does-not-exist",
          inputRoot: tempDir,
          sourceBlueprintRunId: "run-1",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /not found in production spec readiness/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("prepare: blocked page (missing required asset file) is ineligible with reasons", async () => {
  // An empty inputRoot means the required local reference/asset files do not
  // exist on disk -> readiness blockers -> BLOCKED -> ineligible.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "operator-prepare-empty-"));
  try {
    const prepared = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: tempDir,
      sourceBlueprintRunId: "run-1",
    });
    assert.equal(prepared.eligible, false);
    assert.equal(prepared.pageReadiness.status, "BLOCKED");
    assert.ok(prepared.ineligibleReason && prepared.ineligibleReason.length > 0);
    assert.match(prepared.ineligibleReason!, /readiness is BLOCKED/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execute: blocked input NEVER reaches the executor boundary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "operator-prepare-empty-"));
  try {
    const prepared = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: tempDir,
      sourceBlueprintRunId: "run-1",
    });
    assert.equal(prepared.eligible, false);

    let executorCalls = 0;
    await assert.rejects(
      () =>
        executePreparedPageProduction(
          prepared,
          { repoRoot: "/tmp/unused" } as never,
          async () => {
            executorCalls += 1;
            throw new Error("executor must never be called for blocked input");
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /readiness is BLOCKED/);
        return true;
      },
    );
    assert.equal(executorCalls, 0, "blocked input must fail closed before any execution");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execute: eligible input calls the EXISTING executor boundary exactly once with the digested task", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const prepared = await preparePageProductionExecution({
      productionSpec: makeGenericProductionSpec(),
      blueprint: makeGenericBlueprint(),
      siteProfile: makeGenericSiteProfile(),
      pageSlug: "/",
      inputRoot: tempDir,
      sourceBlueprintRunId: "run-1",
    });
    assert.equal(prepared.eligible, true);

    const receivedTasks: unknown[] = [];
    const receivedOpts: unknown[] = [];
    const result = await executePreparedPageProduction(
      prepared,
      { repoRoot: "/tmp/unused", marker: "opts" } as never,
      async (task, runOpts) => {
        receivedTasks.push(task);
        receivedOpts.push(runOpts);
        // Mock executor result mirroring the driver's response shape.
        return { viaInjectedExecutor: true, taskDigest: prepared.taskDigest } as never;
      },
    );

    assert.equal(receivedTasks.length, 1, "executor must be called exactly once");
    assert.equal((result as unknown as { viaInjectedExecutor: boolean }).viaInjectedExecutor, true);
    assert.deepEqual(receivedTasks[0], prepared.siteTask, "executor must receive the exact projected task");
    assert.equal(
      (receivedOpts[0] as { marker?: string }).marker,
      "opts",
      "executor must receive the caller's run options",
    );
  } finally {
    await cleanup();
  }
});

test("execute: injected executor is a seam, not a second executor implementation", async () => {
  // The production default path imports the existing persisted-run driver;
  // this is a structural check that the default remains wired to it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/operator/prepare.ts", import.meta.url), "utf8");
  assert.match(src, /runPersistedSiteTask/);
  assert.match(src, /persistence\/driver\.js/);
});
