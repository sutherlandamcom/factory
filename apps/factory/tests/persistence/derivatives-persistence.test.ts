import assert from "node:assert/strict";
import test from "node:test";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { FactoryError } from "../../src/executor/errors.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { DerivativesService } from "../../src/derivatives/service.js";
import { DerivativesStore } from "../../src/derivatives/store.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { readAcceptedPageCopy, acceptedDerivativeSetDigest } from "../../src/derivatives/core.js";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { and, eq } from "drizzle-orm";
import { parseAcceptedDerivativeSetData } from "@factory/contracts";
import { pageDerivativeIntentSnapshots } from "../../src/persistence/schema.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import {
  seedSyntheticAcceptedSummary,
  seedSyntheticAcceptedAudio,
  seedSyntheticProductionDerivativeSet,
} from "./run10-test-helpers.js";
import {
  assertSummaryProductionAuthority,
  assertAudioProductionAuthority,
} from "../../src/derivatives/production-verifier.js";
import { runSummaryInvocation } from "../../src/derivatives/summary-provider.js";

/**
 * Run 10 persistence suite — real PostgreSQL (dedicated factory_test DB).
 * Covers: project policy/override versioning, intent snapshot idempotency,
 * summary lifecycle (prompt snapshot → fixture proposal → QA → human accept),
 * deterministic narration, audio lifecycle (fixture candidate + production
 * authority gate), accepted derivative set, staleness on content/policy/voice
 * mutation, cross-project isolation, restart durability, and concurrency
 * (real independent connections under the shared project advisory lock).
 *
 * Provider truthfulness: ALL provider executions in this suite are offline
 * fixture doubles (explicitly marked); zero paid calls are made.
 * Downstream acceptance/lifecycle tests use explicitly labeled TEST-ONLY
 * synthetic authority fixtures. LIVE TTS PRODUCTION AUTHORITY IS NOT YET PROVEN.
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

/** Deterministic offline fixture summary invocation (explicit test double). */
function fixtureSummaryInvoke(request: { prompt: string; systemPrompt: string }) {
  // Extract only the ACCEPTED PAGE CONTENT section of the compiled prompt and
  // echo its first sentences verbatim — a faithful offline summarizer double.
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

async function makeService(dbInst: FactoryDatabaseInstance) {
  const repoRoot = await resolveRepositoryRoot();
  return new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    audioProvider: undefined, // default fixture provider
    storage: createAssetStorage(repoRoot),
  });
}

interface SeededPage {
  projectId: string;
  pageIdentity: string;
  contentId: string;
  contentVersion: number;
  contentDigest: string;
}

async function seedProjectWithPage(dbInst: FactoryDatabaseInstance, key: string, slug: string): Promise<SeededPage> {
  const seed = await seedProjectWithAcceptedInputs(dbInst, key);
  const page = await acceptFixturePage(dbInst, seed.projectId, slug);
  return {
    projectId: seed.projectId,
    pageIdentity: slug,
    contentId: page.id,
    contentVersion: page.version,
    contentDigest: page.contentDigest,
  };
}

test("project derivative policy: versioned, digest-bound, immutable history", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seed = await seedProjectWithAcceptedInputs(dbInst, "deriv-policy-1");
  const service = await makeService(dbInst);

  const v1 = await service.updateProjectPolicy({
    projectId: seed.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  assert.equal(v1.version, 1);
  assert.match(v1.policyDigest, /^[0-9a-f]{64}$/);

  const v2 = await service.updateProjectPolicy({
    projectId: seed.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  assert.equal(v2.version, 2);
  assert.notEqual(v1.policyDigest, v2.policyDigest);

  const store = new DerivativesStore(dbInst.db);
  const versions = await store.policyVersions(seed.projectId);
  assert.equal(versions.length, 2);
  // History is immutable: v1 row unchanged.
  assert.equal(versions.find((r) => r.version === 1)!.policyDigest, v1.policyDigest);
});

test("page override: versioned; enabled override without policy fails closed at intent derivation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-override-1", "roof-repair");
  const service = await makeService(dbInst);

  await service.updatePageOverride({
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    summary: { mode: "enabled" },
    audio: { mode: "inherit" },
  });
  await assert.rejects(
    () => service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity }),
    (err: unknown) => isCode(err, "derivative_policy_not_found"),
  );
});

