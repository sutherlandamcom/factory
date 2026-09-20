import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { FactoryError } from "../../src/executor/errors.js";
import { DesignStore } from "../../src/design/design-store.js";
import { VisualStore } from "../../src/visual/store.js";
import { ProductionStore } from "../../src/production/store.js";
import { DerivativesService } from "../../src/derivatives/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import {
  parseAcceptedDerivativeSetData,
  parseDesignCandidateData,
  type DesignCandidateData,
} from "@factory/contracts";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { PageAuthorityReader } from "../../src/writer/page-authority.js";
import { seedSyntheticProductionDerivativeSet } from "./run10-test-helpers.js";
import { requireProductionDerivativeSet } from "../../src/derivatives/production-verifier.js";
import { DerivativesStore } from "../../src/derivatives/store.js";
import { acceptedDerivativeSetDigest } from "../../src/derivatives/core.js";
import { productionCandidates } from "../../src/persistence/schema.js";

/**
 * RUN 10 PRODUCTION INTEGRATION — real PostgreSQL.
 *
 * Proves the derivative-aware production-v2 path:
 *   - no derivative policy → production-v1 input (explicit disabled, Run 9 unchanged);
 *   - enabled policy + accepted derivatives → production-v2 input binding the
 *     exact AcceptedDerivativeSet id/version/digest;
 *   - enabled policy + missing current accepted derivative → derivation FAILS;
 *   - derivative set superseded/stale → production input stale → candidate stale.
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

function siteIdentity() {
  return { siteId: "site-fixture", siteName: "Fixture Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) };
}

function candidateData(pageSlug: string): DesignCandidateData {
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
        title: "Service page",
        deviceType: "DESKTOP",
        archetype: "service",
      },
      {
        id: "screen-home",
        providerScreenName: "projects/fixture/screens/home",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first homepage",
        providerScreenNames: ["projects/fixture/screens/home"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [],
        primaryCta: "Request an inspection",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
      {
        kind: "service",
        purpose: "Trust-first service page",
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

interface LiveEnv {
  dbInst: FactoryDatabaseInstance;
  projectId: string;
  production: ProductionStore;
}

async function setupLiveAuthority(dbInst: FactoryDatabaseInstance, key: string, pageSlug: string): Promise<LiveEnv> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  await acceptFixturePage(dbInst, projectId, pageSlug);
  const root = await mkdtemp(path.join(tmpdir(), "run10-live-"));

  const assetsModule = await import("../../src/assets/service.js");
  const assets = new assetsModule.AssetService({
    store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
    storage: (await import("../../src/assets/storage.js")).createAssetStorage(root),
  });
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
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
    reviewNotes: "live acceptance (test-seeded production authority)",
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

  return { dbInst, projectId, production: new ProductionStore(dbInst.db) };
}

async function makeDerivativesService(dbInst: FactoryDatabaseInstance, repoRoot: string) {
  return new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });
}

function fixtureSummaryInvoke(request: { prompt: string }) {
  const marker = "ACCEPTED PAGE CONTENT FOLLOWS:";
  const source = String(request.prompt);
  const accepted = source.includes(marker) ? source.split(marker)[1]! : source;
  const sentences = accepted.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 40);
  return {
    content: sentences.slice(0, 4).join(" "),
    model: "fixture/page_summarizer",
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    durationMs: 1,
  };
}

async function acceptFullDerivatives(dbInst: FactoryDatabaseInstance, repoRoot: string, projectId: string, pageIdentity: string) {
  const pages = await new PageAuthorityReader(dbInst.db).currentPages(projectId);
  const page = pages.find((p: { slug: string }) => p.slug === pageIdentity)!;
  return seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId,
    pageIdentity,
    sourceContent: { id: page.id, version: page.version, digest: page.contentDigest },
  });
}

test("PG run10: no derivative policy → production-v1 input (Run 9 flow unchanged)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupLiveAuthority(dbInst, "run10-nopolicy", "home");
  void env;
  try {
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    const data = input.data as { schemaVersion?: string };
    assert.equal(data.schemaVersion, "production-v1");
  } finally {
    await dbInst.close();
  }
});

test("PG run10: enabled policy + accepted derivatives → production-v2 binds exact set", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "run10-v2-"));
  const env = await setupLiveAuthority(dbInst, "run10-v2", "home");
  try {
    const repoRoot = await resolveRepositoryRoot();
    const service = await makeDerivativesService(dbInst, repoRoot);
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
    });
    const set = await acceptFullDerivatives(dbInst, repoRoot, env.projectId, "home");

    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    const data = input.data as { schemaVersion?: string; acceptedDerivativeSet?: { id: string; version: number; digest: string } };
    assert.equal(data.schemaVersion, "production-v2");
    assert.equal(data.acceptedDerivativeSet!.id, set.set.id);
    assert.equal(data.acceptedDerivativeSet!.digest, set.set.setDigest);

    // Staleness: current set → not stale.
    const staleness = await env.production.inputStaleness(input, {
      siteProfileDigest: siteIdentity().profileDigest,
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(staleness.stale, false);
  } finally {
    await dbInst.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PG run10: enabled policy + missing accepted derivative → derivation FAILS", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupLiveAuthority(dbInst, "run10-missing", "home");
  try {
    const repoRoot = await resolveRepositoryRoot();
    const service = await makeDerivativesService(dbInst, repoRoot);
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });
    // No accepted summary exists → derivation must fail closed.
    await assert.rejects(
      () =>
        env.production.deriveProductionInput({
          projectId: env.projectId,
          pageSlug: "home",
          siteIdentity: siteIdentity(),
          rendererVersion: "astro-7.2.9",
          rendererPolicyVersion: "production-policy-v1",
        }),
      (e) => isCode(e, "derivative_required_artifact_missing"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG run10: superseded derivative set → production input stale", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "run10-stale-"));
  const env = await setupLiveAuthority(dbInst, "run10-stale", "home");
  try {
    const repoRoot = await resolveRepositoryRoot();
    const service = await makeDerivativesService(dbInst, repoRoot);
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });
    await acceptFullDerivatives(dbInst, repoRoot, env.projectId, "home");
    const input1 = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });

    // Mutate the policy: a new intent supersedes the set bound in input1.
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v2" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });
    const staleness = await env.production.inputStaleness(input1, {
      siteProfileDigest: siteIdentity().profileDigest,
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(staleness.stale, true);
    assert.match(staleness.reason!, /intent snapshot|DerivativeSet|derivative/i);
  } finally {
    await dbInst.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PG run10: policy drift makes deriveProductionInput fail immediately with production_authority_stale", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupLiveAuthority(dbInst, "run10-pol-drift", "home");
  try {
    const repoRoot = await resolveRepositoryRoot();
    const service = await makeDerivativesService(dbInst, repoRoot);
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });
    // Accept derivative set under policy v1
    await acceptFullDerivatives(dbInst, repoRoot, env.projectId, "home");

    // Policy mutates to v2 before deriveProductionInput is called:
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v2" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });

    // deriveProductionInput must verify fresh effective intent directly and fail early
    await assert.rejects(
      () =>
        env.production.deriveProductionInput({
          projectId: env.projectId,
          pageSlug: "home",
          siteIdentity: siteIdentity(),
          rendererVersion: "astro-7.2.9",
          rendererPolicyVersion: "production-policy-v1",
        }),
      (err: unknown) => isCode(err, "production_authority_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG run10: mandatory supersession regression (D1 historical immutable, D2 current, PI1 stale, candidate blocked)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const root = await mkdtemp(path.join(tmpdir(), "run10-supersession-"));
  const env = await setupLiveAuthority(dbInst, "run10-super", "home");
  try {
    const repoRoot = await resolveRepositoryRoot();
    const service = await makeDerivativesService(dbInst, repoRoot);

    // Current policy P1
    await service.updateProjectPolicy({
      projectId: env.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });

    // Current content C1
    const [page] = (await new PageAuthorityReader(dbInst.db).currentPages(env.projectId)).filter(p => p.slug === "home");
    assert.ok(page);
    const content = { id: page.id, version: page.version, digest: page.contentDigest };

    // 1. Accept Summary S1 and DerivativeSet D1
    const seededD1 = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
      projectId: env.projectId,
      pageIdentity: "home",
      sourceContent: content,
      summaryText: "Initial Summary S1 text for page home.",
    });

    // Record D1 id, version, data, digest
    const d1Id = seededD1.set.id;
    const d1Version = seededD1.set.version;
    const d1DataBefore = JSON.parse(JSON.stringify(seededD1.set.data));
    const d1Digest = seededD1.set.setDigest;
    assert.equal(d1Version, 1);

    // D1 is current before D2 exists: requireProductionDerivativeSet(D1) PASSES
    const verifiedD1Before = await requireProductionDerivativeSet({
      db: dbInst.db,
      projectId: env.projectId,
      pageIdentity: "home",
      setId: d1Id,
      setVersion: d1Version,
      setDigest: d1Digest,
      currentContent: content,
    });
    assert.equal(verifiedD1Before.set.id, d1Id);

    // Derive ProductionPageInput PI1 binding D1
    const input1 = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    const input1Data = input1.data as { acceptedDerivativeSet?: { id: string; version: number; digest: string } };
    assert.equal(input1Data.acceptedDerivativeSet?.id, d1Id);
    assert.equal(input1Data.acceptedDerivativeSet?.version, d1Version);
    assert.equal(input1Data.acceptedDerivativeSet?.digest, d1Digest);

    const input1StalenessBefore = await env.production.inputStaleness(input1, {
      siteProfileDigest: siteIdentity().profileDigest,
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(input1StalenessBefore.stale, false);

    // Bind a ProductionCandidate to PI1
    const candidate1 = await env.production.createCandidate({
      projectId: env.projectId,
      productionInputId: input1.id,
      repositorySha: "a".repeat(40),
      lockfileDigest: "b".repeat(64),
      currentEnvironment: {
        siteProfileDigest: siteIdentity().profileDigest,
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      },
    });
    assert.equal(candidate1.state, "pending");

    // 2. Now create new accepted derivative version under the SAME content, policy, intent:
    // Summary S1 -> S2, then accept D2
    const seededD2 = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
      projectId: env.projectId,
      pageIdentity: "home",
      sourceContent: content,
      summaryText: "Updated Summary S2 text for page home.",
    });
    const d2Id = seededD2.set.id;
    const d2Version = seededD2.set.version;
    const d2Digest = seededD2.set.setDigest;
    assert.equal(d2Version, 2);
    assert.notEqual(d2Id, d1Id);
    assert.notEqual(d2Digest, d1Digest);

    // 3. Historical D1 still valid (Theorem A & Section 13):
    const derivStore = new DerivativesStore(dbInst.db);
    const reloadedD1 = await derivStore.getDerivativeSetById(env.projectId, d1Id);
    assert.ok(reloadedD1);
    // D1.data exactly unchanged from before D2 (deep equality)
    assert.deepEqual(reloadedD1.data, d1DataBefore);
    // parseAcceptedDerivativeSetData(D1.data) -> PASS
    const parsedD1 = parseAcceptedDerivativeSetData(reloadedD1.data);
    // acceptedDerivativeSetDigest(D1.data) == D1.setDigest
    assert.equal(acceptedDerivativeSetDigest(parsedD1), d1Digest);
    assert.equal(reloadedD1.setDigest, d1Digest);
    assert.equal(reloadedD1.version, 1);

    // 4. Production currentness (Theorem B & Section 14):
    // requireProductionDerivativeSet(D1) MUST FAIL with production_authority_stale
    await assert.rejects(
      () =>
        requireProductionDerivativeSet({
          db: dbInst.db,
          projectId: env.projectId,
          pageIdentity: "home",
          setId: d1Id,
          setVersion: d1Version,
          setDigest: d1Digest,
          currentContent: content,
        }),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "production_authority_stale");
        assert.match(err.message, /superseded/i);
        return true;
      },
    );

    // requireProductionDerivativeSet(D2) MUST PASS
    const verifiedD2 = await requireProductionDerivativeSet({
      db: dbInst.db,
      projectId: env.projectId,
      pageIdentity: "home",
      setId: d2Id,
      setVersion: d2Version,
      setDigest: d2Digest,
      currentContent: content,
    });
    assert.equal(verifiedD2.set.id, d2Id);
    assert.equal(verifiedD2.set.version, 2);
    assert.equal(verifiedD2.set.setDigest, d2Digest);

    // 5. Production input staleness must follow supersession (Section 15):
    // Content unchanged, policy unchanged, intent unchanged: staleness reason is supersession.
    const input1StalenessAfter = await env.production.inputStaleness(input1, {
      siteProfileDigest: siteIdentity().profileDigest,
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(input1StalenessAfter.stale, true);
    assert.match(input1StalenessAfter.reason!, /superseded/i);

    // 6. Candidate staleness (Section 16):
    // Attempting to create a new candidate with PI1 now fails closed:
    await assert.rejects(
      () =>
        env.production.createCandidate({
          projectId: env.projectId,
          productionInputId: input1.id,
          repositorySha: "a".repeat(40),
          lockfileDigest: "b".repeat(64),
          currentEnvironment: {
            siteProfileDigest: siteIdentity().profileDigest,
            rendererVersion: "astro-7.2.9",
            rendererPolicyVersion: "production-policy-v1",
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "production_authority_stale");
        assert.match(err.message, /superseded/i);
        return true;
      },
    );

    // Existing candidate1 bound to PI1 can no longer proceed as current production authority:
    // recordBuild detects that PI1 became stale, marks candidate1 stale in DB, and throws production_authority_stale.
    await assert.rejects(
      () =>
        env.production.recordBuild({
          projectId: env.projectId,
          candidateId: candidate1.id,
          artifactDigest: "c".repeat(64),
          artifactRef: "artifacts/build-test",
          assetReferences: [],
          manifestSetDigest: "d".repeat(64),
          redirectSnapshotDigest: "e".repeat(64),
          candidateInputs: [
            {
              productionInputId: input1.id,
              productionInputVersion: input1.version,
              productionInputDigest: input1.inputDigest,
              pageIdentity: input1.pageIdentity,
              route: input1.route,
              manifestDigest: "f".repeat(64),
            },
          ],
          redirectRules: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "production_authority_stale");
        assert.match(err.message, /superseded/i);
        return true;
      },
    );

    const [reloadedCand] = await dbInst.db
      .select()
      .from(productionCandidates)
      .where(eq(productionCandidates.id, candidate1.id));
    assert.equal(reloadedCand?.state, "stale");
  } finally {
    await dbInst.close();
    await rm(root, { recursive: true, force: true });
  }
});
