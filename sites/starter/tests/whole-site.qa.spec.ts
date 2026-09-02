import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { resolveCanonicalOrigin } from "@factory/contracts";
import { siteProfile } from "../src/lib/site-profile.js";

// Whole-site deterministic acceptance (Sutherland launch): evaluates the
// built site as ONE website — every SiteProfile navigation target and every
// sitemap URL — across desktop and mobile.

const expectedOrigin = resolveCanonicalOrigin({
  override: process.env.PUBLIC_SITE_URL,
  profile: siteProfile,
});

const IGNORED_ERRORS: RegExp[] = [
  /Failed to load resource: the server responded with a status of 404/,
];

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!IGNORED_ERRORS.some((pattern) => pattern.test(text))) {
        errors.push(`console.error: ${text}`);
      }
    }
  });
  return errors;
}

/** Launch-manifest routes (shipped scope of this run). */
const LAUNCH_ROUTES = [
  "/",
  "/chamonix-market-intelligence",
  "/megeve-market-intelligence",
  "/blog/non-resident-french-property-readiness",
] as const;

const JSON_LD_TYPE_BY_ROUTE: Record<string, string> = {
  "/": "LocalBusiness",
  "/chamonix-market-intelligence": "WebPage",
  "/megeve-market-intelligence": "WebPage",
  "/blog/non-resident-french-property-readiness": "Article",
};

function readSitemapRoutes(): string[] {
  // The sitemap is emitted at build time from the same canonical origin.
  const raw = readFileSync(new URL("../../starter/dist/sitemap.xml", import.meta.url), "utf8");
  return [...raw.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
}

for (const route of LAUNCH_ROUTES) {
  test.describe(`whole-site: ${route}`, () => {
    test("metadata, single H1, canonical, JSON-LD, shell, links, no errors", async ({ page }, testInfo) => {
      const errors = watchForErrors(page);
      const response = await page.goto(route);
      expect(response, `${route} responds`).not.toBeNull();
      expect(response!.status(), `${route} is 200`).toBe(200);

      // Metadata present and unique-ish per page (full uniqueness asserted in
      // the cross-page describe below).
      const title = await page.title();
      expect(title.length, `${route} has title`).toBeGreaterThan(0);
      expect(title, `${route} title carries the site suffix`).toContain(siteProfile.siteName);

      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveCount(1);
      expect(await description.getAttribute("content"), `${route} description non-empty`).toBeTruthy();

      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      expect(
        await canonical.getAttribute("href"),
        `${route} canonical is origin+route`,
      ).toBe(`${expectedOrigin}${route === "/" ? "/" : `${route}/`}`);

      // Exactly one H1, non-empty.
      const h1 = page.locator("h1");
      await expect(h1).toHaveCount(1);
      expect((await h1.textContent())?.trim().length, `${route} H1 non-empty`).toBeGreaterThan(0);

      // Exactly one JSON-LD with the expected type.
      const scripts = page.locator('script[type="application/ld+json"]');
      await expect(scripts).toHaveCount(1);
      const schema = JSON.parse((await scripts.textContent()) ?? "") as Record<string, unknown>;
      expect(schema["@context"]).toBe("https://schema.org");
      expect(schema["@type"], `${route} JSON-LD type`).toBe(JSON_LD_TYPE_BY_ROUTE[route]);

      // Profile-driven shell.
      await expect(page.locator("html")).toHaveAttribute("lang", siteProfile.language);
      const headerLinks = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link");
      await expect(headerLinks).toHaveCount(siteProfile.navigation.length);

      // All same-origin links resolve (bounded).
      const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
        anchors.map((a) => a.getAttribute("href") ?? "").filter(Boolean),
      );
      const unique = [...new Set(hrefs)];
      expect(unique.length, `${route} bounded links`).toBeLessThanOrEqual(50);
      for (const href of unique) {
        if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
        const target = new URL(href, `${expectedOrigin}${route}`);
        if (target.origin !== expectedOrigin) continue;
        const res = await page.request.get(`${target.pathname}${target.search}`);
        expect(
          res.status(),
          `${route} internal link resolves: ${href}`,
        ).toBeLessThan(400);
      }

      await page.screenshot({ path: `qa-artifacts/whole-site${route === "/" ? "/root" : route}-${testInfo.project.name}.png`, fullPage: true });
      expect(errors, `${route} no console/page errors`).toEqual([]);
    });
  });
}

test.describe("whole-site: cross-page coherence", () => {
  let titles: string[];
  let descriptions: string[];

  test.beforeAll(async ({ browser }) => {
    titles = [];
    descriptions = [];
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const route of LAUNCH_ROUTES) {
      await page.goto(route);
      titles.push(await page.title());
      descriptions.push((await page.locator('meta[name="description"]').getAttribute("content")) ?? "");
    }
    await context.close();
  });

  test("titles are present and unique across launch pages", () => {
    expect(new Set(titles).size, "unique titles").toBe(titles.length);
    for (const t of titles) expect(t.length).toBeGreaterThan(0);
  });

  test("descriptions are present and unique across launch pages", () => {
    expect(new Set(descriptions).size, "unique descriptions").toBe(descriptions.length);
    for (const d of descriptions) expect(d.length).toBeGreaterThan(0);
  });

  test("sitemap contains exactly the launch routes (no 404, no demo routes)", () => {
    const sitemapRoutes = readSitemapRoutes().sort();
    const expected = [...LAUNCH_ROUTES].map((r) => (r === "/" ? "/" : `${r}/`)).sort();
    expect(sitemapRoutes).toEqual(expected);
  });

  test("navigation targets all resolve to launch routes", async ({ page }) => {
    for (const entry of siteProfile.navigation) {
      const res = await page.request.get(entry.targetSlug);
      expect(res.status(), `nav target ${entry.targetSlug}`).toBeLessThan(400);
    }
  });
});

test.describe("whole-site: 404 behavior", () => {
  test("unknown route returns 404 with rendered page and home link", async ({ page }) => {
    const errors = watchForErrors(page);
    const response = await page.goto("/no-such-launch-route");
    expect(response!.status()).toBe(404);
    await expect(page.locator("h1")).toHaveCount(1);
    const homeLink = page.getByRole("link", { name: "Back to homepage" });
    await expect(homeLink).toHaveAttribute("href", "/");
    expect(errors).toEqual([]);
  });
});
