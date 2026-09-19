import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../../src/executor/process.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Run 11 Remediation — QA Child Process Environment Precedence Tests.
 *
 * Requirement:
 * Trusted candidate-derived QA values must not be overridden by inherited process.env.
 * Negative tests: Poison inherited environment with wrong values for:
 *   - QA_DIST_DIR
 *   - QA_ROUTES
 *   - QA_PLAYWRIGHT_PKG
 *   - QA_AXE_PLAYWRIGHT_PKG
 * Prove executor still uses candidate-derived values and evidence remains
 * bound to the artifact actually tested.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const collectorSrc = readFileSync(path.join(here, "../../src/production/qa/collector.ts"), "utf8");

test("QA env precedence contract: collector spreads ...process.env BEFORE trusted overrides", () => {
  // Pin the AST/code structure in collector.ts
  const envBlockMatch = collectorSrc.match(/env:\s*\{[\s\S]*?QA_DIST_DIR:[\s\S]*?\}/);
  assert.ok(envBlockMatch, "collector.ts must construct a child env object containing QA_DIST_DIR");
  const block = envBlockMatch[0]!;
  const spreadIdx = block.indexOf("...process.env");
  const distIdx = block.indexOf("QA_DIST_DIR:");
  const routesIdx = block.indexOf("QA_ROUTES:");
  const pwIdx = block.indexOf("QA_PLAYWRIGHT_PKG:");
  const axeIdx = block.indexOf("QA_AXE_PLAYWRIGHT_PKG:");

  assert.ok(spreadIdx !== -1, "must spread process.env");
  assert.ok(distIdx !== -1, "must define QA_DIST_DIR");
  assert.ok(routesIdx !== -1, "must define QA_ROUTES");
  assert.ok(pwIdx !== -1, "must define QA_PLAYWRIGHT_PKG");
  assert.ok(axeIdx !== -1, "must define QA_AXE_PLAYWRIGHT_PKG");

  // Critical requirement: ...process.env must come BEFORE each of the trusted variables
  assert.ok(spreadIdx < distIdx, "...process.env must precede QA_DIST_DIR");
  assert.ok(spreadIdx < routesIdx, "...process.env must precede QA_ROUTES");
  assert.ok(spreadIdx < pwIdx, "...process.env must precede QA_PLAYWRIGHT_PKG");
  assert.ok(spreadIdx < axeIdx, "...process.env must precede QA_AXE_PLAYWRIGHT_PKG");
});

import { LocalTrustedQaEvidenceExecutor } from "../../src/production/qa/collector.js";
import type { RunProcessOptions } from "../../src/executor/process.js";
import { mkdir, writeFile } from "node:fs/promises";

