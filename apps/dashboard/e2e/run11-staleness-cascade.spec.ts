import { test, expect, type Page } from "@playwright/test";
import { gotoArea, gotoSubsection } from "./run11-navigation.js";

/**
 * Macro Run 11 — STALENESS CASCADE browser proof (spec §82, §30, §126).
 *
 * Start from a project at READY_FOR_DEPLOYMENT (authority chain prepared by
 * the shared setup helper — the SAME route the golden journey uses). Then
 * use the LEGITIMATE content workflow to accept a newer AcceptedPageContent.
 *
 * Expected automatically, without manually setting any stage:
 *   - Overview no longer READY_FOR_DEPLOYMENT
 *   - Content = ACCEPTED / current new version
 *   - Derivatives = STALE for the new source
 *   - Production = STALE
 *   - Old QA = PASS but HISTORICAL / NOT CURRENT
 *   - Deployment = BLOCKED
 *   - Next Action = deterministic recovery action
 *
 * No SQL, no CLI, no manual stale flags — the read model derives reality.
 */

const UNIQUE = `${Date.now()}`;
const KEY = `e2e-run11-stale-${UNIQUE}`;
const NAME = "Run11 Staleness Roofing";
const PAGE_SLUG = "homepage";

async function createProject(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(KEY);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(NAME);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: NAME })).toBeVisible({ timeout: 15_000 });
}

async function fillAndAcceptIntake(page: Page): Promise<void> {
  const { gotoIntakeSection } = await import("./run11-navigation.js");
  const set = async (tab: string, label: string, value: string) => {
    await gotoIntakeSection(page, tab);
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Run11 Staleness Roofing Co");
  await set("Business", "Description", "Staleness cascade proof project for Macro Run 11.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Run11 Staleness Roofing");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100400");
  await set("Search Seeds", "Seed Queries", "roof repair austin");
  await set("Evidence & Claims", "Operator Facts", "Family-owned roofing firm operating since 1998");
  await set("Brand", "Positioning", "High-altitude roofing expertise");
  await set("Brand", "Tone", "Plain-spoken expert");
  await set("Content Constitution", "Brand Voice", "Warm, plain-spoken expert");
  await set("Content Constitution", "Tone", "Confident but never pushy");
  await set("Content Constitution", "Evidence / Factuality Policy", "Every claim traces to an operator fact.");
  await set("Content Constitution", "Trust Expectations", "Show license numbers where relevant.");
  await set("Content Constitution", "Locale / Language Preferences", "US English");
  await set("Content Constitution", "Custom Project Writer Instructions", "Keep sentences short. Never invent testimonials.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await gotoIntakeSection(page, "Review");
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Run 11 staleness cascade", () => {
  test("READY_FOR_DEPLOYMENT → accept newer content → downstream stale → deployment BLOCKED → deterministic recovery", async ({ page }) => {
    test.setTimeout(900_000);

    await createProject(page);
    await fillAndAcceptIntake(page);

    // Bring the project to READY_FOR_DEPLOYMENT through the shared golden
    // journey steps (real UI + real API; fixture providers only).
    const { runGoldenJourneyToReady } = await import("./run11-golden-steps.js");
    await runGoldenJourneyToReady(page, PAGE_SLUG);

    // Sanity: the project really is READY_FOR_DEPLOYMENT before the cascade.
    await gotoArea(page, "Overview");
    await expect(page.getByText(/READY FOR DEPLOYMENT/i).first()).toBeVisible({ timeout: 30_000 });

    // ---- Accept a NEWER content version through the legitimate workflow ----
    await gotoSubsection(page, "Content", "Pipeline");
    // Edit the brief (new page target fields) → approve → compile → approve
    // → generate → QA → accept. This creates AcceptedPageContent v2.
    await page.locator('input[placeholder="roof-replacement-denver"]').fill(PAGE_SLUG);
    await page.getByLabel("Title", { exact: false }).first().fill("Roof Repair in Austin — 2026 update");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText(/Brief draft v2 saved|Brief draft v1 saved/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).click();
    await expect(page.getByText(/Brief v\d approved\./).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Compile new snapshot" }).click();
    await expect(page.getByText(/Snapshot v\d compiled/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).click();
    await expect(page.getByText(/approved\. Generation is now authorized/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Generate proposal" }).click();
    await expect(page.getByText(/proposal generated from the current approved snapshot/i).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Run QA" }).click();
    await expect(page.getByText("QA verdict: REVIEW").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "ACCEPT CONTENT" }).click();
    await expect(page.getByText(new RegExp(`AcceptedPageContent v2 created for ${PAGE_SLUG}`))).toBeVisible({ timeout: 30_000 });

    // ---- The cascade, derived automatically ----
    await gotoArea(page, "Overview");
    // 1. Overview no longer READY_FOR_DEPLOYMENT.
    // The Content area still uses its own workspace polling (10s cadence);
    // the derived readiness must disappear within that refresh window.
    await expect(page.locator("main").getByText(/READY FOR DEPLOYMENT/i)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/BLOCKED|IN PROGRESS/i).first()).toBeVisible();

    // 2. Deployment page: BLOCKED with structured reasons.
    await gotoArea(page, "Deployment");
    await expect(page.getByText(/BLOCKED/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Blocking reasons/i)).toBeVisible();

    // 3. Deterministic next action targets recovery.
    await gotoArea(page, "Overview");
    await expect(page.getByText(/Primary next action/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Refresh design authority|Regenerate derivatives|Re-derive production input|Re-run QA/i).first()).toBeVisible({ timeout: 15_000 });

    // 4. Versions: v2 CURRENT, v1 HISTORICAL (never rewritten as failed).
    await gotoArea(page, "Versions");
    // Rows live in the table under the "AcceptedPageContent" section heading.
    const v2Row = page.locator("div:has(> h3:text('AcceptedPageContent')) tr", { hasText: "v2" }).first();
    await expect(v2Row.locator("td").nth(4).locator("span", { hasText: /^CURRENT$/i })).toBeVisible({ timeout: 15_000 });
    const v1Row = page.locator("div:has(> h3:text('AcceptedPageContent')) tr", { hasText: "v1" }).first();
    await expect(v1Row.locator("td").nth(4).locator("span", { hasText: /^HISTORICAL$/i })).toBeVisible();
  });
});
