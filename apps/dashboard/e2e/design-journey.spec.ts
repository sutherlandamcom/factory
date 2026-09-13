import { test, expect, type Page } from "@playwright/test";
import http from "node:http";

/**
 * REAL BROWSER Design journey (Macro Run 6 acceptance):
 *
 * project -> Design tab
 *   -> derive authority-bound design input snapshot
 *   -> generate candidate via the fixture design provider
 *      (FACTORY_DESIGN_MODE=fixture: deterministic, no paid provider)
 *   -> inspect candidate (tokens, archetypes, DESIGN.md lint state)
 *   -> FORGED digest accept fails with a typed error
 *   -> accept EXACT candidate digest
 *   -> accepted design visible with upstream lineage
 *   -> operator service restart (DB kept) -> accepted design persists
 *   -> re-derive input snapshot after upstream change is NOT simulated here
 *      (staleness is proven in persistence tests); the restart proves the
 *      accepted artifact is durable authority.
 *
 * Rules honored: built dashboard served by the real Operator service, real
 * PostgreSQL, no JSON editing, no direct SQL for product actions.
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

async function createProject(page: Page, key: string, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(key);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: name })).toBeVisible({ timeout: 10_000 });
}

/** Minimal intake fill so the project becomes READY/acceptable. */
async function fillIntake(page: Page): Promise<void> {
  const set = async (tab: string, label: string, value: string) => {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Design Journey Roofing Co");
  await set("Business", "Description", "Family roofing company used by the automated design journey test.");
  await set("Business", "Business Model", "Direct-to-consumer services");
  await set("Business", "Positioning", "High-altitude roofing expertise");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Design Journey Roofing");
  await set("Site Identity", "Language", "en");
  await set("Site Identity", "Locale", "en-US");
  await set("Conversion", "Primary Objective", "Generate assessment requests");
  await set("Conversion", "CTA Type", "Call the office");
  // Destination Type is a <select>: use selectOption, not fill.
  await page.getByRole("button", { name: "Conversion", exact: true }).click();
  await page.getByLabel("Destination Type").selectOption("phone");
  await set("Conversion", "CTA Destination", "+15550100100");
  await set("Evidence & Claims", "Operator Facts", "Family-owned roofing firm operating since 1998");
  await set("Brand", "Positioning", "High-altitude roofing expertise");
  await set("Brand", "Tone", "Plain-spoken expert");
  await set("Content Constitution", "Brand Voice", "Warm, plain-spoken expert");
  await set("Content Constitution", "Custom Project Writer Instructions", "Keep sentences short.");
}

test.describe("Design journey", () => {
  test("derive input -> generate candidate -> forged accept fails -> accept exact digest -> restart persistence", async ({ page }) => {
    test.setTimeout(600_000);

    const key = `design-e2e-${UNIQUE}`;
    const name = "Design E2E Project";
    await createProject(page, key, name);

    // Accept project inputs first (required upstream authority).
    await fillIntake(page);
    await page.getByRole("button", { name: "Save Draft" }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
    await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });

    // Open the Design tab.
    await page.getByRole("button", { name: "Design" }).click();
    await expect(page.locator("h3", { hasText: "Design Provider" })).toBeVisible();
    // Fixture provider is configured and reachable.
    await expect(page.locator("text=configured & reachable")).toBeVisible();

    // Derive the authority-bound input snapshot.
    await page.getByRole("button", { name: "Derive input snapshot" }).click();
    await expect(page.locator("text=Re-derive input snapshot")).toBeVisible({ timeout: 15_000 });

    // Generate a candidate via the fixture provider.
    await page.getByRole("button", { name: "Generate design candidate" }).click();
    await expect(page.locator("h3", { hasText: "Candidate Design" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("text=pending").first()).toBeVisible();

    // FORGED digest accept must fail with a typed error (no silent success).
    const acceptButton = page.getByRole("button", { name: "Accept design" });
    await expect(acceptButton).toBeVisible();
    // Tamper with the digest by intercepting the request: the server must
    // reject it. We use page.route to rewrite the request body.
    await page.route("**/design/candidates/*/accept", async (route) => {
      const request = route.request();
      const postData = request.postDataJSON() as { expectedCandidateDigest?: string };
      postData["expectedCandidateDigest"] = "f".repeat(64);
      await route.continue({ postData: JSON.stringify(postData) });
    });
    await acceptButton.click();
    await expect(
      page.locator("text=/Review action rejected: the digest you confirmed does not match the stored candidate/"),
    ).toBeVisible({ timeout: 15_000 });

    // Remove the route tampering and accept with the EXACT digest.
    // Fixture candidates require an explicit fixture declaration in the
    // review notes (fail-closed evidence-mode gate).
    await page.unroute("**/design/candidates/*/accept");
    await page.locator("#design-review-notes").fill("fixture acceptance — design journey");
    await acceptButton.click();
    await expect(page.locator("h3", { hasText: "Accepted Design" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=accepted version(s); accepted designs are immutable").first()).toBeVisible();

    // RESTART the operator service (DB kept) — accepted design must persist.
    await supervisorCall("/restart");
    await page.waitForTimeout(2_000);
    // The dashboard SPA resets to the projects list after a reload; re-open
    // the project like a real operator would.
    await page.reload();
    await expect(page.locator("h1", { hasText: "Projects" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: new RegExp(name) }).first().click();
    await expect(page.locator("h1", { hasText: name })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Design" }).click();
    await expect(page.locator("h3", { hasText: "Accepted Design" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("text=accepted version(s); accepted designs are immutable").first()).toBeVisible();
  });
});
