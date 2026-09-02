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

  const headerNav = page.getByRole("navigation", { name: "Main navigation" });
  const headerLinks = headerNav.getByRole("link");
  await expect(headerLinks).toHaveCount(siteProfile.navigation.length);
  for (const [index, entry] of siteProfile.navigation.entries()) {
    const link = headerLinks.nth(index);
    await expect(link, `header nav entry ${index}`).toHaveAttribute("href", entry.targetSlug);
    await expect(link).toHaveText(entry.label);
  }

  const footerNav = page.getByRole("navigation", { name: "Footer navigation" });
  const footerLinks = footerNav.getByRole("link");
  await expect(footerLinks).toHaveCount(siteProfile.navigation.length);
  for (const [index, entry] of siteProfile.navigation.entries()) {
    const link = footerLinks.nth(index);
    await expect(link, `footer nav entry ${index}`).toHaveAttribute("href", entry.targetSlug);
    await expect(link).toHaveText(entry.label);
  }

  const footer = page.locator("footer");
  await expect(footer).toContainText(`© ${new Date().getFullYear()} ${siteProfile.siteName}`);
  if (siteProfile.addressLines && siteProfile.addressLines.length > 0) {
    for (const line of siteProfile.addressLines) {
      await expect(footer).toContainText(line);
    }
  }
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
  test("loads with metadata, single H1, LocalBusiness JSON-LD, shell, and no errors", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/");

    // Exact title/description/canonical are asserted by Factory's task-aware
    // QA against the compiled SiteTask. This foundation suite asserts the
    // structural contract that does not depend on task content:
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute("href", `${expectedOrigin}/`);
    const ogUrl = page.locator('meta[property="og:url"]');
    await expect(ogUrl).toHaveCount(1);
    await expect(ogUrl).toHaveAttribute("content", `${expectedOrigin}/`);
    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveCount(1);
    const ogDescription = page.locator('meta[property="og:description"]');
    await expect(ogDescription).toHaveCount(1);

    await assertShell(page);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    const h1Text = (await h1.textContent())?.trim() ?? "";
    expect(h1Text.length, "homepage must have a non-empty H1").toBeGreaterThan(0);

    const schema = await assertJsonLd(page);
    expect(schema["@type"]).toBe("LocalBusiness");
    expect(schema.name).toBe(siteProfile.siteName);
    expect(schema.url).toBe(`${expectedOrigin}/`);

    await page.screenshot({
      path: `qa-artifacts/homepage-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: siteProfile.navigation[1]!.label })
      .click();
    await expect(page.locator("h1")).toHaveCount(1);

    assertNoPageErrors(errors);
  });
});

test.describe("404", () => {
  test("unknown route returns 404 status, renders 404 heading and working home link", async ({
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
