import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * RUN 12 BLOCK 38/42/43 — REAL BROWSER E2E & RESPONSIVE QA over the BUILT multi-page Sutherland site.
 *
 * Runs against a real governed production candidate through
 * FACTORY_QA_ARTIFACT_DIR (astro preview of the built dist). When invoked
 * against the default starter fixture build (which does not contain /home),
 * the suite skips cleanly so default fixture QA remains green.
 */

const distDir = process.env.FACTORY_QA_ARTIFACT_DIR
  ? path.resolve(process.env.FACTORY_QA_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, "../dist");

const isSutherlandDist = existsSync(path.join(distDir, "home", "index.html"));

const ROUTES = [
  { path: "/home", titlePart: "Independent Buyer-Side Advisory", h1: "Independent Buyer-Side Advisory for French Alps Property Decisions" },
  { path: "/services/buyer-side-advisory", titlePart: "Buyer-Side Property Advisory", h1: "Buyer-Side Property Advisory: Scope and Engagement" },
  { path: "/locations/chamonix", titlePart: "Property Decision Support in Chamonix", h1: "Property Decision Support in Chamonix" },
  { path: "/advisory/investment-decision-framework", titlePart: "Investment Decision Framework", h1: "Investment Decision Framework for Alpine Property" },
  { path: "/research/alpine-decision-framework", titlePart: "An Evidence-Led Decision Framework", h1: "An Evidence-Led Decision Framework for Alpine Property" },
  { path: "/research/chamonix-supply-notes", titlePart: "Supply-Side Notes", h1: "Supply-Side Notes for the Chamonix Decision Framework" },
];

const IGNORED_ERRORS: RegExp[] = [
  /Failed to load resource: the server responded with a status of 404/,
];

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !IGNORED_ERRORS.some((pattern) => pattern.test(msg.text()))) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return errors;
}

test.describe("Run 12 multi-page browser journey & responsive QA", () => {
  test.beforeEach(() => {
    test.skip(!isSutherlandDist, "Run 12 Sutherland candidate dist not active in this Playwright invocation");
  });

  for (const route of ROUTES) {
    test(`journey & responsive layout: ${route.path}`, async ({ page }) => {
      const errors = watchForErrors(page);
      const response = await page.goto(route.path);
      expect(response?.status(), `200 OK for ${route.path}`).toBe(200);

      // Route identity: unique document title carries the accepted page title.
      await expect(page).toHaveTitle(new RegExp(`${route.titlePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      // Exactly one H1 with the accepted title.
      const h1 = page.locator("h1");
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText(route.h1);

      // Accepted content is present (real governed copy, not fixtures).
      const body = await page.locator("body").innerText();
      expect(body).toContain("Sutherland Private Office");
      expect(body.toLowerCase()).not.toContain("summit roofing");
      expect(body.toLowerCase()).not.toContain("roof repair");
      expect(body.toLowerCase()).not.toContain("fixture");

      // Canonical URL is present and coherent with the route.
      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      const canonicalHref = await canonical.getAttribute("href");
      expect(canonicalHref).toContain(route.path);

      // Structured data present (JSON-LD).
      const jsonLd = page.locator('script[type="application/ld+json"]');
      expect(await jsonLd.count()).toBeGreaterThan(0);

      // Brand navigation link present and internal.
      const nav = page.getByRole("navigation", { name: "Primary" });
      const brandHref = await nav.getByRole("link").first().getAttribute("href");
      expect(brandHref?.startsWith("/"), `brand link ${brandHref} is internal`).toBe(true);

      // Block 43 Responsive QA (executes in both desktop and mobile Playwright projects):
      // 1. No horizontal overflow
      const layoutMetrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const h1El = document.querySelector("h1");
        const sections = [...document.querySelectorAll("[data-component]")].map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            component: (el as HTMLElement).dataset.component ?? "",
            top: rect.top + window.scrollY,
            height: rect.height,
            width: rect.width,
          };
        });
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          h1FontSize: h1El ? parseFloat(getComputedStyle(h1El).fontSize) : 0,
          bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
          sections,
        };
      });
      expect(
        layoutMetrics.scrollWidth,
        `no horizontal overflow on ${route.path} (scrollWidth=${layoutMetrics.scrollWidth}, clientWidth=${layoutMetrics.clientWidth})`,
      ).toBeLessThanOrEqual(layoutMetrics.clientWidth + 1);
      expect(layoutMetrics.h1FontSize, "readable hero heading font size").toBeGreaterThanOrEqual(20);
      expect(layoutMetrics.bodyFontSize, "readable body font size").toBeGreaterThanOrEqual(14);
      expect(layoutMetrics.sections.length, "governed components rendered").toBeGreaterThanOrEqual(4);
      // Verify monotonic vertical section stacking and non-zero dimensions
      for (let i = 0; i < layoutMetrics.sections.length; i++) {
        const sec = layoutMetrics.sections[i]!;
        expect(sec.height, `component ${sec.component} has positive height`).toBeGreaterThan(0);
        expect(sec.width, `component ${sec.component} has positive width`).toBeGreaterThan(0);
        if (i > 0) {
          expect(
            sec.top,
            `section ${sec.component} stacks at or below previous section on ${route.path}`,
          ).toBeGreaterThanOrEqual(layoutMetrics.sections[i - 1]!.top);
        }
      }

      assertNoPageErrors(errors);
    });
  }

  test("journey: root serves the governed homepage redirect", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/");
    // The governed root stub redirects to the homepage route.
    await expect(page).toHaveTitle(/Independent Buyer-Side Advisory/);
    await expect(page.locator("h1")).toHaveCount(1);
    assertNoPageErrors(errors);
  });

  test("journey: editorial related-pages band links resolve across the site", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/research/alpine-decision-framework");
    const related = page.getByRole("navigation", { name: "Related pages" });
    const links = related.getByRole("link");
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    // Every related link resolves to a real production page.
    for (const link of await links.all()) {
      const href = await link.getAttribute("href");
      expect(href?.startsWith("/"), `related link ${href} is internal`).toBe(true);
      const response = await page.goto(href!);
      expect(response?.status(), `related target ${href} resolves`).toBe(200);
      await page.goBack();
    }
    assertNoPageErrors(errors);
  });

  test("journey: brand link reaches the site root which serves the homepage", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/services/buyer-side-advisory");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link").first().click();
    await expect(page).toHaveTitle(/Independent Buyer-Side Advisory/);
    await expect(page.locator("h1")).toHaveCount(1);
    assertNoPageErrors(errors);
  });
});

function assertNoPageErrors(errors: string[]) {
  expect(errors, "expected no critical console errors").toEqual([]);
}
