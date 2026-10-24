import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { acceptContent, acceptDerivatives, createHeroFixture } from "./run11-golden-steps.js";
import { gotoArea, gotoIntakeSection, gotoSubsection } from "./run11-navigation.js";
const PAGE_SLUG = "homepage";
const QUERY = "модернизация производства инженерные решения";
const CTA = "Обсудить производственную задачу";
async function approveAndAssignHeroAsset(page: Page): Promise<void> {
  await gotoSubsection(page, "Assets", "Asset Library");
  await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
  const fixture = await createHeroFixture(9);
  await page.locator("#asset-file").setInputFiles(fixture);
  await page.locator("#asset-title").fill("Stark synthetic illustration fixture");
  await page.locator("#asset-rights").selectOption("operator_owned");
  await page.locator("#asset-rights-note").fill("Synthetic illustration created solely for this isolated test; no documentary claim.");
  await page.locator("#asset-alt").fill("Иллюстративный тестовый материал");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText(/Uploaded v1 \(image\/jpeg/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve exact digest" }).first().click();
  await expect(page.getByText(/Version v1 approved and immutable/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("combobox", { name: "Accepted page" }).last().selectOption(PAGE_SLUG);
  await page.getByRole("combobox", { name: "Slot/role" }).last().selectOption("background");
  await page.getByRole("button", { name: "Assign to page slot" }).click();
  await expect(page.getByText(new RegExp(`Assigned v1 to ${PAGE_SLUG}/background`))).toBeVisible({ timeout: 15_000 });
}

/** Accepted fixture design (the visual plan's upstream authority). */
async function acceptFixtureDesign(page: Page): Promise<void> {
  await gotoArea(page, "Design");
  await expect(page.locator("h3", { hasText: "Design Provider" })).toBeVisible();
  await page.getByRole("button", { name: "Derive input snapshot" }).click();
  await expect(page.locator("text=Re-derive input snapshot")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Generate design candidate" }).click();
  await expect(page.locator("h3", { hasText: "Candidate Design" })).toBeVisible({ timeout: 30_000 });
  await page.locator("#design-review-notes").fill("fixture acceptance — visual journey");
  await page.getByRole("button", { name: "Accept design" }).click();
  await expect(page.getByTitle("Accepted from a deterministic fixture candidate — NOT live Google Stitch evidence")).toBeVisible({ timeout: 15_000 });
}


test("E2E-P1-05 Stark: continuous Russian fixture journey stops at the production authority boundary", async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.locator('input[placeholder="e.g. summit-roofing"]').fill(`e2e01-stark-${Date.now()}`);
  await page.locator('input[placeholder="e.g. Summit Roofing"]').fill("Stark E2E-01 isolated fixture");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("h1", { hasText: "Stark E2E-01" })).toBeVisible();
  const set = async (section: string, label: string, value: string) => {
    await gotoIntakeSection(page, section);
    await page.getByLabel(label, { exact: false }).first().fill(value);
  };
  await set("Business", "Business Name", "Stark Engineering");
  await set("Business", "Description", "Изолированный тест инженерного проекта без подтверждения фактов о предприятиях.");
  await set("Audience", "Segments", "Промышленные предприятия");
  await set("Markets", "Geographies", "Russia");
  await set("Site Identity", "Site Name", "Stark Engineering");
  await set("Site Identity", "Language", "ru-RU");
  await set("Site Identity", "Locale", "ru-RU");
  await set("Conversion", "Primary Objective", CTA);
  await set("Conversion", "CTA Type", CTA);
  await page.getByLabel("Destination Type").selectOption("url");
  await page.getByLabel("Verification State").selectOption("VERIFIED");
  await set("Conversion", "CTA Destination", "https://contact.stark.example.test/discuss");
  await set("Search Seeds", "Seed Queries", QUERY);
  await set("Evidence & Claims", "Operator Facts", "Тестовый проект. Факты о RusSilica и сотрудниках не подтверждены.");
  await set("Brand", "Positioning", "Инженерное обсуждение производственной задачи");
  await set("Brand", "Tone", "Деловой и конкретный");
  await set("Content Constitution", "Brand Voice", "Деловой русский язык");
  await set("Content Constitution", "Tone", "Деловой и конкретный");
  await set("Content Constitution", "Evidence / Factuality Policy", "Только подтверждённые источниками утверждения.");
  await set("Content Constitution", "Trust Expectations", "Различать слова оператора и независимую проверку.");
  await set("Content Constitution", "Locale / Language Preferences", "Русский язык, ru-RU");
  await set("Content Constitution", "Custom Project Writer Instructions", "Не публиковать неподтверждённые проценты, имена и ответственность за производство.");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await gotoIntakeSection(page, "Review");
  await page.getByRole("button", { name: "ACCEPT INPUTS" }).click();
  await expect(page.locator("span", { hasText: /^APPROVED$/i }).first()).toBeVisible();
  await gotoSubsection(page, "Research", "Search");
  await expect(page.getByText(/Accepted search defaults: ru · Russia/)).toBeVisible();
  await acceptContent(page, PAGE_SLUG, { query: QUERY, title: "Модернизация производства", objective: CTA, audience: "Промышленные предприятия России", structure: "Производственная задача\nПорядок обсуждения", cta: CTA });
  const projectId = decodeURIComponent(new URL(page.url()).pathname.match(/\/projects\/([^/]+)/)![1]!);
  const read = async (suffix: string) => { const res = await page.request.get(`/api/projects/${projectId}/${suffix}`); expect(res.ok(), await res.text()).toBeTruthy(); return res.json(); };
  const writer = await read("writer/workspace");
  expect(writer.proposal.latest.provider).toBe("fixture");
  expect(writer.proposal.latest.data.cta).toBe(CTA);
  expect(writer.proposal.latest.data.introduction).toMatch(/тестовый/);
  const search = await read("search/workspace");
  expect(search.effectiveContext).toMatchObject({ language: "ru", location: "Russia" });
  await approveAndAssignHeroAsset(page);
  await acceptFixtureDesign(page);
    // ---- Visual Assets: derive the plan from the accepted design ----
    await gotoSubsection(page, "Assets", "Visual Slots");
    await expect(page.locator("h2", { hasText: "Visual Assets" })).toBeVisible();
    await page.getByRole("button", { name: "Derive visual plan" }).click();
    await expect(page.getByText(/Plan v1/)).toBeVisible({ timeout: 15_000 });
    // The plan carries the exact design slot lineage.
    await expect(page.getByText(/hero[.-]primary/).first()).toBeVisible({ timeout: 15_000 });

    // ---- Confirm the truth classification (operator authority) ----
    await page.getByLabel("Truth class").first().selectOption("illustrative");
    await expect(page.getByText(/Truth class for hero[.-]primary/)).toBeVisible({ timeout: 15_000 });

    // ---- Compile the prompt snapshot ----
    await page.getByRole("button", { name: "Compile prompt snapshot" }).click();
    await expect(page.getByText(/Prompt snapshot compiled for hero[.-]primary/)).toBeVisible({ timeout: 15_000 });

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
    await expect(page.getByText(/Prompt snapshot approved for hero[.-]primary/)).toBeVisible({ timeout: 15_000 });

    // ---- Generate fixture candidates ----
    await page.getByRole("button", { name: "Generate candidates" }).click();
    await expect(page.getByText(/candidate\(s\) generated for hero[.-]primary/)).toBeVisible({ timeout: 30_000 });
    // The durable FIXTURE badge must be visible — fixture candidates can
    // never masquerade as live provider evidence.
    await expect(page.getByText("FIXTURE").first()).toBeVisible({ timeout: 15_000 });
    // C2PA evidence is shown honestly.
    await expect(page.getByText(/C2PA: (absent|validated|unreadable|unavailable_with_reason)/).first()).toBeVisible({ timeout: 15_000 });

    // ---- Accept the candidate (Run 5 assignment created) ----
    await page.getByRole("button", { name: "Accept candidate" }).click();
    await expect(page.getByText(/Slot hero[.-]primary.* accepted: version/)).toBeVisible({ timeout: 30_000 });

    // ---- The Run 5 Asset Library shows the new assignment ----
    await gotoSubsection(page, "Assets", "Asset Library");
    await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible({ timeout: 10_000 });
    // The AI-derived version is durably assigned to the exact page/role slot
    // (visible provenance: generated + exact derivation lineage).
    await expect(page.getByText(/provenance: generated/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(new RegExp(`${PAGE_SLUG} / hero`)).last()).toBeVisible({ timeout: 15_000 });

    // ---- Accept the visual asset set ----
    await gotoSubsection(page, "Assets", "Visual Slots");
    await page.getByRole("button", { name: "Accept visual asset set" }).click();
    await expect(page.getByRole("heading", { name: /Accepted Visual Asset Set v1/ })).toBeVisible({ timeout: 30_000 });

    // ---- Final Design Pass & Freeze (P1-01) ----
    if (await page.getByRole("button", { name: "Run final design pass" }).isVisible()) {
      await page.getByRole("button", { name: "Run final design pass" }).click();
      await expect(page.getByText(/Final design pass complete/)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Accept and freeze design" }).click();
    }
    await expect(page.getByText(/Design frozen \(Accepted design v[12] is reconciled/)).toBeVisible({ timeout: 30_000 });


  await acceptDerivatives(page, PAGE_SLUG);
  // Configure only this test project's isolated profile/target; no content,
  // design, visual or provider authority is seeded or relabelled.
  const configured = await page.request.post(`http://127.0.0.1:${process.env.FACTORY_E2E_SUPERVISOR_PORT || 4177}/configure-test-site`, { data: { projectId, pageSlug: PAGE_SLUG } });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  await gotoArea(page, "Production");
  await page.getByPlaceholder("home").fill(PAGE_SLUG);
  const rejected = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/production/prepare-candidate"));
  await page.getByRole("button", { name: "Prepare candidate" }).click();
  const response = await rejected;
  expect(response.ok()).toBeFalsy();
  const error = await response.json();
  expect(error.error.code).toMatch(/production_|design_/);
  expect(error.error.message).toMatch(/fixture/i);
  const design = await read("design/workspace");
  expect(design.accepted.providerMode).toBe("fixture");
  const production = await read("production/workspace");
  expect(production.candidates).toHaveLength(0);
  const evidence = { classification: "FIXTURE_ONLY_NOT_PUBLICATION_AUTHORITY", projectId, search, writer, assets: await read("assets/workspace"), design, visual: await read("visual/workspace"), derivatives: await read("derivatives/workspace"), production, rejection: error, boundary: "Isolated project/site target is configured; fixture design/visual output cannot grant live production authority. No candidate HTML/artifact/production QA exists for this chain." };
  const evidenceDir = path.resolve(import.meta.dirname, "../../../.factory/e2e01/stark-browser");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "traceability.json"), JSON.stringify(evidence, null, 2));
});
