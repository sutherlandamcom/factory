import { test, expect, type Page } from "@playwright/test";
import http from "node:http";

/**
 * REAL BROWSER Competitors + Content Gap journey (Macro Run 3 acceptance):
 *
 * accepted project (real Intake UI)
 *   -> Search run (fixture SERP provider; trusted backend env)
 *   -> Competitors Research workspace: pick SERP evidence -> acquire
 *      (fixture page provider; zero network) -> candidates render with
 *      classification/acquisition/analysis summaries
 *   -> Content Gaps: propose report -> review gaps -> per-gap
 *      disposition/priority/note -> save review -> ACCEPT v1
 *   -> reload browser -> persists
 *   -> restart Operator WITHOUT resetting DB -> persists
 *   -> accepted v1 remains inspectable and immutable
 *
 * Rules honored: built dashboard served by the real Operator service, real
 * PostgreSQL, no JSON editing, no direct SQL for product actions, zero
 * paid provider calls (fixture modes are trusted backend config for CI).
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
  key: `e2e-gaps-${UNIQUE}`,
  name: "E2E Gaps Roofing",
};

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
  await set("Business", "Business Name", "E2E Gaps Roofing Co");
  await set("Business", "Description", "Family roofing company exercised by the automated Competitors + Content Gap journey.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100100");
  await set("Search Seeds", "Seed Queries", "roof repair austin");
  await set("Evidence & Claims", "Operator Facts", "Serving Austin roofs since 2009 with 12-person crew");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(
    page.locator("span", { hasText: /^APPROVED$/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

async function runSearch(page: Page) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Query", { exact: false }).first().fill("roof repair austin");
  await page.getByRole("button", { name: "Run Search", exact: false }).click();
  await expect(page.locator("text=SERP", { hasText: "SERP" }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("Competitors + Content Gap journey", () => {
  test("accepted inputs -> search -> acquire competitors -> gap proposal -> review -> ACCEPT v1 -> reload/restart persistence", async ({ page }) => {
    test.setTimeout(300_000);
    await createAndAcceptProject(page);
    await runSearch(page);

    // ---- Competitors Research ----
    await page.getByRole("button", { name: "Competitors Research", exact: true }).click();
    await expect(page.locator("text=Competitor evidence run")).toBeVisible({ timeout: 10_000 });
    await page
      .locator("select")
      .first()
      .selectOption({ index: 0 });
    await page.getByRole("button", { name: "Acquire competitors" }).click();
    await expect(page.locator("text=Candidates (")).toBeVisible({ timeout: 60_000 });
    // Fixture SERP domains acquired through the fixture page provider:
    await expect(page.locator("td", { hasText: "market-leader.example.com" }).first()).toBeVisible();
    await expect(page.locator("text=Analyzed:").first()).toBeVisible();

    // ---- Content Gaps ----
    await page.getByRole("button", { name: "Content Gaps", exact: true }).click();
    await page.getByRole("button", { name: "Propose gap report", exact: true }).click();
    await expect(page.locator("text=Review gaps (")).toBeVisible({ timeout: 60_000 });

    // Edit every gap decision (disposition + priority + note).
    const gapCards = page.locator("div.rounded-md.border", { hasText: "competitor coverage:" });
    const count = await gapCards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const card = gapCards.nth(i);
      await card.locator("select").nth(0).selectOption(i % 2 === 0 ? "REQUIRED" : "OPTIONAL");
      await card.locator("select").nth(1).selectOption(i % 2 === 0 ? "HIGH" : "MEDIUM");
      await card.locator("input").first().fill(`e2e note ${i}`);
    }
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page.locator("text=Decisions saved.")).toBeVisible({ timeout: 30_000 });

    // Accept binds the exact reviewed digest.
    await page.getByRole("button", { name: /Accept as v/ }).click();
    await expect(page.locator("text=/Content gaps accepted as version 1/")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("text=Accepted snapshot v1 (immutable)")).toBeVisible({ timeout: 30_000 });

    // ---- Reload persistence ----
    await page.reload();
    // Reload lands on the projects list (view state is not persisted); reopen.
    await page.getByRole("button", { name: new RegExp(PROJECT.name) }).first().click();
    await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Content Gaps", exact: true }).click();
    await expect(page.locator("text=Accepted versions")).toBeVisible({ timeout: 15_000 });
    await page.locator("button", { hasText: "v1" }).first().click();
    await expect(page.locator("text=Accepted snapshot v1 (immutable)")).toBeVisible({ timeout: 15_000 });

    // ---- Real operator restart WITHOUT database reset ----
    await supervisorCall("/restart");
    await page.waitForTimeout(1_000);
    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(PROJECT.name) }).first().click();
    await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Content Gaps", exact: true }).click();
    await expect(page.locator("text=Accepted versions")).toBeVisible({ timeout: 15_000 });
    await page.locator("button", { hasText: "v1" }).first().click();
    await expect(page.locator("text=Accepted snapshot v1 (immutable)")).toBeVisible({ timeout: 15_000 });
    // v1 stays inspectable; digest-bound lineage visible.
    await expect(page.locator("text=Report digest:").first()).toBeVisible();
  });
});
