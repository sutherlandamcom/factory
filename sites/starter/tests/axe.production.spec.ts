import { test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

/**
 * ACCESSIBILITY GATES (Run 9) — axe-core via the official Playwright
 * integration against the BUILT production site.
 *
 * Hard initial policy: 0 critical violations, 0 serious violations on every
 * built production page, desktop and mobile. No global axe rule disables.
 * Result is reported honestly as "automated accessibility gates passed" —
 * axe coverage is not a full WCAG conformance claim.
 */

const distDir = process.env.FACTORY_QA_ARTIFACT_DIR
  ? path.resolve(process.env.FACTORY_QA_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, "../dist");

/** Collect built production routes from dist (directory format). */
function collectRoutes(): string[] {
  if (!existsSync(distDir)) return [];
  const routes: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (entry.name === "index.html") routes.push(prefix === "" ? "/" : prefix);
    }
  };
  walk(distDir, "");
  return routes.sort();
}

const routes = collectRoutes();

for (const route of routes) {
  for (const project of ["desktop", "mobile"]) {
    test(`axe: ${route} [${project}] has 0 critical/serious violations`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== project, `scoped to ${project} project`);
      await page.goto(route, { waitUntil: "commit" }).catch(() => undefined);
      // A governed root redirect stub (noindex meta-refresh to the homepage
      // route) is a delivery artifact, not a content page: axe analysis on it
      // races the navigation and is meaningless. Skip stubs explicitly. The
      // meta-refresh may destroy the execution context before evaluate runs,
      // so detect the stub from the fetched document instead of the live DOM.
      let isRedirectStub = false;
      try {
        const response = await page.request.get(route === "/" ? "/index.html" : route);
        const body = await response.text();
        isRedirectStub = /http-equiv="refresh"/i.test(body) && /name="robots" content="noindex"/i.test(body);
      } catch {
        isRedirectStub = false;
      }
      test.skip(isRedirectStub, `${route} is a governed noindex redirect stub, not a content page`);
      await page.goto(route);
      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
      );
      const summary = blocking
        .map((violation) => `${violation.id}(${violation.impact}): ${violation.nodes.length} node(s)`)
        .join("; ");
      assert.strictEqual(blocking.length, 0, `axe blocking violations on ${route}: ${summary}`);
    });
  }
}