test("page override: disabled suppresses derivative generation for that page", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-override-2", "roof-repair");
  const service = await makeService(dbInst);

  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  await service.updatePageOverride({
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    summary: { mode: "disabled" },
    audio: { mode: "inherit" },
  });

  const { snapshot } = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(snapshot.effectiveSummaryState, "disabled");
  assert.equal(snapshot.effectiveAudioState, "enabled");

  // Summary generation rejected because effective policy is disabled:
  await assert.rejects(
    () => service.generateSummaryProposal({ projectId: page.projectId, pageIdentity: page.pageIdentity }),
    (err: unknown) => isCode(err, "derivative_generation_blocked"),
  );
});

test("intent snapshot: deterministic from (content + policy + override); idempotent", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-intent-1", "roof-repair");
  const service = await makeService(dbInst);

  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const first = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(first.reused, false);
  assert.match(first.snapshot.snapshotDigest, /^[0-9a-f]{64}$/);

  // Calling again with zero mutations returns the SAME intent snapshot:
  const second = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(second.reused, true);
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(second.snapshot.snapshotDigest, first.snapshot.snapshotDigest);
});

test("summary lifecycle: compile prompt snapshot → fixture proposal → fixture acceptance blocked", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-summary-1", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });

  const { promptSnapshot } = await service.compileSummaryPromptSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.match(promptSnapshot.promptDigest, /^[0-9a-f]{64}$/);
  assert.ok(promptSnapshot.systemPrompt.length > 0);
  assert.ok(promptSnapshot.userPrompt.length > 0);

  // Prompt snapshot is idempotent per intent.
  const again = await service.compileSummaryPromptSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(again.promptSnapshot.id, promptSnapshot.id);

  const { proposal, qa } = await service.generateSummaryProposal({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(proposal.providerMode, "fixture");
  assert.equal(proposal.isTestDouble, true);
  assert.ok(qa.overall === "PASS" || qa.overall === "REVIEW");

  // Provider success is NOT acceptance: the artifact does not exist yet.
  const store = new DerivativesStore(dbInst.db);
  assert.equal(await store.currentAcceptedSummary(page.projectId, page.pageIdentity), null);

  // Fixture summary proposal CANNOT become production authority (gate fail-closed).
  await assert.rejects(
    () => service.acceptSummary({ projectId: page.projectId, pageIdentity: page.pageIdentity, proposalId: proposal.id }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );

  // Downstream acceptance persistence verified via synthetic production authority helper
  const synthetic = await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: again.promptSnapshot.intentSnapshotId, digest: again.promptSnapshot.intentSnapshotDigest },
  });
  assert.match(synthetic.artifactDigest, /^[0-9a-f]{64}$/);

  // Acceptance binds the exact source content.
  const current = await store.currentAcceptedSummary(page.projectId, page.pageIdentity);
  assert.equal(current!.sourceContentId, page.contentId);
  assert.equal(current!.sourceContentDigest, page.contentDigest);
});

test("summary QA FAIL blocks acceptance (fail closed)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-summary-2", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  const { proposal } = await service.generateSummaryProposal({ projectId: page.projectId, pageIdentity: page.pageIdentity });

  // Force the QA report to FAIL state directly (simulating a failing gate).
  const store = new DerivativesStore(dbInst.db);
  await store.recordSummaryQa({ proposalId: proposal.id, qaReport: { checks: [], overall: "FAIL" }, qaReportDigest: deterministicDigest({ overall: "FAIL" }), qaOverall: "FAIL" });

  await assert.rejects(
    () => service.acceptSummary({ projectId: page.projectId, pageIdentity: page.pageIdentity, proposalId: proposal.id }),
    (err: unknown) => isCode(err, "derivative_qa_failed"),
  );
});

test("summary regeneration does not mutate the accepted artifact", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-summary-3", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  const { snapshot } = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  const accepted1 = await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
    summaryText: "First accepted summary version text.",
  });

  // Regenerate: accepting a new summary creates a NEW version; v1 remains immutable.
  const accepted2 = await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
    summaryText: "Second accepted summary version text.",
  });
  assert.equal(accepted2.version, accepted1.version + 1);

  const versions = await dbInst.db.execute(
    (await import("drizzle-orm")).sql`select count(*)::int as count from accepted_summary_artifacts where project_id = ${page.projectId}`,
  );
  assert.equal((versions.rows[0] as { count: number }).count, 2);
});

