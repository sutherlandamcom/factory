import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";

/**
 * VISUAL REGRESSION — Pre-Run-12 hardening.
 *
 * Deterministic STRUCTURAL visual oracle over the governed production-v3
 * fixture page. Methodology note (design policy §27): a pixel oracle over
 * full-page text requires byte-identical font rasterization across every
 * environment; the accepted font delivery is an approved SYSTEM stack, so
 * macOS and Linux rasterize differently BY DESIGN and a committed PNG
 * baseline is not a portable oracle. The portable regression oracle here is
 * the page's geometric structure + token projection + component registry
 * markers:
 *   - every governed component's bounding box (tag, component, variant,
 *     pattern, x/y/w/h rounded to whole CSS px);
 *   - root semantic token values as computed on html/body/header/main/
 *     article (identical projection everywhere);
 *   - resolved font-family chains for display/heading/body.
 *
 * The committed JSON baseline is a reviewed implementation-regression
 * ORACLE, never design authority:
 *   - unexpected structural difference -> FAIL;
 *   - automatic baseline regeneration is FORBIDDEN in CI (no script runs
 *     with UPDATE_VISUAL_BASELINE=1);
 *   - a baseline update is an explicit reviewed change (developer runs the
 *     spec locally with UPDATE_VISUAL_BASELINE=1 and reviews the diff).
 *
 * Rasterization-level drift detection remains available locally via
 * page.screenshot()+sharp whenever the reviewer wants it; it is not a
 * committed cross-environment oracle.
 */

const fixtureRoute = "/services/advisory";
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, "visual.production.spec.ts-snapshots", "governed-service-fixture.structure.json");
const updateBaseline = process.env.UPDATE_VISUAL_BASELINE === "1";

interface StructureSnapshot {
  viewport: { width: number; height: number };
  components: Array<{ component: string; variant: string; pattern: string | null; box: { x: number; y: number; width: number; height: number } }>;
  tokenProjection: { bg: string[]; text: string[]; sectionY: string[] };
  fontFamilies: { display: string; heading: string; body: string };
  documentHeight: number;
}

test.describe("governed production visual regression", () => {
  // Structural baselines are desktop-project oracles: skip in other projects.
  test.beforeEach(async ({ }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "visual baselines are desktop-project oracles");
  });

  test("service fixture page renders the accepted composition without visual drift", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixtureRoute, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*{caret-color:transparent !important} ::-webkit-scrollbar{display:none}" });

    const structure: StructureSnapshot = await page.evaluate(() => {
      const round = (value: number) => Math.round(value * 2) / 2;
      const components = [...document.querySelectorAll("[data-component]")].map((node) => {
        const element = node as HTMLElement;
        const box = element.getBoundingClientRect();
        return {
          component: element.dataset.component ?? "",
          variant: element.dataset.variant ?? "",
          pattern: element.dataset.pattern ?? null,
          box: { x: round(box.x + window.scrollX), y: round(box.y + window.scrollY), width: round(box.width), height: round(box.height) },
        };
      });
      const targets = [document.documentElement, document.body, document.querySelector("header"), document.querySelector("main"), document.querySelector("article")];
      const probe = (element: Element | null, variable: string): string => getComputedStyle(element ?? document.documentElement).getPropertyValue(variable).trim();
      const heroTitle = document.querySelector("h1");
      const heroHeading = document.querySelector("h2");
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        components,
        tokenProjection: {
          bg: targets.map((element) => probe(element, "--color-background-primary")),
          text: targets.map((element) => probe(element, "--color-text-primary")),
          sectionY: targets.map((element) => probe(element, "--spacing-section-y")),
        },
        fontFamilies: {
          display: getComputedStyle(heroTitle ?? document.body).fontFamily,
          heading: getComputedStyle(heroHeading ?? document.body).fontFamily,
          body: getComputedStyle(document.body).fontFamily,
        },
        documentHeight: round(document.documentElement.scrollHeight),
      };
    });

    if (updateBaseline) {
      // Explicit, reviewed, local-only path (never run in CI).
      await mkdir(path.dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, JSON.stringify(structure, null, 2) + "\n");
      return;
    }

    let baseline: StructureSnapshot;
    try {
      baseline = JSON.parse(await readFile(baselinePath, "utf8")) as StructureSnapshot;
    } catch {
      throw new Error(
        `Visual baseline missing at ${baselinePath}. Regenerating baselines automatically is FORBIDDEN; ` +
        `a baseline change is an explicit reviewed change (run locally with UPDATE_VISUAL_BASELINE=1).`,
      );
    }

    expect(structure.viewport).toEqual(baseline.viewport);
    // Component registry markers: same governed components, same variants.
    expect(structure.components.map((entry) => ({ component: entry.component, variant: entry.variant, pattern: entry.pattern })))
      .toEqual(baseline.components.map((entry) => ({ component: entry.component, variant: entry.variant, pattern: entry.pattern })));
    // Root token projection reaches html/body/header/main/article identically.
    for (const key of ["bg", "text", "sectionY"] as const) {
      const defined = structure.tokenProjection[key].filter((value) => value !== "");
      expect(defined.length).toBe(structure.tokenProjection[key].length);
      expect(new Set(defined).size).toBe(1);
      expect(structure.tokenProjection[key][0]).toBe(baseline.tokenProjection[key][0]);
    }
    // Deterministic font delivery actually applied at runtime.
    expect(structure.fontFamilies.display).toBe(baseline.fontFamilies.display);
    expect(structure.fontFamilies.body).toBe(baseline.fontFamilies.body);
    // Geometry: same component boxes (order + rounded CSS px) and page height.
    expect(structure.components.map((entry) => entry.box)).toEqual(baseline.components.map((entry) => entry.box));
    expect(structure.documentHeight).toBe(baseline.documentHeight);
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
