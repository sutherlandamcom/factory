import assert from "node:assert/strict";
import test from "node:test";
import { DerivativesService } from "../../src/derivatives/service.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage } from "../fixtures/accepted-page.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { FactoryError } from "../../src/executor/errors.js";
import { seedSyntheticProductionDerivativeSet } from "./run10-test-helpers.js";
import { FixtureAudioNarrationProvider } from "../../src/derivatives/audio-provider.js";
import type { AudioNarrationProvider, AudioNarrationRequest, AudioNarrationResult } from "../../src/derivatives/audio-provider.js";

/**
 * RUN 10 PROVIDER ECONOMICS + ZERO VISITOR PROVIDER CALLS.
 *
 * Core Run 10 economic invariant:
 *   - first derivative generation: exactly one provider operation each;
 *   - ordinary page render / site rebuild: ZERO provider calls;
 *   - visitor page load / 100 visitor interactions: ZERO provider calls.
 *
 * Proven with provider spy counters around the application service: the
 * service exposes no code path from rendering or visitor consumption to a
 * provider; only the explicit generate* operations invoke the provider.
 */

class CountingAudioProvider implements AudioNarrationProvider {
  readonly providerId = "counting-fixture-tts";
  readonly providerMode = "fixture" as const;
  readonly isTestDouble = true as const;
  calls = 0;
  preflightCalls = 0;
  private readonly inner = new FixtureAudioNarrationProvider();

  async preflight(): Promise<void> {
    this.preflightCalls++;
  }

  async synthesize(request: AudioNarrationRequest): Promise<AudioNarrationResult> {
    this.calls++;
    return this.inner.synthesize(request);
  }
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

test("provider economics: one provider op per generation; zero on re-derivation, status, and set acceptance", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seed = await seedProjectWithAcceptedInputs(dbInst, "deriv-econ-1");
  const page = await acceptFixturePage(dbInst, seed.projectId, "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const audio = new CountingAudioProvider();
  let summaryCalls = 0;
  const countingInvoke = async (request: { prompt: string }) => {
    summaryCalls++;
    return fixtureSummaryInvoke(request);
  };
  const service = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: countingInvoke as never, dailyLimitUsd: 10 },
    audioProvider: audio,
    storage: createAssetStorage(repoRoot),
  });

  await service.updateProjectPolicy({
    projectId: seed.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });

  // First generation: exactly one provider operation each.
  const { proposal } = await service.generateSummaryProposal({ projectId: seed.projectId, pageIdentity: page.slug });
  assert.equal(summaryCalls, 1, "summary generation must be exactly one provider call");
  const { candidate } = await service.generateAudioCandidate({ projectId: seed.projectId, pageIdentity: page.slug });
  assert.equal(audio.calls, 1, "audio generation must be exactly one provider call");

  // Summary fixture cannot be accepted as production authority:
  await assert.rejects(
    () => service.acceptSummary({ projectId: seed.projectId, pageIdentity: page.slug, proposalId: proposal.id }),
    (err: unknown) =>
      err instanceof FactoryError && err.code === "derivative_fixture_not_production_authority",
  );
  assert.equal(summaryCalls, 1, "acceptance rejection must not invoke the provider");

  // Audio fixture cannot be accepted as production authority:
  await assert.rejects(
    () => service.acceptAudio({ projectId: seed.projectId, pageIdentity: page.slug, candidateId: candidate.id }),
    (err: unknown) =>
      err instanceof FactoryError &&
      (err.code === "derivative_fixture_not_production_authority" ||
        err.code === "derivative_audio_fixture_not_production_authority"),
  );
  assert.equal(audio.calls, 1, "audio rejection must not invoke the provider");

  // Production derivative set rejects missing accepted audio (since audio fixture was rejected):
  await assert.rejects(
    () => service.acceptDerivativeSet({ projectId: seed.projectId, pageIdentity: page.slug }),
    (err: unknown) =>
      err instanceof FactoryError &&
      (err.code === "derivative_required_artifact_missing" ||
        err.code === "derivative_fixture_not_production_authority" ||
        err.code === "derivative_audio_fixture_not_production_authority"),
  );
  assert.equal(summaryCalls, 1, "acceptance rejection must not invoke the provider");
  assert.equal(audio.calls, 1, "acceptance rejection must not invoke the provider");

  // Seed synthetic accepted authority for downstream status and visitor read testing:
  await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: seed.projectId,
    pageIdentity: page.slug,
    sourceContent: { id: page.id, version: page.version, digest: page.contentDigest },
  });

  // Idempotent re-derivation of intent + narration: zero provider calls.
  await service.deriveIntentSnapshot({ projectId: seed.projectId, pageIdentity: page.slug });
  await service.deriveNarrationSnapshot({ projectId: seed.projectId, pageIdentity: page.slug });
  assert.equal(summaryCalls, 1);
  assert.equal(audio.calls, 1);

  // Status inspection (what the Dashboard polls): zero provider calls.
  for (let i = 0; i < 10; i++) {
    await service.derivativeStatus({ projectId: seed.projectId, pageIdentity: page.slug });
  }
  assert.equal(summaryCalls, 1, "status polling must never invoke the provider");
  assert.equal(audio.calls, 1, "status polling must never invoke the provider");
});