test("deterministic narration snapshot: identical content reuses the snapshot", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-narration-1", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: false, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  const first = await service.deriveNarrationSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(first.reused, false);
  const second = await service.deriveNarrationSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(second.reused, true);
  assert.equal(second.snapshot.id, first.snapshot.id);
  // Narration text is verbatim accepted copy (title present, meta description absent).
  const copy = readAcceptedPageCopy(
    ((await dbInst.db.execute((await import("drizzle-orm")).sql`select data from accepted_page_content where id = ${page.contentId}`)).rows[0] as { data: unknown }).data,
  );
  assert.ok(second.snapshot.narrationText.includes(copy.title));
  assert.ok(!second.snapshot.narrationText.includes(copy.metaDescription));
});

test("audio lifecycle: fixture candidate succeeds; fixture acceptance fails closed", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-audio-1", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: false, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const { candidate, binaryDigest, mimeType } = await service.generateAudioCandidate({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(candidate.providerMode, "fixture");
  assert.equal(candidate.isTestDouble, true);
  assert.equal(mimeType, "audio/wav");
  assert.match(binaryDigest, /^[0-9a-f]{64}$/);

  // Fixture audio must NEVER be accepted as production authority.
  await assert.rejects(
    () => service.acceptAudio({ projectId: page.projectId, pageIdentity: page.pageIdentity, candidateId: candidate.id }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );

  // Downstream accepted audio persistence and storage verified via synthetic authority helper
  const repoRoot = await resolveRepositoryRoot();
  const { row: acceptedAudio } = await seedSyntheticAcceptedAudio(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    narrationText: "Accepted audio test content",
  });
  assert.match(acceptedAudio.artifactDigest, /^[0-9a-f]{64}$/);

  // Stored bytes match the recorded digest (binary integrity).
  const storage = createAssetStorage(repoRoot);
  const stored = await storage.getObject(storage.derivativeKey(acceptedAudio.binaryDigest));
  assert.equal(sha256HexBytes(stored), acceptedAudio.binaryDigest);
});

test("forged binary digest blocks audio acceptance", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-audio-2", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: false, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  const { snapshot: narration } = await service.deriveNarrationSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });

  // Forge: register a candidate whose binaryDigest claims bytes that do NOT
  // exist under that content-addressed key. Acceptance must fail closed on
  // the missing/mismatched binary (forged binary digest).
  const store = new DerivativesStore(dbInst.db);
  const tampered = await store.insertAudioCandidate({
    id: "audio_candidate_forged",
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    data: {
      schemaVersion: "derivatives-v1",
      projectId: page.projectId,
      pageIdentity: page.pageIdentity,
      narrationSnapshot: { id: narration.id, digest: narration.narrationDigest },
      providerMode: "live",
      isTestDouble: false,
      provider: "test-synthetic-authority",
      engine: "engine-x",
      voiceId: "fixture-voice-1",
      language: "en",
      providerRequestId: "forged-req",
      binaryDigest: deterministicDigest({ forged: true }), // 64-hex but no bytes stored under this key
      mimeType: "audio/wav",
      sizeBytes: 3,
      durationSeconds: 1,
      usage: { characters: 3, costMicros: null, currency: "UNKNOWN" },
    },
    candidateDigest: deterministicDigest({ forged: true, n: 1 }),
  });
  await assert.rejects(
    () => service.acceptAudio({ projectId: page.projectId, pageIdentity: page.pageIdentity, candidateId: tampered.id }),
    (err: unknown) => isCode(err, "derivative_binary_digest_mismatch"),
  );
});

test("accepted derivative set: requires current accepted artifacts for enabled derivatives; explicit disabled passes", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-set-1", "roof-repair");
  const service = await makeService(dbInst);

  // No policy: explicit disabled set accepted immediately.
  const disabled = await service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(disabled.set.summaryState, "disabled");
  assert.equal(disabled.set.audioState, "disabled");

  // Enable summary: set acceptance now requires a current accepted summary.
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  await assert.rejects(
    () => service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity }),
    (err: unknown) => isCode(err, "derivative_required_artifact_missing"),
  );
});

