import { assignmentPage, acceptFixturePage } from "../fixtures/accepted-page.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { setupMigratedTestDatabase } from "./helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { DesignStore } from "../../src/design/design-store.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { FactoryError } from "../../src/executor/errors.js";
import { parseDesignCandidateData, type DesignCandidateData, type ProductionQaCheckResult } from "@factory/contracts";
import { VisualStore } from "../../src/visual/store.js";
import { ProductionStore } from "../../src/production/store.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { bindQaCheck, REQUIRED_PRODUCTION_QA_GATES, TRUSTED_PRODUCTION_QA_GATES } from "../../src/production/qa/registry.js";

/**
 * Run 9 persistence suite — real PostgreSQL (dedicated factory_test DB).
 * Covers: ProductionPageInput derivation (fail-closed on missing/stale/
 * fixture authority), route authority conflicts, candidate immutability,
 * staleness on upstream mutation, QA run recording, restart durability,
 * cross-project isolation, and concurrent candidate creation.
 *
 * Live production authority is seeded via the same SQL pattern the Run 7
 * suite uses for its requireProductionVisualSet tests (a real approved
 * AssetVersion bound into a live accepted visual set + live accepted
 * design artifact). Fixture authority paths prove fail-closed behavior.
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

const REPOSITORY_SHA = "1".repeat(40);
const LOCKFILE_DIGEST = "2".repeat(64);
const MANIFEST_SET_DIGEST = "3".repeat(64);
const REDIRECT_DIGEST = deterministicDigest({ projectId: "fixture", rules: [] });
const CANDIDATE_IDENTITY = { repositorySha: REPOSITORY_SHA, lockfileDigest: LOCKFILE_DIGEST };
function siteIdentity() {
  return { siteId: "site-fixture", siteName: "Fixture Site", canonicalOrigin: "https://example.com", language: "en", profileDigest: "4".repeat(64) };
}
function completeQaChecks(route: string, manifestSetDigest: string, repositorySha: string, failingCheck?: string): ProductionQaCheckResult[] {
  return REQUIRED_PRODUCTION_QA_GATES.map((gate) => {
    const subject = gate.scope === "page" ? route : gate.scope === "site" ? manifestSetDigest : repositorySha;
    const group = gate.checkId.split(".")[0] as ProductionQaCheckResult["group"];
    return bindQaCheck({ checkId: gate.checkId, group, verdict: gate.checkId === failingCheck ? "FAIL" : "PASS", detail: "test evidence", evidence: [] }, { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" });
  });
}

async function seedProject(dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>, key: string) {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const project = await store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });
  return { projectId: project.id, inputSnapshot: accepted };
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
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/fixture/screens/abc"],
        sectionPatterns: ["hero", "evidence", "cta"],
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
        primaryCta: "Request assessment",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Fixture rationale",
  });
}

interface LiveAuthorityEnv {
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>;
  projectId: string;
  root: string;
  designId: string;
  designDigest: string;
  setId: string;
  setDigest: string;
  production: ProductionStore;
}

/**
 * Seed LIVE production authority exactly as the Run 7 suite does for its
 * production-boundary tests: fixture-accepted writer content (the accepted
 * content path is provider-neutral), then SQL-seeded live design artifact +
 * live accepted visual set binding a real approved AssetVersion.
 */
