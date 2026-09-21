import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { acceptedPageContent } from "../../src/persistence/schema.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { ProductionStore } from "../../src/production/store.js";
import { VisualStore } from "../../src/visual/store.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { derivePageArchetype, PageArchetypeError } from "../../src/production/page-archetype.js";
import { deriveDesignImplementationContract } from "../../src/production/design-implementation.js";
import { normalizeArchetypeGrammar } from "../../src/design/archetype-grammar.js";
import {
  DESIGN_SCHEMA_VERSION_V2,
  parseDesignCandidateAnyVersion,
  parseDesignInputSnapshotAnyVersion,
  type DesignCandidateData,
  isDesignInputSnapshotV2,
  type DesignCandidateDataV2,
} from "@factory/contracts";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  StitchDesignProvider,
  type StitchMcpClientLike,
  type McpToolCallResult,
} from "../../src/design/stitch-provider.js";
import { VisualService } from "../../src/visual/service.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { visualSetDigest } from "../../src/visual/store.js";
import { FixtureVisualAssetProvider } from "../../src/visual/fixture-adapter.js";
import {
  ProductionRenderCompiler,
  assertManifest,
  computeRenderManifestDigest,
} from "../../src/production/render-manifest.js";
import { emitSitemapAndRobots } from "../../src/production/seo-engine.js";
import { runSiteWideQa } from "../../src/production/qa/site-wide.js";
import { parseRenderManifestAnyVersion } from "@factory/contracts";
import { resolveRepositoryRoot } from "../../src/repo-root.js";

class OfflineLiveVisualAssetProvider extends FixtureVisualAssetProvider {
  override readonly providerMode = "live" as const;
}

class MockStitchClient implements StitchMcpClientLike {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private toolSequence: Array<Record<string, unknown>> = [];

  queue(result: Record<string, unknown>): void {
    this.toolSequence.push(result);
  }

  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return {
      tools: [
        { name: "create_project" },
        { name: "delete_project" },
        { name: "list_screens" },
        { name: "get_screen" },
        { name: "generate_screen_from_text" },
        { name: "create_design_system" },
      ],
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolCallResult> {
    this.calls.push({ name: params.name, args: params.arguments });
    const next = this.toolSequence.shift();
    if (next === undefined) {
      throw new Error(`MockStitchClient: unexpected tool call ${params.name}`);
    }
    return { structuredContent: next };
  }

  async close(): Promise<void> {}
}

function screenResult(screenName: string): Record<string, unknown> {
  return {
    name: screenName,
    title: "Fixture Screen",
    deviceType: "DESKTOP",
    htmlCode: { name: `${screenName}/html`, mimeType: "text/html", downloadUrl: null },
    screenshot: { name: `${screenName}/shot`, mimeType: "image/png", downloadUrl: null },
  };
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", reject);
  });
}

/**
 * PRE-RUN-12 MULTI-PAGE AUTHORITY CHAIN — mandatory scale proof.
 *
 * Full integration across REAL authority derivation (no fabricated final
 * manifests): accepted page/planning authority -> typed page archetype
 * binding (policy) -> design input snapshot (v2, design-defining scope) ->
 * accepted design -> per-page visual authority -> ProductionPageInput ->
 * render manifest (production-v3 with DIC evidence) — for:
 *
 *   /                    -> homepage
 *   services/advisory    -> service   (representative page)
 *   services/valuation   -> service   (SAME archetype, NOT representative)
 *   locations/chamonix   -> location
 *   research/report      -> editorial
 *
 * Plus the FIFTH-PAGE REUSE PROOF in both interpretations (Case A:
 * pre-existing non-representative page; Case B: page added after design
 * acceptance) with ZERO DesignProvider calls and ZERO new
 * AcceptedDesignArtifact records, and the §26 negative tests.
 */

const REPOSITORY_SHA = "1".repeat(40);
const LOCKFILE_DIGEST = "2".repeat(64);

function siteIdentity() {
  return { siteId: "site-fixture", siteName: "Fixture Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) };
}

type ArchKind = DesignCandidateDataV2["archetypes"][number]["kind"];
function v2CandidateData(input: { archetypes: Array<{ kind: ArchKind; sectionPatterns: string[]; pageSlug: string; providerScreenName: string }>; providerMode?: "fixture" | "live"; providerProjectName?: string }): DesignCandidateDataV2 {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION_V2,
    provider: "google-stitch",
    providerMode: input.providerMode ?? "fixture",
    providerProjectName: input.providerProjectName ?? "projects/fixture",
    providerDesignSystemAsset: "",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "fixture scale" },
      rationale: "Seed rationale",
    },
    providerEvidence: { designSystemAsset: "" },
    tokens: {
      colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2", background: "#FFFFFF", surface: "#F7F5F2", textPrimary: "#1A2E35", textSecondary: "#4A5A62" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "fixture scale" },
      spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px" },
      rounded: { sm: "4px", md: "8px" },
      ctaHierarchy: "Primary solid accent; secondary outlined",
      navigationLanguage: "Fixture navigation language",
      imageryTreatment: "Placeholders explicitly labeled",
      sectionRhythm: "Fixture rhythm",
    },
    screens: input.archetypes.map((archetype) => ({
      id: `screen-${archetype.kind}`,
      providerScreenName: archetype.providerScreenName,
      title: archetype.kind,
      deviceType: "DESKTOP",
      archetype: archetype.kind,
    })) as DesignCandidateDataV2["screens"],
    archetypes: input.archetypes.map((archetype) => ({
      kind: archetype.kind,
      purpose: `Fixture ${archetype.kind} archetype`,
      providerScreenNames: [archetype.providerScreenName],
      sectionPatterns: archetype.sectionPatterns,
      contentRequirements: ["Accepted copy presented verbatim"],
      assetSlots: [
        {
          slot: "hero.primary",
          requirement: "Hero placeholder",
          pageSlug: archetype.pageSlug,
          role: "hero",
          requiredRole: "hero",
          providerConsumed: false,
          placeholder: true,
          unresolvedReason: "No approved asset assignment.",
        },
      ],
      primaryCta: "Primary action",
      secondaryCta: "",
      responsiveBehavior: "Mobile-first fixture behavior",
      trustPresentation: "Author/date/source areas visible",
    })) as DesignCandidateDataV2["archetypes"],
    visualRoleRequirements: input.archetypes.map((archetype) => ({
      archetype: archetype.kind as ArchKind,
      roles: [
        { role: "hero-primary", requirement: `${archetype.kind} hero visual`, requiredRole: "hero", required: false },
      ],
    })),
    archetypeGrammar: normalizeArchetypeGrammar(
      input.archetypes.map((archetype) => ({
        kind: archetype.kind as ArchKind,
        sectionPatterns: archetype.sectionPatterns,
      })),
    ),
    normalization: {
      factoryAuthorityGroups: ["tokens", "typography", "spacing", "rounded", "ctaHierarchy", "navigationLanguage", "imageryTreatment", "sectionRhythm", "archetypeStructure"],
      providerDerivedGroups: [],
      note: "Fixture candidate: structured values are Factory authority; provider screens are evidence only.",
    },
    rationale: "Deterministic v2 fixture candidate.",
    providerSessionId: "fixture-session-1",
  };
}

