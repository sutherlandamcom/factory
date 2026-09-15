import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { resolveCanonicalOrigin } from "@factory/contracts";
import { siteProfile } from "../src/lib/site-profile.js";

// Site identity comes from the repository-owned SiteProfile (parsed with the
// shared contract via the same data file the site builds from). The trusted
// PUBLIC_SITE_URL override wins exactly as in astro.config.ts.
const expectedOrigin = resolveCanonicalOrigin({
  override: process.env.PUBLIC_SITE_URL,
  profile: siteProfile,
});

/**
 * Console/page errors that are known-benign and ignored by assertNoPageErrors.
 */
const IGNORED_ERRORS: RegExp[] = [
  // Chromium logs a console error for the intentional 404 HTTP status when navigating to missing routes
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

async function expectOk(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response, `expected a response for ${path}`).not.toBeNull();
  expect(response!.status(), `expected 200 OK for ${path}`).toBe(200);
}

function assertNoPageErrors(errors: string[]) {
  expect(errors, "expected no critical console errors").toEqual([]);
}

/**
 * Profile-driven shell assertions: language, navigation, and footer identity
 * must come from the SiteProfile-derived data the components receive.
 */
async function assertShell(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("lang", siteProfile.language);

  const headerNav = page.getByRole("navigation", { name: "Primary" });
  const headerLinks = headerNav.getByRole("link");
  await expect(headerLinks).toHaveCount(1);
  await expect(headerLinks).toHaveAttribute("href", "/");
  await expect(headerLinks).toHaveText(siteProfile.siteName);

  const footer = page.locator("footer");
  await expect(footer).toContainText(siteProfile.siteName);
}

async function assertJsonLd(page: Page): Promise<Record<string, unknown>> {
  const script = page.locator('script[type="application/ld+json"]');
  await expect(script).toHaveCount(1);
  const text = await script.textContent();
  expect(text, "expected non-empty JSON-LD content").toBeTruthy();
  const parsed = JSON.parse(text!) as Record<string, unknown>;
  expect(parsed["@context"]).toBe("https://schema.org");
  return parsed;
}

test.describe("homepage", () => {
  test("loads governed production authority with shell identity, metadata, WebPage JSON-LD, and no errors", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/");

    // Exact homepage copy is asserted by the dynamic task QA spec (derived
    // from the SiteTask) rather than hardcoded here: the static suite owns
    // the shell and structural truth that holds regardless of page content.
    const title = await page.title();
    expect(title.endsWith(` | ${siteProfile.siteName}`), `title must end with the profile suffix, got: ${title}`).toBe(true);
    expect(title.length, "title must be non-empty").toBeGreaterThan(siteProfile.siteName.length + 3);

    const desc = page.locator('meta[name="description"]');
    await expect(desc).toHaveCount(1);
    const descContent = (await desc.getAttribute("content"))?.trim() ?? "";
    expect(descContent.length, "meta description must be present").toBeGreaterThan(0);

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute("href", `${expectedOrigin}/`);

    const ogUrl = page.locator('meta[property="og:url"]');
    await expect(ogUrl).toHaveCount(1);
    await expect(ogUrl).toHaveAttribute("content", `${expectedOrigin}/`);

    await assertShell(page);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    const h1Text = (await h1.textContent())?.trim() ?? "";
    expect(h1Text.length, "H1 must be non-empty").toBeGreaterThan(0);

    const schema = await assertJsonLd(page);
    expect(schema["@type"]).toBe("WebPage");
    expect(schema.name).toBe(h1Text);
    expect(schema.url).toBe(`${expectedOrigin}/`);

    await page.screenshot({
      path: `qa-artifacts/homepage-${testInfo.project.name}.png`,
      fullPage: true,
    });

    assertNoPageErrors(errors);
  });
});

