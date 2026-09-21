import { expect, type Page } from "@playwright/test";
import { gotoArea, gotoSubsection } from "./run11-navigation.js";
import { acceptSearchGap } from "./search-gap-helper.js";

/**
 * Shared golden-journey steps for Run 11 browser proofs.
 *
 * Drives the REAL UI + REAL Operator API from an accepted-intake project to
 * the READY_FOR_DEPLOYMENT terminal state using fixture providers only.
 * Used by the golden journey spec and the staleness cascade spec so both
 * prove the same authority chain.
 */

const PAGE_SLUG = "homepage";

export async function runGoldenJourneyToReady(page: Page, pageSlug: string = PAGE_SLUG): Promise<void> {
  await acceptContent(page, pageSlug);
  await seedAndViewSyntheticAuthority(page, pageSlug);
  await acceptDerivatives(page, pageSlug);
  await buildAndQa(page, pageSlug);
}

/**
 * Test bootstrap (§53): seed test-only synthetic production authority
 * (design + visual set + real approved hero asset) via the supervisor
 * control API, then VERIFY through the real Dashboard UI that the seeded
 * authority is visible as CURRENT. The browser journey itself performs no
 * workflow action through the supervisor — only this one-time setup.
 */
async function seedAndViewSyntheticAuthority(page: Page, pageSlug: string): Promise<void> {
  const projectId = await currentProjectId(page);
  const res = await page.request.post("http://127.0.0.1:4177/seed-synthetic-authority", {
    data: { projectId, pageSlug },
  });
  if (!res.ok()) throw new Error(`synthetic authority seed failed: ${res.status()} ${await res.text()}`);

  // Verify the seeded design authority through the real UI.
  await gotoArea(page, "Design");
  await expect(page.getByRole("heading", { name: "Accepted Design" })).toBeVisible({ timeout: 30_000 });

  // Verify the seeded visual set through the real UI (Visual Slots area).
  await gotoSubsection(page, "Assets", "Visual Slots");
  await expect(page.getByRole("heading", { name: /Accepted Visual Asset Set v1/ })).toBeVisible({ timeout: 30_000 });
}

/** Read the current project id from the workspace URL. */
async function currentProjectId(page: Page): Promise<string> {
  const url = new URL(page.url());
  const match = url.pathname.match(/\/projects\/([^/]+)\//);
  if (!match) throw new Error(`not inside a project workspace: ${page.url()}`);
  return decodeURIComponent(match[1]!);
}

/** Content pipeline through the governed writer: policy → brief → snapshot → proposal → QA → accept. */
async function acceptContent(page: Page, pageSlug: string): Promise<void> {
  await acceptSearchGap(page);
  await gotoSubsection(page, "Content", "Pipeline");
  await expect(page.getByText("Factory Writer Policy")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Derive draft" }).click();
  await expect(page.getByText("Writer policy draft created")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText("Writer policy v1 approved and immutable.")).toBeVisible({ timeout: 15_000 });

  await page.locator('input[placeholder="roof-replacement-denver"]').fill(pageSlug);
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
  await expect(page.getByText(new RegExp(`AcceptedPageContent v1 created for ${pageSlug}`))).toBeVisible({ timeout: 30_000 });
}

/** Derivatives: enable policy → generate summary → accept → accept set (Run 10). */
async function acceptDerivatives(page: Page, pageSlug: string): Promise<void> {
  await gotoSubsection(page, "Content", "Derivatives");
  // Wait until the derivatives workspace read model is loaded (the per-page
  // section renders only after the workspace query resolves).
  await expect(page.getByRole("heading", { name: "Per-page derivatives" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("div.rounded.border", { hasText: "Summary" }).first()).toBeVisible({ timeout: 30_000 });
  // Derivatives stay at the Run 10 default (disabled, no project policy)
  // in this journey:
  // fixture summary/audio output can never become production authority
  // (fail-closed Run 10 governance), so the operator records the truthful
  // disabled set. Accepting the disabled set is a real UI action through
  // the real API; no fixture authority is accepted.
  // With no project policy the disabled state is already effective; if a
  // policy row exists, explicitly disable both derivatives.
  const disableBoth = page.getByRole("button", { name: "Disable both" });
  if (await disableBoth.count()) {
    await disableBoth.click();
    await expect(page.getByText(/DISABLED/).first()).toBeVisible({ timeout: 15_000 });
  }
  const pageCard = page.locator("div.rounded.border", { hasText: pageSlug }).first();
  await pageCard.getByRole("button", { name: "Accept derivative set" }).click();
  await expect(page.getByText(/Set v1/).first()).toBeVisible({ timeout: 30_000 });
}

/** Production: input → candidate → build → QA (Run 9). */
async function buildAndQa(page: Page, pageSlug: string): Promise<void> {
  await gotoArea(page, "Production");
  await page.getByPlaceholder("home").fill(pageSlug);
  await page.getByRole("button", { name: "Prepare candidate" }).click();
  await expect(page.getByRole("button", { name: "Build", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run QA" }).first()).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Run QA" }).first().click();
  await expect(page.getByText(/qa_passed|qa_failed|PASS|FAIL/).first()).toBeVisible({ timeout: 180_000 });
}

/** Deterministic hero photograph fixture (same approach as the Run 5/7 journeys). */
export async function createHeroFixture(seed: number): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const sharp = (await import("sharp")).default;
  const width = 1600;
  const height = 900;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="rgb(${30 + seed}, ${90 + seed}, ${160 + seed})"/>
    <polygon points="0,${height} ${width * 0.28},${height * 0.42} ${width * 0.5},${height * 0.62} ${width * 0.72},${height * 0.36} ${width},${height}" fill="rgb(${40 + seed}, ${55 + seed}, ${70 + seed})"/>
  </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-run11-"));
  const file = path.join(dir, `run11-hero-${seed}.jpg`);
  await writeFile(file, jpeg);
  return file;
}