test("QA env precedence runtime: real LocalTrustedQaEvidenceExecutor overrides poisoned ambient QA_* variables", async () => {
  const origDist = process.env.QA_DIST_DIR;
  const origRoutes = process.env.QA_ROUTES;
  const origPw = process.env.QA_PLAYWRIGHT_PKG;
  const origAxe = process.env.QA_AXE_PLAYWRIGHT_PKG;

  // Poison ambient inherited environment with attacker-controlled values
  process.env.QA_DIST_DIR = "/poisoned/qa/dist/dir";
  process.env.QA_ROUTES = JSON.stringify(["/poisoned-route-attacker"]);
  process.env.QA_PLAYWRIGHT_PKG = "/poisoned/playwright/attacker.js";
  process.env.QA_AXE_PLAYWRIGHT_PKG = "/poisoned/axe/attacker.js";

  const repoRoot = path.resolve(here, "../../../../");
  const trustedDistDir = "/trusted/candidate-a/dist";
  const trustedRoutes = ["/homepage", "/about"];

  // Capture real executor process invocations and probe child process runtime environment
  const captured: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    childObserved?: { dist?: string; routes?: string[]; pw?: string; axe?: string };
  }> = [];

  const capturingRunner = async (
    command: string,
    args: string[],
    opts: RunProcessOptions,
  ) => {
    if (command === "node") {
      // Execute a real child process with opts.env (constructed by LocalTrustedQaEvidenceExecutor)
      // to prove the child process actually receives the trusted values, overriding poisoned ambient env.
      const probe = await runProcess("node", ["-e", `
        process.stdout.write(JSON.stringify({
          dist: process.env.QA_DIST_DIR,
          routes: JSON.parse(process.env.QA_ROUTES),
          pw: process.env.QA_PLAYWRIGHT_PKG,
          axe: process.env.QA_AXE_PLAYWRIGHT_PKG,
        }));
      `], opts);
      const childObserved = JSON.parse(probe.stdout);
      captured.push({ command, args, env: opts.env, childObserved });

      // Return valid browser check results so collect() continues through its real flow
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify([
          { kind: "axe", route: "/homepage", count: 0, blocking: [] },
          { kind: "keyboard", route: "/homepage", expected: 1, visited: 1, ok: true },
        ]),
        stderr: "",
        timedOut: false,
      };
    }

    if (command === "pnpm") {
      // Lighthouse: provide minimal manifest so collectLighthouse parses safely without expensive full run
      const outDir = path.join(repoRoot, "qa-artifacts", "lhci-e2e");
      await mkdir(outDir, { recursive: true });
      const reportPath = path.join(outDir, "report.json");
      await writeFile(reportPath, JSON.stringify({
        categories: { performance: { score: 1 }, seo: { score: 1 }, "best-practices": { score: 1 } },
        audits: {},
      }));
      await writeFile(path.join(outDir, "manifest.json"), JSON.stringify([
        { url: "http://localhost/homepage", jsonPath: reportPath },
      ]));
      captured.push({ command, args, env: opts.env });
      return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false };
    }

    // gitleaks and osv scanner: return pass without running expensive full scans
    captured.push({ command, args, env: opts.env });
    return { exitCode: 0, signal: null, stdout: "no leaks found", stderr: "", timedOut: false };
  };

  try {
    // Invoke the REAL LocalTrustedQaEvidenceExecutor
    const executor = new LocalTrustedQaEvidenceExecutor(capturingRunner);
    const checks = await executor.collect({
      distDir: trustedDistDir,
      routes: trustedRoutes,
      manifestSetDigest: "m".repeat(64),
      repositorySha: "s".repeat(40),
      repoRoot,
    });

    assert.ok(checks.length > 0, "executor.collect must produce check results");

    // Verify node browser-harness invocation through the real production executor path
    const nodeInvocation = captured.find((c) => c.command === "node");
    assert.ok(nodeInvocation, "LocalTrustedQaEvidenceExecutor must execute the browser harness");

    // 1. The env passed by LocalTrustedQaEvidenceExecutor MUST contain candidate-derived trusted values
    assert.equal(
      nodeInvocation.env.QA_DIST_DIR,
      trustedDistDir,
      "QA_DIST_DIR in executor child env must be the candidate-derived trustedDistDir",
    );
    assert.equal(
      nodeInvocation.env.QA_ROUTES,
      JSON.stringify(trustedRoutes),
      "QA_ROUTES in executor child env must be the candidate-derived trustedRoutes",
    );
    assert.notEqual(
      nodeInvocation.env.QA_DIST_DIR,
      "/poisoned/qa/dist/dir",
      "Poisoned ambient QA_DIST_DIR must not leak into child process",
    );
    assert.notEqual(
      nodeInvocation.env.QA_ROUTES,
      JSON.stringify(["/poisoned-route-attacker"]),
      "Poisoned ambient QA_ROUTES must not leak into child process",
    );
    assert.notEqual(
      nodeInvocation.env.QA_PLAYWRIGHT_PKG,
      "/poisoned/playwright/attacker.js",
      "Poisoned ambient QA_PLAYWRIGHT_PKG must not leak into child process",
    );
    assert.notEqual(
      nodeInvocation.env.QA_AXE_PLAYWRIGHT_PKG,
      "/poisoned/axe/attacker.js",
      "Poisoned ambient QA_AXE_PLAYWRIGHT_PKG must not leak into child process",
    );

    // 2. Child process runtime check: the spawned process actually observed trusted candidate values
    assert.equal(nodeInvocation.childObserved?.dist, trustedDistDir);
    assert.deepEqual(nodeInvocation.childObserved?.routes, trustedRoutes);
    assert.ok(nodeInvocation.childObserved?.pw?.endsWith(path.join("@playwright", "test")));
    assert.ok(nodeInvocation.childObserved?.axe?.endsWith(path.join("@axe-core", "playwright")));
  } finally {
    // Restore process.env
    if (origDist === undefined) delete process.env.QA_DIST_DIR;
    else process.env.QA_DIST_DIR = origDist;

    if (origRoutes === undefined) delete process.env.QA_ROUTES;
    else process.env.QA_ROUTES = origRoutes;

    if (origPw === undefined) delete process.env.QA_PLAYWRIGHT_PKG;
    else process.env.QA_PLAYWRIGHT_PKG = origPw;

    if (origAxe === undefined) delete process.env.QA_AXE_PLAYWRIGHT_PKG;
    else process.env.QA_AXE_PLAYWRIGHT_PKG = origAxe;
  }
});
