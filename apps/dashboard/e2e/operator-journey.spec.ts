import { test, expect, type Page } from "@playwright/test";
import http from "node:http";

/**
 * REAL BROWSER Operator journey (Macro Run 1 acceptance):
 *
 * New Project -> enter Project Intake -> Content Constitution -> Save Draft
 *   -> READY -> Review -> ACCEPT v1 -> APPROVED / current v1
 *   -> reload browser -> v1 persists
 *   -> restart Operator service WITHOUT resetting DB -> v1 persists
 *   -> edit -> Save -> CHANGED (v1 unchanged)
 *   -> ACCEPT v2 -> v2 CURRENT ACCEPTED -> v1 remains in history (not current)
 *
 * Rules honored:
 * - built dashboard served by the actual Operator service (real topology);
 * - dedicated real PostgreSQL test database;
 * - no JSON editing, no direct SQL for product actions, no API mocking.
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
  key: `e2e-journey-${UNIQUE}`,
  name: "E2E Journey Roofing",
};

/** Fill intake fields needed to reach READY (including Audience segments and Conversion CTA destination). */
async function fillIntake(page: Page) {
  const set = async (tab: string, label: string, value: string) => {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };

  await set("Business", "Business Name", "Journey Test Roofing Co");
  await set("Business", "Description", "Family roofing company used by the automated operator journey test.");
  await set("Audience", "Segments", "Residential Homeowners\nCommercial Property Managers");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100100");
  await set("Content Constitution", "Custom Project Writer Instructions", "Keep sentences short. Never invent testimonials.");
}

