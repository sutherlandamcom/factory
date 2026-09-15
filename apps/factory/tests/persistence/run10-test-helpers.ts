import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FactoryDb } from "../../src/persistence/db.js";
import {
  type AcceptedSummaryArtifactRecord,
  type AcceptedAudioArtifactRecord,
  type AcceptedDerivativeSetRecord,
  narrationTextSnapshots,
  summaryPromptSnapshots,
} from "../../src/persistence/schema.js";
import {
  type AcceptedSummaryArtifactData,
  type AcceptedAudioArtifactData,
  type AcceptedDerivativeSetData,
  type SummaryPromptSnapshotData,
  type SummaryProposalData,
  type NarrationTextSnapshotData,
  type AudioCandidateData,
} from "@factory/contracts";
import {
  acceptedSummaryArtifactDigest,
  acceptedAudioArtifactDigest,
  acceptedDerivativeSetDigest,
} from "../../src/derivatives/core.js";
import { deriveCurrentDerivativeIntentAuthority } from "../../src/derivatives/production-verifier.js";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { AUDIO_FIXTURE_ENGINE_ID } from "../../src/derivatives/audio-provider.js";
import { DerivativesStore } from "../../src/derivatives/store.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";

/**
 * TEST-ONLY authority fixtures for Macro Run 10.
 *
 * IMPORTANT GOVERNANCE NOTE:
 * These test doubles seed synthetic authority records directly into the
 * database with live markers solely to test downstream status, lifecycle,
 * manifest compilation, and Astro static build verification in offline CI.
 *
 * They DO NOT prove external provider execution or live TTS quality.
 * LIVE TTS PRODUCTION AUTHORITY IS NOT YET PROVEN.
 */

export async function seedSyntheticAcceptedSummary(
  db: FactoryDb,
  options: {
    projectId: string;
    pageIdentity: string;
    sourceContent: { id: string; version: number; digest: string };
    intentSnapshot: { id: string; digest: string };
    summaryText?: string;
    language?: string;
  },
): Promise<AcceptedSummaryArtifactRecord> {
  const store = new DerivativesStore(db);
  const existingPrompt = await store.findPromptSnapshotByIntent(options.intentSnapshot.id);
  let promptRow = existingPrompt;
  if (!promptRow) {
    const promptId = `prompt_${randomUUID()}`;
    const promptData: SummaryPromptSnapshotData = {
      schemaVersion: "derivatives-v1",
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      intentSnapshot: options.intentSnapshot,
      acceptedContent: options.sourceContent,
      summaryPolicyVersion: "summary-instructions-v1",
      language: (options.language ?? "en") as "en",
      provider: "test-synthetic-authority",
      model: "test-synthetic-authority",
      systemPrompt: "System prompt for test",
      userPrompt: "User prompt for test",
      maxOutputTokens: 500,
    };
    const promptDigest = deterministicDigest(promptData);
    promptRow = await store.insertPromptSnapshot({
      id: promptId,
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      data: promptData,
      promptDigest,
    });
  }

  const summaryText =
    options.summaryText ??
    "This is a verified test summary produced by the synthetic test authority fixture for offline verification.";
  const proposalId = `proposal_${randomUUID()}`;
  const proposalData: SummaryProposalData = {
    schemaVersion: "derivatives-v1",
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    promptSnapshot: { id: promptRow.id, digest: promptRow.promptDigest },
    acceptedContent: options.sourceContent,
    providerMode: "live",
    isTestDouble: false,
    provider: "test-synthetic-authority",
    model: "test-synthetic-authority",
    summaryText,
    providerRequestId: `req_${randomUUID()}`,
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      costMicros: null,
      currency: "UNKNOWN",
    },
  };
  const proposalDigest = deterministicDigest(proposalData);
  const proposalRow = await store.insertSummaryProposal({
    id: proposalId,
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    data: proposalData,
    proposalDigest,
  });

  const current = await store.currentAcceptedSummary(options.projectId, options.pageIdentity);
  const version = (current?.version ?? 0) + 1;

  const qaReportDigest = deterministicDigest({ qaPassed: true, proposalId: proposalRow.id });
  const acceptedData: AcceptedSummaryArtifactData = {
    schemaVersion: "derivatives-v1",
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    sourceContent: options.sourceContent,
    intentSnapshot: options.intentSnapshot,
    promptSnapshot: { id: promptRow.id, digest: promptRow.promptDigest },
    providerMode: "live",
    isTestDouble: false, // TEST-ONLY synthetic authority
    provider: "test-synthetic-authority",
    model: "test-synthetic-authority",
    language: (options.language ?? "en") as "en",
    proposalDigest: proposalRow.proposalDigest,
    summaryText,
    qaReportDigest,
    qaOverall: "PASS",
  };
  const artifactDigest = acceptedSummaryArtifactDigest(acceptedData);
  return await store.insertAcceptedSummary({
    id: `summary_accepted_${randomUUID()}`,
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    data: acceptedData,
    proposalId: proposalRow.id,
    artifactDigest,
    version,
  });
}