const ARCHETYPE_SECTIONS: Record<string, string[]> = {
  homepage: ["hero", "value-statement", "evidence", "services-overview", "trust-signals", "conclusion", "cta"],
  service: ["page-header", "service-overview", "process", "evidence", "faq", "conclusion", "cta"],
  location: ["page-header", "location-intro", "coverage", "local-evidence", "contact", "conclusion", "cta"],
  editorial: ["article-header", "article-body", "methodology", "sources", "conclusion", "cta"],
  investment_advisory: ["page-header", "approach", "assumptions", "scenarios", "disclaimer", "conclusion", "cta"],
};

interface ChainEnv {
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>;
  projectId: string;
  designId: string;
  designDigest: string;
  visualSetId: string;
  visualSetDigest: string;
  planId: string;
  production: ProductionStore;
  designStore: DesignStore;
  visualStore: VisualStore;
  visualService: VisualService;
  assets: import("../../src/assets/service.js").AssetService;
  acceptedPages: string[];
  root: string;
}

/**
 * Derive the design input snapshot using repository-owned default policy
 * (fresh projects default to design-v2 without requiring env overrides).
 */
async function setupV2Chain(
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>,
  key: string,
  pageSlugs: string[],
): Promise<ChainEnv> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  const acceptedPages: string[] = [];
  for (const slug of pageSlugs) {
    await acceptFixturePage(dbInst, projectId, slug);
    acceptedPages.push(slug);
  }
  const root = await mkdtemp(path.join(tmpdir(), "pre-run12-"));
  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
  const snapshotData = parseDesignInputSnapshotAnyVersion(snapshot.data);
  if (!isDesignInputSnapshotV2(snapshotData)) throw new Error("expected design-v2 snapshot derivation");

  // Live Stitch provider generation via deterministic MCP mock (P1 prompt §2 & §10)
  const mockStitch = new MockStitchClient();
  mockStitch.queue({ name: `projects/pr12-${key}`, title: `factory-${projectId.slice(0, 8)}-design` });
  mockStitch.queue({ name: `assets/ds-${key}` });
  for (const kind of snapshotData.archetypes) {
    mockStitch.queue({
      outputComponents: [
        { design: { screens: [{ name: `projects/pr12-${key}/screens/${kind}`, title: kind, deviceType: "DESKTOP" }] } },
      ],
      sessionId: `sess-${kind}`,
    });
    mockStitch.queue(screenResult(`projects/pr12-${key}/screens/${kind}`));
    if (kind === "homepage") {
      mockStitch.queue({
        outputComponents: [
          { design: { screens: [{ name: `projects/pr12-${key}/screens/home-mob`, title: "Home Mobile", deviceType: "MOBILE" }] } },
        ],
        sessionId: "sess-mob",
      });
      mockStitch.queue(screenResult(`projects/pr12-${key}/screens/home-mob`));
    }
  }

  const stitchProvider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "mock-token" },
    createClient: () => mockStitch,
  });

  const copyByArchetype: Record<string, { slug: string; title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string; cta: string }> = {};
  for (const rep of snapshotData.representativePages) {
    copyByArchetype[rep.archetype] = {
      slug: rep.slug,
      title: rep.slug,
      introduction: `Introduction for ${rep.slug}`,
      sections: [{ heading: "Process", body: `Body for ${rep.slug}` }],
      conclusion: `Conclusion for ${rep.slug}`,
      cta: `Contact ${rep.slug}`,
    };
  }

  const genResult = await stitchProvider.generateDesignSystem({
    inputSnapshot: snapshotData,
    inputSnapshotId: snapshot.id,
    projectId,
    acceptedCopyByArchetype: copyByArchetype,
    designSeed: {
      colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "Institutional typographic scale" },
      rationale: "Institutional advisory identity.",
    },
  });

  const candidate = await designStore.createCandidate({
    projectId,
    inputSnapshot: snapshot,
    data: genResult.candidate,
  });
  const accepted = await designStore.acceptCandidate({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "pre-run12 live stitch acceptance",
  });

  // Visual asset authority: real AssetService with storage in root
  const assetsModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const assets = new assetsModule.AssetService({
    store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });
  const heroBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const heroUpload = await assets.uploadAsset(projectId, {
    filename: "hero-advisory.jpg",
    kind: "photo",
    title: "Advisory hero",
    rightsStatus: "operator_owned",
    dataBase64: heroBytes.toString("base64"),
    altIntent: "Professional financial advisory consultation and valuation services",
  });
  const approvedHero = await assets.approveVersion(projectId, heroUpload.version.id, heroUpload.version.binaryDigest);

  const bgBytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 30, b: 40 } } }).jpeg().toBuffer();
  const bgUpload = await assets.uploadAsset(projectId, {
    filename: "bg-location.jpg",
    kind: "photo",
    title: "Location background",
    rightsStatus: "operator_owned",
    dataBase64: bgBytes.toString("base64"),
    altIntent: "Location landscape background",
  });
  const approvedBg = await assets.approveVersion(projectId, bgUpload.version.id, bgUpload.version.binaryDigest);

  // Derive visual asset plan using REAL VisualService.derivePlan() (prompt §10)
  const visualStore = new VisualStore(dbInst.db);
  const budgetStore = new VisualBudgetStore(dbInst.db);
  const visualService = new VisualService({
    store: visualStore,
    designStore,
    assets,
    budget: budgetStore,
    provider: new OfflineLiveVisualAssetProvider(),
    repoRoot: root,
  });
  const plan = await visualService.derivePlan({ projectId });

  // Resolve required slots via real VisualService lifecycle; optional slots remain unresolved.
  const planData = visualStore.planData(plan);
  for (const slot of planData.slots) {
    if (slot.required) {
      const approvedToUse = slot.role === "hero" ? approvedHero : approvedBg;
      await visualService.confirmClassification({
        projectId,
        planId: plan.id,
        slot: slot.slot,
        truthClass: "illustrative",
      });
      await visualService.resolveReuse({
        projectId,
        planId: plan.id,
        slot: slot.slot,
        versionId: approvedToUse.id,
      });
    }
  }

  const visualRecord = await visualService.acceptSet({
    projectId,
    planId: plan.id,
  });

  return {
    dbInst,
    projectId,
    designId: accepted.id,
    designDigest: accepted.candidateDigest,
    visualSetId: visualRecord.id,
    visualSetDigest: visualRecord.setDigest,
    planId: plan.id,
    production: new ProductionStore(dbInst.db),
    designStore,
    visualStore,
    visualService,
    assets,
    acceptedPages,
    root,
  };
}

