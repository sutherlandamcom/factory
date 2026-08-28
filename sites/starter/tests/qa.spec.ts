import { expect, test, type Page } from "@playwright/test";

/**
 * Console/page errors that are known-benign and ignored by assertNoPageErrors.
 * Currently empty — add entries here (with a comment explaining why) if a
 * third-party or platform quirk ever produces unavoidable noise.
 */
const IGNORED_ERRORS: RegExp[] = [];

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
  expect(response!.status(), `expected 2xx for ${path}`).toBeLessThan(400);
}

function assertNoPageErrors(errors: string[]) {
  expect(errors, "expected no critical console errors").toEqual([]);
}

test.describe("homepage", () => {
  test("loads with exactly one H1, working nav, and no console errors", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/");

    await expect(page.locator("h1")).toHaveCount(1);

    await page.screenshot({
      path: `qa-artifacts/homepage-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Services" }).click();
    await expect(page).toHaveURL(/\/services\/example$/);
    await expect(page.locator("h1")).toHaveCount(1);

    assertNoPageErrors(errors);
  });
});

test.describe("service page", () => {
  test("loads with correct title, visible CTA, and working navigation", async ({
    page,
  }, testInfo) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/services/example");

    await expect(page).toHaveTitle(/Roof Repair & Replacement Services/);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Start at our homepage" })).toBeVisible();

    await page.screenshot({
      path: `qa-artifacts/service-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);

    assertNoPageErrors(errors);
  });
});

test.describe("article page", () => {
  test("loads, renders article content, and internal links work", async ({ page }) => {
    const errors = watchForErrors(page);
    await expectOk(page, "/blog/example");

    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("article")).toBeVisible();
    await expect(page.locator("article")).toContainText("5 Signs Your Roof Needs Repair");

    const articleSchema = await page.locator('script[type="application/ld+json"]').textContent();
    expect(articleSchema).toContain('"@type":"Article"');

    await page
      .locator("article")
      .getByRole("link", { name: "roof repair and replacement services" })
      .click();
    await expect(page).toHaveURL(/\/services\/example$/);

    assertNoPageErrors(errors);
  });
});

test.describe("404", () => {
  test("unknown route returns the 404 page", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response, "expected a response").not.toBeNull();
    expect(response!.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("404");
    await expect(page.getByRole("link", { name: "Back to homepage" })).toBeVisible();
  });
});
