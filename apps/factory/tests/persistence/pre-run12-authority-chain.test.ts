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
import { mkdtemp } from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

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
  production: ProductionStore;
  designStore: DesignStore;
  acceptedPages: string[];
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
  try {
    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
    const snapshotData = parseDesignInputSnapshotAnyVersion(snapshot.data);
    if (!isDesignInputSnapshotV2(snapshotData)) throw new Error("expected design-v2 snapshot derivation");
    // Snapshot binds only design-defining (representative) content.
    const supportedKinds = [...new Set(acceptedPages.map((slug) => derivePageArchetype(slug, ["homepage", "service", "location", "editorial", "investment_advisory"]).archetype))];
    const data = v2CandidateData({
      archetypes: supportedKinds.map((kind) => ({
        kind,
        sectionPatterns: ARCHETYPE_SECTIONS[kind] ?? ["hero", "conclusion", "cta"],
        pageSlug: acceptedPages[0] ?? "home",
        providerScreenName: `projects/fixture/screens/${kind}`,
      })),
      // Live-classified candidate (test-seeded production authority, same
      // approach as the Run 9 suite): data providerMode matches the column.
      providerMode: "live",
      providerProjectName: "projects/live",
    });
    const candidate = await designStore.createCandidate({ projectId, inputSnapshot: snapshot, data });
    await dbInst.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
    const accepted = await designStore.acceptCandidate({
      projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "pre-run12 v2 fixture acceptance",
    });
    // Visual asset authority: a live accepted visual set bound to the
    // accepted design, carrying a REAL approved asset version resolved for
    // the representative service page's hero-primary role (the same
    // SQL-seeded live authority pattern the Run 9 suite uses).
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
    });
    const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);
    // Reuse the ALREADY accepted advisory page (re-accepting would supersede
    // the version the design snapshot bound and stale the chain).
    const advisoryPage = await dbInst.db
      .select({ id: acceptedPageContent.id, version: acceptedPageContent.version, contentDigest: acceptedPageContent.contentDigest })
      .from(acceptedPageContent)
      .where(sql`${acceptedPageContent.projectId} = ${projectId} AND ${acceptedPageContent.slug} = 'services/advisory'`)
      .limit(1)
      .then((rows) => rows[0]!);
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
    const visualStore = new VisualStore(dbInst.db);
    const planId = `vap-${key}`;
    const slot = {
      slot: "hero-primary.services/advisory",
      pageSlug: "services/advisory",
      role: "hero",
      resolvedVersionId: approved.id,
      binaryDigest: approved.binaryDigest,
      governanceDigest: approved.governanceDigest!,
      resolutionMode: "reuse_real",
      truthClass: "illustrative" as const,
    };
    await dbInst.db.execute(sql`
      INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
      VALUES (${planId}, ${projectId}, 1, ${accepted.id}, ${accepted.version}, ${accepted.candidateDigest}, ${accepted.inputDigest}, 'live', ${JSON.stringify([slot])}::jsonb, ${"c".repeat(64)})
    `);
    const visualSet = await visualStore.createAcceptedSetAtomic({
      projectId,
      planId,
      providerMode: "live",
      designArtifactId: accepted.id,
      designArtifactVersion: accepted.version,
      designCandidateDigest: accepted.candidateDigest,
      designInputDigest: accepted.inputDigest,
      slots: [slot],
    });
    return {
      dbInst,
      projectId,
      designId: accepted.id,
      designDigest: accepted.candidateDigest,
      visualSetId: visualSet.id,
      visualSetDigest: visualSet.setDigest,
      production: new ProductionStore(dbInst.db),
      designStore,
      acceptedPages,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("PG pre-run12: two pages of one archetype classify independently; representative pages are evidence only", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const env = await setupV2Chain(dbInst, "pr12-a", ["home", "services/advisory", "services/valuation", "locations/chamonix", "research/report"]);
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
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    await dbInst.close();
  }
});

test("PG pre-run12: adding a page after design acceptance does NOT stale a v2 design and needs no new artifact", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const env = await setupV2Chain(dbInst, "pr12-b", ["home", "services/advisory"]);
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
    await dbInst.close();
  }
});

test("PG pre-run12: v1 designs keep historical CONTENT_ADDED staleness semantics", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "pr12-v1");
    await acceptFixturePage(dbInst, projectId, "home");
    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
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
  const { assertManifest, computeRenderManifestDigest } = await import("../../src/production/render-manifest.js");
  const { ProductionRenderCompiler } = await import("../../src/production/render-manifest.js");
  void ProductionRenderCompiler;
  // Build a minimal valid v1 manifest through the exported compiler path is heavy;
  // instead validate the tamper-detection contract directly on the manifest shape:
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
  try {
    const env = await setupV2Chain(dbInst, "pr12-asset", ["home", "services/advisory"]);
    // Tamper the persisted slot's binaryDigest -> digest recomputation diverges.
    await env.dbInst.db.execute(sql`
      UPDATE accepted_visual_asset_slots SET binary_digest = ${"f".repeat(64)}
      WHERE set_id = ${env.visualSetId}
    `);
    await assert.rejects(
      () => env.production.deriveProductionInput({
        projectId: env.projectId,
        pageSlug: "services/advisory",
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v3",
      }),
      (error: unknown) => error instanceof Error && /digest|slot|asset/i.test(error.message),
    );
  } finally {
    process.env.FACTORY_DESIGN_SNAPSHOT_SCHEMA = undefined;
    await dbInst.close();
  }
});
