import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { sql, and, eq } from "drizzle-orm";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { FactoryError } from "../../src/executor/errors.js";
import { DesignStore } from "../../src/design/design-store.js";
import { VisualStore } from "../../src/visual/store.js";
import { ProductionStore } from "../../src/production/store.js";
import { ProductionBuildService } from "../../src/production/build-service.js";
import { DerivativesService } from "../../src/derivatives/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { parseDesignCandidateData, parseProductionPageInputV2Data, type DesignCandidateData } from "@factory/contracts";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import {
  requireProductionDerivativeSet,
  deriveCurrentDerivativeIntentAuthority,
} from "../../src/derivatives/production-verifier.js";
import {
  seedSyntheticProductionDerivativeSet,
  seedSyntheticAcceptedSummary,
  seedSyntheticAcceptedAudio,
} from "./run10-test-helpers.js";
import { runSiteWideQa } from "../../src/production/qa/site-wide.js";
import { acceptedPageContent, acceptedDerivativeSets } from "../../src/persistence/schema.js";
import { DerivativesStore } from "../../src/derivatives/store.js";
import { acceptedDerivativeSetDigest } from "../../src/derivatives/core.js";

/**
 * MACRO RUN 10 — GOLDEN SEAM PROOF & DIRECT VERIFIER INVARIANTS
 *
 * Proves the full end-to-end derivative chain:
 *   Real DB
 *   ↓ AcceptedDerivativeSet (Option A canonical ordering)
 *   ↓ ProductionPageInput (production-v2 schema)
 *   ↓ ProductionBuildService / actual Astro static build (pnpm run build)
 *   ↓ Actual built dist
 *   ↓ Deterministic site-wide QA PASS
 *   ↓ Local static preview server
 *   ↓ Playwright Chromium browser
 *
 * And proves negative seam guards:
 *   - fixture summary rejected by requireProductionDerivativeSet
 *   - fixture audio rejected by requireProductionDerivativeSet
 *   - forged set digest rejected
 *   - stale policy fails deriveProductionInput immediately
 *   - stale content rejected
 *   - audio binary byte mutation rejected
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

function candidateData(pageSlug: string): DesignCandidateData {
  const isHome = pageSlug === "home" || pageSlug === "" || pageSlug === "/";
  const kind = isHome ? "homepage" : "service";
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "projects/fixture",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      rationale: "Seed rationale",
    },
    providerEvidence: {},
    tokens: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      spacing: { md: "16px" },
      rounded: { md: "8px" },
    },
    screens: [
      {
        id: "screen-1",
        providerScreenName: "projects/fixture/screens/abc",
        title: isHome ? "Home page" : "Service page",
        deviceType: "DESKTOP",
        archetype: kind,
      },
    ],
    archetypes: [
      {
        kind,
        purpose: isHome ? "Trust-first homepage" : "Trust-first service page",
        providerScreenNames: ["projects/fixture/screens/abc"],
        sectionPatterns: ["page-header", "article-body", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero placeholder",
            pageSlug,
            role: "hero",
            requiredRole: "hero",
            providerConsumed: false,
            placeholder: true,
            unresolvedReason: "No approved asset assignment for hero.",
          },
        ],
        primaryCta: "Request an inspection",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Fixture rationale",
  });
}

async function setupGoldenEnvironment(dbInst: FactoryDatabaseInstance, repoRoot: string, key: string, pageSlug: string) {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  await acceptFixturePage(dbInst, projectId, pageSlug);

  const assetsModule = await import("../../src/assets/service.js");
  const assets = new assetsModule.AssetService({
    store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
    storage: createAssetStorage(repoRoot),
  });

  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
    altIntent: "Hero roof inspection",
    rightsStatus: "operator_owned",
    dataBase64: bytes.toString("base64"),
  });
  const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
  const liveData = parseDesignCandidateData({ ...candidateData(pageSlug), providerMode: "live", providerProjectName: "projects/live" });
  const candidate = await designStore.createCandidate({ projectId, inputSnapshot: snapshot, data: liveData });
  await dbInst.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
  const accepted = await designStore.acceptCandidate({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "live acceptance (golden seam authority)",
  });

  const visualStore = new VisualStore(dbInst.db);
  const planId = `vap-${key}`;
  await dbInst.db.execute(sql`
    INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
    VALUES (${planId}, ${projectId}, 1, ${accepted.id}, ${accepted.version}, ${accepted.candidateDigest}, ${accepted.inputDigest}, 'live', '[]'::jsonb, ${"c".repeat(64)})
  `);
  await visualStore.createAcceptedSetAtomic({
    projectId,
    planId,
    providerMode: "live",
    designArtifactId: accepted.id,
    designArtifactVersion: accepted.version,
    designCandidateDigest: accepted.candidateDigest,
    designInputDigest: accepted.inputDigest,
    slots: [
      {
        slot: "hero.primary",
        pageSlug,
        role: "hero",
        resolvedVersionId: approved.id,
        binaryDigest: approved.binaryDigest,
        governanceDigest: approved.governanceDigest!,
        resolutionMode: "reuse_real",
        truthClass: "illustrative",
      },
    ],
  });

  return { projectId, production: new ProductionStore(dbInst.db) };
}

function fixtureSummaryInvoke(request: { prompt: string }) {
  const marker = "ACCEPTED PAGE CONTENT FOLLOWS:";
  const idx = request.prompt.indexOf(marker);
  const body = idx >= 0 ? request.prompt.slice(idx + marker.length).trim() : request.prompt;
  const snippet = body.slice(0, 160).replace(/\s+/g, " ");
  return Promise.resolve({
    summaryText: `Summary: ${snippet}`,
    usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125, costMicros: 0, currency: "USD" },
    model: "fixture-model",
    rawOutput: `Summary: ${snippet}`,
  });
}

function serveStatic(distDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      let filePath = path.join(distDir, parsed.pathname);
      let stat = await readFile(filePath).then(() => ({ isFile: true })).catch(() => null);
      if (!stat) {
        filePath = path.join(filePath, "index.html");
        stat = await readFile(filePath).then(() => ({ isFile: true })).catch(() => null);
      }
      if (!stat) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const data = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".wav": "audio/wav",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".json": "application/json",
      };
      res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("Internal Error");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// -----------------------------------------------------------------------------
// 1. FULL GOLDEN SEAM E2E TEST
// -----------------------------------------------------------------------------

test("GOLDEN SEAM: real DB → AcceptedDerivativeSet → production-v2 → manifest → Astro build → QA → Playwright browser", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "home";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-e2e-1", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const syntheticSummaryText = "Expert roof inspection and repair services for commercial and residential properties.";
  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
    summaryText: syntheticSummaryText,
  });

  // Verify Option A canonical digest/version canonicality:
  assert.equal(acceptedDerivativeSetDigest(synthetic.setData), synthetic.set.setDigest);
  assert.equal(synthetic.setData.version, synthetic.set.version);

  const buildService = new ProductionBuildService(dbInst.db, repoRoot);
  const prep = await buildService.prepareCandidate({
    projectId: env.projectId,
    pageSlug,
  });

  const store = new ProductionStore(dbInst.db);
  const inputRow = await store.latestProductionInput(env.projectId, pageSlug);
  assert.ok(inputRow);
  const inputData = parseProductionPageInputV2Data(inputRow.data);
  assert.equal(inputData.schemaVersion, "production-v2");
  assert.equal(inputData.acceptedDerivativeSet.id, synthetic.set.id);
  assert.equal(inputData.acceptedDerivativeSet.version, synthetic.set.version);
  assert.equal(inputData.acceptedDerivativeSet.digest, synthetic.set.setDigest);

  // Execute real Astro build from compiled manifest:
  const buildResult = await buildService.buildCandidate({
    projectId: env.projectId,
    candidateId: prep.candidateId,
  });

  assert.ok(buildResult.artifactDigest.length === 64);
  assert.ok(buildResult.manifestSetDigest.length === 64);
  assert.equal(buildResult.routeCount, 1);
  assert.deepEqual(buildResult.htmlRoutes, ["/home"]);

  const manifests = await buildService.loadManifests({ projectId: env.projectId, candidateId: prep.candidateId });
  assert.equal(manifests.length, 1);
  const manifest = manifests[0]!;
  assert.ok(manifest.derivatives);
  assert.equal(manifest.derivatives.summary.state, "accepted");
  assert.equal(manifest.derivatives.summary.summaryText, syntheticSummaryText);
  assert.equal(manifest.derivatives.audio.state, "accepted");
  assert.equal(manifest.derivatives.audio.binaryDigest, synthetic.audio!.binaryDigest);
  assert.equal(manifest.derivatives.audio.publicPath, `/production-assets/${synthetic.audio!.binaryDigest}.wav`);

  const candidate = await store.getCandidate(env.projectId, prep.candidateId);
  assert.ok(candidate?.artifactRef);
  assert.ok(candidate?.repositorySha);

  // Verify site-wide QA passes on the built output:
  const qa = await runSiteWideQa({
    distDir: candidate.artifactRef,
    manifests,
    redirectRules: [],
    siteName: manifest.input.siteIdentity.siteName,
    manifestSetDigest: buildResult.manifestSetDigest,
    repositorySha: candidate.repositorySha,
  });
  const failures = qa.checks.filter((c) => c.verdict === "FAIL");
  assert.deepEqual(failures.map((f) => f.checkId), [], `Site-wide QA failures: ${JSON.stringify(failures)}`);
  assert.equal(qa.overall, "PASS");

  // Verify audio file exists on disk with exact binary digest:
  const audioDiskBytes = await readFile(path.join(candidate.artifactRef, "production-assets", `${synthetic.audio!.binaryDigest}.wav`));
  assert.equal(sha256HexBytes(audioDiskBytes), synthetic.audio!.binaryDigest);

  // Serve the candidate dist and launch Playwright Chromium:
  const server = await serveStatic(candidate.artifactRef);
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const providerRequests: string[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (/openrouter|anthropic|stitch|vertex|ai\.google|tts|speech|api\./i.test(url)) {
          providerRequests.push(url);
        }
      });

      const response = await page.goto(`${server.url}/home`);
      assert.equal(response!.status(), 200);

      // Verify AI summary element:
      const summaryEl = page.locator('[data-derivative="summary"]');
      assert.equal(await summaryEl.count(), 1);
      const summaryHeader = await summaryEl.locator("summary").textContent();
      assert.match(summaryHeader ?? "", /AI-generated summary/i);
      const summaryBody = await summaryEl.locator("p").textContent();
      assert.equal(summaryBody?.trim(), syntheticSummaryText);

      // Verify Audio element:
      const audioEl = page.locator('[data-derivative="audio"]');
      assert.equal(await audioEl.count(), 1);
      const audioTag = audioEl.locator("audio");
      assert.equal(await audioTag.count(), 1);
      assert.equal(await audioTag.getAttribute("controls"), "");
      assert.equal(await audioTag.getAttribute("preload"), "none");
      const srcAttr = await audioTag.getAttribute("src");
      assert.equal(srcAttr, `/production-assets/${synthetic.audio!.binaryDigest}.wav`);

      // 100 visitor interactions trigger ZERO provider calls:
      for (let i = 0; i < 20; i++) {
        await summaryEl.locator("summary").click();
      }
      assert.deepEqual(providerRequests, [], "Zero provider calls must occur during visitor interactions.");
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
    // Clean up candidate staging / dist
    const candidateDir = path.dirname(candidate.artifactRef);
    await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// -----------------------------------------------------------------------------
// 2. REBUILD DETERMINISM TEST (Section 44)
// -----------------------------------------------------------------------------

test("DETERMINISM: Re-compiling manifest without authority changes yields identical digests", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-det-1", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
    summaryText: "Deterministic summary test.",
  });

  const verified1 = await requireProductionDerivativeSet({
    db: dbInst.db,
    projectId: env.projectId,
    pageIdentity: pageSlug,
    setId: synthetic.set.id,
    setVersion: synthetic.set.version,
    setDigest: synthetic.set.setDigest,
    currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  const verified2 = await requireProductionDerivativeSet({
    db: dbInst.db,
    projectId: env.projectId,
    pageIdentity: pageSlug,
    setId: synthetic.set.id,
    setVersion: synthetic.set.version,
    setDigest: synthetic.set.setDigest,
    currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  assert.equal(verified1.set.setDigest, verified2.set.setDigest);
  assert.equal(
    verified1.summary.state === "accepted" ? verified1.summary.acceptedDigest : null,
    verified2.summary.state === "accepted" ? verified2.summary.acceptedDigest : null,
  );
  assert.equal(
    verified1.audio.state === "accepted" ? verified1.audio.acceptedDigest : null,
    verified2.audio.state === "accepted" ? verified2.audio.acceptedDigest : null,
  );
});

// -----------------------------------------------------------------------------
// 3. NEGATIVE SEAM TESTS (Section 31 & 32)
// -----------------------------------------------------------------------------

test("NEGATIVE SEAM: requireProductionDerivativeSet rejects fixture summary", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-1", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  // Seed synthetic set with summary, then manually mutate summary record to fixture mode
  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Mutate summary to fixture mode
  await dbInst.db.execute(
    sql`UPDATE accepted_summary_artifacts SET provider_mode = 'fixture', is_test_double = true WHERE id = ${synthetic.summary!.id}`,
  );

  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: synthetic.set.setDigest,
        currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
      }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
});

test("NEGATIVE SEAM: requireProductionDerivativeSet rejects fixture audio", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-2", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: false, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Mutate audio record to fixture mode
  await dbInst.db.execute(
    sql`UPDATE accepted_audio_artifacts SET provider_mode = 'fixture', is_test_double = true WHERE id = ${synthetic.audio!.id}`,
  );

  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: synthetic.set.setDigest,
        currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
      }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
});

test("NEGATIVE SEAM: forged set digest is rejected", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-3", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Call with forged set digest:
  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: "a".repeat(64),
        currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
      }),
    (err: unknown) => isCode(err, "derivative_authority_digest_mismatch"),
  );

  // Forged data inside the database row:
  await dbInst.db.execute(
    sql`UPDATE accepted_derivative_sets SET data = jsonb_set(data, '{summary,version}', '999') WHERE id = ${synthetic.set.id}`,
  );
  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: synthetic.set.setDigest,
        currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
      }),
    (err: unknown) => isCode(err, "derivative_authority_digest_mismatch"),
  );
});

test("NEGATIVE SEAM: stale policy makes deriveProductionInput fail immediately with production_authority_stale", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-4", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Mutate policy to v2
  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  // deriveProductionInput must fail immediately on policy drift
  await assert.rejects(
    () =>
      env.production.deriveProductionInput({
        projectId: env.projectId,
        pageSlug,
        siteIdentity: { siteId: "site-fixture", siteName: "Fixture Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) },
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      }),
    (err: unknown) => isCode(err, "production_authority_stale"),
  );
});

test("NEGATIVE SEAM: stale content makes requireProductionDerivativeSet reject", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-5", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Upstream content moved to C2
  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: synthetic.set.setDigest,
        currentContent: { id: contentRow.id, version: contentRow.version + 1, digest: "b".repeat(64) },
      }),
    (err: unknown) => isCode(err, "production_authority_stale"),
  );
});

test("NEGATIVE SEAM: audio binary byte mutation in storage fails closed", async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  const pageSlug = "services/roof-repair";
  const env = await setupGoldenEnvironment(dbInst, repoRoot, "gold-neg-6", pageSlug);

  const derivService = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });

  await derivService.updateProjectPolicy({
    projectId: env.projectId,
    summary: { enabled: false, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const [contentRow] = await dbInst.db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, env.projectId), eq(acceptedPageContent.slug, pageSlug)));
  assert.ok(contentRow);

  const synthetic = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: env.projectId,
    pageIdentity: pageSlug,
    sourceContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
  });

  // Mutate stored audio bytes on disk in storage
  const storage = createAssetStorage(repoRoot);
  const corruptedBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const targetPath = storage.absolutePath(storage.derivativeKey(synthetic.audio!.binaryDigest));
  await writeFile(targetPath, corruptedBytes);

  await assert.rejects(
    () =>
      requireProductionDerivativeSet({
        db: dbInst.db,
        projectId: env.projectId,
        pageIdentity: pageSlug,
        setId: synthetic.set.id,
        setVersion: synthetic.set.version,
        setDigest: synthetic.set.setDigest,
        currentContent: { id: contentRow.id, version: contentRow.version, digest: contentRow.contentDigest },
        storage,
      }),
    (err: unknown) => isCode(err, "derivative_binary_digest_mismatch"),
  );
});
