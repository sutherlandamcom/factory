import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEditorialQa } from "../src/writer/qa.js";
import type { PageContentProposalData } from "@factory/contracts";

/**
 * Run 4.1 W4 — editorial.vale_style (E7) hermetic tests.
 *
 * A stub "vale binary" (node script) is written to a tmpdir and pointed at via
 * FACTORY_VALE_BIN. No real Vale binary is required; these tests never touch
 * the network.
 */

const BRIEF = {
  lineage: {
    acceptedInputSnapshotId: "s",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    writerPolicyId: "p",
    writerPolicyVersion: 1,
    writerPolicyDigest: "b".repeat(64),
    gapSnapshotId: "g",
    gapSnapshotVersion: 1,
    gapSnapshotDigest: "c".repeat(64),
  },
  pageTarget: {
    route: "roof-replacement",
    title: "Roof Replacement in Denver",
    ctaIntent: "request a quote",
    structureGuidance: ["What a full roof replacement includes"],
  },
  allowedClaims: ["Licensed and insured"],
  prohibitedClaims: [],
  unknownClaims: [],
  operatorFacts: [],
  searchSemantics: {
    primaryIntent: "roof replacement",
    semanticCoverageRequirements: [],
    userNeeds: [],
  },
  contentBriefKeyPoints: [],
  noGapLineageAcknowledged: false,
} as never;

const POLICY = {
  forbiddenTerminology: [],
  aiLanguageAvoidance: [],
  clicheAvoidance: [],
  localePreferences: "US English",
};

function proposal(): PageContentProposalData {
  return {
    schemaVersion: "writer-content-v1",
    snapshotId: "s",
    snapshotVersion: 1,
    snapshotDigest: "a".repeat(64),
    title: "Roof Replacement in Denver",
    metaDescription: "Licensed Denver roof replacement with a limited warranty.",
    introduction: "Denver roofs face hail and freeze-thaw stress.",
    sections: [{ heading: "Process", body: "Licensed crews handle permits and disposal." }],
    conclusion: "Comparing roofers is straightforward with clear facts.",
    cta: "Book a free roof inspection today.",
    internalLinks: [],
  } as PageContentProposalData;
}

/** Write a stub executable that prints the given stdout. */
function stubVale(stdout: string, opts: { exitCode?: number; crash?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "vale-stub-"));
  const bin = join(dir, "vale-stub.mjs");
  const script = opts.crash
    ? "process.exit(2);"
    : `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${opts.exitCode ?? 0});`;
  writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

function valeCheck(checks: ReturnType<typeof runEditorialQa>) {
  return checks.find((c) => c.checkId === "editorial.vale_style");
}

const dirs: string[] = [];
function tracked<T>(value: string, fn: () => T): T {
  dirs.push(value);
  return fn();
}
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("vale: stub emits alerts JSON → REVIEW with mapped evidence", () => {
  const alerts = JSON.stringify({
    "body.txt": [
      { Check: "write-good.Weasel", Line: 1, Severity: "suggestion", Message: "this may be weasel wording" },
      { Check: "write-good.Passive", Line: 2, Severity: "suggestion", Message: "may be passive voice" },
    ],
  });
  const bin = stubVale(alerts);
  tracked(join(bin, ".."), () =>
    withEnv({ FACTORY_VALE_BIN: bin }, () => {
      const checks = runEditorialQa(proposal(), BRIEF, POLICY);
      const e7 = valeCheck(checks);
      assert.ok(e7, "E7 must be present when FACTORY_VALE_BIN is set");
      assert.equal(e7!.verdict, "REVIEW");
      assert.match(e7!.detail, /Vale style lint: 2 finding\(s\) \(advisory\)\./);
      assert.equal(e7!.evidence.length, 2);
      assert.equal(e7!.evidence[0]!.kind, "section");
      assert.match(e7!.evidence[0]!.ref, /^L1: this may be weasel wording \[write-good\.Weasel\]$/);
      assert.match(e7!.evidence[1]!.ref, /^L2: may be passive voice \[write-good\.Passive\]$/);
    }),
  );
});

test("vale: stub emits {} → PASS with no evidence", () => {
  const bin = stubVale("{}");
  tracked(join(bin, ".."), () =>
    withEnv({ FACTORY_VALE_BIN: bin }, () => {
      const checks = runEditorialQa(proposal(), BRIEF, POLICY);
      const e7 = valeCheck(checks);
      assert.ok(e7, "E7 must be present when FACTORY_VALE_BIN is set");
      assert.equal(e7!.verdict, "PASS");
      assert.deepEqual(e7!.evidence, []);
    }),
  );
});

test("vale: nonexistent binary path → loud degradation REVIEW", () => {
  withEnv({ FACTORY_VALE_BIN: "/nonexistent/vale/binary/path" }, () => {
    const checks = runEditorialQa(proposal(), BRIEF, POLICY);
    const e7 = valeCheck(checks);
    assert.ok(e7, "degradation check must be emitted when configured but broken");
    assert.equal(e7!.verdict, "REVIEW");
    assert.equal(e7!.detail, "Vale configured but unavailable/unparseable — style lint degraded.");
  });
});

test("vale: stub emits garbage → loud degradation REVIEW", () => {
  const bin = stubVale("this is not json at all");
  tracked(join(bin, ".."), () =>
    withEnv({ FACTORY_VALE_BIN: bin }, () => {
      const checks = runEditorialQa(proposal(), BRIEF, POLICY);
      const e7 = valeCheck(checks);
      assert.ok(e7);
      assert.equal(e7!.verdict, "REVIEW");
      assert.equal(e7!.detail, "Vale configured but unavailable/unparseable — style lint degraded.");
    }),
  );
});

test("vale: stub crashes (nonzero exit, no stdout) → loud degradation REVIEW", () => {
  const bin = stubVale("", { crash: true });
  tracked(join(bin, ".."), () =>
    withEnv({ FACTORY_VALE_BIN: bin }, () => {
      const checks = runEditorialQa(proposal(), BRIEF, POLICY);
      const e7 = valeCheck(checks);
      assert.ok(e7);
      assert.equal(e7!.verdict, "REVIEW");
      assert.equal(e7!.detail, "Vale configured but unavailable/unparseable — style lint degraded.");
    }),
  );
});

test("vale: FACTORY_VALE_BIN unset → NO editorial.vale_style check present", () => {
  withEnv({ FACTORY_VALE_BIN: undefined }, () => {
    const checks = runEditorialQa(proposal(), BRIEF, POLICY);
    const e7 = valeCheck(checks);
    assert.equal(e7, undefined, "E7 must be absent when FACTORY_VALE_BIN is unset");
  });
});

test("vale: evidence refs respect the 280-char cap", () => {
  const longMessage = "x".repeat(400);
  const alerts = JSON.stringify({
    "body.txt": [{ Check: "write-good.TooWordy", Line: 3, Severity: "suggestion", Message: longMessage }],
  });
  const bin = stubVale(alerts);
  tracked(join(bin, ".."), () =>
    withEnv({ FACTORY_VALE_BIN: bin }, () => {
      const checks = runEditorialQa(proposal(), BRIEF, POLICY);
      const e7 = valeCheck(checks);
      assert.ok(e7);
      assert.ok(e7!.evidence[0]!.ref.length <= 280);
    }),
  );
});
