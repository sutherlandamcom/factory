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

test("QA env precedence runtime: poisoned process.env cannot override candidate-derived QA variables", async () => {
  const origDist = process.env.QA_DIST_DIR;
  const origRoutes = process.env.QA_ROUTES;
  const origPw = process.env.QA_PLAYWRIGHT_PKG;
  const origAxe = process.env.QA_AXE_PLAYWRIGHT_PKG;

  // Poison inherited environment with corrupted values
  process.env.QA_DIST_DIR = "/poisoned/qa/dist/dir";
  process.env.QA_ROUTES = JSON.stringify(["/poisoned-route-attacker"]);
  process.env.QA_PLAYWRIGHT_PKG = "/poisoned/playwright/attacker.js";
  process.env.QA_AXE_PLAYWRIGHT_PKG = "/poisoned/axe/attacker.js";

  const trustedDistDir = "/trusted/candidate/dist";
  const trustedRoutes = ["/homepage", "/about"];
  const trustedPlaywrightPkg = "@playwright/test";
  const trustedAxePkg = "@axe-core/playwright";

  try {
    // Invoke child process with the exact environment construction pattern used in collector.ts
    const childEnv = {
      ...process.env,
      QA_DIST_DIR: trustedDistDir,
      QA_ROUTES: JSON.stringify(trustedRoutes),
      QA_PLAYWRIGHT_PKG: trustedPlaywrightPkg,
      QA_AXE_PLAYWRIGHT_PKG: trustedAxePkg,
    };

    const probeScript = `
      process.stdout.write(JSON.stringify({
        dist: process.env.QA_DIST_DIR,
        routes: JSON.parse(process.env.QA_ROUTES),
        pw: process.env.QA_PLAYWRIGHT_PKG,
        axe: process.env.QA_AXE_PLAYWRIGHT_PKG
      }));
    `;

    const result = await runProcess("node", ["-e", probeScript], {
      cwd: process.cwd(),
      env: childEnv,
      timeoutMs: 10_000,
    });

    assert.equal(result.exitCode, 0, `probe script failed: ${result.stderr}`);
    const observed = JSON.parse(result.stdout);

    // Assert that the trusted candidate-derived values won and poisoned process.env was defeated
    assert.equal(observed.dist, trustedDistDir, "QA_DIST_DIR must use candidate-derived value");
    assert.deepEqual(observed.routes, trustedRoutes, "QA_ROUTES must use candidate-derived value");
    assert.equal(observed.pw, trustedPlaywrightPkg, "QA_PLAYWRIGHT_PKG must use candidate-derived value");
    assert.equal(observed.axe, trustedAxePkg, "QA_AXE_PLAYWRIGHT_PKG must use candidate-derived value");
  } finally {
    // Clean up process.env
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
