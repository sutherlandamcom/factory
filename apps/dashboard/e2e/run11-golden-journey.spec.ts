import { test, expect, type Page } from "@playwright/test";
import { gotoArea, gotoIntakeSection, gotoSubsection } from "./run11-navigation.js";
import { runGoldenJourneyToReady } from "./run11-golden-steps.js";

/**
 * Macro Run 11 — GOLDEN OPERATOR JOURNEY (spec §77–79).
 *
 * One coherent browser workflow across Runs 1–10 against the REAL topology:
 * built Dashboard + real Operator API + real PostgreSQL + fixture providers.
 *
 * CREATE PROJECT → INTAKE (structured inputs) → ACCEPT INPUTS
 *   → RESEARCH (search → competitors → gaps → accept)
 *   → CONTENT (policy → brief → prompt → approval → proposal → QA → ACCEPT)
 *   → ASSETS (upload → approve → assign)
 *   → DESIGN (fixture provider → accept)
 *   → VISUAL RESOLUTION (plan → classify → prompt → generate → accept → set)
 *   → DERIVATIVES (enable → generate → accept set)
 *   → PRODUCTION (input → candidate → build → QA)
 *   → OVERVIEW shows READY_FOR_DEPLOYMENT
 *
 * Rules honored: no SQL/CLI/curl/raw-JSON for any product action; no paid
 * provider calls (fixture modes are trusted backend config only); no API
 * mocking; no handcrafted frontend state.
 */

const UNIQUE = `${Date.now()}`;
const KEY = `e2e-run11-${UNIQUE}`;
const NAME = "Run11 Golden Roofing";
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
  const set = async (tab: string, label: string, value: string) => {
    await gotoIntakeSection(page, tab);
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Run11 Golden Roofing Co");
  await set("Business", "Description", "Family roofing company operated end to end by the Run 11 golden journey.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Run11 Golden Roofing");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100300");
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

test.describe("Run 11 golden operator journey", () => {
  test("intake → research → content → assets → design → visuals → derivatives → production → READY_FOR_DEPLOYMENT", async ({ page }) => {
    test.setTimeout(900_000);

    await createProject(page);
    await fillAndAcceptIntake(page);

    // Overview must answer the four operator questions from the start.
    await gotoArea(page, "Overview");
    await expect(page.getByText(/Primary next action/i)).toBeVisible({ timeout: 15_000 });

    await runGoldenJourneyToReady(page, PAGE_SLUG);

    // Terminal Run 11 state: READY_FOR_DEPLOYMENT, derived from authority.
    await gotoArea(page, "Overview");
    await expect(page.getByText(/READY FOR DEPLOYMENT/i).first()).toBeVisible({ timeout: 30_000 });
    await gotoArea(page, "Deployment");
    await expect(page.getByText(/READY_FOR_DEPLOYMENT/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Production delivery lifecycle — implemented in Macro Run 13/)).toBeVisible();
    // No publish action exists in Run 11 (the header next-action button is
    // navigation only; lifecycle steps render as non-interactive spans).
    const deploymentArea = page.locator("main");
    await expect(deploymentArea.getByRole("button", { name: /Publish|Rollback/i })).toHaveCount(0);
    await expect(deploymentArea.getByRole("button", { name: /^Deploy/ })).toHaveCount(0);
  });
});
