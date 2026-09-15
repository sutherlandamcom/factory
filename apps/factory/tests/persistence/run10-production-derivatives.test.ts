import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
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
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";

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
    ],
    archetypes: [
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
  const { FixtureAudioNarrationProvider: FixtureProvider } = await import("../../src/derivatives/audio-provider.js");
  class OfflineLiveAudioProvider extends FixtureProvider {
    override readonly providerMode = "live" as const;
    override readonly isTestDouble = false as const;
  }
  return new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    audioProvider: new OfflineLiveAudioProvider(),
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

async function acceptFullDerivatives(service: DerivativesService, projectId: string, pageIdentity: string) {
  const { proposal } = await service.generateSummaryProposal({ projectId, pageIdentity });
  await service.acceptSummary({ projectId, pageIdentity, proposalId: proposal.id });
  // Generate/accept audio only when the effective policy enables it.
  const { snapshot } = await service.deriveIntentSnapshot({ projectId, pageIdentity });
  if (snapshot.effectiveAudioState === "enabled") {
    const { candidate } = await service.generateAudioCandidate({ projectId, pageIdentity });
    await service.acceptAudio({ projectId, pageIdentity, candidateId: candidate.id });
  }
  return service.acceptDerivativeSet({ projectId, pageIdentity });
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
    const set = await acceptFullDerivatives(service, env.projectId, "home");

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
    await acceptFullDerivatives(service, env.projectId, "home");
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