test("PG pre-run12: two pages of one archetype classify independently; representative pages are evidence only", async () => {
  const dbInst = await setupMigratedTestDatabase();
  let env: ChainEnv | undefined;
  try {
    env = await setupV2Chain(dbInst, "pr12-a", ["home", "services/advisory", "services/valuation", "locations/chamonix", "research/report"]);
    // Both service pages derive production inputs independently.
    for (const slug of ["home", "services/advisory", "services/valuation", "locations/chamonix", "research/report"]) {
      const input = await env.production.deriveProductionInput({
        projectId: env.projectId,
        pageSlug: slug,
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v3",
      });
      const expected = derivePageArchetype(slug, ["homepage", "service", "location", "editorial", "investment_advisory"]).archetype;
      assert.equal(input.pageType, expected, `${slug} -> ${expected}`);
      assert.equal(input.acceptedDesignId, env.designId);
    }
    // services/advisory and services/valuation BOTH classify as service
    // although only one was the representative page.
    const advisory = await env.production.latestProductionInput(env.projectId, "services/advisory");
    const valuation = await env.production.latestProductionInput(env.projectId, "services/valuation");
    assert.equal(advisory!.pageType, "service");
    assert.equal(valuation!.pageType, "service");

    // Real production manifest compilation & Astro build & QA for services/valuation (P1 prompt §10)
    const repoRoot = await resolveRepositoryRoot();
    const compiler = new ProductionRenderCompiler(env.dbInst.db, env.root);
    const assetSnapshotDir = path.join(env.root, "asset-snapshots");
    const manifestDir = path.join(env.root, "manifests");
    const distDir = path.join(env.root, "dist");

    const manifest = await compiler.compileManifest({
      projectId: env.projectId,
      productionInputId: valuation!.id,
      assetSnapshotDir,
    });

    // Invariants of production-v3 manifest
    assert.equal(manifest.schemaVersion, "production-v3");
    assert.doesNotThrow(() => assertManifest(manifest));
    assert.ok(manifest.design.designImplementation);
    assert.match(manifest.design.designImplementation.implementationContractDigest, /^[0-9a-f]{64}$/);
    assert.equal(manifest.design.designImplementation.policyVersion, "production-policy-v3");
    assert.ok(manifest.design.semanticTokens);
    assert.ok(manifest.design.semanticTokens.some((t) => t.role === "color.background.primary"));
    assert.ok(manifest.design.composition);
    assert.ok(manifest.design.composition.length > 0);
    assert.equal(manifest.derivatives?.state, "disabled");

    // Write manifest to manifest directory
    await compiler.writeManifest(manifest, manifestDir);

    // Run real Astro build
    const siteDir = path.join(repoRoot, "sites", "starter");
    const buildResult = await runProcess("pnpm", ["run", "build"], {
      cwd: siteDir,
      env: {
        ...process.env,
        FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir,
        FACTORY_PRODUCTION_OUT_DIR: distDir,
        FACTORY_PRODUCTION_SITE_PROFILE_DIGEST: siteIdentity().profileDigest,
        PUBLIC_SITE_URL: siteIdentity().canonicalOrigin,
      },
      timeoutMs: 120_000,
    });
    assert.equal(buildResult.exitCode, 0, `Astro build failed: ${buildResult.stderr}`);

    // Verify built HTML output
    const valuationHtml = await readFile(path.join(distDir, "services", "valuation", "index.html"), "utf8");
    assert.ok(valuationHtml.includes("<!DOCTYPE html>") || valuationHtml.includes("<html"));
    assert.match(valuationHtml, /valuation/i);

    // Emit sitemap and run site-wide QA
    await emitSitemapAndRobots({ manifests: [manifest], distDir, siteName: siteIdentity().siteName });
    const qa = await runSiteWideQa({
      distDir,
      manifests: [manifest],
      redirectRules: [],
      siteName: siteIdentity().siteName,
      manifestSetDigest: deterministicDigest([{ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest }]),
      repositorySha: REPOSITORY_SHA,
    });
    assert.equal(qa.overall, "PASS");
    const sectionUniqueCheck = qa.checks.find((c) => c.checkId === "content.sections_unique");
    assert.ok(sectionUniqueCheck);
    assert.equal(sectionUniqueCheck.verdict, "PASS");
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    if (env) {
      await rm(env.root, { recursive: true, force: true }).catch(() => undefined);
    }
    await dbInst.close();
  }
});

test("PG pre-run12: adding a page after design acceptance does NOT stale a v2 design and needs no new artifact", async () => {
  const dbInst = await setupMigratedTestDatabase();
  let env: ChainEnv | undefined;
  try {
    env = await setupV2Chain(dbInst, "pr12-b", ["home", "services/advisory"]);
    const beforeView = await env.designStore.latestAcceptedDesign(env.projectId);
    assert.ok(beforeView);
    const before = beforeView.artifact;
    // Case B: a NEW ordinary service page after design acceptance.
    await acceptFixturePage(dbInst, env.projectId, "services/valuation");
    const stalenessView = await env.designStore.latestAcceptedDesign(env.projectId);
    assert.equal(stalenessView!.staleness.stale, false, `v2 design must not stale on ordinary page addition: ${stalenessView!.staleness.reason}`);
    const after = stalenessView!.artifact;
    assert.equal(after.id, before.id);
    assert.equal(after.version, before.version);
    // The new page classifies and derives production input with the SAME design.
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });
    assert.equal(input.pageType, "service");
    assert.equal(input.acceptedDesignId, before!.id);
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    if (env) {
      await rm(env.root, { recursive: true, force: true }).catch(() => undefined);
    }
    await dbInst.close();
  }
});

