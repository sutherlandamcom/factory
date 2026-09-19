import { fillAndAcceptIntake, acceptPageContent } from "./content-authority-helper.js";
import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { gotoArea, gotoIntakeSection, gotoSubsection } from "./run11-navigation";

/**
 * REAL BROWSER Asset journey (Macro Run 5 acceptance):
 *
 * project -> Asset Library
 *   -> upload a REAL photograph (deterministic Chamonix-style JPEG fixture)
 *   -> server validates actual bytes (sharp/file-type ingest)
 *   -> metadata/provenance/rights visible
 *   -> approve EXACT digest
 *   -> assign homepage/hero
 *   -> reload -> assignment persists
 *   -> service restart (DB kept) -> same exact version still assigned
 *   -> upload v2 (different bytes) -> approve
 *   -> assignment does NOT silently move (staleness banner shown)
 *   -> explicit replace -> v2 bound
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

/** Deterministic "photograph-like" fixture: gradient sky + mountain silhouette. */
async function createChamonixFixture(seed: number): Promise<string> {
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
    <polygon points="${width * 0.6},${height} ${width * 0.8},${height * 0.55} ${width},${height * 0.8}" fill="rgb(${60 + seed}, ${75 + seed}, ${90 + seed})"/>
    <circle cx="${width * 0.78}" cy="${height * 0.2}" r="${26 + seed}" fill="rgb(250, ${240 - seed}, 200)"/>
  </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-asset-"));
  const file = path.join(dir, `chamonix-hero-${seed}.jpg`);
  await writeFile(file, jpeg);
  return file;
}

test.describe("Asset journey", () => {
  test("upload -> inspect -> approve exact digest -> assign -> reload/restart persistence -> replacement does not silently move -> explicit replace", async ({ page }) => {
    test.setTimeout(600_000);
    const key = `e2e-assets-${UNIQUE}`;
    await createProject(page, key, "E2E Assets Chamonix");
    await fillAndAcceptIntake(page);
    await acceptPageContent(page);

    // ---- Asset Library ----
    await gotoSubsection(page, "Assets", "Asset Library");
    await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("No assets uploaded yet.")).toBeVisible({ timeout: 10_000 });

    // ---- Upload a real photograph (server validates the actual bytes) ----
    const fixtureV1 = await createChamonixFixture(0);
    await page.locator("#asset-file").setInputFiles(fixtureV1);
    await page.locator("#asset-title").fill("Chamonix homepage hero photograph");
    await page.locator("#asset-rights").selectOption("operator_owned");
    await page.locator("#asset-rights-note").fill("Taken by operator, Chamonix valley, 2026-08");
    await page.locator("#asset-alt").fill("Aiguilles view above the Chamonix valley at dusk");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText(/Uploaded v1 \(image\/jpeg/)).toBeVisible({ timeout: 30_000 });

    // ---- Metadata, provenance, rights visible ----
    await expect(page.getByText("v1").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("rights: operator_owned").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/provenance: operator_upload · chamonix-hero-0\.jpg/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Taken by operator, Chamonix valley, 2026-08")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/digest: [0-9a-f]{12}…/)).toBeVisible({ timeout: 10_000 });
    // The real image renders through the byte-serving endpoint.
    await expect(page.locator("img[alt*='Aiguilles view']").first()).toBeVisible({ timeout: 15_000 });

    // ---- Approve the EXACT version ----
    await page.getByRole("button", { name: "Approve exact digest" }).first().click();
    await expect(page.getByText(/Version v1 approved and immutable/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("approved").first()).toBeVisible({ timeout: 10_000 });

    // ---- Assign to homepage/hero ----
    await page.getByRole("combobox", { name: "Accepted page" }).last().selectOption("homepage");
    await page.getByRole("button", { name: "Assign to page slot" }).click();
    await expect(page.getByText(/Assigned v1 to homepage\/hero/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/homepage \/ hero/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/← Chamonix homepage hero photograph v1/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("replacement available", { exact: false })).toHaveCount(0);

    // ---- Reload persistence ----
    await page.reload();
    // Router deep link: reload re-lands on the same project workspace.
    await gotoSubsection(page, "Assets", "Asset Library");
    await expect(page.getByText(/← Chamonix homepage hero photograph v1/)).toBeVisible({ timeout: 15_000 });

    // ---- Service restart WITHOUT DB reset ----
    await supervisorCall("/restart");
    await page.reload();
    // Router deep link: reload re-lands on the same project workspace.
    await gotoSubsection(page, "Assets", "Asset Library");
    await expect(page.getByText(/← Chamonix homepage hero photograph v1/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("replacement available", { exact: false })).toHaveCount(0);

    // ---- Replacement version v2 (different bytes) -> approve ----
    const fixtureV2 = await createChamonixFixture(40);
    await page.locator("#asset-file").setInputFiles(fixtureV2);
    await page.locator("#asset-title").fill("Chamonix homepage hero photograph");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText(/Uploaded v2 \(image\/jpeg/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Approve exact digest" }).first().click();
    await expect(page.getByText(/Version v2 approved and immutable/)).toBeVisible({ timeout: 15_000 });

    // ---- CRITICAL: assignment does NOT silently move to v2 ----
    await expect(page.getByText(/← Chamonix homepage hero photograph v1/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/replacement available: v2 — assignment UNCHANGED until you replace explicitly/)).toBeVisible({ timeout: 15_000 });

    // ---- Explicit replace moves the assignment to v2 ----
    await page.getByRole("button", { name: "Replace explicitly with v2" }).click();
    await page.getByRole("button", { name: "Confirm replace" }).click();
    await expect(page.getByText(/Assignment explicitly moved to v2/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/← Chamonix homepage hero photograph v2/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("replacement available", { exact: false })).toHaveCount(0);
  });

  test("upload of non-image bytes is rejected server-side with visible operator feedback", async ({ page }) => {
    test.setTimeout(300_000);
    const key = `e2e-assets-bad-${UNIQUE}`;
    await createProject(page, key, "E2E Assets Negative");

    await gotoSubsection(page, "Assets", "Asset Library");
    await expect(page.getByText("No assets uploaded yet.")).toBeVisible({ timeout: 10_000 });

    // A text file with an image-ish name: the server must reject the actual bytes.
    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-asset-bad-"));
    const fake = path.join(dir, "not-a-photo.jpg");
    await writeFile(fake, "this is definitely not an image, it is plain text");
    await page.locator("#asset-file").setInputFiles(fake);
    await page.locator("#asset-title").fill("Should never exist");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText(/Upload rejected: the file is not a supported, decodable image/)).toBeVisible({ timeout: 30_000 });
    // Nothing was persisted.
    await expect(page.getByText("No assets uploaded yet.")).toBeVisible({ timeout: 10_000 });
  });
});