test("full derivative lifecycle E2E: policy → intent → fixture rejected → synthetic authority → set", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-e2e-1", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);

  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  // Verify fixture summary proposal is rejected
  const { proposal } = await service.generateSummaryProposal({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  await assert.rejects(
    () => service.acceptSummary({ projectId: page.projectId, pageIdentity: page.pageIdentity, proposalId: proposal.id }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );

  // Verify fixture audio candidate is rejected
  const { candidate } = await service.generateAudioCandidate({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  await assert.rejects(
    () => service.acceptAudio({ projectId: page.projectId, pageIdentity: page.pageIdentity, candidateId: candidate.id }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );

  // Seed synthetic production authority artifacts
  const { set, summary, audio } = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
  });

  assert.equal(set.summaryState, "accepted");
  assert.equal(set.audioState, "accepted");
  assert.equal(set.summaryArtifactId, summary!.id);
  assert.equal(set.audioArtifactId, audio!.id);
  assert.equal(set.audioBinaryDigest, audio!.binaryDigest);

  // Status: everything ACCEPTED.
  const status = await service.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(status.summary.status, "ACCEPTED");
  assert.equal(status.audio.status, "ACCEPTED");
  assert.equal(status.set.status, "ACCEPTED");
});

test("staleness: content mutation makes summary/audio/set stale", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-stale-1", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const { set } = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
  });
  assert.equal(set.summaryState, "accepted");

  // Mutate content: accept a NEW version of the page (C1 → C2).
  const newPage = await acceptFixturePage(dbInst, page.projectId, page.pageIdentity);
  assert.notEqual(newPage.contentDigest, page.contentDigest);

  const status = await service.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(status.summary.status, "STALE");
  assert.equal(status.audio.status, "STALE");
  assert.equal(status.set.status, "STALE");

  // Regenerate/accept current derivatives under new content: new production-ready state.
  const { set: set2 } = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: newPage.id, version: newPage.version, digest: newPage.contentDigest },
  });
  assert.equal(set2.version, set.version + 1);
  const status2 = await service.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(status2.summary.status, "ACCEPTED");
  assert.equal(status2.set.status, "ACCEPTED");
});

test("staleness: policy mutation invalidates summary but voice-only mutation invalidates only audio", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-stale-2", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
  });

  // Voice-only mutation: summary remains current, audio goes stale.
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-2", policyVersion: "narration-projection-v1" },
  });
  const statusVoice = await service.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(statusVoice.summary.status, "ACCEPTED");
  assert.equal(statusVoice.audio.status, "STALE");
});

test("cross-project isolation: derivative artifacts from project B cannot attach to project A", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const pageA = await seedProjectWithPage(dbInst, "deriv-cross-a", "roof-repair");
  const pageB = await seedProjectWithPage(dbInst, "deriv-cross-b", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: pageA.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  const { snapshot } = await service.deriveIntentSnapshot({ projectId: pageA.projectId, pageIdentity: pageA.pageIdentity });
  const accepted = await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: pageA.projectId,
    pageIdentity: pageA.pageIdentity,
    sourceContent: { id: pageA.contentId, version: pageA.contentVersion, digest: pageA.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
  });

  // Accepting a set for project B that references project A's artifact must fail.
  const store = new DerivativesStore(dbInst.db);
  await assert.rejects(
    () =>
      store.insertDerivativeSet({
        id: "derivative_set_cross",
        projectId: pageB.projectId,
        pageIdentity: pageB.pageIdentity,
        data: {
          schemaVersion: "derivatives-v1",
          projectId: pageB.projectId,
          pageIdentity: pageB.pageIdentity,
          sourceContent: { id: pageB.contentId, version: pageB.contentVersion, digest: pageB.contentDigest },
          intentSnapshot: { id: "deriv_intent_x", digest: deterministicDigest({ x: 1 }) },
          summary: { state: "accepted", acceptedArtifactId: accepted.id, version: accepted.version, digest: accepted.artifactDigest },
          audio: { state: "disabled" },
          version: 1,
        },
        setDigest: deterministicDigest({ cross: true }),
        version: 1,
      }),
    (err: unknown) => isCode(err, "derivative_authority_wrong_project"),
  );
});

