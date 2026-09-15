import { randomUUID } from "node:crypto";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * AUDIO NARRATION PROVIDER BOUNDARY — Run 10.
 *
 * NO approved production TTS provider exists in repository policy today
 * (verified: no TTS/narration role, adapter or SDK anywhere). Per the Run 10
 * provider decision rule this boundary therefore ships ONLY:
 *   - the narrow provider interface,
 *   - a deterministic offline fixture provider (explicit providerMode
 *     "fixture" + isTestDouble truth),
 *   - the trusted preflight contract, and
 *   - the production authority gate (fixture output can never become
 *     production authority).
 * LIVE TTS PROVIDER ACTIVATION PENDING PROVIDER POLICY. No TTS SDK is added.
 */

export const NARRATION_POLICY_VERSION = "narration-projection-v1";
export const AUDIO_FIXTURE_PROVIDER_ID = "factory-fixture-tts";
export const AUDIO_FIXTURE_ENGINE_ID = "deterministic-wav-v1";

export interface AudioNarrationRequest {
  projectId: string;
  pageIdentity: string;
  /** Exact NarrationTextSnapshot digest the synthesis is bound to. */
  narrationSnapshotDigest: string;
  narrationText: string;
  language: string;
  voiceId: string;
}

export interface AudioNarrationResult {
  provider: string;
  engine: string;
  /** Exact audio bytes (fixture: deterministic WAV; live: provider bytes). */
  bytes: Uint8Array;
  mimeType: "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/mp4";
  durationSeconds: number | null;
  providerRequestId: string;
  usage: {
    characters: number;
    costMicros: number | null;
    currency: "USD" | "UNKNOWN";
  };
}

export interface AudioNarrationProvider {
  readonly providerId: string;
  /** Truthful execution mode of this adapter instance. */
  readonly providerMode: "live" | "fixture";
  /** True when this adapter is an offline test double (never production authority). */
  readonly isTestDouble: boolean;
  /** Safe reachability/credential preflight; throws typed failures before spend. */
  preflight(request: { voiceId: string; language: string }): Promise<void>;
  synthesize(request: AudioNarrationRequest): Promise<AudioNarrationResult>;
}

/**
 * Deterministic offline TTS fixture. Produces a valid, minimal, deterministic
 * WAV file whose bytes derive only from the narration digest — identical
 * inputs always produce identical bytes. NEVER production authority.
 */
export class FixtureAudioNarrationProvider implements AudioNarrationProvider {
  readonly providerId = AUDIO_FIXTURE_PROVIDER_ID;
  /** Literal-typed as fixture; subclasses may widen to a live-marked offline double. */
  readonly providerMode: "live" | "fixture" = "fixture";
  readonly isTestDouble: boolean = true;

  async preflight(): Promise<void> {
    // The fixture has no external dependency; preflight always succeeds.
  }

  async synthesize(request: AudioNarrationRequest): Promise<AudioNarrationResult> {
    const digest = deterministicDigest({
      narrationSnapshotDigest: request.narrationSnapshotDigest,
      voiceId: request.voiceId,
      language: request.language,
      engine: AUDIO_FIXTURE_ENGINE_ID,
    });
    const bytes = renderFixtureWav(digest, request.narrationText.length);
    return {
      provider: this.providerId,
      engine: AUDIO_FIXTURE_ENGINE_ID,
      bytes,
      mimeType: "audio/wav",
      // Deterministic estimate: ~14 characters per second of narration.
      durationSeconds: Math.max(1, Math.round(request.narrationText.length / 14)),
      providerRequestId: `fixture_tts_${digest.slice(0, 24)}`,
      usage: {
        characters: request.narrationText.length,
        costMicros: null,
        currency: "UNKNOWN",
      },
    };
  }
}

/** Minimal deterministic PCM WAV renderer (44-byte header + mono samples). */
function renderFixtureWav(seedDigest: string, textLength: number): Uint8Array {
  const sampleRate = 8000;
  const seconds = Math.max(1, Math.min(30, Math.round(textLength / 14)));
  const sampleCount = sampleRate * seconds;
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  // Deterministic pseudo-audio from the seed digest (amplitude varies slowly).
  let state = 0;
  for (let i = 0; i < seedDigest.length; i++) state = (state * 31 + seedDigest.charCodeAt(i)) >>> 0;
  for (let i = 0; i < sampleCount; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    const amplitude = 2000 + (state % 4000);
    view.setInt16(44 + i * 2, amplitude % 32768 - 16384 > 0 ? amplitude : -amplitude, true);
  }
  return new Uint8Array(buffer);
}

/** Production authority gate: fixture/test-double output can never be production authority. */
export function assertAudioProductionAuthority(result: {
  providerMode: string;
  isTestDouble: boolean;
  provider: string;
}): void {
  if (result.providerMode !== "live" || result.isTestDouble) {
    throw new FactoryError(
      "derivative_fixture_not_production_authority",
      `Audio from provider "${result.provider}" is fixture/test-double output and cannot become production authority. LIVE TTS PROVIDER ACTIVATION PENDING PROVIDER POLICY.`,
    );
  }
}

/** Stable provider request id for live adapters (fixture generates its own). */
export function newProviderRequestId(): string {
  return randomUUID();
}