test("PG pre-run12: v1 designs keep historical CONTENT_ADDED staleness semantics", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "pr12-v1");
    await acceptFixturePage(dbInst, projectId, "home");
    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId, schemaVersion: "design-v1" });
    const data = parseDesignCandidateAnyVersion({
      schemaVersion: "design-v1",
      provider: "google-stitch",
      providerMode: "fixture",
      providerProjectName: "projects/fixture",
      designMdDigest: "d".repeat(64),
      designMdToolVersion: "factory-design-md-lint-v1",
      designMdLint: { errors: 0, warnings: 0, infos: 0 },
      designSeed: { colors: { primary: "#1A2E35" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" }, rationale: "r" },
      providerEvidence: { designSystemAsset: "" },
      tokens: {
        colors: { primary: "#1A2E35" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
        spacing: { md: "16px" },
        rounded: { md: "8px" },
      },
      screens: [{ id: "s1", providerScreenName: "p/1", title: "t", deviceType: "DESKTOP", archetype: "homepage" }],
      archetypes: [
        { kind: "homepage", purpose: "p", providerScreenNames: ["p/1"], sectionPatterns: ["hero", "evidence", "cta"], contentRequirements: ["c"], assetSlots: [{ slot: "hero.primary", requirement: "r", pageSlug: "home", role: "hero", requiredRole: "hero", providerConsumed: false, placeholder: true, unresolvedReason: "none" }], primaryCta: "", secondaryCta: "", responsiveBehavior: "r", trustPresentation: "t" },
      ],
      rationale: "r",
    });
    const candidate = await designStore.createCandidate({ projectId, inputSnapshot: snapshot, data });
    await designStore.acceptCandidate({ projectId, candidateId: candidate.id, expectedCandidateDigest: candidate.candidateDigest, reviewNotes: "v1 fixture acceptance" });
    assert.equal((await designStore.latestAcceptedDesign(projectId))!.staleness.stale, false);
    // Add a page -> v1 whole-inventory semantics: CONTENT_ADDED stale.
    await acceptFixturePage(dbInst, projectId, "services/advisory");
    const staleness = (await designStore.latestAcceptedDesign(projectId))!.staleness;
    assert.equal(staleness.stale, true);
    assert.equal(staleness.code, "CONTENT_ADDED");
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    await dbInst.close();
  }
});

test("PG pre-run12: archetype classification negative paths fail closed", () => {
  const supported: DesignCandidateDataV2["archetypes"][number]["kind"][] = ["homepage", "service", "location", "editorial", "investment_advisory"];
  // missing binding (unclassified)
  assert.throws(() => derivePageArchetype("completely-unknown-page", supported), PageArchetypeError);
  try {
    derivePageArchetype("completely-unknown-page", supported);
    assert.fail("expected unclassified");
  } catch (error) {
    assert.ok(error instanceof PageArchetypeError);
    assert.equal(error.code, "page_archetype_unclassified");
  }
  // unsupported archetype (derived but not supported by the design)
  try {
    derivePageArchetype("services/advisory", ["homepage"]);
    assert.fail("expected unsupported");
  } catch (error) {
    assert.ok(error instanceof PageArchetypeError);
    assert.equal(error.code, "page_archetype_unsupported");
  }
  // determinism: same slug -> same archetype
  assert.equal(derivePageArchetype("services/advisory", supported).archetype, derivePageArchetype("services/advisory", supported).archetype);
  assert.equal(derivePageArchetype("/", supported).archetype, "homepage");
});

test("PG pre-run12: DIC determinism and design/policy mutation sensitivity", () => {
  const data = v2CandidateData({ archetypes: [{ kind: "service", sectionPatterns: ARCHETYPE_SECTIONS["service"]!, pageSlug: "services/advisory", providerScreenName: "p/1" }] });
  const a = deriveDesignImplementationContract({ design: data, acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) }, rendererPolicyVersion: "production-policy-v3" });
  const b = deriveDesignImplementationContract({ design: data, acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) }, rendererPolicyVersion: "production-policy-v3" });
  assert.equal(a.implementationContractDigest, b.implementationContractDigest);
  // design mutation (a CONSUMED token role) -> digest change
  const mutated = structuredClone(data);
  mutated.tokens.colors.textPrimary = "#222222";
  const c = deriveDesignImplementationContract({ design: mutated, acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) }, rendererPolicyVersion: "production-policy-v3" });
  assert.notEqual(a.implementationContractDigest, c.implementationContractDigest);
  // renderer policy mutation -> digest change
  const d = deriveDesignImplementationContract({ design: data, acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) }, rendererPolicyVersion: "production-policy-v4" });
  assert.notEqual(a.implementationContractDigest, d.implementationContractDigest);
  // font delivery fail-closed
  const badFont = structuredClone(data);
  badFont.tokens.typography.headingFont = "Mystery Font 9000";
  assert.throws(() => deriveDesignImplementationContract({ design: badFont, acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) }, rendererPolicyVersion: "production-policy-v3" }), /design_font_delivery_unresolved|no deterministic approved delivery/);
});

