import { expect, type Page } from "@playwright/test";
export async function acceptSearchGap(page: Page) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Query", { exact: false }).first().fill("roof repair austin");
  await page.getByRole("button", { name: "Run Search", exact: false }).click();
  await expect(page.locator("text=SERP", { hasText: "SERP" }).first()).toBeVisible({ timeout: 30_000 });
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

    // Item 4: Explicit Search Semantics visible in Review
    await expect(page.locator("text=Search intelligence semantics")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("search-primary-intent")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("search-coverage-requirements")).toBeVisible({ timeout: 10_000 });

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


}
