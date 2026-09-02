import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function assertMetadata(
  page: Page,
  expected: {
    title: string;
    description: string;
    canonicalPath: string;
    ogType?: string;
  },
) {
  await expect(page).toHaveTitle(expected.title);

  const desc = page.locator('meta[name="description"]');
  await expect(desc).toHaveCount(1);
  await expect(desc).toHaveAttribute("content", expected.description);

  const canonicalUrl = `${expectedOrigin}${expected.canonicalPath}`;
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute("href", canonicalUrl);

  const ogTitle = page.locator('meta[property="og:title"]');
  await expect(ogTitle).toHaveCount(1);
  await expect(ogTitle).toHaveAttribute("content", expected.title);

  const ogDesc = page.locator('meta[property="og:description"]');
  await expect(ogDesc).toHaveCount(1);
  await expect(ogDesc).toHaveAttribute("content", expected.description);

  const ogUrl = page.locator('meta[property="og:url"]');
  await expect(ogUrl).toHaveCount(1);
  await expect(ogUrl).toHaveAttribute("content", canonicalUrl);

  const ogType = page.locator('meta[property="og:type"]');
  await expect(ogType).toHaveCount(1);
  await expect(ogType).toHaveAttribute("content", expected.ogType ?? "website");
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

async function assertResponsiveImage(
  locator: Locator,
  expected: {
    alt: string;
    sizes?: string;
    loading: "eager" | "lazy";
  },
) {
  await expect(locator).toBeVisible();
  const src = await locator.getAttribute("src");
  expect(src, "image src must be a local generated asset").toMatch(/^\/_astro\//);
  await expect(locator).toHaveAttribute("alt", expected.alt);

  const width = Number(await locator.getAttribute("width"));
  const height = Number(await locator.getAttribute("height"));
  expect(width, "image width must be explicit and positive").toBeGreaterThan(0);
  expect(height, "image height must be explicit and positive").toBeGreaterThan(0);

  const srcset = await locator.getAttribute("srcset");
  expect(srcset, "responsive image must have srcset").toBeTruthy();
  expect(srcset).toContain("/_astro/");

  if (expected.sizes) {
    await expect(locator).toHaveAttribute("sizes", expected.sizes);
  }

  await expect(locator).toHaveAttribute("loading", expected.loading);
}

test.describe("homepage", () => {
  test("loads with exact metadata, H1, JSON-LD, responsive image, working nav, and no errors", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/");

    await assertMetadata(page, {
      title: `Roof Repair & Replacement in Boulder, CO | ${siteProfile.siteName}`,
      description:
        "Summit Roofing Co. provides residential roof repair, replacement, and inspection services in Boulder, Colorado. Licensed, insured, and rated 5 stars by local homeowners.",
      canonicalPath: "/",
      ogType: "website",
    });

    await assertShell(page);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText("Roofing done right, the first time");

    const schema = await assertJsonLd(page);
    expect(schema["@type"]).toBe("LocalBusiness");
    expect(schema.name).toBe("Summit Roofing Co.");
    expect(schema.url).toBe(`${expectedOrigin}/`);
    expect(schema.areaServed).toBe("Boulder, CO");

    await assertResponsiveImage(page.locator("section.bg-slate-50 img"), {
      alt: "A repaired shingle roof on a Boulder home at the foot of the Flatirons",
      sizes: "(max-width: 768px) 100vw, 50vw",
      loading: "eager",
    });

    await page.screenshot({
      path: `qa-artifacts/homepage-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Services" })
      .click();
    await expect(page).toHaveURL(/\/services\/example\/?$/);
    await expect(page.locator("h1")).toHaveCount(1);

    assertNoPageErrors(errors);
  });
});

test.describe("service page", () => {
  test("loads with exact metadata, H1, Service JSON-LD, responsive image, visible CTA, and nav", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/services/example");

    await assertMetadata(page, {
      title: `Roof Repair & Replacement Services | ${siteProfile.siteName}`,
      description:
        "Roof repair, full replacement, and storm damage restoration for Boulder-area homes. Free inspections, transparent pricing, and a 10-year workmanship warranty.",
      canonicalPath: "/services/example/",
      ogType: "website",
    });

    await assertShell(page);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText("Roof repair & replacement");

    const schema = await assertJsonLd(page);
    expect(schema["@type"]).toBe("Service");
    expect(schema.serviceType).toBe("Roof repair and replacement");
    expect(schema.url).toBe(`${expectedOrigin}/services/example/`);
    expect((schema.provider as Record<string, unknown>)?.name).toBe("Summit Roofing Co.");

    await assertResponsiveImage(page.locator("section.bg-slate-50 img"), {
      alt: "A Summit Roofing crew member replacing damaged shingles",
      sizes: "(max-width: 768px) 100vw, 50vw",
      loading: "eager",
    });

    const cta = page.getByRole("link", { name: "Start at our homepage" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/");

    await page.screenshot({
      path: `qa-artifacts/service-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Home" })
      .click();
    await expect(page).toHaveURL(/\/$/);

    assertNoPageErrors(errors);
  });
});

test.describe("article page", () => {
  test("loads with exact metadata, H1, Article JSON-LD, lazy responsive image, and internal links", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/blog/example");

    await assertMetadata(page, {
      title: `5 Signs Your Roof Needs Repair Before Winter | ${siteProfile.siteName}`,
      description:
        "Catching roof damage early is the cheapest repair there is. Here are the five warning signs our inspectors check first on Boulder homes.",
      canonicalPath: "/blog/example/",
      ogType: "website",
    });

    await assertShell(page);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText("5 Signs Your Roof Needs Repair Before Winter");

    await expect(page.locator("article")).toBeVisible();
    await expect(page.locator("article h2")).toHaveCount(5);

    const schema = await assertJsonLd(page);
    expect(schema["@type"]).toBe("Article");
    expect(schema.headline).toBe("5 Signs Your Roof Needs Repair Before Winter");
    expect(schema.datePublished).toBe("2026-01-15");
    expect((schema.author as Record<string, unknown>)?.name).toBe("Summit Roofing Co.");
    expect(
      ((schema.mainEntityOfPage as Record<string, unknown>)?.[
        "@id"
      ] as string),
    ).toBe(`${expectedOrigin}/blog/example/`);

    await assertResponsiveImage(page.locator("article img"), {
      alt: "Close-up of asphalt shingles showing hail damage and granule loss",
      sizes: "(max-width: 768px) 100vw, 768px",
      loading: "lazy",
    });

    await page.screenshot({
      path: `qa-artifacts/article-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page
      .locator("article")
      .getByRole("link", { name: "roof repair and replacement services" })
      .click();
    await expect(page).toHaveURL(/\/services\/example\/?$/);

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