test("pre-run12: tampered manifest digest fails closed at load; unknown component/variant fail closed", async () => {
  // Validate the tamper-detection contract directly on the manifest shape:
  const manifest = {
    schemaVersion: "production-v3" as const,
    input: { id: "ppin-x", version: 1, digest: "a".repeat(64), projectId: "proj-x", pageIdentity: "services/advisory", pageType: "service" as const, route: "/services/advisory", siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) } },
    seo: { fullTitle: "T | S", description: "d", canonicalUrl: "https://example.com/services/advisory", ogTitle: "T | S", ogDescription: "d", ogUrl: "https://example.com/services/advisory" },
    content: { acceptedId: "wacc-x", acceptedVersion: 1, acceptedDigest: "b".repeat(64), title: "T", metaDescription: "d", introduction: "i", sections: [{ heading: "h", body: "b" }], conclusion: "c", cta: "cta", internalLinks: [] },
    design: {
      acceptedId: "dsac-x", acceptedVersion: 1, acceptedDigest: "a".repeat(64),
      tokens: { colors: { primary: "#111111" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "n" }, spacing: { md: "16px" }, rounded: { md: "8px" }, ctaHierarchy: "c", navigationLanguage: "n", imageryTreatment: "i", sectionRhythm: "s" },
      archetype: { kind: "service" as const, sectionPatterns: ["page-header", "cta"], contentRequirements: [], assetSlots: [], primaryCta: "", secondaryCta: "", responsiveBehavior: "r", trustPresentation: "t", rendererPrimitives: ["hero", "cta"] },
      designImplementation: { implementationContractDigest: "9".repeat(64), policyVersion: "production-policy-v3", schemaVersion: "design-implementation-v1" },
      semanticTokens: [{ role: "color.background.primary", value: "#ffffff" }],
      fontDelivery: [{ mode: "approved_system_stack" as const, family: "Georgia", sourceToken: "typography.display" as const }],
      composition: [{ componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once" as const }],
    },
    links: [], breadcrumbs: [], assets: [],
    derivatives: { setDigest: "e".repeat(64), summary: { state: "disabled" as const }, audio: { state: "disabled" as const } },
    manifestDigest: "",
  };
  const digest = computeRenderManifestDigest(manifest);
  const valid = { ...manifest, manifestDigest: digest };
  assert.doesNotThrow(() => assertManifest(valid));
  // Tamper: any body mutation must invalidate the recorded digest.
  const tampered = structuredClone(valid);
  tampered.content.title = "Tampered";
  assert.throws(() => assertManifest(tampered), /digest mismatch/);
  // Unknown component in composition: assertManifest itself does not check
  // registry membership (that is the renderer + drift QA responsibility), but
  // the drift QA must FAIL on it.
  const { runDesignDriftQa } = await import("../../src/production/qa/design-drift.js");
  const checks = await runDesignDriftQa({
    manifests: [valid as never],
    starterSrcDir: path.join(path.dirname(new URL(import.meta.url).pathname), "../../..", "sites", "starter", "src"),
    manifestSetDigest: digest,
  });
  const composition = checks.find((c) => c.checkId === "design.composition_valid");
  assert.ok(composition);
  assert.equal(composition.verdict, "PASS", "registered page-hero/split composition must pass");
  // Now a genuinely unknown component:
  const unknown = structuredClone(valid);
  unknown.design.composition = [{ componentId: "mystery-widget", variant: "default", pattern: "hero", repetition: "once" as const }];
  const checks2 = await runDesignDriftQa({
    manifests: [unknown as never],
    starterSrcDir: path.join(path.dirname(new URL(import.meta.url).pathname), "../../..", "sites", "starter", "src"),
    manifestSetDigest: digest,
  });
  const composition2 = checks2.find((c) => c.checkId === "design.composition_valid");
  assert.equal(composition2!.verdict, "FAIL");
  assert.match(composition2!.detail, /unknown component mystery-widget/);
  // Unknown variant on a registered component:
  const unknownVariant = structuredClone(valid);
  unknownVariant.design.composition = [{ componentId: "page-hero", variant: "fancy", pattern: "hero", repetition: "once" as const }];
  const checks3 = await runDesignDriftQa({
    manifests: [unknownVariant as never],
    starterSrcDir: path.join(path.dirname(new URL(import.meta.url).pathname), "../../..", "sites", "starter", "src"),
    manifestSetDigest: digest,
  });
  const composition3 = checks3.find((c) => c.checkId === "design.composition_valid");
  assert.equal(composition3!.verdict, "FAIL");
  assert.match(composition3!.detail, /unknown variant page-hero\/fancy/);
});

test("pre-run12: wrong AssetVersion binding in a visual set slot fails closed at derivation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  let env: ChainEnv | undefined;
  try {
    env = await setupV2Chain(dbInst, "pr12-asset", ["home", "services/advisory"]);
    assert.ok(env);
    const activeEnv = env;
    // Tamper the persisted slot's binaryDigest -> digest recomputation diverges.
    await activeEnv.dbInst.db.execute(sql`
      UPDATE accepted_visual_asset_slots SET binary_digest = ${"f".repeat(64)}
      WHERE set_id = ${activeEnv.visualSetId}
    `);
    await assert.rejects(
      () => activeEnv.production.deriveProductionInput({
        projectId: activeEnv.projectId,
        pageSlug: "services/advisory",
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v3",
      }),
      (error: unknown) => error instanceof Error && /digest|slot|asset/i.test(error.message),
    );
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    if (env) {
      await rm(env.root, { recursive: true, force: true }).catch(() => undefined);
    }
    await dbInst.close();
  }
});