/** Minimal deterministic PCM WAV renderer (44-byte header + mono samples) */
function renderSyntheticWavBytes(seedDigest: string, charCount: number): Uint8Array {
  const sampleRate = 22050;
  const durationSec = Math.max(1, Math.min(60, Math.round(charCount / 14)));
  const sampleCount = sampleRate * durationSec;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let state = 0;
  for (let i = 0; i < seedDigest.length; i++) state = (state * 31 + seedDigest.charCodeAt(i)) >>> 0;
  for (let i = 0; i < sampleCount; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    const amplitude = 2000 + (state % 4000);
    view.setInt16(44 + i * 2, amplitude % 32768 - 16384 > 0 ? amplitude : -amplitude, true);
  }
  return new Uint8Array(buffer);
}

export async function seedSyntheticAcceptedAudio(
  db: FactoryDb,
  repoRoot: string,
  options: {
    projectId: string;
    pageIdentity: string;
    sourceContent: { id: string; version: number; digest: string };
    narrationText?: string;
    voiceId?: string;
    mimeType?: "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/mp4";
    durationSeconds?: number;
  },
): Promise<{ row: AcceptedAudioArtifactRecord; bytes: Uint8Array }> {
  const store = new DerivativesStore(db);
  const narrationText = options.narrationText ?? "Test narration text for synthetic audio.";
  let narrationRow: { id: string; narrationDigest: string } | null = null;
  const existingNarrations = await db
    .select()
    .from(narrationTextSnapshots)
    .where(
      and(
        eq(narrationTextSnapshots.projectId, options.projectId),
        eq(narrationTextSnapshots.pageIdentity, options.pageIdentity),
        eq(narrationTextSnapshots.sourceContentId, options.sourceContent.id),
        eq(narrationTextSnapshots.sourceContentVersion, options.sourceContent.version),
        eq(narrationTextSnapshots.narrationPolicyVersion, "narration-projection-v1"),
        eq(narrationTextSnapshots.language, "en"),
      ),
    )
    .limit(1);
  if (existingNarrations[0]) {
    narrationRow = existingNarrations[0];
  } else {
    const narrationSnapshotId = `narration_${randomUUID()}`;
    const narrationData: NarrationTextSnapshotData = {
      schemaVersion: "derivatives-v1",
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      sourceContent: options.sourceContent,
      narrationPolicyVersion: "narration-projection-v1",
      language: "en",
      narrationText,
    };
    const narrationDigest = deterministicDigest(narrationData);
    narrationRow = await store.insertNarrationSnapshot({
      id: narrationSnapshotId,
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      data: narrationData,
      narrationDigest,
    });
  }

  const bytes = renderSyntheticWavBytes(narrationRow.narrationDigest, narrationText.length);
  const binaryDigest = sha256HexBytes(bytes);

  const storage = createAssetStorage(repoRoot);
  await storage.putObject(storage.derivativeKey(binaryDigest), bytes);

  const voiceId = (options.voiceId ?? "fixture-voice-1") as "fixture-voice-1";
  const mimeType = options.mimeType ?? "audio/wav";
  const durationSeconds = options.durationSeconds ?? 10;

  const candidateId = `audio_cand_${randomUUID()}`;
  const candidateData: AudioCandidateData = {
    schemaVersion: "derivatives-v1",
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    narrationSnapshot: { id: narrationRow.id, digest: narrationRow.narrationDigest },
    providerMode: "live",
    isTestDouble: false, // TEST-ONLY synthetic authority
    provider: "test-synthetic-authority",
    engine: AUDIO_FIXTURE_ENGINE_ID,
    voiceId,
    language: "en",
    providerRequestId: `test_req_${randomUUID()}`,
    binaryDigest,
    mimeType,
    sizeBytes: bytes.byteLength,
    durationSeconds,
    usage: {
      characters: narrationText.length,
      costMicros: null,
      currency: "UNKNOWN",
    },
  };
  const candidateDigest = deterministicDigest(candidateData);
  const candidateRow = await store.insertAudioCandidate({
    id: candidateId,
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    data: candidateData,
    candidateDigest,
  });

  const current = await store.currentAcceptedAudio(options.projectId, options.pageIdentity);
  const version = (current?.version ?? 0) + 1;

  const acceptedData: AcceptedAudioArtifactData = {
    schemaVersion: "derivatives-v1",
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    sourceContent: options.sourceContent,
    narrationSnapshot: { id: narrationRow.id, digest: narrationRow.narrationDigest },
    providerMode: "live",
    isTestDouble: false, // TEST-ONLY synthetic authority
    provider: "test-synthetic-authority",
    engine: AUDIO_FIXTURE_ENGINE_ID,
    voiceId,
    language: "en",
    candidateDigest: candidateRow.candidateDigest,
    binaryDigest,
    mimeType,
    sizeBytes: bytes.byteLength,
    durationSeconds,
  };
  const artifactDigest = acceptedAudioArtifactDigest(acceptedData);
  const acceptedRow = await store.insertAcceptedAudio({
    id: `accepted_audio_${randomUUID()}`,
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    data: acceptedData,
    candidateId: candidateRow.id,
    artifactDigest,
    version,
  });

  return { row: acceptedRow, bytes };
}

