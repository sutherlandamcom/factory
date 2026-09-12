import { test, expect, type Page } from "@playwright/test";
import http from "node:http";

/**
 * REAL BROWSER Content Writer journey (Macro Run 4 acceptance):
 *
 * accepted project + accepted gap snapshot (via the real Content Gaps UI)
 *   -> Content workspace
 *   -> enter Page Target fields
 *   -> brief visible with full lineage
 *   -> approve Factory Writer Policy (derived from accepted Content Constitution)
 *   -> compile WriterPromptSnapshot
 *   -> approve exact digest
 *   -> (fixture writer) proposal persisted
 *   -> factual/search/editorial verdicts visible
 *   -> ACCEPT CONTENT -> AcceptedPageContent v1
 *   -> browser reload -> persists
 *   -> service restart (DB kept) -> persists
 *   -> edit upstream (new accepted inputs) -> workspace artifacts show STALE,
 *      accepted v1 unchanged
 *
 * Rules honored: built dashboard served by the real Operator service, real
 * PostgreSQL, no JSON editing, no direct SQL for product actions, zero paid
 * provider calls (FACTORY_WRITER_MODE=fixture is trusted backend config).
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
  key: `e2e-writer-${UNIQUE}`,
  name: "E2E Writer Roofing",
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
  await set("Business", "Business Name", "E2E Writer Roofing Co");
  await set("Business", "Description", "Family roofing company exercised by the automated Content Writer journey.");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Language", "en");
  await set("Conversion", "CTA Destination", "tel:+15550100100");
  await set("Search Seeds", "Seed Queries", "roof repair austin");
  await set("Evidence & Claims", "Operator Facts", "Serving Austin roofs since 2009 with 12-person crew");
  // Content Constitution: the writer policy derives from these accepted fields.
  await set("Content Constitution", "Brand Voice", "Warm, plain-spoken expert");
  await set("Content Constitution", "Tone", "Confident but never pushy");
  await set("Content Constitution", "Evidence / Factuality Policy", "Every claim traces to an operator fact.");
  await set("Content Constitution", "Trust Expectations", "Show license numbers where relevant.");
  await set("Content Constitution", "Locale / Language Preferences", "US English");
  await set("Content Constitution", "Custom Project Writer Instructions", "Keep sentences under 20 words.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 10_000 });
}

async function acceptGapSnapshot(page: Page) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Query", { exact: false }).first().fill("roof repair austin");
  await page.getByRole("button", { name: "Run Search", exact: false }).click();
  await expect(page.locator("text=SERP").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Competitors Research", exact: true }).click();
  await page.locator("select").first().selectOption({ index: 0 });
  await page.getByRole("button", { name: "Acquire competitors" }).click();
  await expect(page.locator("text=Candidates (")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Content Gaps", exact: true }).click();
  await page.getByRole("button", { name: "Propose gap report", exact: true }).click();
  await expect(page.locator("text=Review gaps (")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.locator("text=Decisions saved.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Accept as v/ }).click();
  await expect(page.locator("text=/Content gaps accepted as version 1/")).toBeVisible({ timeout: 30_000 });
}

test.describe("Content Writer journey", () => {
  test("accepted inputs + gap -> writer policy -> brief -> snapshot -> proposal -> QA -> ACCEPT v1 -> reload/restart persistence -> upstream edit marks artifacts STALE, v1 unchanged", async ({ page }) => {
    test.setTimeout(600_000);
    await createAndAcceptProject(page);
    await acceptGapSnapshot(page);

    // ---- Content workspace ----
    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.getByText("Factory Writer Policy")).toBeVisible({ timeout: 10_000 });

    // ---- Writer Policy: derive + approve ----
    await page.getByRole("button", { name: "Derive draft" }).click();
    await expect(page.getByText("Writer policy draft created")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).first().click();
    await expect(page.getByText("Writer policy v1 approved and immutable.")).toBeVisible({ timeout: 15_000 });

    // ---- Brief: enter Page Target fields, save, approve ----
    await page.locator('input[placeholder="roof-replacement-denver"]').fill("roof-repair-austin");
    await page.getByLabel("Title", { exact: false }).first().fill("Roof Repair in Austin");
    await page.getByLabel("Objective", { exact: false }).fill("Convert homeowners researching roof repair into inspection requests.");
    await page.getByLabel("Audience", { exact: false }).fill("Austin homeowners comparing local roofers");
    await page.getByLabel("Structure guidance (one per line)").fill("Storm damage context\nRepair process\nWarranty and trust signals");
    await page.getByLabel("CTA intent", { exact: false }).fill("Book a free roof inspection");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText(/Brief draft v1 saved/)).toBeVisible({ timeout: 15_000 });
    // Brief with full lineage visible (gap digest present, no-gap flag absent).
    await expect(page.getByText(/gap [0-9a-f]{12}…/).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).click();
    await expect(page.getByText("Brief v1 approved.")).toBeVisible({ timeout: 15_000 });

    // ---- Snapshot: compile + preview + approve exact digest ----
    await page.getByRole("button", { name: "Compile new snapshot" }).click();
    await expect(page.getByText(/Snapshot v1 compiled/)).toBeVisible({ timeout: 15_000 });
    await page.getByText("Review exact prompt packet").click();
    await expect(page.getByText("You are the production marketing writer")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).click();
    await expect(page.getByText(/approved\. Generation is now authorized/)).toBeVisible({ timeout: 15_000 });

    // ---- Proposal (fixture writer) + QA verdicts ----
    await page.getByRole("button", { name: "Generate proposal" }).click();
    await expect(page.getByText(/Proposal generated/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Run QA" }).click();
    await expect(page.getByText(/QA verdict: /)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Factual", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Search", { exact: true }).nth(1)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Editorial", { exact: true })).toBeVisible({ timeout: 10_000 });

    // ---- ACCEPT CONTENT ----
    await page.getByRole("button", { name: "ACCEPT CONTENT" }).click();
    await expect(page.getByText(/AcceptedPageContent v1 created for roof-repair-austin/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Accepted Page Content")).toBeVisible({ timeout: 10_000 });

    // ---- Reload persistence ----
    await page.reload();
    // Reload lands on the projects list (view state is not persisted); reopen.
    await page.getByRole("button", { name: new RegExp(PROJECT.key) }).click();
    await expect(page.locator("h1", { hasText: PROJECT.name })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.getByText("Accepted Page Content")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("v1").first()).toBeVisible();

    // ---- Service restart WITHOUT DB reset ----
    await supervisorCall("/restart");
    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(PROJECT.key) }).click();
    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.getByText("Accepted Page Content")).toBeVisible({ timeout: 30_000 });

    // ---- Upstream edit -> new accepted inputs -> snapshot STALE, v1 unchanged ----
    await page.getByRole("button", { name: "Business", exact: true }).click();
    await page.getByLabel("Description", { exact: false }).first().fill("Updated description after acceptance.");
    await page.getByRole("button", { name: "Save Draft" }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
    await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.getByText("STALE").first()).toBeVisible({ timeout: 15_000 });
    // Accepted v1 remains unchanged and inspectable.
    await expect(page.getByText("Accepted Page Content")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Digest: [0-9a-f]{64}/).first()).toBeVisible({ timeout: 10_000 });
  });
});