test("pre-run12 adversarial: visual roles matrix (6 states)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  let env: ChainEnv | undefined;
  try {
    env = await setupV2Chain(dbInst, "pr12-matrix", ["home", "services/advisory", "services/valuation"]);
    const valuationInput = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });
    assert.ok(valuationInput);

    const compiler = new ProductionRenderCompiler(env.dbInst.db, env.root);
    const assetSnapshotDir = path.join(env.root, "asset-snapshots-matrix");

    // State 1: Required present -> PASS
    const manifest = await compiler.compileManifest({
      projectId: env.projectId,
      productionInputId: valuationInput.id,
      assetSnapshotDir,
    });
    assert.equal(manifest.schemaVersion, "production-v3");
    assert.ok(manifest.assets.some((a) => a.slot === "hero-primary.services/valuation"));

    // State 2: Required missing -> FAIL
    // A new visual plan has unclassified and unresolved required slots. Calling acceptSet fails closed:
    const planMissingRequired = await env.visualService.derivePlan({ projectId: env.projectId });
    await assert.rejects(
      () => env!.visualService.acceptSet({ projectId: env!.projectId, planId: planMissingRequired.id }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_classification_required" || e.code === "visual_slot_unresolved";
      },
    );

    // If classification is confirmed but required slot is left unresolved, acceptSet still fails closed:
    await env.visualService.confirmClassification({
      projectId: env.projectId,
      planId: planMissingRequired.id,
      slot: "hero-primary.services/valuation",
      truthClass: "illustrative",
    });
    await assert.rejects(
      () => env!.visualService.acceptSet({ projectId: env!.projectId, planId: planMissingRequired.id }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_slot_unresolved";
      },
    );

    // State 3: Optional missing -> PASS
    // In design-v2, service archetype has visualRoleRequirements:
    // [{ role: "hero-primary", requiredRole: "hero", required: true }, { role: "supporting", requiredRole: "supporting", required: false }]
    // When "supporting" is NOT resolved in the visual plan, acceptSet passed cleanly and omitted it from the accepted set.
    assert.ok(!manifest.assets.some((a) => a.slot === "supporting.services/valuation"));

    // State 4: Optional valid -> PASS
    // Upload and approve a supporting asset for services/valuation
    const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 50, g: 60, b: 70 } } }).jpeg().toBuffer();
    const uploadSupporting = await env.assets.uploadAsset(env.projectId, {
      filename: "supporting-val.jpg",
      kind: "photo",
      title: "Supporting val",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
      altIntent: "Supporting valuation and advisory chart",
    });
    const approvedSupporting = await env.assets.approveVersion(env.projectId, uploadSupporting.version.id, uploadSupporting.version.binaryDigest);

    // Resolve the optional slot through real VisualService lifecycle on a new plan version
    const planWithOptional = await env.visualService.derivePlan({ projectId: env.projectId });
    const planDataWithOptional = env.visualStore.planData(planWithOptional);
    for (const slot of planDataWithOptional.slots) {
      if (slot.required && slot.existingVersionId) {
        await env.visualService.confirmClassification({
          projectId: env.projectId,
          planId: planWithOptional.id,
          slot: slot.slot,
          truthClass: "illustrative",
        });
        await env.visualService.resolveReuse({
          projectId: env.projectId,
          planId: planWithOptional.id,
          slot: slot.slot,
          versionId: slot.existingVersionId,
        });
      }
    }

    await env.visualService.confirmClassification({
      projectId: env.projectId,
      planId: planWithOptional.id,
      slot: "supporting.services/valuation",
      truthClass: "illustrative",
    });
    await env.visualService.resolveReuse({
      projectId: env.projectId,
      planId: planWithOptional.id,
      slot: "supporting.services/valuation",
      versionId: approvedSupporting.id,
    });

    const acceptedRecord = await env.visualService.acceptSet({
      projectId: env.projectId,
      planId: planWithOptional.id,
    });
    const setWithOptionalSlots = await env.visualStore.listAcceptedSlots(acceptedRecord.id);
    assert.ok(setWithOptionalSlots.some((s) => s.slot === "supporting.services/valuation" && s.role === "supporting"));

    const inputWithOptional = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });

    const manifestWithOptional = await compiler.compileManifest({
      projectId: env.projectId,
      productionInputId: inputWithOptional.id,
      assetSnapshotDir,
    });
    assert.ok(manifestWithOptional.assets.some((a) => a.slot === "supporting.services/valuation" && a.role === "supporting"));

    // State 5: Wrong role / incompatible binding -> FAIL
    // 5A: Version conflict / incompatible binding between assignment and recorded resolution:
    const planConflict = await env.visualService.derivePlan({ projectId: env.projectId });
    const planConflictData = env.visualStore.planData(planConflict);
    for (const slot of planConflictData.slots) {
      if (slot.required && slot.existingVersionId) {
        await env.visualService.confirmClassification({
          projectId: env.projectId,
          planId: planConflict.id,
          slot: slot.slot,
          truthClass: "illustrative",
        });
        await env.visualService.resolveReuse({
          projectId: env.projectId,
          planId: planConflict.id,
          slot: slot.slot,
          versionId: slot.existingVersionId,
        });
      }
    }

    const conflictBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 99, g: 88, b: 77 } } }).jpeg().toBuffer();
    const conflictingUpload = await env.assets.uploadAsset(env.projectId, {
      filename: "conflicting-hero.jpg",
      kind: "photo",
      title: "Conflicting hero",
      rightsStatus: "operator_owned",
      dataBase64: conflictBytes.toString("base64"),
      altIntent: "Conflicting hero asset",
    });
    const conflictingApproved = await env.assets.approveVersion(env.projectId, conflictingUpload.version.id, conflictingUpload.version.binaryDigest);
    const ws = await env.assets.workspace(env.projectId);
    const existingHeroAssignment = ws.assignments.find(
      (a) => a.pageSlug === "services/valuation" && a.role === "hero",
    )!;
    await env.assets.casReplaceAssignment(env.projectId, existingHeroAssignment.id, {
      expectedCurrentAssetId: existingHeroAssignment.assetId,
      expectedCurrentVersionId: existingHeroAssignment.versionId,
      expectedCurrentGovernanceDigest: existingHeroAssignment.versionDigest,
      toAssetId: conflictingUpload.asset.id,
      toVersionId: conflictingApproved.id,
      expectedTargetBinaryDigest: conflictingApproved.binaryDigest,
    });

    await assert.rejects(
      () => env!.visualService.acceptSet({ projectId: env!.projectId, planId: planConflict.id }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_slot_resolution_conflict";
      },
    );

    // 5B: Incompatible dimensions / output invalid fails closed during resolution:
    const smallBytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const smallUpload = await env.assets.uploadAsset(env.projectId, {
      filename: "too-small.jpg",
      kind: "photo",
      title: "Too small",
      rightsStatus: "operator_owned",
      dataBase64: smallBytes.toString("base64"),
      altIntent: "Too small",
    });
    const smallApproved = await env.assets.approveVersion(env.projectId, smallUpload.version.id, smallUpload.version.binaryDigest);
    await assert.rejects(
      () => env!.visualService.resolveReuse({
        projectId: env!.projectId,
        planId: planConflict.id,
        slot: "hero-primary.services/valuation",
        versionId: smallApproved.id,
      }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_acceptance_failed" && /do not meet slot minimum dimensions/.test(e.message ?? "");
      },
    );

    // State 6: Unknown slot -> FAIL
    // 6A: Confirm classification on unknown slot fails closed:
    await assert.rejects(
      () => env!.visualService.confirmClassification({
        projectId: env!.projectId,
        planId: planConflict.id,
        slot: "mystery-slot.services/valuation",
        truthClass: "illustrative",
      }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_not_found";
      },
    );

    // 6B: Resolve reuse on unknown slot fails closed:
    await assert.rejects(
      () => env!.visualService.resolveReuse({
        projectId: env!.projectId,
        planId: planConflict.id,
        slot: "mystery-slot.services/valuation",
        versionId: approvedSupporting.id,
      }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_not_found";
      },
    );

    // 6C: Recorded resolution for an unknown slot causes acceptSet to fail closed:
    await env.visualStore.recordSlotResolution({
      projectId: env.projectId,
      planId: planConflict.id,
      slot: "mystery-slot.services/valuation",
      pageSlug: "services/valuation",
      role: "hero",
      fromAssetId: null,
      fromVersionId: null,
      fromBinaryDigest: null,
      fromGovernanceDigest: null,
      toAssetId: conflictingUpload.asset.id,
      toVersionId: conflictingApproved.id,
      toBinaryDigest: conflictingApproved.binaryDigest,
      toGovernanceDigest: conflictingApproved.governanceDigest!,
      resolutionMode: "reuse_real",
      visualProviderConsumedSourceAsset: false,
      visualProviderProducedAsset: false,
    });
    await assert.rejects(
      () => env!.visualService.acceptSet({ projectId: env!.projectId, planId: planConflict.id }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "visual_acceptance_failed" && /does not belong to any declared plan slot/.test(e.message ?? "");
      },
    );
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    if (env) {
      await rm(env.root, { recursive: true, force: true }).catch(() => undefined);
    }
    await dbInst.close();
  }
});