export async function seedSyntheticProductionDerivativeSet(
  db: FactoryDb,
  repoRoot: string,
  options: {
    projectId: string;
    pageIdentity: string;
    sourceContent: { id: string; version: number; digest: string };
    summaryText?: string;
    voiceId?: string;
  },
): Promise<{
  set: AcceptedDerivativeSetRecord;
  setData: AcceptedDerivativeSetData;
  summary: AcceptedSummaryArtifactRecord | null;
  audio: AcceptedAudioArtifactRecord | null;
}> {
  const derivStore = new DerivativesStore(db);
  const currentIntent = await deriveCurrentDerivativeIntentAuthority(
    derivStore,
    options.projectId,
    options.pageIdentity,
    options.sourceContent,
  );

  // Ensure intent snapshot exists in database
  let intentRow = await derivStore.findIntentSnapshot(
    options.projectId,
    options.pageIdentity,
    currentIntent.digest,
  );
  if (!intentRow) {
    const intentSnapId = `intent_${randomUUID()}`;
    intentRow = await derivStore.insertIntentSnapshot({
      id: intentSnapId,
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      data: currentIntent.data,
      snapshotDigest: currentIntent.digest,
    });
  }

  let summaryRecord: AcceptedSummaryArtifactRecord | null = null;
  if (currentIntent.effective.summary.state === "enabled") {
    summaryRecord = await seedSyntheticAcceptedSummary(db, {
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      sourceContent: options.sourceContent,
      intentSnapshot: { id: intentRow.id, digest: intentRow.snapshotDigest },
      summaryText: options.summaryText,
      language: currentIntent.effective.summary.language,
    });
  }

  let audioRecord: AcceptedAudioArtifactRecord | null = null;
  if (currentIntent.effective.audio.state === "enabled") {
    const seededAudio = await seedSyntheticAcceptedAudio(db, repoRoot, {
      projectId: options.projectId,
      pageIdentity: options.pageIdentity,
      sourceContent: options.sourceContent,
      narrationText: options.summaryText ?? "Test narration text for synthetic audio.",
      voiceId: options.voiceId ?? currentIntent.effective.audio.voiceId ?? "fixture-voice-1",
    });
    audioRecord = seededAudio.row;
  }

  const latest = await derivStore.currentDerivativeSet(options.projectId, options.pageIdentity);
  const nextVersion = (latest?.version ?? 0) + 1;

  const setData: AcceptedDerivativeSetData = {
    schemaVersion: "derivatives-v1",
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    sourceContent: options.sourceContent,
    intentSnapshot: { id: intentRow.id, digest: intentRow.snapshotDigest },
    summary:
      summaryRecord !== null
        ? {
            state: "accepted",
            acceptedArtifactId: summaryRecord.id,
            version: summaryRecord.version,
            digest: summaryRecord.artifactDigest,
          }
        : { state: "disabled" },
    audio:
      audioRecord !== null
        ? {
            state: "accepted",
            acceptedArtifactId: audioRecord.id,
            version: audioRecord.version,
            digest: audioRecord.artifactDigest,
            binaryDigest: audioRecord.binaryDigest,
          }
        : { state: "disabled" },
    version: nextVersion,
  };

  const computedDigest = acceptedDerivativeSetDigest(setData);
  const setRow = await derivStore.insertDerivativeSet({
    id: `derivative_set_${randomUUID()}`,
    projectId: options.projectId,
    pageIdentity: options.pageIdentity,
    data: setData,
    setDigest: computedDigest,
    version: nextVersion,
  });

  return {
    set: setRow,
    setData,
    summary: summaryRecord,
    audio: audioRecord,
  };
}