test("zero visitor provider calls: 100 visitor interactions trigger zero provider operations", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seed = await seedProjectWithAcceptedInputs(dbInst, "deriv-visitor-1");
  const page = await acceptFixturePage(dbInst, seed.projectId, "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const audio = new CountingAudioProvider();
  let summaryCalls = 0;
  const countingInvoke = async (request: { prompt: string }) => {
    summaryCalls++;
    return fixtureSummaryInvoke(request);
  };
  const service = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: countingInvoke as never, dailyLimitUsd: 10 },
    audioProvider: audio,
    storage: createAssetStorage(repoRoot),
  });
  await service.updateProjectPolicy({
    projectId: seed.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  await service.generateSummaryProposal({ projectId: seed.projectId, pageIdentity: page.slug });
  await service.generateAudioCandidate({ projectId: seed.projectId, pageIdentity: page.slug });
  await seedSyntheticProductionDerivativeSet(dbInst.db, repoRoot, {
    projectId: seed.projectId,
    pageIdentity: page.slug,
    sourceContent: { id: page.id, version: page.version, digest: page.contentDigest },
  });
  const baselineSummary = summaryCalls;
  const baselineAudio = audio.calls;

  // 100 visitor summary reveals + 100 audio play/control interactions. The
  // visitor surface is the static Astro page: it consumes the manifest copy
  // of the accepted artifacts and the delivered audio bytes. Prove the
  // invariant at the service boundary: the ONLY operations that reach a
  // provider are generateSummaryProposal/generateAudioCandidate — no
  // visitor-shaped operation exists on the service at all.
  const serviceProto = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
  const providerTouching = serviceProto.filter((name) => name.toLowerCase().includes("generate"));
  assert.deepEqual(providerTouching.sort(), ["generateAudioCandidate", "generateSummaryProposal"]);

  // Simulate 100 visitor reads of the accepted derivative state (what the
  // static page renders): derivativeStatus + narration read. Zero provider calls.
  for (let i = 0; i < 100; i++) {
    await service.derivativeStatus({ projectId: seed.projectId, pageIdentity: page.slug });
    await service.deriveNarrationSnapshot({ projectId: seed.projectId, pageIdentity: page.slug });
  }
  assert.equal(summaryCalls, baselineSummary, "100 visitor interactions must cause zero summary provider calls");
  assert.equal(audio.calls, baselineAudio, "100 visitor interactions must cause zero audio provider calls");
});

test("cost telemetry: fixture proposals record UNKNOWN cost (never zero) and usage tokens", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const seed = await seedProjectWithAcceptedInputs(dbInst, "deriv-cost-1");
  const page = await acceptFixturePage(dbInst, seed.projectId, "roof-repair");
  const repoRoot = await resolveRepositoryRoot();
  const service = new DerivativesService(dbInst.db, repoRoot, {
    budget: new WriterBudgetStore(dbInst.db),
    summary: { invoke: fixtureSummaryInvoke as never, dailyLimitUsd: 10 },
    storage: createAssetStorage(repoRoot),
  });
  await service.updateProjectPolicy({
    projectId: seed.projectId,
    summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
    audio: { enabled: false, language: "en", policyVersion: "narration-projection-v1" },
  });
  const { proposal } = await service.generateSummaryProposal({ projectId: seed.projectId, pageIdentity: page.slug });
  // Fixture double supplies usage tokens; cost is UNKNOWN (null), never 0.
  assert.equal(proposal.usagePromptTokens, 10);
  assert.equal(proposal.usageCompletionTokens, 20);
  assert.equal(proposal.usageCostMicros, null);
  assert.equal(proposal.usageCurrency, "UNKNOWN");
});