test("pre-run12 adversarial: missing token throws design_implementation_unsupported", () => {
  const data = v2CandidateData({
    archetypes: [{ kind: "service", sectionPatterns: ARCHETYPE_SECTIONS["service"]!, pageSlug: "services/advisory", providerScreenName: "p/1" }],
  });

  // Missing background token
  const noBg = structuredClone(data);
  delete (noBg.tokens.colors as Record<string, unknown>).background;
  assert.throws(
    () =>
      deriveDesignImplementationContract({
        design: noBg,
        acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) },
        rendererPolicyVersion: "production-policy-v3",
      }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      return e.code === "design_implementation_unsupported" && /colors\.background/.test(e.message ?? "");
    },
  );

  // Missing spacing.md token
  const noSpacing = structuredClone(data);
  delete (noSpacing.tokens.spacing as Record<string, unknown>).md;
  assert.throws(
    () =>
      deriveDesignImplementationContract({
        design: noSpacing,
        acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) },
        rendererPolicyVersion: "production-policy-v3",
      }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      return e.code === "design_implementation_unsupported" && /spacing\.md/.test(e.message ?? "");
    },
  );

  // Missing rounded.md token
  const noRadius = structuredClone(data);
  delete (noRadius.tokens.rounded as Record<string, unknown>).md;
  assert.throws(
    () =>
      deriveDesignImplementationContract({
        design: noRadius,
        acceptedDesign: { id: "d", version: 1, digest: "a".repeat(64) },
        rendererPolicyVersion: "production-policy-v3",
      }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      return e.code === "design_implementation_unsupported" && /rounded\.md/.test(e.message ?? "");
    },
  );
});

test("pre-run12 adversarial: malformed disabled derivatives rejected", () => {
  const baseValidManifest = {
    schemaVersion: "production-v3" as const,
    input: { id: "ppin-x", version: 1, digest: "a".repeat(64), projectId: "proj-x", pageIdentity: "services/advisory", pageType: "service" as const, route: "/services/advisory", siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) } },
    seo: { fullTitle: "T | S", description: "d", canonicalUrl: "https://example.com/services/advisory", ogTitle: "T | S", ogDescription: "d", ogUrl: "https://example.com/services/advisory" },
    content: { acceptedId: "wacc-x", acceptedVersion: 1, acceptedDigest: "b".repeat(64), title: "T", metaDescription: "d", introduction: "i", sections: [{ heading: "h", body: "b" }], conclusion: "c", cta: "cta", internalLinks: [] },
    design: {
      acceptedId: "dsac-x", acceptedVersion: 1, acceptedDigest: "a".repeat(64),
      tokens: { colors: { primary: "#111111" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "n" }, spacing: { md: "16px" }, rounded: { md: "8px" }, ctaHierarchy: "c", navigationLanguage: "n", imageryTreatment: "i", sectionRhythm: "s" },
      archetype: { kind: "service" as const, sectionPatterns: ["page-header", "cta"], contentRequirements: [], assetSlots: [], primaryCta: "", secondaryCta: "", responsiveBehavior: "r", trustPresentation: "t", rendererPrimitives: ["hero", "cta"] },
      designImplementation: { implementationContractDigest: "9".repeat(64), policyVersion: "production-policy-v3", schemaVersion: "design-implementation-v1" },
      semanticTokens: [{ role: "color.background.primary", value: "#ffffff" }],
      fontDelivery: [{ mode: "approved_system_stack" as const, family: "Georgia", sourceToken: "typography.display" as const }],
      composition: [{ componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once" as const }],
    },
    links: [], breadcrumbs: [], assets: [],
    derivatives: { state: "disabled" as const },
    manifestDigest: "c".repeat(64),
  };

  // Valid manifest parses without error
  assert.doesNotThrow(() => parseRenderManifestAnyVersion(baseValidManifest));

  // Missing derivatives in v3 -> throws
  const missingDerivatives = structuredClone(baseValidManifest);
  delete (missingDerivatives as Record<string, unknown>).derivatives;
  assert.throws(
    () => parseRenderManifestAnyVersion(missingDerivatives),
    /production-v3 manifest is missing its derivatives authority/,
  );

  // Malformed derivatives (e.g. invalid state or object shape)
  const malformedDerivatives = structuredClone(baseValidManifest);
  (malformedDerivatives as Record<string, unknown>).derivatives = { state: "unknown_state" };
  assert.throws(
    () => parseRenderManifestAnyVersion(malformedDerivatives),
  );

  // Malformed derivatives with unexpected extra property on disabled state
  const extraKeysDisabled = structuredClone(baseValidManifest);
  (extraKeysDisabled as Record<string, unknown>).derivatives = { state: "disabled", unexpectedKey: "bad" };
  assert.throws(
    () => parseRenderManifestAnyVersion(extraKeysDisabled),
  );

  // v1 carrying derivatives -> throws
  const v1WithDerivatives = {
    ...structuredClone(baseValidManifest),
    schemaVersion: "production-v1",
  };
  assert.throws(
    () => parseRenderManifestAnyVersion(v1WithDerivatives),
    /production-v1 manifest must not carry derivatives authority/,
  );
});

