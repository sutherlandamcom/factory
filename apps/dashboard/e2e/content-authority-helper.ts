import { gotoIntakeSection, gotoSubsection } from "./run11-navigation.js";
import { expect, type Page } from "@playwright/test";
import { acceptSearchGap } from "./search-gap-helper.js";
export async function fillAndAcceptIntake(page: Page): Promise<void> {
  const set = async (tab: string, label: string, value: string) => {
    await gotoIntakeSection(page, tab);
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Design Authority Roofing Co");
  await set("Business", "Description", "Family roofing company used by the design authority journey test.");
  await set("Business", "Business Model", "Direct-to-consumer services");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Design Authority Roofing");
  await set("Site Identity", "Language", "en");
  await set("Site Identity", "Locale", "en-US");
  await set("Conversion", "Primary Objective", "Generate assessment requests");
  await set("Conversion", "CTA Type", "Call the office");
  await gotoIntakeSection(page, "Conversion");
  await page.getByLabel("Destination Type").selectOption("phone");
  await set("Conversion", "CTA Destination", "+15550100200");
  await set("Search Seeds", "Seed Queries", "roof repair austin");
  await set("Evidence & Claims", "Operator Facts", "Family-owned roofing firm operating since 1998");
  await set("Brand", "Positioning", "High-altitude roofing expertise");
  await set("Brand", "Tone", "Plain-spoken expert");
  await set("Content Constitution", "Brand Voice", "Warm, plain-spoken expert");
  await set("Content Constitution", "Tone", "Confident but never pushy");
  await set("Content Constitution", "Evidence / Factuality Policy", "Every claim traces to an operator fact.");
  await set("Content Constitution", "Trust Expectations", "Show license numbers where relevant.");
  await set("Content Constitution", "Locale / Language Preferences", "US English");
  await set("Content Constitution", "Custom Project Writer Instructions", "Keep sentences short.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await gotoIntakeSection(page, "Review");
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });
}

/** Accepted page content through fixture Search, reviewed Gap and the governed Writer. */
export async function acceptPageContent(page: Page, PAGE_SLUG = "homepage"): Promise<void> {
  await acceptSearchGap(page);
  await gotoSubsection(page, "Content", "Pipeline");
  await expect(page.getByText("Factory Writer Policy")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Derive draft" }).click();
  await expect(page.getByText("Writer policy draft created")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText("Writer policy v1 approved and immutable.")).toBeVisible({ timeout: 15_000 });

  await page.locator('input[placeholder="roof-replacement-denver"]').fill(PAGE_SLUG);
  await page.getByLabel("Title", { exact: false }).first().fill("Roof Repair in Austin");
  await page.getByLabel("Objective", { exact: false }).fill("Convert homeowners researching roof repair into inspection requests.");
  await page.getByLabel("Audience", { exact: false }).fill("Austin homeowners comparing local roofers");
  await page.getByLabel("Structure guidance (one per line)").fill("Storm damage context\nRepair process\nWarranty and trust signals");
  await page.getByLabel("CTA intent", { exact: false }).fill("Book a free roof inspection");

  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText(/Brief draft v1 saved/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).click();
  await expect(page.getByText("Brief v1 approved.")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Compile new snapshot" }).click();
  await expect(page.getByText(/Snapshot v1 compiled/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).click();
  await expect(page.getByText(/approved\. Generation is now authorized/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Generate proposal" }).click();
  await expect(page.getByText(/Proposal generated/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Run QA" }).click();
  await expect(page.getByText("QA verdict: REVIEW")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "ACCEPT CONTENT" }).click();
  await expect(page.getByText(new RegExp(`AcceptedPageContent v1 created for ${PAGE_SLUG}`))).toBeVisible({ timeout: 30_000 });
}

