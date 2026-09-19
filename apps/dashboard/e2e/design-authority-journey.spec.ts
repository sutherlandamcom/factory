import { fillAndAcceptIntake, acceptPageContent } from "./content-authority-helper.js";
import type { WriterWorkspace, AssetsWorkspace, DesignWorkspace } from "../src/api/client.js";
import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { gotoArea, gotoIntakeSection, gotoSubsection } from "./run11-navigation";

/**
 * REAL BROWSER Design AUTHORITY journey (Macro Run 6 acceptance, §24):
 *
 * The design journey must exercise REAL upstream authority, not an empty
 * project:
 *
 * create project -> accepted inputs
 *   -> accepted page content (fixture writer: policy -> brief -> snapshot
 *      -> proposal -> QA -> ACCEPT v1)
 *   -> upload a REAL test image -> approve EXACT AssetVersion
 *   -> assign EXACT page/role (homepage/hero)
 *   -> derive design input -> verify the input carries the accepted content
 *      and the exact asset assignment (UI shows upstream lineage)
 *   -> generate fixture candidate (FACTORY_DESIGN_MODE=fixture)
 *   -> verify correct archetype routing evidence (homepage archetype bound
 *      to the accepted page; asset slot bound to the exact page/role)
 *   -> forged acceptance fails
 *   -> fixture acceptance requires explicit fixture declaration
 *   -> restart -> persistence verified
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
const KEY = `design-auth-${UNIQUE}`;
const NAME = "Design Authority E2E";
const PAGE_SLUG = "roof-repair-austin";

async function createProject(page: Page, key: string, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(key);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: name })).toBeVisible({ timeout: 10_000 });
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-design-asset-"));
  const file = path.join(dir, `design-hero-${seed}.jpg`);
  await writeFile(file, jpeg);
  return file;
}

/** Real Run 5 asset authority: upload -> approve exact digest -> assign homepage/hero. */
async function approveAndAssignHeroAsset(page: Page): Promise<void> {
  await gotoSubsection(page, "Assets", "Asset Library");
  await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
  const fixture = await createHeroFixture(7);
  await page.locator("#asset-file").setInputFiles(fixture);
  await page.locator("#asset-title").fill("Design journey homepage hero photograph");
  await page.locator("#asset-rights").selectOption("operator_owned");
  await page.locator("#asset-rights-note").fill("Taken by operator for the design authority journey");
  await page.locator("#asset-alt").fill("Alpine hero photograph for the design journey");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText(/Uploaded v1 \(image\/jpeg/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText(/Version v1 approved and immutable/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("combobox", { name: "Accepted page" }).last().selectOption(PAGE_SLUG);
  await page.getByRole("button", { name: "Assign to page slot" }).click();
  await expect(page.getByText(new RegExp(`Assigned v1 to ${PAGE_SLUG}/hero`))).toBeVisible({ timeout: 15_000 });
}

test.describe("Design authority journey", () => {
  test("accepted content + approved/assigned asset -> design input -> fixture candidate -> fixture acceptance gate -> restart persistence", async ({ page }) => {
    test.setTimeout(900_000);

    let projectId = "";
    page.on("request", request => {
      const match = new URL(request.url()).pathname.match(/^\/api\/projects\/([^/]+)\//);
      if (match && match[1] !== "e2e") projectId = match[1]!;
    });
    const read = async <T,>(suffix: string): Promise<T> => {
      expect(projectId).not.toBe("");
      const response = await page.request.get(`/api/projects/${projectId}/${suffix}`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await createProject(page, KEY, NAME);
    await fillAndAcceptIntake(page);
    await acceptPageContent(page, PAGE_SLUG);
    const writer = await read<WriterWorkspace>("writer/workspace");
    const brief = writer.brief.latest!, snapshot = writer.snapshot.latest!, proposal = writer.proposal.latest!, content = writer.accepted.latest!;
    expect(brief.noGapLineageAcknowledged).toBe(false);
    expect(brief.lineage.gapSnapshotId).toBeTruthy();
    expect(brief.lineage.gapSnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.lineage.writerPolicyDigest).toBe(writer.policy.latest!.digest);
    expect(snapshot).toMatchObject({ briefId: brief.id, briefVersion: brief.version, briefDigest: brief.digest });
    expect(proposal).toMatchObject({ snapshotId: snapshot.id, snapshotVersion: snapshot.version, snapshotDigest: snapshot.digest });
    expect(content).toMatchObject({ proposalId: proposal.id, proposalDigest: proposal.digest, slug: PAGE_SLUG });
    await page.getByRole("button", { name: `Inspect ${PAGE_SLUG} v1` }).click();
    await expect(page.getByText(proposal.data.introduction, { exact: true }).last()).toBeVisible();
    await approveAndAssignHeroAsset(page);
    const assets = await read<AssetsWorkspace>("assets/workspace");
    const assignment = assets.assignments[0]!;
    expect(assignment).toMatchObject({ acceptedPageContentId: content.id, acceptedPageContentVersion: content.version, acceptedPageContentDigest: content.digest, pageSlug: PAGE_SLUG, role: "hero" });

    // ---- Design: derive the authority-bound input snapshot ----
    await gotoArea(page, "Design");
    await expect(page.locator("h3", { hasText: "Design Provider" })).toBeVisible();
    await page.getByRole("button", { name: "Derive input snapshot" }).click();
    await expect(page.locator("text=Re-derive input snapshot")).toBeVisible({ timeout: 15_000 });

    // The input snapshot must carry the accepted content + the exact asset
    // assignment (upstream lineage visible in the UI).
    await expect(page.getByText(`Accepted content: ${PAGE_SLUG}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(new RegExp(`${PAGE_SLUG} / hero`)).first()).toBeVisible({ timeout: 15_000 });

    // ---- Generate a fixture candidate ----
    await page.getByRole("button", { name: "Generate design candidate" }).click();
    await expect(page.locator("h3", { hasText: "Candidate Design" })).toBeVisible({ timeout: 30_000 });
    // The durable FIXTURE badge must be visible — a fixture candidate can
    // never masquerade as live Stitch evidence.
    await expect(page.getByText("FIXTURE").first()).toBeVisible({ timeout: 15_000 });

    // ---- FORGED digest accept fails ----
    const acceptButton = page.getByRole("button", { name: "Accept design" });
    await expect(acceptButton).toBeVisible();
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

    // ---- Accept WITHOUT fixture declaration fails closed ----
    await page.unroute("**/design/candidates/*/accept");
    await acceptButton.click();
    await expect(
      page.locator("text=/fixture candidates require an explicit fixture declaration/i").first(),
    ).toBeVisible({ timeout: 15_000 });

    // ---- Accept WITH the explicit fixture declaration succeeds ----
    await page.locator("#design-review-notes").fill("fixture acceptance — design authority journey");
    await acceptButton.click();
    await expect(page.locator("h3", { hasText: "Accepted Design" })).toBeVisible({ timeout: 15_000 });
    // The accepted design durably shows the FIXTURE mode.
    await expect(page.getByTitle("Accepted from a deterministic fixture candidate — NOT live Google Stitch evidence")).toBeVisible({ timeout: 15_000 });

    const design = await read<DesignWorkspace>("design/workspace");
    const input = design.latestInputSnapshot!;
    const data = input.data as { contentRefs: unknown[]; assetRefs: unknown[] };
    expect(data.contentRefs).toContainEqual({ id: content.id, version: content.version, slug: PAGE_SLUG, contentDigest: content.digest });
    expect(data.assetRefs).toContainEqual({ versionId: assignment.versionId, binaryDigest: assignment.binaryDigest, governanceDigest: assignment.versionDigest, acceptedPageContentId: content.id, acceptedPageContentVersion: content.version, acceptedPageContentDigest: content.digest, pageSlug: PAGE_SLUG, role: "hero" });
    expect(design.accepted).toMatchObject({ inputSnapshotId: input.id, inputSnapshotVersion: input.version, inputDigest: input.inputDigest, candidateId: design.candidates[0]!.id, candidateDigest: design.candidates[0]!.candidateDigest, providerMode: "fixture" });

    // ---- RESTART the operator service (DB kept) — accepted design persists ----
    await supervisorCall("/restart");
    await page.waitForTimeout(2_000);
    await page.reload();
    // Router deep link: reload re-lands on the same project workspace
    // (the URL carries the exact project id).
    await expect(page.locator("h1", { hasText: NAME })).toBeVisible({ timeout: 30_000 });
    await gotoArea(page, "Design");
    await expect(page.locator("h3", { hasText: "Accepted Design" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTitle("Accepted from a deterministic fixture candidate — NOT live Google Stitch evidence")).toBeVisible({ timeout: 15_000 });
    expect((await read<WriterWorkspace>("writer/workspace")).accepted.latest).toEqual(content);
    expect((await read<AssetsWorkspace>("assets/workspace")).assignments).toEqual(assets.assignments);
    expect((await read<DesignWorkspace>("design/workspace")).accepted).toEqual(design.accepted);
  });
});
