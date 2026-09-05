import { test, expect, type Page } from "@playwright/test";
import http from "node:http";

/**
 * REAL BROWSER Search Intelligence journey (Macro Run 2 acceptance):
 *
 * existing accepted project (created through the real Intake UI)
 *   -> Search workspace shows accepted-input lineage + seeds
 *   -> pick seed query -> run search (deterministic fixture provider;
 *      configured via trusted backend env, never the browser)
 *   -> exact SERP results + GROUNDED RESEARCH + Search Intelligence render
 *   -> reload browser -> run persists (inspectable from history)
 *   -> restart Operator service WITHOUT resetting DB -> state persists
 *   -> history remains inspectable
 *
 * Rules honored: built dashboard served by the real Operator service, real
 * PostgreSQL, no JSON editing, no direct SQL for product actions, no paid
 * provider calls (fixture mode is backend-trusted config for CI).
 */

const SUPERVISOR = `http://127.0.0.1:${process.env.FACTORY_E2E_SUPERVISOR_PORT || 4177}`;

function supervisorCall(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SUPERVISOR}${path}`, { method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`supervisor ${path} -> ${res.statusCode} ${body}`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const UNIQUE = `${Date.now()}`;
const PROJECT = {
  key: `e2e-search-${UNIQUE}`,
  name: "E2E Search Roofing",
};

async function openProject(page: Page, projectName = PROJECT.name) {
  await page.goto("/");
  const projectButton = page.getByRole("button", { name: new RegExp(projectName) }).first();
  await projectButton.waitFor({ state: "visible", timeout: 15_000 });
  await projectButton.click();
  await expect(page.locator("h1", { hasText: projectName })).toBeVisible({ timeout: 10_000 });
}

async function createAndAcceptProject(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(PROJECT.key);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(PROJECT.name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 10_000 });

  const set = async (tab: string, label: string, value: string) => {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "E2E Search Roofing Co");
  await set("Business", "Description", "Family roofing company exercised by the automated Search Intelligence journey.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100100");
  await set("Search Seeds", "Seed Queries", "roof repair austin");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(
    page.locator("span", { hasText: /^APPROVED$/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Search Intelligence journey", () => {
  test("accepted inputs -> search run -> SERP + grounded + intelligence -> reload/restart persistence", async ({ page }) => {
    test.setTimeout(240_000);

    // 1. Create project through the real Intake flow and accept v1.
    await createAndAcceptProject(page);

    // 2. Open the Search workspace; accepted-input lineage + seeds visible.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("search-workspace")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("search-accepted-version")).toHaveText(/v1/);
    await expect(page.getByRole("button", { name: "roof repair austin" })).toBeVisible();

    // Readiness shows a configured provider (fixture mode in E2E).
    await expect(page.getByTestId("search-readiness")).toContainText("Ready", { timeout: 10_000 });

    // 3. Pick the seed query and run the search.
    await page.getByRole("button", { name: "roof repair austin" }).click();
    await page.getByLabel("Location", { exact: false }).fill("Austin, TX");
    await page.getByRole("button", { name: "Run Search" }).click();

    // 4. Run detail renders: SERP organic results (human-readable list).
    await expect(page.getByTestId("search-run-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("serp-organic").locator("li")).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByTestId("serp-organic")).toContainText("#1");
    await expect(page.getByTestId("serp-organic")).toContainText("market-leader.example.com");
    await expect(page.getByTestId("serp-paa")).toContainText("How much does roof repair austin cost");
    await expect(page.getByTestId("serp-related")).toContainText("roof repair austin cost");

    // 5. GROUNDED RESEARCH is rendered SEPARATELY and labeled as research, not rankings.
    await expect(
      page.getByRole("heading", { name: /GROUNDED RESEARCH/i }),
    ).toBeVisible();
    await expect(page.getByTestId("grounded-label")).toContainText("fixture-gemini-flash");
    await expect(page.getByTestId("grounded-queries")).toContainText("roof repair austin");
    await expect(page.getByTestId("grounded-sources")).toContainText("Fixture: local market overview");

    // 6. Search Intelligence renders semantic groups.
    await expect(page.getByTestId("intel-body")).toContainText("commercial", { timeout: 10_000 });
    await expect(page.getByTestId("intel-clusters")).toContainText("Core: roof repair austin");
    await expect(page.getByTestId("intel-questions")).toContainText("How much does roof repair austin cost?");
    await expect(page.getByTestId("intel-evidence")).toContainText("serp_snapshot");

    // No secret/config leakage anywhere on the page.
    const pageText = await page.locator("body").innerText();
    for (const forbidden of ["DATAFORSEO_PASSWORD", "OPENROUTER_API_KEY", "sk-", "password"]) {
      expect(pageText.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // 7. Reload the browser — run persists and is re-openable from history.
    await page.reload();
    await openProject(page);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("search-history").locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("search-history")).toContainText("roof repair austin");
    await page.getByRole("button", { name: "Inspect" }).first().click();
    await expect(page.getByTestId("serp-organic").locator("li")).toHaveCount(3, { timeout: 15_000 });

    // 8. Restart the Operator service WITHOUT resetting the DB.
    await supervisorCall("/restart");
    await openProject(page);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("search-accepted-version")).toHaveText(/v1/, { timeout: 15_000 });
    await expect(page.getByTestId("search-history").locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });

    // 9. History remains inspectable after restart: same SERP evidence.
    await page.getByRole("button", { name: "Inspect" }).first().click();
    await expect(page.getByTestId("serp-organic")).toContainText("market-leader.example.com", { timeout: 15_000 });
    await expect(page.getByTestId("intel-body")).toContainText("commercial", { timeout: 15_000 });
  });
});
