import type { Page } from "@playwright/test";

/**
 * Run 11 navigation helpers for E2E journeys.
 *
 * The operator shell is URL-routed with side navigation links; vertical
 * capabilities are subsections inside areas. These helpers centralize the
 * selectors so the journeys stay readable and behavioral assertions are
 * untouched.
 */

/** Navigate to a top-level area via the side navigation. */
export async function gotoArea(page: Page, area: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Project areas" })
    .getByRole("link", { name: area, exact: true })
    .click();
  await page.waitForTimeout(100);
}

/** Navigate to an intake section (Business, Review, Content Constitution, …). */
export async function gotoIntakeSection(page: Page, section: string): Promise<void> {
  await gotoArea(page, "Intake");
  await page.getByRole("button", { name: section, exact: true }).click();
}

/**
 * Navigate to an area subsection (e.g. Research → Competitors,
 * Assets → Visual Slots, Content → Derivatives). Subsections render as
 * aria tabs in some areas and plain buttons in others.
 */
export async function gotoSubsection(page: Page, area: string, subsection: string): Promise<void> {
  await gotoArea(page, area);
  const tab = page.getByRole("tab", { name: subsection, exact: true });
  if (await tab.count()) {
    await tab.click();
  } else {
    await page.getByRole("button", { name: subsection, exact: true }).click();
  }
}