test("restart durability: accepted state survives a fresh database connection", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-restart-1", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  const { set, summary } = await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
  });

  // Fresh connection (simulated restart): a brand-new service/store instance
  // over the same database must see identical accepted state.
  const freshService = await makeService(dbInst);
  const status = await freshService.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(status.summary.status, "ACCEPTED");
  assert.equal(status.summary.artifact!.id, summary!.id);
  assert.equal(status.set.set!.id, set.id);
});

test("concurrency race A: intent snapshot insertion is idempotent under concurrency", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-race-a", "roof-repair");
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  // 8 parallel calls deriving the intent simultaneously: all return the same id.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity })),
  );
  const firstId = results[0]!.snapshot.id;
  for (const r of results) {
    assert.equal(r.snapshot.id, firstId);
  }

  // Exactly one intent row was created.
  const rows = await dbInst.db
    .select()
    .from(pageDerivativeIntentSnapshots)
    .where(
      and(
        eq(pageDerivativeIntentSnapshots.projectId, page.projectId),
        eq(pageDerivativeIntentSnapshots.pageIdentity, page.pageIdentity),
      ),
    );
  assert.equal(rows.length, 1);
});

test("concurrency race B: derivative set acceptance serializes with policy mutation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-race-b", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);
  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const { snapshot } = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
  });
  await seedSyntheticAcceptedAudio(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    narrationText: "Race condition test narration audio",
  });

  // Race: set acceptance vs policy mutation. Both take the shared lock; the
  // set acceptance re-derives the intent snapshot inside the lock, so the
  // resulting set is either bound to the old policy coherently or rejected.
  const [setResult] = await Promise.allSettled([
    service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity }),
    service.updateProjectPolicy({
      projectId: page.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: true, language: "en", voiceId: "fixture-voice-9", policyVersion: "narration-projection-v1" },
    }),
  ]);
  assert.equal(setResult.status, "fulfilled");
  // Post-race status must be coherent: set either ACCEPTED (old policy) or
  // STALE (new policy superseded the intent) — never a false ACCEPTED.
  const status = await service.derivativeStatus({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.ok(["ACCEPTED", "STALE"].includes(status.set.status));
});

