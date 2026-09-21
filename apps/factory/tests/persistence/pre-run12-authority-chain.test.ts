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
  acceptedPages: string[];
  root: string;
}

/**
 * Derive the design input snapshot with FACTORY_DESIGN_SNAPSHOT_SCHEMA=v2
 * (env must be set BEFORE deriveInputSnapshotDraft).
 */
async function setupV2Chain(
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>,
  key: string,
  pageSlugs: string[],
): Promise<ChainEnv> {
  process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = DESIGN_SCHEMA_VERSION_V2;
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  const acceptedPages: string[] = [];
  for (const slug of pageSlugs) {
    await acceptFixturePage(dbInst, projectId, slug);
    acceptedPages.push(slug);
  }
  const root = await mkdtemp(path.join(tmpdir(), "pre-run12-"));
  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId, schemaVersion: "design-v2" });
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
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "hero-advisory.jpg",
    kind: "photo",
    title: "Advisory hero",
    rightsStatus: "operator_owned",
    dataBase64: bytes.toString("base64"),
    altIntent: "Professional financial advisory consultation and valuation services",
  });
  const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  // Assign approved asset to services/advisory
  const advisoryPage = await dbInst.db
    .select({ id: acceptedPageContent.id, version: acceptedPageContent.version, contentDigest: acceptedPageContent.contentDigest })
    .from(acceptedPageContent)
    .where(sql`${acceptedPageContent.projectId} = ${projectId} AND ${acceptedPageContent.slug} = 'services/advisory'`)
    .limit(1)
    .then((rows) => rows[0]);
  if (advisoryPage) {
    await assets.assignVersion(projectId, {
      assetId: upload.asset.id,
      versionId: approved.id,
      acceptedPageContentId: advisoryPage.id,
      acceptedPageContentVersion: advisoryPage.version,
      acceptedPageContentDigest: advisoryPage.contentDigest,
      expectedGovernanceDigest: approved.governanceDigest!,
      pageSlug: "services/advisory",
      role: "hero",
      expectedBinaryDigest: approved.binaryDigest,
    });
  }

  // Assign approved asset to services/valuation if present
  const valuationPage = await dbInst.db
    .select({ id: acceptedPageContent.id, version: acceptedPageContent.version, contentDigest: acceptedPageContent.contentDigest })
    .from(acceptedPageContent)
    .where(sql`${acceptedPageContent.projectId} = ${projectId} AND ${acceptedPageContent.slug} = 'services/valuation'`)
    .limit(1)
    .then((rows) => rows[0]);
  if (valuationPage) {
    await assets.assignVersion(projectId, {
      assetId: upload.asset.id,
      versionId: approved.id,
      acceptedPageContentId: valuationPage.id,
      acceptedPageContentVersion: valuationPage.version,
      acceptedPageContentDigest: valuationPage.contentDigest,
      expectedGovernanceDigest: approved.governanceDigest!,
      pageSlug: "services/valuation",
      role: "hero",
      expectedBinaryDigest: approved.binaryDigest,
    });
  }

  // Assign approved asset to home if present
  const homePage = await dbInst.db
    .select({ id: acceptedPageContent.id, version: acceptedPageContent.version, contentDigest: acceptedPageContent.contentDigest })
    .from(acceptedPageContent)
    .where(sql`${acceptedPageContent.projectId} = ${projectId} AND ${acceptedPageContent.slug} = 'home'`)
    .limit(1)
    .then((rows) => rows[0]);
  if (homePage) {
    await assets.assignVersion(projectId, {
      assetId: upload.asset.id,
      versionId: approved.id,
      acceptedPageContentId: homePage.id,
      acceptedPageContentVersion: homePage.version,
      acceptedPageContentDigest: homePage.contentDigest,
      expectedGovernanceDigest: approved.governanceDigest!,
      pageSlug: "home",
      role: "hero",
      expectedBinaryDigest: approved.binaryDigest,
    });
  }

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

  const slots = [
    ...(homePage
      ? [
          {
            slot: "hero-primary.home",
            pageSlug: "home",
            role: "hero",
            resolvedVersionId: approved.id,
            binaryDigest: approved.binaryDigest,
            governanceDigest: approved.governanceDigest!,
            resolutionMode: "reuse_real",
            truthClass: "illustrative" as const,
          },
        ]
      : []),
    ...(advisoryPage
      ? [
          {
            slot: "hero-primary.services/advisory",
            pageSlug: "services/advisory",
            role: "hero",
            resolvedVersionId: approved.id,
            binaryDigest: approved.binaryDigest,
            governanceDigest: approved.governanceDigest!,
            resolutionMode: "reuse_real",
            truthClass: "illustrative" as const,
          },
        ]
      : []),
    ...(valuationPage
      ? [
          {
            slot: "hero-primary.services/valuation",
            pageSlug: "services/valuation",
            role: "hero",
            resolvedVersionId: approved.id,
            binaryDigest: approved.binaryDigest,
            governanceDigest: approved.governanceDigest!,
            resolutionMode: "reuse_real",
            truthClass: "illustrative" as const,
          },
        ]
      : []),
  ];

  const visualSet = await visualStore.createAcceptedSetAtomic({
    projectId,
    planId: plan.id,
    providerMode: "live",
    designArtifactId: accepted.id,
    designArtifactVersion: accepted.version,
    designCandidateDigest: accepted.candidateDigest,
    designInputDigest: accepted.inputDigest,
    slots,
  });

  return {
    dbInst,
    projectId,
    designId: accepted.id,
    designDigest: accepted.candidateDigest,
    visualSetId: visualSet.id,
    visualSetDigest: visualSet.setDigest,
    planId: plan.id,
    production: new ProductionStore(dbInst.db),
    designStore,
    visualStore,
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
    // Create a visual set for the project that does NOT have hero-primary.services/valuation
    await env.visualStore.createAcceptedSetAtomic({
      projectId: env.projectId,
      planId: env.planId,
      providerMode: "live",
      designArtifactId: env.designId,
      designArtifactVersion: 1,
      designCandidateDigest: env.designDigest,
      designInputDigest: "a".repeat(64),
      slots: [
        {
          slot: "hero-primary.services/advisory",
          pageSlug: "services/advisory",
          role: "hero",
          resolvedVersionId: manifest.assets[0]!.versionId,
          binaryDigest: manifest.assets[0]!.binaryDigest,
          governanceDigest: manifest.assets[0]!.governanceDigest,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
      ],
    });
    // Derive new production input pointing at the latest visual set (which is missing valuation hero)
    const inputMissingRequired = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });
    await assert.rejects(
      () =>
        compiler.compileManifest({
          projectId: env!.projectId,
          productionInputId: inputMissingRequired.id,
          assetSnapshotDir,
        }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "production_build_rejected" && /has no accepted visual resolution/.test(e.message ?? "");
      },
    );

    // State 3: Optional missing -> PASS
    // In design-v2, service archetype has visualRoleRequirements:
    // [{ role: "hero-primary", requiredRole: "hero", required: true }, { role: "supporting", requiredRole: "supporting", required: false }]
    // When "supporting" is NOT in the visual set, State 1 passed without requiring it!
    assert.ok(!manifest.assets.some((a) => a.slot === "supporting.services/valuation"));

    // State 4: Optional valid -> PASS
    // Upload and approve a supporting asset for services/valuation
    const assetsModule = await import("../../src/assets/service.js");
    const assetStorageModule = await import("../../src/assets/storage.js");
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      storage: assetStorageModule.createAssetStorage(env.root),
    });
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 60, b: 70 } } }).jpeg().toBuffer();
    const uploadSupporting = await assets.uploadAsset(env.projectId, {
      filename: "supporting-val.jpg",
      kind: "photo",
      title: "Supporting val",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
      altIntent: "Supporting valuation and advisory chart",
    });
    const approvedSupporting = await assets.approveVersion(env.projectId, uploadSupporting.version.id, uploadSupporting.version.binaryDigest);

    const valPageRow = await dbInst.db
      .select({ id: acceptedPageContent.id, version: acceptedPageContent.version, contentDigest: acceptedPageContent.contentDigest })
      .from(acceptedPageContent)
      .where(sql`${acceptedPageContent.projectId} = ${env.projectId} AND ${acceptedPageContent.slug} = 'services/valuation'`)
      .limit(1)
      .then((rows) => rows[0]!);

    await assets.assignVersion(env.projectId, {
      assetId: uploadSupporting.asset.id,
      versionId: approvedSupporting.id,
      acceptedPageContentId: valPageRow.id,
      acceptedPageContentVersion: valPageRow.version,
      acceptedPageContentDigest: valPageRow.contentDigest,
      expectedGovernanceDigest: approvedSupporting.governanceDigest!,
      pageSlug: "services/valuation",
      role: "supporting",
      expectedBinaryDigest: approvedSupporting.binaryDigest,
    });

    await env.visualStore.createAcceptedSetAtomic({
      projectId: env.projectId,
      planId: env.planId,
      providerMode: "live",
      designArtifactId: env.designId,
      designArtifactVersion: 1,
      designCandidateDigest: env.designDigest,
      designInputDigest: "a".repeat(64),
      slots: [
        {
          slot: "hero-primary.services/valuation",
          pageSlug: "services/valuation",
          role: "hero",
          resolvedVersionId: manifest.assets[0]!.versionId,
          binaryDigest: manifest.assets[0]!.binaryDigest,
          governanceDigest: manifest.assets[0]!.governanceDigest,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
        {
          slot: "supporting.services/valuation",
          pageSlug: "services/valuation",
          role: "supporting",
          resolvedVersionId: approvedSupporting.id,
          binaryDigest: approvedSupporting.binaryDigest,
          governanceDigest: approvedSupporting.governanceDigest!,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
      ],
    });

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

    // State 5: Optional wrong role -> FAIL
    await env.visualStore.createAcceptedSetAtomic({
      projectId: env.projectId,
      planId: env.planId,
      providerMode: "live",
      designArtifactId: env.designId,
      designArtifactVersion: 1,
      designCandidateDigest: env.designDigest,
      designInputDigest: "a".repeat(64),
      slots: [
        {
          slot: "hero-primary.services/valuation",
          pageSlug: "services/valuation",
          role: "hero",
          resolvedVersionId: manifest.assets[0]!.versionId,
          binaryDigest: manifest.assets[0]!.binaryDigest,
          governanceDigest: manifest.assets[0]!.governanceDigest,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
        {
          slot: "supporting.services/valuation",
          pageSlug: "services/valuation",
          role: "illustration", // WRONG ROLE: should be "supporting"
          resolvedVersionId: approvedSupporting.id,
          binaryDigest: approvedSupporting.binaryDigest,
          governanceDigest: approvedSupporting.governanceDigest!,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
      ],
    });

    const inputWrongRole = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });

    await assert.rejects(
      () =>
        compiler.compileManifest({
          projectId: env!.projectId,
          productionInputId: inputWrongRole.id,
          assetSnapshotDir,
        }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "production_build_rejected" && /cannot be placed by the selected archetype/.test(e.message ?? "");
      },
    );

    // State 6: Unknown slot -> FAIL
    await env.visualStore.createAcceptedSetAtomic({
      projectId: env.projectId,
      planId: env.planId,
      providerMode: "live",
      designArtifactId: env.designId,
      designArtifactVersion: 1,
      designCandidateDigest: env.designDigest,
      designInputDigest: "a".repeat(64),
      slots: [
        {
          slot: "hero-primary.services/valuation",
          pageSlug: "services/valuation",
          role: "hero",
          resolvedVersionId: manifest.assets[0]!.versionId,
          binaryDigest: manifest.assets[0]!.binaryDigest,
          governanceDigest: manifest.assets[0]!.governanceDigest,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
        {
          slot: "mystery-slot.services/valuation", // UNKNOWN SLOT
          pageSlug: "services/valuation",
          role: "hero",
          resolvedVersionId: manifest.assets[0]!.versionId,
          binaryDigest: manifest.assets[0]!.binaryDigest,
          governanceDigest: manifest.assets[0]!.governanceDigest,
          resolutionMode: "reuse_real",
          truthClass: "illustrative" as const,
        },
      ],
    });

    const inputUnknownSlot = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "services/valuation",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v3",
    });

    await assert.rejects(
      () =>
        compiler.compileManifest({
          projectId: env!.projectId,
          productionInputId: inputUnknownSlot.id,
          assetSnapshotDir,
        }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "production_build_rejected" && /cannot be placed by the selected archetype/.test(e.message ?? "");
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