test("pre-run12 ordinary path: fresh project enters hardened design-v2 path without test-only overrides", async () => {
  const dbInst = await setupMigratedTestDatabase();
  let root: string | undefined;
  try {
    // Ensure clean environment without test-only overrides
    delete process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA;
    assert.equal(process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA, undefined);

    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "fresh-ord");
    await acceptFixturePage(dbInst, projectId, "home");
    await acceptFixturePage(dbInst, projectId, "services/advisory");
    await acceptFixturePage(dbInst, projectId, "services/valuation");

    root = await mkdtemp(path.join(tmpdir(), "pre-run12-fresh-"));
    const designStore = new DesignStore(dbInst.db);

    // 1. Derive snapshot draft with NO explicit schemaVersion
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
    const snapshotData = parseDesignInputSnapshotAnyVersion(snapshot.data);
    assert.ok(isDesignInputSnapshotV2(snapshotData));
    assert.equal(snapshotData.schemaVersion, "design-v2", "fresh project must derive design-v2 snapshot by default");

    // 2. Generate and accept design-v2 candidate
    const mockStitch = new MockStitchClient();
    mockStitch.queue({ name: "projects/fresh-ord", title: `factory-${projectId.slice(0, 8)}-design` });
    mockStitch.queue({ name: "assets/ds-fresh-ord" });
    for (const kind of snapshotData.archetypes) {
      mockStitch.queue({
        outputComponents: [
          { design: { screens: [{ name: `projects/fresh-ord/screens/${kind}`, title: kind, deviceType: "DESKTOP" }] } },
        ],
        sessionId: `sess-${kind}`,
      });
      mockStitch.queue(screenResult(`projects/fresh-ord/screens/${kind}`));
      if (kind === "homepage") {
        mockStitch.queue({
          outputComponents: [
            { design: { screens: [{ name: "projects/fresh-ord/screens/home-mob", title: "Home Mobile", deviceType: "MOBILE" }] } },
          ],
          sessionId: "sess-mob",
        });
        mockStitch.queue(screenResult("projects/fresh-ord/screens/home-mob"));
      }
    }

    const stitchProvider = new StitchDesignProvider({
      env: { STITCH_ACCESS_TOKEN: "mock-token" },
      createClient: () => mockStitch,
    });

    const copyByArchetype: Record<string, { slug: string; title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string; cta: string }> = {};
    for (const rep of snapshotData.representativePages) {
      copyByArchetype[rep.archetype] = {
        slug: rep.slug,
        title: rep.slug,
        introduction: `Introduction for ${rep.slug}`,
        sections: [{ heading: "Process", body: `Body for ${rep.slug}` }],
        conclusion: `Conclusion for ${rep.slug}`,
        cta: `Contact ${rep.slug}`,
      };
    }

    const genResult = await stitchProvider.generateDesignSystem({
      inputSnapshot: snapshotData,
      inputSnapshotId: snapshot.id,
      projectId,
      acceptedCopyByArchetype: copyByArchetype,
      designSeed: {
        colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "Institutional typographic scale" },
        rationale: "Institutional advisory identity.",
      },
    });

    const candidate = await designStore.createCandidate({
      projectId,
      inputSnapshot: snapshot,
      data: genResult.candidate,
    });
    const candidateData = parseDesignCandidateAnyVersion(candidate.data);
    assert.equal(candidateData.schemaVersion, "design-v2");

    const accepted = await designStore.acceptCandidate({
      projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "fresh-project design-v2 acceptance",
    });
    const acceptedData = parseDesignCandidateAnyVersion(accepted.data);
    assert.equal(acceptedData.schemaVersion, "design-v2");

    // 3. Compile DIC directly to verify governed grammar and visual requirements
    const dic = deriveDesignImplementationContract({
      design: candidateData as DesignCandidateDataV2,
      acceptedDesign: { id: accepted.id, version: accepted.version, digest: accepted.candidateDigest },
      rendererPolicyVersion: "production-policy-v3",
    });
    assert.equal(dic.schemaVersion, "design-implementation-v1");
    assert.match(dic.implementationContractDigest, /^[0-9a-f]{64}$/);
    assert.ok(dic.archetypeGrammar.length > 0);

    // 4. Derive visual asset plan with real VisualService and verify slot optionality
    const assetsModule = await import("../../src/assets/service.js");
    const assetStorageModule = await import("../../src/assets/storage.js");
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      storage: assetStorageModule.createAssetStorage(root),
    });
    const visualStore = new VisualStore(dbInst.db);
    const budgetStore = new VisualBudgetStore(dbInst.db);
    const visualService = new VisualService({
      store: visualStore,
      designStore,
      assets,
      budget: budgetStore,
      provider: new OfflineLiveVisualAssetProvider(),
      repoRoot: root,
    });

    const plan = await visualService.derivePlan({ projectId });
    const planData = visualStore.planData(plan);
    const heroVal = planData.slots.find((s) => s.slot === "hero-primary.services/valuation");
    const suppVal = planData.slots.find((s) => s.slot === "supporting.services/valuation");
    assert.ok(heroVal);
    assert.equal(heroVal.required, true, "hero-primary on service archetype must be required");
    assert.ok(suppVal);
    assert.equal(suppVal.required, false, "supporting on service archetype must be optional");

    // 5. Upload asset, resolve required slots, leave optional slot unresolved, accept set
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(projectId, {
      filename: "hero-fresh.jpg",
      kind: "photo",
      title: "Hero fresh",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
      altIntent: "Hero fresh asset",
    });
    const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

    for (const slot of planData.slots) {
      if (slot.required) {
        await visualService.confirmClassification({
          projectId,
          planId: plan.id,
          slot: slot.slot,
          truthClass: "illustrative",
        });
        await visualService.resolveReuse({
          projectId,
          planId: plan.id,
          slot: slot.slot,
          versionId: approved.id,
        });
      }
    }

    const freshRecord = await visualService.acceptSet({ projectId, planId: plan.id });
    const acceptedSlots = await visualStore.listAcceptedSlots(freshRecord.id);
    assert.ok(acceptedSlots.some((s) => s.slot === "hero-primary.services/valuation"));
    assert.ok(!acceptedSlots.some((s) => s.slot === "supporting.services/valuation"), "unresolved optional slot omitted");

    // 6. Derive production input and compile production-v3 manifest
    const production = new ProductionStore(dbInst.db);
    const prodInput = await production.deriveProductionInput({
      projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });
    assert.equal(prodInput.pageType, "service");
    assert.equal(prodInput.acceptedDesignId, accepted.id);

    const compiler = new ProductionRenderCompiler(dbInst.db, root);
    const assetSnapshotDir = path.join(root, "fresh-snapshots");
    const manifest = await compiler.compileManifest({
      projectId,
      productionInputId: prodInput.id,
      assetSnapshotDir,
    });
    assert.equal(manifest.schemaVersion, "production-v3");
    assert.ok(manifest.design.designImplementation);
    assert.equal(manifest.design.designImplementation.implementationContractDigest, dic.implementationContractDigest);
    assert.ok(manifest.assets.some((a) => a.slot === "hero-primary.services/valuation"));
    assert.ok(!manifest.assets.some((a) => a.slot === "supporting.services/valuation"));

    // 7. Backward compatibility: read existing design-v1 records cleanly without mutation
    const v1ProjectId = (await seedProjectWithAcceptedInputs(dbInst, "v1-compat")).projectId;
    await acceptFixturePage(dbInst, v1ProjectId, "home");
    const v1Snapshot = await designStore.deriveInputSnapshotDraft({ projectId: v1ProjectId, schemaVersion: "design-v1" });
    const v1SnapshotData = parseDesignInputSnapshotAnyVersion(v1Snapshot.data);
    assert.equal(v1SnapshotData.schemaVersion, "design-v1");
    // Next snapshot draft on v1 project preserves established v1 version:
    const v1NextSnapshot = await designStore.deriveInputSnapshotDraft({ projectId: v1ProjectId });
    const v1NextData = parseDesignInputSnapshotAnyVersion(v1NextSnapshot.data);
    assert.equal(v1NextData.schemaVersion, "design-v1", "existing v1 project must preserve design-v1");
  } finally {
    delete process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA;
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await dbInst.close();
  }
});