async function expectStatus(page: Page, status: string) {
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(
    page.locator("span", { hasText: new RegExp(`^${status}$`, "i") }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

/** Re-open the project from the Projects list after a full page reload. */
async function openProject(page: Page, projectName = PROJECT.name) {
  await page.goto("/");
  const projectButton = page.getByRole("button", { name: new RegExp(projectName) }).first();
  await projectButton.waitFor({ state: "visible", timeout: 15_000 });
  await projectButton.click();
  await expect(page.locator("h1", { hasText: projectName })).toBeVisible({ timeout: 10_000 });
}

test.describe("Operator journey", () => {
  test("create -> intake -> save -> accept v1 -> restart -> edit -> accept v2 (v1 preserved)", async ({ page }) => {
    test.setTimeout(180_000);

    // 1. New Project via the UI form.
    await page.goto("/");
    await page.getByRole("button", { name: "New Project" }).click();
    await page.locator('input[placeholder="e.g. summit-roofing"]').fill(PROJECT.key);
    await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(PROJECT.name);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // 2. Detail page opens immediately; fresh project is editable (DRAFT).
    await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 10_000 });
    await expectStatus(page, "DRAFT");

    // 3. Enter Project Intake: Business, Audience with Segments, Site Identity, Conversion with CTA Destination, Content Constitution.
    await fillIntake(page);

    // 4. Save Draft -> READY (verify save succeeds without schema error).
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect(page.locator("div.bg-red-50")).toHaveCount(0);
    await expectStatus(page, "READY");

    // 5. Review tab -> visibly contains actual audience segments and CTA destination.
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("Residential Homeowners, Commercial Property Managers")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("tel:+15550100100")).toBeVisible({ timeout: 10_000 });

    // ACCEPT v1 -> APPROVED, current v1.
    await expect(page.getByRole("button", { name: "ACCEPT INPUTS" })).toBeEnabled();
    await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
    await expectStatus(page, "APPROVED");

    // Versions tab shows exactly v1 as CURRENT ACCEPTED.
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const v1Card = page.locator("div.rounded-lg.border.p-4", { hasText: /^v1/ }).first();
    await expect(v1Card.locator("span", { hasText: "CURRENT ACCEPTED" })).toBeVisible();
    const v1DigestValue = (await v1Card.locator("div.font-mono").innerText()).replace("digest:", "").trim();
    expect(v1DigestValue).toMatch(/^[0-9a-f]{64}$/);

    // 6. Reload the browser — accepted v1 persists.
    await page.reload();
    await openProject(page);
    await expectStatus(page, "APPROVED");

    // 7. Restart the Operator service WITHOUT resetting the DB.
    await supervisorCall("/restart");
    await openProject(page);
    await expectStatus(page, "APPROVED");

    // v1 still current after restart.
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const v1After = page.locator("div.rounded-lg.border.p-4", { hasText: /^v1/ }).first();
    await expect(v1After.locator("span", { hasText: "CURRENT ACCEPTED" })).toBeVisible();
    await expect(v1After.locator("div.font-mono")).toContainText(v1DigestValue);

    // 8. Edit the draft -> Save -> CHANGED (v1 must remain unchanged).
    await page.getByRole("button", { name: "Business", exact: true }).click();
    await page.getByLabel("Description").first().fill(
      "UPDATED after acceptance by the operator journey (v2 candidate).",
    );
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect(page.locator("div.bg-red-50")).toHaveCount(0);
    await expectStatus(page, "CHANGED");

    // v1 digest must be unchanged.
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const v1BeforeV2 = page.locator("div.rounded-lg.border.p-4", { hasText: /^v1/ }).first();
    await expect(v1BeforeV2.locator("span", { hasText: "CURRENT ACCEPTED" })).toBeVisible();
    await expect(v1BeforeV2.locator("div.font-mono")).toContainText(v1DigestValue);

    // 9. ACCEPT v2 -> v2 CURRENT ACCEPTED, v1 remains inspectable without badge.
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("button", { name: "ACCEPT INPUTS" })).toBeEnabled();
    await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
    await expectStatus(page, "APPROVED");

    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const v2Card = page.locator("div.rounded-lg.border.p-4", { hasText: /^v2/ }).first();
    await expect(v2Card.locator("span", { hasText: "CURRENT ACCEPTED" })).toBeVisible();
    const v2Digest = (await v2Card.locator("div.font-mono").innerText()).replace("digest:", "").trim();
    expect(v2Digest).not.toEqual(v1DigestValue);

    const v1Final = page.locator("div.rounded-lg.border.p-4", { hasText: /^v1/ }).first();
    await expect(v1Final.locator("div.font-mono")).toContainText(v1DigestValue);
    await expect(v1Final.locator("span", { hasText: "CURRENT ACCEPTED" })).toHaveCount(0);
  });

  test("regression: conversion CTA destination string round-trips through Dashboard UI without intake_schema_invalid", async ({ page }) => {
    test.setTimeout(120_000);
    const regKey = `cta-reg-${Date.now()}`;
    const regName = "CTA Regression Roofing";

    await page.goto("/");
    await page.getByRole("button", { name: "New Project" }).click();
    await page.locator('input[placeholder="e.g. summit-roofing"]').fill(regKey);
    await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(regName);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.locator("h1", { hasText: regName })).toBeVisible({ timeout: 10_000 });
    await expectStatus(page, "DRAFT");

    // Navigate to Conversion tab and enter CTA Destination
    await page.getByRole("button", { name: "Conversion", exact: true }).click();
    await page.getByLabel("CTA Destination", { exact: false }).first().fill("https://example.com/contact-us");

    // Save Draft
    await page.getByRole("button", { name: "Save Draft" }).click();

    // Verify Save succeeds and no schema error is shown
    await expect(page.locator("div.bg-red-50")).toHaveCount(0);

    // Full page reload to prove round-trip through backend and DB
    await page.reload();
    await openProject(page, regName);

    // Inspect Conversion tab again: CTA destination input must contain the exact string
    await page.getByRole("button", { name: "Conversion", exact: true }).click();
    const ctaInput = page.getByLabel("CTA Destination", { exact: false }).first();
    await expect(ctaInput).toHaveValue("https://example.com/contact-us");

    // Inspect Review tab: CTA field must visibly render the string
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("https://example.com/contact-us")).toBeVisible();
  });
});
