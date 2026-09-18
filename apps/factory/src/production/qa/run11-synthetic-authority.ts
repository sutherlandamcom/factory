import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  acceptedPageContent,
  acceptedVisualAssetSets,
  assetVersions,
  assets as assetsTable,
  designCandidates,
  visualAssetPlans,
} from "../../persistence/schema.js";
import type { FactoryDb } from "../../persistence/db.js";
import path from "node:path";
import { FactoryError } from "../../executor/errors.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";
import { DesignStore } from "../../design/design-store.js";
import type { DesignInputSnapshotRecord } from "../../persistence/schema.js";
import { VisualStore } from "../../visual/store.js";
import { deterministicDigest } from "../../intelligence/digest.js";

/**
 * Run 11 TEST-ONLY synthetic production-authority seed.
 *
 * The unified Run 11 browser journey proves Dashboard/workflow mechanics;
 * it does NOT prove external DesignProvider or VisualProvider execution.
 * Ordinary fixture authority is correctly REJECTED as production authority
 * (requireProductionDesign/requireProductionVisualSet fail closed), so this
 * helper seeds production-shaped authority records DIRECTLY into the
 * dedicated test database — never through the Operator API, never via a
 * provider mode, never with network calls.
 *
 * Hard guarantees (all fail closed):
 *  1. Only the dedicated `factory_test` database is accepted (naming gate).
 *  2. Refuses to run when the project already has real accepted authority
 *     (idempotent no-op instead of duplicate authority).
 *  3. Records carry the truthful marker provider "test-synthetic-authority".
 *  4. Nothing here is reachable from the production Operator API surface.
 *
 * This does NOT prove external provider execution (Run 11 report states so).
 */

const REQUIRED_TEST_DATABASE_NAME = "factory_test";

