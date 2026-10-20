import { test, expect, type Page } from "@playwright/test";
import { gotoArea, gotoIntakeSection } from "./run11-navigation.js";
import { runGoldenJourneyToReady } from "./run11-golden-steps.js";

/**
 * Macro Run 13 — PRODUCTION DELIVERY & ROLLBACK E2E (P1-04).
 *
 * Real browser journey through the full release lifecycle:
 * Candidate → Preview → QA → Approve (Alice) → Publish → Verify → Monitor → Rollback
 *
 * Runs against the REAL topology:
 * - Built Dashboard (dist)
 * - Real Operator API
 * - Real PostgreSQL 18 test database
 * - Real release state machine & cryptographic HMAC seals
 * - Real Playwright browser driving Chromium
 */

const UNIQUE = `${Date.now()}`;
const KEY = `e2e-run13-${UNIQUE}`;
const NAME = "Run13 Production Delivery Site";
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
  await set("Business", "Business Name", "Run13 Roofing Co");
  await set("Business", "Description", "Commercial and residential roofing in Austin operated by Run 13 delivery.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Run13 Roofing");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100400");
  await set("Search Seeds", "Seed Queries", "roof restoration austin");
  await set("Evidence & Claims", "Operator Facts", "Commercial and residential roofing in Austin since 2005");
  await set("Brand", "Positioning", "Austin premier roofing contractor");
  await set("Brand", "Tone", "Plain-spoken expert");
  await set("Content Constitution", "Brand Voice", "Warm, plain-spoken expert");
  await set("Content Constitution", "Tone", "Confident but never pushy");
  await set("Content Constitution", "Evidence / Factuality Policy", "Every claim traces to an operator fact.");
  await set("Content Constitution", "Trust Expectations", "Show license numbers.");
  await set("Content Constitution", "Locale / Language Preferences", "US English");
  await set("Content Constitution", "Custom Project Writer Instructions", "Clear, concise roofing guidance.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await gotoIntakeSection(page, "Review");
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });
}

async function requestReleaseToken(page: Page, input: {
  actorId: string;
  actorName: string;
  actorRole: string;
  permissions?: string[];
  audience?: string;
}): Promise<string> {
  const url = new URL(page.url());
  const match = url.pathname.match(/\/projects\/([^/]+)\//);
  const projectId = match ? decodeURIComponent(match[1]!) : "";

  const res = await page.request.post("http://127.0.0.1:4177/create-release-token", {
    data: {
      projectId,
      actorId: input.actorId,
      actorName: input.actorName,
      actorRole: input.actorRole,
      permissions: input.permissions ?? ["DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH"],
      audience: input.audience ?? "factory-release-governance",
    },
  });
  if (!res.ok()) throw new Error(`create-release-token failed: ${res.status()}`);
  const json = await res.json();
  return json.token as string;
}

test.describe("Run 13 governed production delivery lifecycle", () => {
  test("full browser journey: candidate → preview → approve → publish → monitor → rollback", async ({ page }) => {
    test.setTimeout(900_000);

    // 1. Project setup and intake
    await createProject(page);
    await fillAndAcceptIntake(page);

    // 2. Bring project to READY_FOR_DEPLOYMENT via golden steps
    await runGoldenJourneyToReady(page, PAGE_SLUG);

    // 3. Navigate to Governed Deployment Area
    await gotoArea(page, "Overview");
    await expect(page.getByText(/READY FOR DEPLOYMENT/i).first()).toBeVisible({ timeout: 30_000 });
    await gotoArea(page, "Deployment");
    await expect(page.getByText(/Governed Production Delivery/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/READY_FOR_DEPLOYMENT/i).first()).toBeVisible();

    // Verify Candidate card is rendered
    await expect(page.getByText(/1\. Candidate Build & QA/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Prepare Candidate Preview/i })).toBeEnabled();

    // 4. Stage 1: Prepare Candidate Preview
    await page.getByRole("button", { name: /Prepare Candidate Preview/i }).click();
    await expect(page.getByText(/Candidate preview successfully created and verified/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("span", { hasText: "Verified" }).first()).toBeVisible();

    // 5. Negative Test: Unauthorized actor cannot approve release
    const unauthorizedToken = await requestReleaseToken(page, {
      actorId: "actor-mallory",
      actorName: "Mallory Attacker",
      actorRole: "VIEWER",
      permissions: [], // zero permissions
    });

    const tokenInput = page.locator('input[type="password"]');
    await tokenInput.fill(unauthorizedToken);
    await expect(page.getByRole("button", { name: /Approve Release for Production/i })).toBeEnabled();
    await page.getByRole("button", { name: /Approve Release for Production/i }).click();
    await expect(page.getByText(/Permission denied|unauthorized|failed to approve|lacks required permission/i).first()).toBeVisible({ timeout: 15_000 });

    // 6. Positive Test: Alice (authorized Release Manager) approves release
    const aliceToken = await requestReleaseToken(page, {
      actorId: "actor-alice",
      actorName: "Alice ReleaseManager",
      actorRole: "DEPLOYER",
      permissions: ["DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH"],
    });

    await tokenInput.fill(aliceToken);
    await page.getByRole("button", { name: /Approve Release for Production/i }).click();
    await expect(page.getByText(/Release approval successfully verified and cryptographically sealed/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("span", { hasText: "SEALED" }).first()).toBeVisible();
    await expect(page.getByText(/Alice ReleaseManager/i)).toBeVisible();

    // 7. Stage 3: Publish Approved Release to Production
    await expect(page.getByRole("button", { name: /Publish Approved Release/i })).toBeEnabled();
    await page.getByRole("button", { name: /Publish Approved Release/i }).click();
    await expect(page.getByText(/promoted to Cloudflare production and verified/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("span", { hasText: "Live" }).first()).toBeVisible();

    // 8. Stage 4: Production Monitoring & Search Quality
    await expect(page.getByText(/Production Monitoring & Search Quality/i)).toBeVisible();
    const runCheckButton = page.getByRole("button", { name: /Run Operational Check/i });
    await expect(runCheckButton).toBeEnabled();
    await runCheckButton.click();
    await expect(page.getByText(/Operational monitoring check completed successfully/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Technical Verification/i)).toBeVisible();
    await expect(page.getByText(/Google Search Console/i)).toBeVisible();

    // 9. Stage 5: Rollback to Known-Good
    await expect(page.getByRole("button", { name: /Explicit Rollback to Known-Good/i })).toBeEnabled();
    await page.getByRole("button", { name: /Explicit Rollback to Known-Good/i }).click();
    await expect(page.getByText(/Explicit rollback executed and production verified/i)).toBeVisible({ timeout: 60_000 });

    // 10. Audit History Integrity: verify historical entries are immutably recorded
    await expect(page.getByText(/Deployment Audit History/i)).toBeVisible();
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("td").nth(1)).toHaveText("rolled_back");
    await expect(rows.first().locator("td").nth(5)).toHaveText("Yes");
  });
});