test.describe("404", () => {
  test("unknown route returns 404 status, attaches error watcher, renders 404 heading and working home link", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    const response = await page.goto("/this-page-does-not-exist");
    expect(response, "expected a response for unknown path").not.toBeNull();
    expect(response!.status()).toBe(404);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText("404");

    const homeLink = page.getByRole("link", { name: "Back to homepage" });
    await expect(homeLink).toBeVisible();
    await expect(homeLink).toHaveAttribute("href", "/");

    await page.screenshot({
      path: `qa-artifacts/404-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await homeLink.click();
    await expect(page).toHaveURL(/\/$/);

    assertNoPageErrors(errors);
  });
});

test.describe("sitemap and robots crawler baseline", () => {
  test("sitemap.xml and robots.txt exist after build with valid canonical URLs and no 404", async () => {
    const sitemapUrl = new URL("../../starter/dist/sitemap.xml", import.meta.url);
    const robotsUrl = new URL("../../starter/dist/robots.txt", import.meta.url);

    expect(existsSync(sitemapUrl), "sitemap.xml must exist after build").toBe(true);
    expect(existsSync(robotsUrl), "robots.txt must exist after build").toBe(true);

    const sitemapContent = readFileSync(sitemapUrl, "utf8");
    const robotsContent = readFileSync(robotsUrl, "utf8");

    // robots allows crawl and points to canonical sitemap
    expect(robotsContent).toContain("Allow: /");
    const expectedSitemapUrl = `${expectedOrigin}/sitemap.xml`;
    expect(robotsContent).toContain(`Sitemap: ${expectedSitemapUrl}`);

    // Parse URLs from sitemap
    const locMatches = [...sitemapContent.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locMatches.length, "sitemap must contain at least one URL").toBeGreaterThan(0);

    // No duplicate URLs in sitemap
    expect(new Set(locMatches).size, "sitemap must contain no duplicate URLs").toBe(locMatches.length);

    // One-page launch scope: the sitemap contains exactly the launch route.
    expect(locMatches, "sitemap must contain exactly the one-page launch scope").toEqual([`${expectedOrigin}/`]);

    // 404 is absent from sitemap and all URLs use effective canonical origin
    for (const url of locMatches) {
      expect(url, "404 must be absent from sitemap").not.toContain("404");
      expect(url.startsWith(expectedOrigin), `sitemap URL ${url} must use canonical origin ${expectedOrigin}`).toBe(true);
    }
  });
});

test.describe("whole-site navigation coherence", () => {
  test("every navigation target resolves with single H1, coherent canonical, metadata, and healthy links", async ({
    page,
  }) => {
    const titles: string[] = [];
    const descriptions: string[] = [];

    for (const entry of [{ targetSlug: "/" }]) {
      const errors = watchForErrors(page);
      const res = await page.goto(entry.targetSlug);
      expect(res, `navigation target ${entry.targetSlug} responds`).not.toBeNull();
      expect(res!.status(), `navigation target ${entry.targetSlug} returns 200`).toBe(200);

      // Single H1
      const h1 = page.locator("h1");
      await expect(h1, `${entry.targetSlug} must have exactly one H1`).toHaveCount(1);
      const h1Text = (await h1.textContent())?.trim() ?? "";
      expect(h1Text.length, `${entry.targetSlug} H1 must be non-empty`).toBeGreaterThan(0);

      // Metadata present
      const title = await page.title();
      expect(title.length, `${entry.targetSlug} title must be non-empty`).toBeGreaterThan(0);
      titles.push(title);

      const desc = page.locator('meta[name="description"]');
      await expect(desc, `${entry.targetSlug} must have meta description`).toHaveCount(1);
      const descContent = (await desc.getAttribute("content"))?.trim() ?? "";
      expect(descContent.length, `${entry.targetSlug} meta description must be non-empty`).toBeGreaterThan(0);
      descriptions.push(descContent);

      // Canonical origin matches expected origin
      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical, `${entry.targetSlug} must have canonical link`).toHaveCount(1);
      const expectedCanonical = `${expectedOrigin}${entry.targetSlug === "/" ? "/" : `${entry.targetSlug}/`}`;
      await expect(canonical).toHaveAttribute("href", expectedCanonical);

      // Consistent shell identity
      await expect(page.locator("html")).toHaveAttribute("lang", siteProfile.language);
      await expect(page.locator("footer")).toContainText(siteProfile.siteName);

      // Same-origin links resolve
      const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
        anchors.map((a) => a.getAttribute("href") ?? "").filter(Boolean),
      );
      const uniqueHrefs = [...new Set(hrefs)];
      for (const href of uniqueHrefs) {
        if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
        const target = new URL(href, `${expectedOrigin}${entry.targetSlug}`);
        if (target.origin !== expectedOrigin) continue;
        const linkRes = await page.request.get(`${target.pathname}${target.search}`);
        expect(linkRes.status(), `${entry.targetSlug} internal link ${href} resolves`).toBeLessThan(400);
      }

      assertNoPageErrors(errors);
    }

    // Titles and descriptions are unique across navigation targets
    expect(new Set(titles).size, "navigation page titles must be unique").toBe(titles.length);
    expect(new Set(descriptions).size, "navigation page descriptions must be unique").toBe(descriptions.length);
  });
});