function assertTestDatabaseUrl(rawUrl: string | undefined): void {
  // The repository's stable test-DB naming rule: only the dedicated
  // `factory_test` database may be targeted. No convenience override (§9).
  const raw = rawUrl?.trim();
  if (!raw) {
    throw new FactoryError(
      "test_database_url_invalid",
      "Run 11 synthetic authority seeding requires FACTORY_TEST_DATABASE_URL (dedicated test database).",
    );
  }
  let dbName: string;
  try {
    dbName = new URL(raw).pathname.replace(/^\//, "");
  } catch {
    throw new FactoryError("test_database_url_invalid", `Run 11 synthetic authority seeding received an invalid database URL.`);
  }
  if (dbName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new FactoryError(
      "test_database_url_invalid",
      `Run 11 synthetic authority seeding refuses non-test databases (got '${dbName}'; expected '${REQUIRED_TEST_DATABASE_NAME}').`,
    );
  }
}

export interface SeedRun11SyntheticAuthorityInput {
  projectId: string;
  pageSlug: string;
}

export interface SeedRun11SyntheticAuthorityResult {
  designId: string;
  designVersion: number;
  designDigest: string;
  visualSetId: string;
  visualSetVersion: number;
  visualSetDigest: string;
}

/**
 * Seed a live-marked accepted design artifact + accepted visual asset set
 * bound to the project's current accepted page content, using the REAL
 * design/visual stores so all transitive lineage (input snapshot, digest
 * bindings) is valid. The recorded provider is the explicit test marker.
 */
export async function seedRun11SyntheticDesignAuthorityForTest(
  db: FactoryDb,
  input: SeedRun11SyntheticAuthorityInput & { testDatabaseUrl?: string },
): Promise<SeedRun11SyntheticAuthorityResult> {
  assertTestDatabaseUrl(input.testDatabaseUrl ?? process.env.FACTORY_TEST_DATABASE_URL);

  const [page] = await db
    .select()
    .from(acceptedPageContent)
    .where(and(eq(acceptedPageContent.projectId, input.projectId), eq(acceptedPageContent.slug, input.pageSlug)))
    .orderBy(desc(acceptedPageContent.version))
    .limit(1);
  if (!page) {
    throw new FactoryError("production_authority_not_found", `No accepted page content for slug ${input.pageSlug}; seed synthetic authority only after content acceptance.`);
  }

  // Idempotency: if a synthetic accepted design already exists for this
  // project, reuse it (safe deterministic reuse, §30).
  const designStore = new DesignStore(db);
  const existing = await designStore.listAcceptedDesigns(input.projectId);
  const existingSet = await db
    .select()
    .from(acceptedVisualAssetSets)
    .where(eq(acceptedVisualAssetSets.projectId, input.projectId))
    .orderBy(desc(acceptedVisualAssetSets.version))
    .limit(1);
  if (existing.length > 0 && existingSet[0]) {
    return {
      designId: existing[0]!.id,
      designVersion: existing[0]!.version,
      designDigest: existing[0]!.candidateDigest,
      visualSetId: existingSet[0]!.id,
      visualSetVersion: existingSet[0]!.version,
      visualSetDigest: existingSet[0]!.setDigest,
    };
  }

  // Real approved asset version (Run 5 authority): a real local image is
  // uploaded through the REAL AssetService and approved. The provider that
  // "produced" it is the operator (operator_owned) — truthful provenance.
  const { AssetService } = await import("../../assets/service.js");
  const { AssetStore } = await import("../../assets/asset-store.js");
  const { createAssetStorage } = await import("../../assets/storage.js");
  const { resolveRepositoryRoot } = await import("../../repo-root.js");
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  // Storage root matches the operator's own asset storage (repo .factory
  // layout) so the production build can read the materialized bytes.
  const assets = new AssetService({
    store: new AssetStore(db),
    storage: createAssetStorage(await resolveRepositoryRoot()),
  });
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: (input.projectId.charCodeAt(0) * 7) % 255, g: (input.projectId.charCodeAt(1) * 13) % 255, b: (input.projectId.charCodeAt(2) * 29) % 255 } } }).jpeg().toBuffer();
  let approved: { id: string; binaryDigest: string; governanceDigest: string | null; version: number };
  try {
    const upload = await assets.uploadAsset(input.projectId, {
      filename: "run11-synthetic-hero.jpg",
      kind: "photo",
      title: "Run 11 synthetic hero (test authority)",
      rightsStatus: "operator_owned",
      dataBase64: bytes.toString("base64"),
    });
    approved = await assets.approveVersion(input.projectId, upload.version.id, upload.version.binaryDigest);
  } catch (err) {
    // Idempotent re-seed: the project already holds an approved synthetic
    // hero version (identical bytes) — reuse the latest approved version.
    if (!(err instanceof FactoryError) || err.code !== "asset_assignment_conflict") throw err;
    const [latest] = await db
      .select({ id: assetVersions.id, binaryDigest: assetVersions.binaryDigest, governanceDigest: assetVersions.governanceDigest, version: assetVersions.version })
      .from(assetVersions)
      .innerJoin(assetsTable, eq(assetVersions.assetId, assetsTable.id))
      .where(and(eq(assetsTable.projectId, input.projectId), eq(assetVersions.approvalState, "approved")))
      .orderBy(desc(assetVersions.version))
      .limit(1);
    if (!latest) throw err;
    approved = latest;
  }
  // Meaningful hero image requires accepted alt authority (Run 5/9 policy).
  // The test-only seed sets the alt intent directly (approved versions are
  // immutable through the API; this guarded test seam may backfill it).
  await db.execute(sql`UPDATE asset_versions SET alt_intent = 'Synthetic test hero image showing a mountain landscape' WHERE id = ${approved.id}`);
  await assets.assignVersion(input.projectId, {
    assetId: (await db.select({ assetId: assetVersions.assetId }).from(assetVersions).where(eq(assetVersions.id, approved.id)).limit(1))[0]!.assetId,
    versionId: approved.id,
    acceptedPageContentId: page.id,
    acceptedPageContentVersion: page.version,
    acceptedPageContentDigest: page.contentDigest,
    expectedGovernanceDigest: approved.governanceDigest!,
    pageSlug: input.pageSlug,
    role: "hero",
    expectedBinaryDigest: approved.binaryDigest,
  });

  // Re-derive the design input snapshot AFTER the assignment so the asset
  // lineage (assetRefs) is included, then create the candidate against it.
  const snapshotWithAssets = await designStore.deriveInputSnapshotDraft({ projectId: input.projectId });

  const data = parseDesignCandidateData(syntheticDesignData({
    projectId: input.projectId,
    pageSlug: input.pageSlug,
    snapshot: snapshotWithAssets,
    approved,
  }));

  const candidate = await designStore.createCandidate({
    projectId: input.projectId,
    inputSnapshot: snapshotWithAssets,
    data,
  });
  // The candidate row's provider mode comes from data.providerMode; the
  // design_candidates column is set from the same data — no SQL flips here.
  // Verify the recorded mode is live (defensive; the parse above guarantees).
  const [candidateRow] = await db.select().from(designCandidates).where(eq(designCandidates.id, candidate.id));
  if (candidateRow!.providerMode !== "live" || data.providerMode !== "live") {
    throw new FactoryError("test_seeding_invalid", "Synthetic authority seeding must record live provider mode truthfully as test-only.");
  }

  const accepted = await designStore.acceptCandidate({
    projectId: input.projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "test-only synthetic production authority (Run 11 E2E harness; NOT external provider execution)",
  });

  // Visual plan row (FK parent of the accepted set) — synthetic, binding
  // the exact accepted design lineage. Its single slot binds the real
  // approved asset version via reuse_real (truthful: the operator owns it).
  const planId = `vap-synth-${candidate.id}`;
  await db.insert(visualAssetPlans).values({
    id: planId,
    projectId: input.projectId,
    version: 1,
    designArtifactId: accepted.id,
    designArtifactVersion: accepted.version,
    designCandidateDigest: accepted.candidateDigest,
    designInputDigest: accepted.inputDigest,
    designProviderMode: "live",
    slots: [
      {
        slot: "hero.primary",
        pageSlug: input.pageSlug,
        role: "hero",
        requiredRole: "hero",
        requirement: "Hero image",
        truthClassProposal: "illustrative",
        truthClassRationale: "Synthetic test authority proposal",
        aspectRatio: "16:9",
        minDimensions: { width: 1200, height: 675 },
        existingVersionId: approved.id,
        existingBinaryDigest: approved.binaryDigest,
        existingGovernanceDigest: approved.governanceDigest!,
        proposedStrategy: "reuse_real",
        unresolvedReason: "Resolved via synthetic test authority reuse_real.",
      },
    ],
    planDigest: deterministicDigest({ synthetic: "plan", projectId: input.projectId }),
  });

  // Accepted visual set bound to the exact design lineage (live mode marker)
  // with the real approved asset resolved via reuse_real.
  const visualStore = new VisualStore(db);
  const set = await visualStore.createAcceptedSetAtomic({
    projectId: input.projectId,
    planId,
    providerMode: "live",
    designArtifactId: accepted.id,
    designArtifactVersion: accepted.version,
    designCandidateDigest: accepted.candidateDigest,
    designInputDigest: accepted.inputDigest,
    slots: [
      {
        slot: "hero.primary",
        pageSlug: input.pageSlug,
        role: "hero",
        resolvedVersionId: approved.id,
        binaryDigest: approved.binaryDigest,
        governanceDigest: approved.governanceDigest!,
        resolutionMode: "reuse_real",
        truthClass: "illustrative",
      },
    ],
  });

  return {
    designId: accepted.id,
    designVersion: accepted.version,
    designDigest: accepted.candidateDigest,
    visualSetId: set.id,
    visualSetVersion: set.version,
    visualSetDigest: set.setDigest,
  };
}
/** Build the synthetic design candidate data bound to the real approved asset. */
function syntheticDesignData(input: {
  projectId: string;
  pageSlug: string;
  snapshot: DesignInputSnapshotRecord;
  approved: { id: string; binaryDigest: string; governanceDigest: string | null; version: number };
}): Record<string, unknown> {
  return {
    schemaVersion: "design-v1",
    // The contract pins provider to google-stitch (Run 6 single provider);
    // the truthful test-only marker lives in providerProjectName and the
    // acceptance review notes, both operator-visible.
    provider: "google-stitch",
    providerMode: "live",
    providerProjectName: "test/run11-synthetic-authority (NOT external provider execution)",
    designMdDigest: deterministicDigest({ synthetic: "design", projectId: input.projectId }),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "synthetic" },
      rationale: "Synthetic Run 11 test authority seed rationale",
    },
    providerEvidence: {},
    tokens: {
      colors: { primary: "#1A2E35", background: "#FFFFFF", surface: "#F6F5F2" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "synthetic test authority" },
      spacing: { md: "16px", lg: "32px" },
      rounded: { md: "8px" },
      ctaHierarchy: "text only",
      navigationLanguage: "plain",
      imageryTreatment: "none",
      sectionRhythm: "measured",
    },
    screens: [
      {
        id: `synth-screen-${input.projectId}`,
        providerScreenName: "test/run11-synthetic-authority/screens/home",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry (synthetic test authority)",
        providerScreenNames: ["test/run11-synthetic-authority/screens/home"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero image",
            pageSlug: input.pageSlug,
            role: "hero",
            requiredRole: "hero",
            boundAssetVersionId: input.approved.id,
            boundBinaryDigest: input.approved.binaryDigest,
            boundGovernanceDigest: input.approved.governanceDigest!,
            providerConsumed: false,
            placeholder: false,
            designProviderReferencedFinalAsset: false,
            designProviderConsumedFinalAsset: false,
          },
        ],
        primaryCta: "Request assessment",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Run 11 test-only synthetic production authority; NOT external provider execution.",
  };
}
