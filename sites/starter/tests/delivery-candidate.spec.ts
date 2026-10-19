import { expect, test } from "@playwright/test";
import { productionRouteSchema } from "@factory/contracts";

/**
 * Run 13 remote oracle for the EXACT approved ProductionCandidate route set.
 *
 * Intentionally separate from tests/qa.spec.ts: that legacy suite asserts a
 * fixed fixture sitemap and cannot validate a genuine 6-page candidate.
 * The trusted delivery backend supplies this route set after binding QA and
 * manifest lineage; no routes are obtained from the live site's own sitemap.
 */
const payload = process.env.FACTORY_DELIVERY_EXPECTED_ROUTES;
const origin = process.env.PUBLIC_SITE_URL?.replace(/\/$/, "");
if (payload && !origin) {
  throw new Error("Candidate delivery QA requires a production canonical origin.");
}
let expectedRoutes: string[] = [];
if (payload) {
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 200) {
    throw new Error("Candidate delivery QA requires a bounded, nonempty route set.");
  }
  expectedRoutes = parsed.map((route) => productionRouteSchema.parse(route));
  if (new Set(expectedRoutes).size !== expectedRoutes.length) {
    throw new Error("Candidate delivery QA route set has duplicates.");
  }
  expectedRoutes.sort();
}

// Skipped only in ordinary, non-delivery Playwright runs. Real delivery
// supplies the route set mandatorily, so all assertions must execute.
test.describe("exact ProductionCandidate remote delivery QA", () => {
  test.skip(!payload, "Not a candidate delivery run: no trusted expected routes supplied.");

  test("all expected routes serve exact canonical content with healthy metadata and no browser errors", async ({ page }, testInfo) => {
    const titles: string[] = [];
    const descriptions: string[] = [];
    const indexableRoutes: string[] = [];

    for (const route of expectedRoutes) {
      const errors: string[] = [];
      const pageError = (error: Error) => errors.push(error.message);
      page.on("pageerror", pageError);
      try {
        const response = await page.goto(route, { waitUntil: "domcontentloaded" });
        expect(response?.status(), `Expected 200 for candidate route ${route}`).toBe(200);
        const canonical = `${origin}${route}`;
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
        await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
        await expect(page.locator("h1")).toHaveCount(1);
        const h1 = (await page.locator("h1").textContent())?.trim();
        expect(h1?.length ?? 0).toBeGreaterThan(0);

        const title = await page.title();
        const description = await page.locator('meta[name="description"]').getAttribute("content");
        expect(title.trim().length).toBeGreaterThan(0);
        expect(description?.trim().length ?? 0).toBeGreaterThan(0);
        titles.push(title);
        descriptions.push(description!);

        const robotTags = await page.locator('meta[name="robots"]').allTextContents();
        const robotContent = await page.locator('meta[name="robots"]').first().getAttribute("content").catch(() => null);
        if (!(robotContent ?? robotTags.join(" ")).toLowerCase().includes("noindex")) {
          indexableRoutes.push(route);
        }

        for (const raw of await page.locator('script[type="application/ld+json"]').allTextContents()) {
          const json: unknown = JSON.parse(raw);
          expect(typeof json).toBe("object");
          expect(json).not.toBeNull();
        }
        await page.screenshot({
          path: testInfo.outputPath(`candidate-${route.replace(/[^a-z0-9]+/gi, "-") || "root"}.png`),
          fullPage: true,
        });
        expect(errors, `Browser errors on route ${route}`).toEqual([]);
      } finally {
        page.off("pageerror", pageError);
      }
    }
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);

    // The sitemap is a provider-served resource, not trusted as a source of
    // truth. Compare it against independently expected route identities.
    const sitemap = await page.request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!).sort();
    expect(locs).toEqual(indexableRoutes.map((r) => `${origin}${r}`).sort());
  });

  test("robots targets correct canonical sitemap and unsupported routes are not silently served", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    const body = await robots.text();
    expect(body).toContain(`Sitemap: ${origin}/sitemap.xml`);
    const nonexistent = await request.get("/__factory_run13_missing_route__");
    expect(nonexistent.status()).toBe(404);
  });
});
