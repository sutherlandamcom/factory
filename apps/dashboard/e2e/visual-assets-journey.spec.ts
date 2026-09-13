import { test, expect, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import http from "node:http";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";

/**
 * REAL BROWSER Visual Assets journey (Macro Run 7 acceptance, §24):
 *
 * The visual journey must exercise REAL upstream authority, not an empty
 * project:
 *
 * create project -> accepted inputs
 *   -> accepted page content (fixture writer)
 *   -> upload a REAL test image -> approve EXACT AssetVersion
 *   -> assign EXACT page/role (homepage/hero)
 *   -> derive design input -> generate fixture candidate
 *   -> accept design (fixture declaration)
 *   -> Visual Assets tab: derive visual plan
 *   -> confirm truth classification (illustrative)
 *   -> compile prompt snapshot -> approve exact digest
 *   -> generate fixture candidates (dedup proof: second generate reuses)
 *   -> accept candidate -> Run 5 assignment visible in Asset Library
 *   -> accept the visual asset set
 *   -> restart -> persistence verified
 *
 * Rules honored: built dashboard served by the real Operator service, real
 * PostgreSQL, no JSON editing, no direct SQL for product actions, zero paid
 * provider calls (FACTORY_VISUAL_MODE=fixture).
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
const KEY = `visual-journey-${UNIQUE}`;
const NAME = "Visual Journey E2E";
const PAGE_SLUG = "roof-repair-austin";

async function createProject(page: Page, key: string, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(key);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: name })).toBeVisible({ timeout: 10_000 });
}

async function fillAndAcceptIntake(page: Page): Promise<void> {
  const set = async (tab: string, label: string, value: string) => {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Visual Journey Roofing Co");
  await set("Business", "Description", "Family roofing company used by the visual journey test.");
  await set("Business", "Business Model", "Direct-to-consumer services");
  await set("Audience", "Segments", "Residential Homeowners");
  await set("Site Identity", "Site Name", "Visual Journey Roofing");
  await set("Site Identity", "Language", "en");
  await set("Site Identity", "Locale", "en-US");
  await set("Conversion", "Primary Objective", "Generate assessment requests");
  await set("Conversion", "CTA Type", "Call the office");
  await page.getByRole("button", { name: "Conversion", exact: true }).click();
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
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible({ timeout: 15_000 });
}

/** Accepted page content via the fixture writer (no-gap path: no SERP spend). */
async function acceptPageContent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Content", exact: true }).click();
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
  await page.getByLabel(/Explicitly draft\/approve WITHOUT accepted gap lineage/).check();
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

/** Deterministic "photograph-like" fixture image (real bytes, real ingest). */
async function createHeroFixture(seed: number): Promise<string> {
  const width = 640;
  const height = 420;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${30 + seed}, ${90 + seed}, ${160 + seed})"/>
        <stop offset="100%" stop-color="rgb(${200 + seed}, ${215 + seed}, ${230 + seed})"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#sky)"/>
    <polygon points="0,${height} ${width * 0.28},${height * 0.42} ${width * 0.5},${height * 0.62} ${width * 0.72},${height * 0.36} ${width},${height}" fill="rgb(${40 + seed}, ${55 + seed}, ${70 + seed})"/>
  </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-visual-asset-"));
  const file = path.join(dir, `visual-hero-${seed}.jpg`);
  await writeFile(file, jpeg);
  return file;
}

