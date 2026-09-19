import { test, expect, type Page } from "@playwright/test";
import { gotoArea, gotoIntakeSection, gotoSubsection } from "./run11-navigation.js";

/**
 * Run 11 Remediation — ContentPage initial-load race browser regression test.
 *
 * Problem:
 * ContentPage previously allowed brief actions to submit before initial
 * /writer/workspace data had been loaded and adopted into the form,
 * sending empty objective="", audience="", ctaIntent="" which the backend rejects.
 *
 * Proof:
 * 1. Delay initial workspace GET intentionally.
 * 2. Before adoption -> submit is disabled and impossible.
 * 3. Workspace returns -> form adopts server values -> submit becomes enabled.
 * 4. Submit sends correct non-empty values.
 */

const UNIQUE = `${Date.now()}`;
const PROJECT = {
  key: `e2e-race-${UNIQUE}`,
  name: `E2E Race Roofing ${UNIQUE}`,
};

async function setupProjectWithBrief(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(PROJECT.key);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(PROJECT.name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 15_000 });

  const set = async (tab: string, label: string, value: string) => {
    await gotoIntakeSection(page, tab);
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "E2E Race Roofing Co");
  await set("Business", "Description", "Testing race safety in Content workspace.");
  await set("Audience", "Segments", "Commercial Property Owners");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100999");
  await set("Search Seeds", "Seed Queries", "commercial roofing austin");
  await set("Evidence & Claims", "Operator Facts", "Commercial roofing specialists since 2012.");
  await set("Content Constitution", "Brand Voice", "Clear, professional");
  await set("Content Constitution", "Tone", "Authoritative");
  await set("Content Constitution", "Evidence / Factuality Policy", "Grounded in operator facts.");
  await set("Content Constitution", "Trust Expectations", "Include certifications.");
  await set("Content Constitution", "Locale / Language Preferences", "US English");
  await set("Content Constitution", "Custom Project Writer Instructions", "Be direct.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await gotoIntakeSection(page, "Review");
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });

  // Go to Content -> Pipeline and save initial non-empty brief
  await gotoSubsection(page, "Content", "Pipeline");
  await expect(page.getByText("Factory Writer Policy")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Derive draft" }).click();
  await expect(page.getByText("Writer policy draft created")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText("Writer policy v1 approved and immutable.")).toBeVisible({ timeout: 15_000 });

  await page.locator('input[placeholder="roof-replacement-denver"]').fill("commercial-roofing");
  await page.getByLabel("Title", { exact: false }).first().fill("Commercial Roofing in Austin");
  await page.getByLabel("Objective", { exact: false }).fill("Convert commercial building owners into bid requests.");
  await page.getByLabel("Audience", { exact: false }).fill("Austin commercial facility managers.");
  await page.getByLabel("Structure guidance (one per line)").fill("Facility assessment\nProject scope");
  await page.getByLabel("CTA intent", { exact: false }).fill("Request commercial proposal");
  await page.getByLabel(/Explicitly draft\/approve WITHOUT accepted gap lineage/).check();

  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText(/Brief draft v1 saved/)).toBeVisible({ timeout: 15_000 });
}

test.describe("ContentPage initial-load race safety", () => {
  test("delayed workspace GET gates submit until adoption, then submits non-empty adopted values", async ({ page }) => {
    test.setTimeout(180_000);
    await setupProjectWithBrief(page);

    // Navigate to Overview
    await gotoArea(page, "Overview");
    await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 10_000 });

    // Arm deferred route intercept for workspace GET
    let resumeWorkspaceRequest: (() => void) | null = null;
    const workspaceGate = new Promise<void>((resolve) => {
      resumeWorkspaceRequest = resolve;
    });

    let workspaceInterceptionActive = true;
    await page.route("**/api/projects/*/writer/workspace", async (route) => {
      if (workspaceInterceptionActive) {
        // Hold the workspace GET request until resumeWorkspaceRequest is called
        await workspaceGate;
        workspaceInterceptionActive = false;
      }
      await route.continue();
    });

    // Navigate back to Content -> Pipeline while workspace response is held
    await gotoSubsection(page, "Content", "Pipeline");
    await expect(page.getByText("Content Production Brief")).toBeVisible({ timeout: 10_000 });

    const submitButton = page.locator('button:has-text("Create draft"), button:has-text("Update draft")').first();

    // 1. PROVE: Before adoption -> submit is disabled and impossible
    await expect(submitButton).toBeDisabled();

    // 2. Release the held workspace response
    if (resumeWorkspaceRequest) {
      (resumeWorkspaceRequest as () => void)();
    }

    // 3. PROVE: Workspace returns -> form adopts server values -> submit becomes enabled
    const objectiveField = page.getByLabel("Objective", { exact: false });
    await expect(objectiveField).toHaveValue("Convert commercial building owners into bid requests.", { timeout: 15_000 });
    await expect(submitButton).toBeEnabled({ timeout: 15_000 });

    // 4. PROVE: Submitting sends the correct adopted non-empty values
    let capturedBody: Record<string, any> | null = null;
    page.on("request", (req) => {
      if (req.url().includes("/writer/brief") && (req.method() === "PUT" || req.method() === "POST")) {
        try {
          capturedBody = req.postDataJSON();
        } catch {
          // ignore
        }
      }
    });

    // Submit the brief
    await submitButton.click();
    await expect(page.getByText(/Brief draft v\d saved/)).toBeVisible({ timeout: 15_000 });

    // Verify sent payload
    expect(capturedBody).not.toBeNull();
    const pt = capturedBody!.pageTarget;
    expect(pt).toBeDefined();
    expect(pt.objective).toBe("Convert commercial building owners into bid requests.");
    expect(pt.audience).toBe("Austin commercial facility managers.");
    expect(pt.ctaIntent).toBe("Request commercial proposal");
    expect(pt.objective).not.toBe("");
    expect(pt.audience).not.toBe("");
    expect(pt.ctaIntent).not.toBe("");
  });
});