async function setupLiveAuthority(
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>,
  key: string,
  pageSlug: string,
): Promise<LiveAuthorityEnv> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  await acceptFixturePage(dbInst, projectId, pageSlug);
  const root = await mkdtemp(path.join(tmpdir(), "production-live-"));

  // Real approved asset version (exact binary + governance digests).
  const assetsModule = await import("../../src/assets/service.js");
  const assetStorageModule = await import("../../src/assets/storage.js");
  const sharp = (await import("sharp")).default;
  const assets = new assetsModule.AssetService({
    store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
    storage: assetStorageModule.createAssetStorage(root),
  });
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const upload = await assets.uploadAsset(projectId, {
    filename: "hero.jpg",
    kind: "photo",
    title: "Hero",
    rightsStatus: "operator_owned",
    dataBase64: bytes.toString("base64"),
  });
  const approved = await assets.approveVersion(projectId, upload.version.id, upload.version.binaryDigest);

  // Live accepted design artifact derived through the REAL design pipeline
  // (valid transitive lineage), then switched to live provider mode via a
  // scoped test-only UPDATE — the accepted design pipeline is provider-
  // neutral; only the recorded provider mode distinguishes live evidence.
  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
  const fixtureData = candidateData(pageSlug);
  const liveData = parseDesignCandidateData({
    ...fixtureData,
    providerMode: "live",
    providerProjectName: "projects/live",
  });
  const candidate = await designStore.createCandidate({
    projectId,
    inputSnapshot: snapshot,
    data: liveData,
  });
  // Test-only live-mode enforcement: the acceptance path refuses fixture
  // acceptance without explicit fixture review notes; for production-authority
  // tests we flip the recorded provider mode to live (the Run 7 suite uses
  // the same SQL-seeding approach for its production boundary tests).
  await dbInst.db.execute(
    sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`,
  );
  const accepted = await designStore.acceptCandidate({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "live acceptance (test-seeded production authority)",
  });
  const designId = accepted.id;

  // Live visual plan + accepted visual set binding the approved version.
  // The plan binds the exact accepted design lineage.
  const visualStore = new VisualStore(dbInst.db);
  const planId = `vap-${key}`;
  await dbInst.db.execute(sql`
    INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest)
    VALUES (${planId}, ${projectId}, 1, ${designId}, ${accepted.version}, ${accepted.candidateDigest}, ${accepted.inputDigest}, 'live', '[]'::jsonb, ${"c".repeat(64)})
  `);
  const set = await visualStore.createAcceptedSetAtomic({
    projectId,
    planId,
    providerMode: "live",
    designArtifactId: designId,
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


  return {
    dbInst,
    projectId,
    root,
    designId,
    designDigest: "a".repeat(64),
    setId: set.id,
    setDigest: set.setDigest,
    production: new ProductionStore(dbInst.db),
  };
}

async function closeEnv(env: LiveAuthorityEnv): Promise<void> {
  await env.dbInst.close();
  await rm(env.root, { recursive: true, force: true });
}

test("PG: production input derivation fails closed without accepted content", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProject(dbInst, "prod-empty");
    const production = new ProductionStore(dbInst.db);
    await assert.rejects(
      production.deriveProductionInput({
        projectId,
        pageSlug: "home",
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      }),
      (e) => isCode(e, "production_authority_not_found"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: production input derives from the exact accepted authority chain and is idempotent", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-derive-1", "home");
  try {
    const input1 = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(input1.version, 1);
    assert.equal(input1.route, "/home");
    assert.equal(input1.pageType, "homepage");
    assert.equal(input1.acceptedDesignId, env.designId);
    assert.equal(input1.acceptedVisualSetId, env.setId);
    assert.match(input1.inputDigest, /^[0-9a-f]{64}$/);

    // Idempotent: same authority + renderer config -> same input row.
    const input2 = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(input2.id, input1.id);

    // Restart durability: fresh store instance over the same DB.
    const fresh = new ProductionStore(env.dbInst.db);
    const latest = await fresh.latestProductionInput(env.projectId, "home");
    assert.equal(latest?.id, input1.id);
  } finally {
    await closeEnv(env);
  }
});

test("PG: fixture authority cannot masquerade as production authority (fail closed)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupVisualFixtureOnly(dbInst, "prod-fixture-1", "home");
  try {
    // The fixture-accepted design must fail the production gate.
    await assert.rejects(
      env.production.deriveProductionInput({
        projectId: env.projectId,
        pageSlug: "home",
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      }),
      (e) =>
        isCode(e, "production_authority_stale") ||
        isCode(e, "production_authority_not_found") ||
        isCode(e, "design_accepted_not_found") ||
        isCode(e, "design_approval_failed"),
    );
  } finally {
    await dbInst.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

/** Fixture-only environment: fixture writer content + fixture design (no live seeding). */
async function setupVisualFixtureOnly(
  dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>,
  key: string,
  pageSlug: string,
): Promise<{ projectId: string; root: string; production: ProductionStore }> {
  const { projectId } = await seedProjectWithAcceptedInputs(dbInst, key);
  await acceptFixturePage(dbInst, projectId, pageSlug);
  const root = await mkdtemp(path.join(tmpdir(), "production-fixture-"));
  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.deriveInputSnapshotDraft({ projectId });
  const candidate = await designStore.createCandidate({
    projectId,
    inputSnapshot: snapshot,
    data: candidateData(pageSlug),
  });
  await designStore.acceptCandidate({
    projectId,
    candidateId: candidate.id,
    expectedCandidateDigest: candidate.candidateDigest,
    reviewNotes: "fixture acceptance",
  });
  return { projectId, root, production: new ProductionStore(dbInst.db) };
}

test("PG: route authority conflict — a different page identity cannot claim a claimed route", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-route-1", "home");
  try {
    // Accept content for a second slug; the design binds archetype only for
    // "home", so derivation for "home-alt" fails closed at archetype
    // resolution (route-conflict family: no unambiguous page identity).
    // First derive the legitimate 'home' input (claims route /home).
    const homeInput = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    assert.equal(homeInput.route, "/home");
    await acceptFixturePage(env.dbInst, env.projectId, "home-alt");
    await assert.rejects(
      env.production.deriveProductionInput({
        projectId: env.projectId,
        pageSlug: "home-alt",
        siteIdentity: siteIdentity(),
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v1",
      }),
      (e) => isCode(e, "production_route_conflict") || isCode(e, "production_authority_stale"),
    );
    // DB-level stable route owner backstop: historical input versions may
    // coexist, but a different page identity cannot claim the route.
    await assert.rejects(
      env.dbInst.db.execute(sql`
        INSERT INTO production_route_authorities (project_id, route, page_identity)
        VALUES (${env.projectId}, '/home', 'home-alt')
      `),
    );
  } finally {
    await closeEnv(env);
  }
});

test("PG: candidate creation is refused for stale authority and succeeds for current", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-cand-1", "home");
  try {
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });

    // Fault injection: mutate the recorded content digest binding.
    await env.dbInst.db.execute(
      sql`UPDATE production_page_inputs SET accepted_content_digest = ${"9".repeat(64)} WHERE id = ${input.id}`,
    );
    const reread = (await env.production.latestProductionInput(env.projectId, "home"))!;
    const staleness = await env.production.inputStaleness(reread);
    assert.equal(staleness.stale, true);

    // Candidate creation from the stale input fails closed.
    await assert.rejects(
      env.production.createCandidate({ projectId: env.projectId, productionInputId: reread.id, ...CANDIDATE_IDENTITY }),
      (e) => isCode(e, "production_authority_stale"),
    );
  } finally {
    await closeEnv(env);
  }
});

test("PG: candidate lifecycle — create, build-record, QA record, state transitions", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-life-1", "home");
  try {
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    const candidate = await env.production.createCandidate({
      projectId: env.projectId,
      productionInputId: input.id,
      ...CANDIDATE_IDENTITY,
    });
    assert.equal(candidate.state, "pending");
    assert.equal(candidate.canonicalUrl, "https://example.com/home");

    // Double build is refused (immutable candidate).
    await env.production.recordBuild({
      projectId: env.projectId,
      candidateId: candidate.id,
      artifactDigest: "a".repeat(64),
      artifactRef: "/tmp/dist",
      assetReferences: [],
      manifestSetDigest: MANIFEST_SET_DIGEST,
      candidateInputs: [{ productionInputId: input.id, productionInputVersion: input.version, productionInputDigest: input.inputDigest, pageIdentity: input.pageIdentity, route: input.route, manifestDigest: "5".repeat(64) }],
      redirectRules: [],
      redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }),
    });
    await assert.rejects(
      env.production.recordBuild({
        projectId: env.projectId,
        candidateId: candidate.id,
        artifactDigest: "b".repeat(64),
        artifactRef: "/tmp/dist2",
        assetReferences: [],
        manifestSetDigest: MANIFEST_SET_DIGEST,
        candidateInputs: [{ productionInputId: input.id, productionInputVersion: input.version, productionInputDigest: input.inputDigest, pageIdentity: input.pageIdentity, route: input.route, manifestDigest: "5".repeat(64) }],
        redirectRules: [],
        redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }),
      }),
      (e) => isCode(e, "production_build_rejected"),
    );

    await assert.rejects(
      env.production.recordQaRun({
        projectId: env.projectId, candidateId: candidate.id,
        checks: [bindQaCheck({ checkId: "content.sections_complete", group: "content", verdict: "PASS", detail: "incomplete", evidence: [] }, { scope: "page", subject: input.route, tool: "test-runner", toolVersion: "1" })],
        evaluatedArtifactDigest: "a".repeat(64), manifestSetDigest: MANIFEST_SET_DIGEST,
        redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }), repositorySha: REPOSITORY_SHA, lockfileDigest: LOCKFILE_DIGEST, pageRoutes: [input.route],
      }),
      (e) => isCode(e, "production_qa_failed"),
      "a partial PASS report must never accept the candidate",
    );

    const passingChecks = completeQaChecks(input.route, MANIFEST_SET_DIGEST, REPOSITORY_SHA);
    await assert.rejects(
      env.production.recordQaRun({
        projectId: env.projectId, candidateId: candidate.id, checks: passingChecks,
        evaluatedArtifactDigest: "a".repeat(64), manifestSetDigest: MANIFEST_SET_DIGEST,
        redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }),
        repositorySha: REPOSITORY_SHA, lockfileDigest: LOCKFILE_DIGEST, pageRoutes: [input.route],
      }),
      (e) => isCode(e, "production_qa_failed"),
      "caller-supplied trusted verdicts must not substitute for persisted candidate-bound evidence",
    );
    for (const check of passingChecks.filter((entry) => TRUSTED_PRODUCTION_QA_GATES.some((gate) => gate.checkId === entry.checkId))) {
      await env.production.recordTrustedQaEvidence({
        projectId: env.projectId,
        candidateId: candidate.id,
        check,
        artifactDigest: check.scope === "repository" ? undefined : "a".repeat(64),
        repositorySha: check.scope === "repository" ? REPOSITORY_SHA : undefined,
        lockfileDigest: check.scope === "repository" ? LOCKFILE_DIGEST : undefined,
      });
    }

    // QA PASS transitions to qa_passed only after trusted evidence exists.
    await env.production.recordQaRun({
      projectId: env.projectId,
      candidateId: candidate.id,
      checks: passingChecks,
      evaluatedArtifactDigest: "a".repeat(64), manifestSetDigest: MANIFEST_SET_DIGEST,
      redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }),
      repositorySha: REPOSITORY_SHA, lockfileDigest: LOCKFILE_DIGEST, pageRoutes: [input.route],
    });
    const passed = (await env.production.getCandidate(env.projectId, candidate.id))!;
    assert.equal(passed.state, "qa_passed");

    // A FAIL QA run blocks acceptance (state qa_failed).
    await env.production.recordQaRun({
      projectId: env.projectId,
      candidateId: candidate.id,
      checks: completeQaChecks(input.route, MANIFEST_SET_DIGEST, REPOSITORY_SHA, "seo.canonical"),
      evaluatedArtifactDigest: "a".repeat(64), manifestSetDigest: MANIFEST_SET_DIGEST,
      redirectSnapshotDigest: deterministicDigest({ projectId: env.projectId, rules: [] }),
      repositorySha: REPOSITORY_SHA, lockfileDigest: LOCKFILE_DIGEST, pageRoutes: [input.route],
    });
    const failed = (await env.production.getCandidate(env.projectId, candidate.id))!;
    assert.equal(failed.state, "qa_failed");

    // Restart durability.
    const fresh = new ProductionStore(env.dbInst.db);
    const latest = await fresh.latestQaRun(env.projectId, candidate.id);
    assert.equal(latest?.overall, "FAIL");
  } finally {
    await closeEnv(env);
  }
});

test("PG: cross-project isolation — another project cannot read or use this authority", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const env = await setupLiveAuthority(dbInst, "prod-iso-1", "home");
  try {
    const { projectId: otherProject } = await seedProject(dbInst, "prod-iso-1-other");
    const candidates = await env.production.listCandidates(otherProject);
    assert.equal(candidates.length, 0);
    const inputs = await env.production.listProductionInputs(otherProject);
    assert.equal(inputs.length, 0);
  } finally {
    await closeEnv(env);
  }
});

test("PG: concurrent candidate creation serializes through the project advisory lock", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-conc-1", "home");
  try {
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    const [a, b] = await Promise.all([
      env.production.createCandidate({ projectId: env.projectId, productionInputId: input.id, ...CANDIDATE_IDENTITY }),
      env.production.createCandidate({ projectId: env.projectId, productionInputId: input.id, ...CANDIDATE_IDENTITY }),
    ]);
    assert.notEqual(a.id, b.id);
    assert.equal(a.productionInputId, input.id);
    assert.equal(b.productionInputId, input.id);
  } finally {
    await closeEnv(env);
  }
});

test("PG: stale accepted content blocks candidate creation (negative authority test)", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-stale-1", "home");
  try {
    const input = await env.production.deriveProductionInput({
      projectId: env.projectId,
      pageSlug: "home",
      siteIdentity: siteIdentity(),
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
    });
    // Accept new content for the same slug (new version supersedes the old).
    await acceptFixturePage(env.dbInst, env.projectId, "home");
    const staleness = await env.production.inputStaleness(input);
    assert.equal(staleness.stale, true, "new accepted content version must make old input stale");
    await assert.rejects(
      env.production.createCandidate({ projectId: env.projectId, productionInputId: input.id, ...CANDIDATE_IDENTITY }),
      (e) => isCode(e, "production_authority_stale"),
    );
  } finally {
    await closeEnv(env);
  }
});

test("PG: a newer accepted design makes retained historical production input stale", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-design-stale", "home");
  try {
    const input = await env.production.deriveProductionInput({ projectId: env.projectId, pageSlug: "home", siteIdentity: siteIdentity(), rendererVersion: "7.2.9", rendererPolicyVersion: "production-policy-v2" });
    const designStore = new DesignStore(env.dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: env.projectId });
    const candidate = await designStore.createCandidate({ projectId: env.projectId, inputSnapshot: snapshot, data: parseDesignCandidateData({ ...candidateData("home"), providerMode: "live", providerProjectName: "projects/live-new" }) });
    await env.dbInst.db.execute(sql`UPDATE design_candidates SET provider_mode = 'live' WHERE id = ${candidate.id}`);
    await designStore.acceptCandidate({ projectId: env.projectId, candidateId: candidate.id, expectedCandidateDigest: candidate.candidateDigest, reviewNotes: "superseding live design" });
    assert.equal((await env.production.inputStaleness(input)).stale, true);
  } finally { await closeEnv(env); }
});

test("PG: a newer accepted visual set makes retained historical production input stale", async () => {
  const env = await setupLiveAuthority(await setupMigratedTestDatabase(), "prod-visual-stale", "home");
  try {
    const input = await env.production.deriveProductionInput({ projectId: env.projectId, pageSlug: "home", siteIdentity: siteIdentity(), rendererVersion: "7.2.9", rendererPolicyVersion: "production-policy-v2" });
    const visual = new VisualStore(env.dbInst.db);
    const currentSet = (await visual.latestAcceptedSet(env.projectId))!;
    const [slot] = await visual.listAcceptedSlots(currentSet.id);
    const planId = "vap-prod-visual-stale-2";
    await env.dbInst.db.execute(sql`INSERT INTO visual_asset_plans (id, project_id, version, design_artifact_id, design_artifact_version, design_candidate_digest, design_input_digest, design_provider_mode, slots, plan_digest) VALUES (${planId}, ${env.projectId}, 2, ${currentSet.designArtifactId}, ${currentSet.designArtifactVersion}, ${currentSet.designCandidateDigest}, ${currentSet.designInputDigest}, 'live', '[]'::jsonb, ${"6".repeat(64)})`);
    await visual.createAcceptedSetAtomic({ projectId: env.projectId, planId, providerMode: "live", designArtifactId: currentSet.designArtifactId, designArtifactVersion: currentSet.designArtifactVersion, designCandidateDigest: currentSet.designCandidateDigest, designInputDigest: currentSet.designInputDigest, slots: [{ slot: slot!.slot, pageSlug: slot!.pageSlug, role: slot!.role, resolvedVersionId: slot!.resolvedVersionId, binaryDigest: slot!.binaryDigest, governanceDigest: slot!.governanceDigest, resolutionMode: slot!.resolutionMode as "reuse_real", truthClass: slot!.truthClass as "documentary" | "documentary_edited" | "illustrative" | "decorative" | "data_visualization" }] });
    assert.equal((await env.production.inputStaleness(input)).stale, true);
  } finally { await closeEnv(env); }
});