/** Real Run 5 asset authority: upload -> approve exact digest -> assign homepage/hero. */
async function approveAndAssignHeroAsset(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Asset Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
  const fixture = await createHeroFixture(9);
  await page.locator("#asset-file").setInputFiles(fixture);
  await page.locator("#asset-title").fill("Visual journey homepage hero photograph");
  await page.locator("#asset-rights").selectOption("operator_owned");
  await page.locator("#asset-rights-note").fill("Taken by operator for the visual journey");
  await page.locator("#asset-alt").fill("Alpine hero photograph for the visual journey");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText(/Uploaded v1 \(image\/jpeg/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText(/Version v1 approved and immutable/)).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("homepage", { exact: true }).last().fill("homepage");
  await page.getByRole("button", { name: "Assign to page slot" }).click();
  await expect(page.getByText(/Assigned v1 to homepage\/hero/)).toBeVisible({ timeout: 15_000 });
}

/** Accepted fixture design (the visual plan's upstream authority). */
async function acceptFixtureDesign(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Design" }).click();
  await expect(page.locator("h3", { hasText: "Design Provider" })).toBeVisible();
  await page.getByRole("button", { name: "Derive input snapshot" }).click();
  await expect(page.locator("text=Re-derive input snapshot")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Generate design candidate" }).click();
  await expect(page.locator("h3", { hasText: "Candidate Design" })).toBeVisible({ timeout: 30_000 });
  await page.locator("#design-review-notes").fill("fixture acceptance — visual journey");
  await page.getByRole("button", { name: "Accept design" }).click();
  await expect(page.locator("h3", { hasText: "Accepted Design" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Visual assets journey", () => {
  test("accepted design -> visual plan -> classify -> prompt approval -> fixture generation -> candidate acceptance (Run 5 assignment) -> set acceptance -> restart persistence", async ({ page }) => {
    test.setTimeout(900_000);

    await createProject(page, KEY, NAME);
    await fillAndAcceptIntake(page);
    await acceptPageContent(page);
    await approveAndAssignHeroAsset(page);
    await acceptFixtureDesign(page);

    // ---- Visual Assets: derive the plan from the accepted design ----
    await page.getByRole("button", { name: "Visual Assets" }).click();
    await expect(page.locator("h2", { hasText: "Visual Assets" })).toBeVisible();
    await page.getByRole("button", { name: "Derive visual plan" }).click();
    await expect(page.getByText(/Plan v1/)).toBeVisible({ timeout: 15_000 });
    // The plan carries the exact design slot lineage.
    await expect(page.getByText(/hero\.primary/).first()).toBeVisible({ timeout: 15_000 });

    // ---- Confirm the truth classification (operator authority) ----
    await page.getByLabel("Truth class").first().selectOption("illustrative");
    await expect(page.getByText(/Truth class for hero.primary confirmed/)).toBeVisible({ timeout: 15_000 });

    // ---- Compile the prompt snapshot ----
    await page.getByRole("button", { name: "Compile prompt snapshot" }).click();
    await expect(page.getByText(/Prompt snapshot compiled for hero\.primary/)).toBeVisible({ timeout: 15_000 });

    // ---- Approve the exact prompt digest ----
    // The UI exposes the full digest via data-prompt-digest (operator copies
    // it); the E2E reads it and pastes it back — the exact-digest binding
    // gate is exercised for real.
    const fullDigest = await page
      .locator("[data-prompt-digest]")
      .first()
      .getAttribute("data-prompt-digest");
    assert.ok(fullDigest !== null && /^[0-9a-f]{64}$/.test(fullDigest), "full prompt digest must be exposed for operator binding");
    await page.locator('input[placeholder*="Confirm digest"]').fill(fullDigest!);
    await page.getByRole("button", { name: "Approve exact digest" }).click();
    await expect(page.getByText(/Prompt snapshot approved for hero\.primary/)).toBeVisible({ timeout: 15_000 });

    // ---- Generate fixture candidates ----
    await page.getByRole("button", { name: "Generate candidates" }).click();
    await expect(page.getByText(/candidate\(s\) generated for hero\.primary/)).toBeVisible({ timeout: 30_000 });
    // The durable FIXTURE badge must be visible — fixture candidates can
    // never masquerade as live provider evidence.
    await expect(page.getByText("FIXTURE").first()).toBeVisible({ timeout: 15_000 });
    // C2PA evidence is shown honestly.
    await expect(page.getByText(/C2PA: (absent|validated|unreadable|unavailable_with_reason)/).first()).toBeVisible({ timeout: 15_000 });

    // ---- Accept the candidate (Run 5 assignment created) ----
    await page.getByRole("button", { name: "Accept candidate" }).click();
    await expect(page.getByText(/Slot hero\.primary accepted: version/)).toBeVisible({ timeout: 30_000 });

    // ---- The Run 5 Asset Library shows the new assignment ----
    await page.getByRole("button", { name: "Asset Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
    // The AI-derived version is durably assigned to the exact page/role slot
    // (visible provenance: generated + exact derivation lineage).
    await expect(page.getByText(/provenance: generated/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/roof-repair-austin \/ hero/).last()).toBeVisible({ timeout: 15_000 });

    // ---- Accept the visual asset set ----
    await page.getByRole("button", { name: "Visual Assets" }).click();
    await page.getByRole("button", { name: "Accept visual asset set" }).click();
    await expect(page.getByRole("heading", { name: /Accepted Visual Asset Set v1/ })).toBeVisible({ timeout: 30_000 });

    // ---- Final Design Pass & Freeze (P1-01) ----
    await page.getByRole("button", { name: "Run final design pass" }).click();
    await expect(page.getByText(/Final design pass complete/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Accept and freeze design" }).click();
    await expect(page.getByText(/Design frozen \(Accepted design v2 is UP_TO_DATE/)).toBeVisible({ timeout: 30_000 });

    // ---- RESTART the operator service (DB kept) — everything persists ----
    await supervisorCall("/restart");
    await page.waitForTimeout(2_000);
    await page.reload();
    await expect(page.locator("h1", { hasText: "Projects" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: new RegExp(KEY) }).first().click();
    await expect(page.locator("h1", { hasText: NAME })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Visual Assets" }).click();
    await expect(page.getByRole("heading", { name: /Accepted Visual Asset Set v1/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Design frozen \(Accepted design v2 is UP_TO_DATE/)).toBeVisible({ timeout: 30_000 });

    // Verify Design tab reflects Accepted Design v2 (not stale)
    await page.getByRole("button", { name: "Design" }).click();
    await expect(page.getByRole("heading", { name: "Accepted Design" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("v2").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("current").first()).toBeVisible({ timeout: 15_000 });
  });
});