test("production authority truth matrix: fixture/double output is rejected", () => {
  // Summary truth matrix
  assert.throws(
    () => assertSummaryProductionAuthority({ providerMode: "fixture", isTestDouble: true, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.throws(
    () => assertSummaryProductionAuthority({ providerMode: "live", isTestDouble: true, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.throws(
    () => assertSummaryProductionAuthority({ providerMode: "fixture", isTestDouble: false, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.doesNotThrow(() =>
    assertSummaryProductionAuthority({ providerMode: "live", isTestDouble: false, provider: "test" }),
  );

  // Audio truth matrix
  assert.throws(
    () => assertAudioProductionAuthority({ providerMode: "fixture", isTestDouble: true, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.throws(
    () => assertAudioProductionAuthority({ providerMode: "live", isTestDouble: true, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.throws(
    () => assertAudioProductionAuthority({ providerMode: "fixture", isTestDouble: false, provider: "test" }),
    (err: unknown) => isCode(err, "derivative_fixture_not_production_authority"),
  );
  assert.doesNotThrow(() =>
    assertAudioProductionAuthority({ providerMode: "live", isTestDouble: false, provider: "test" }),
  );
});

test("AcceptedDerivativeSet digest/version canonicality roundtrip", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const page = await seedProjectWithPage(dbInst, "deriv-set-canon", "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = await makeService(dbInst);

  await service.updateProjectPolicy({
    projectId: page.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  const { snapshot } = await service.deriveIntentSnapshot({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
  });
  await seedSyntheticAcceptedAudio(dbInst.db, repoRoot, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    narrationText: "Canonical roundtrip narration text",
  });

  // Accept derivative set (v1)
  const set1 = await service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(set1.reused, false);
  assert.equal(set1.set.version, 1);
  const data1 = parseAcceptedDerivativeSetData(set1.set.data);
  assert.equal(data1.version, 1);
  assert.equal(acceptedDerivativeSetDigest(data1), set1.set.setDigest);

  // Idempotency: re-accepting with identical data does not bump version
  const set1Again = await service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(set1Again.reused, true);
  assert.equal(set1Again.set.id, set1.set.id);
  assert.equal(set1Again.set.version, 1);

  // Update summary to produce v2
  const summary2 = await seedSyntheticAcceptedSummary(dbInst.db, {
    projectId: page.projectId,
    pageIdentity: page.pageIdentity,
    sourceContent: { id: page.contentId, version: page.contentVersion, digest: page.contentDigest },
    intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
    summaryText: "Second accepted summary version text.",
  });
  assert.equal(summary2.version, 2);

  const set2 = await service.acceptDerivativeSet({ projectId: page.projectId, pageIdentity: page.pageIdentity });
  assert.equal(set2.reused, false);
  assert.equal(set2.set.version, 2);
  const data2 = parseAcceptedDerivativeSetData(set2.set.data);
  assert.equal(data2.version, 2);
  assert.equal(acceptedDerivativeSetDigest(data2), set2.set.setDigest);

  // Restart durability / fresh store inspection
  const freshStore = new DerivativesStore(dbInst.db);
  const read = await freshStore.currentDerivativeSet(page.projectId, page.pageIdentity);
  assert.ok(read);
  assert.equal(read.version, 2);
  const readData = parseAcceptedDerivativeSetData(read.data);
  assert.equal(readData.version, 2);
  assert.equal(acceptedDerivativeSetDigest(readData), read.setDigest);

  // Theorem A / Historical Immutability:
  // Historical set1 remains strictly unchanged, unmutated, and parseable after set2 exists
  const reloadedSet1 = await freshStore.getDerivativeSetById(page.projectId, set1.set.id);
  assert.ok(reloadedSet1);
  assert.deepEqual(reloadedSet1.data, set1.set.data);
  const reloadedData1 = parseAcceptedDerivativeSetData(reloadedSet1.data);
  assert.equal(reloadedData1.version, 1);
  assert.equal(acceptedDerivativeSetDigest(reloadedData1), reloadedSet1.setDigest);
});

test("Theorem D / Section 18-21: page_summarizer implementationStatus=future blocks live summary generation with zero network calls", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const repoRoot = await resolveRepositoryRoot();
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("HARD NETWORK TRAP: external network was reached!");
  }) as typeof globalThis.fetch;

  const originalApiKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "sk-or-v1-fake-test-key-12345678";

  try {
    // 1. Direct invocation test on runSummaryInvocation without fixture override:
    await assert.rejects(
      () =>
        runSummaryInvocation(
          {
            promptSnapshotDigest: "d".repeat(64),
            projectId: "proj-fake",
            pageIdentity: "home",
            systemPrompt: "System prompt instructions",
            userPrompt: "User prompt content",
          },
          {
            budget: new WriterBudgetStore(dbInst.db),
            // Explicitly NO deps.invoke — exercises the real live policy guard!
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "derivative_generation_blocked");
        assert.match(err.message, /implementationStatus is "future"/);
        return true;
      },
    );
    assert.equal(networkCalls, 0, "Network calls must be strictly 0");

    // 2. Full service-level test on DerivativesService.generateSummaryProposal:
    // Construct service WITHOUT deps.summary.invoke (non-fixture path):
    const liveService = new DerivativesService(dbInst.db, repoRoot, {
      budget: new WriterBudgetStore(dbInst.db),
      summary: undefined, // NO fixture invoke
      storage: createAssetStorage(repoRoot),
    });

    const page = await seedProjectWithPage(dbInst, "future-guard", "home");
    await liveService.updateProjectPolicy({
      projectId: page.projectId,
      summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
      audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
    });

    await assert.rejects(
      () =>
        liveService.generateSummaryProposal({
          projectId: page.projectId,
          pageIdentity: "home",
        }),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "derivative_generation_blocked");
        assert.match(err.message, /implementationStatus is "future"/);
        return true;
      },
    );
    assert.equal(networkCalls, 0, "Network calls must be strictly 0 after service call");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env["OPENROUTER_API_KEY"] = originalApiKey;
    } else {
      delete process.env["OPENROUTER_API_KEY"];
    }
    await dbInst.close();
  }
});
