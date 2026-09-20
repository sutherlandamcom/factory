import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

/**
 * VISUAL REGRESSION — Pre-Run-12 hardening.
 *
 * Deterministic pixel regression over the governed production-v3 fixture
 * page. Implemented with page.screenshot() + sharp pixel comparison
 * (deterministic, zero new dependencies) because the Playwright
 * `toHaveScreenshot` stable-expectation screencast path crashes in this
 * environment; comparison semantics are equivalent: any pixel difference
 * beyond zero FAILS.
 *
 * Baseline rules (design policy):
 *   - committed baseline = implementation regression ORACLE, never design
 *     authority;
 *   - unexpected difference -> FAIL;
 *   - automatic baseline regeneration is FORBIDDEN in CI (no scripts run
 *     with UPDATE_VISUAL_BASELINE=1);
 *   - a baseline update is an explicit reviewed change (developer runs the
 *     spec locally with UPDATE_VISUAL_BASELINE=1 and reviews the diff).
 */

const fixtureRoute = "/services/advisory";
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, "visual.production.spec.ts-snapshots", "governed-service-fixture.png");
const updateBaseline = process.env.UPDATE_VISUAL_BASELINE === "1";

/** Full-page screenshot as raw RGBA pixels + dimensions. */
async function capturePixels(page: import("@playwright/test").Page) {
  const buffer = await page.screenshot({ fullPage: true, animations: "disabled" });
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

test.describe("governed production visual regression", () => {
  // Visual baselines are desktop-project oracles: skip in other projects.
  test.beforeEach(async ({ }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "visual baselines are desktop-project oracles");
  });
  test("service fixture page renders the accepted composition without visual drift", async ({ page }) => {
    await page.goto(fixtureRoute, { waitUntil: "networkidle" });
    // Deterministic state: neutralize caret/scrollbar variation sources.
    await page.addStyleTag({ content: "*{caret-color:transparent !important} ::-webkit-scrollbar{display:none}" });
    const actual = await capturePixels(page);

    if (updateBaseline) {
      // Explicit, reviewed, local-only path (never run in CI).
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, await page.screenshot({ fullPage: true, animations: "disabled" }));
      return;
    }

    let baselineBuffer: Buffer;
    try {
      baselineBuffer = await readFile(baselinePath);
    } catch {
      throw new Error(
        `Visual baseline missing at ${baselinePath}. Regenerating baselines automatically is FORBIDDEN; ` +
        `a baseline change is an explicit reviewed change (run locally with UPDATE_VISUAL_BASELINE=1).`,
      );
    }
    const baselineRaw = await sharp(baselineBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (baselineRaw.info.width !== actual.width || baselineRaw.info.height !== actual.height) {
      throw new Error(
        `Visual drift: page dimensions changed (baseline ${baselineRaw.info.width}x${baselineRaw.info.height}, actual ${actual.width}x${actual.height}). ` +
        `Review the visual change and update the baseline explicitly.`,
      );
    }
    // Exact pixel comparison: any difference beyond zero FAILS.
    const differing = baselineRaw.data.length === actual.data.length
      ? baselineRaw.data.findIndex((value, index) => value !== actual.data[index])
      : -1;
    const identical = baselineRaw.data.length === actual.data.length && differing === -1;
    if (!identical) {
      throw new Error(
        `Visual drift detected against the committed baseline (first differing byte at ${differing}). ` +
        `Unexpected difference -> FAIL; update the baseline only as an explicit reviewed change.`,
      );
    }
  });

  test("hero and section components carry registry data attributes", async ({ page }) => {
    await page.goto(fixtureRoute, { waitUntil: "networkidle" });
    const components = await page.locator("[data-component]").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.component),
    );
    expect(components).toContain("page-hero");
    expect(components).toContain("content-section");
    expect(components).toContain("page-conclusion");
    expect(components).toContain("page-cta");
  });

  test("root token projection reaches html, body, header, main and article identically", async ({ page }) => {
    await page.goto(fixtureRoute, { waitUntil: "networkidle" });
    const tokenProbe = await page.evaluate(() => {
      const targets = [document.documentElement, document.body, document.querySelector("header"), document.querySelector("main"), document.querySelector("article")];
      const probe = (element: Element | null, variable: string): string | null => {
        if (!element) return null;
        return getComputedStyle(element).getPropertyValue(variable).trim() || null;
      };
      return {
        bg: targets.map((element) => probe(element, "--color-background-primary")),
        text: targets.map((element) => probe(element, "--color-text-primary")),
        sectionY: targets.map((element) => probe(element, "--spacing-section-y")),
      };
    });
    for (const values of [tokenProbe.bg, tokenProbe.text, tokenProbe.sectionY]) {
      const defined = values.filter((value): value is string => value !== null);
      expect(defined.length).toBe(values.length);
      expect(new Set(defined).size).toBe(1);
    }
  });
});
