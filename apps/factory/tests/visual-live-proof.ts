/**
 * LIVE GOOGLE GENAI VISUAL ASSET INTEGRATION PROOF — controlled, one-shot.
 *
 * Exercises the real Google GenAI provider adapter (@google/genai SDK) against
 * Gemini's image generation model using real credentials from the local
 * environment, through the SAME governed pipeline and models Factory uses.
 *
 * NOT part of ordinary unit/CI test runs (env-gated):
 *   FACTORY_VISUAL_LIVE_PROOF=1 GEMINI_API_KEY=<key> \
 *     npx tsx tests/visual-live-proof.ts
 *
 * Preflight guarantees:
 * - Preflight is strictly zero-spend (credential check and client construction only,
 *   never issues unbudgeted model inference).
 * - Exact model policy enforcement (pinned to gemini-3.1-flash-image / gemini-2.5-flash-image).
 * - Honest reporting of provider mode and live proof scope.
 */

import sharp from "sharp";
import {
  GoogleGenAiVisualAssetAdapter,
  resolveGeminiCredential,
  GEMINI_API_KEY_ENV,
  GEMINI_API_KEY_ENV_ALT,
  ALLOWED_VISUAL_MODELS,
} from "../src/visual/google-genai-adapter.js";
import {
  VISUAL_DEFAULT_MODEL,
  VISUAL_FALLBACK_DEFAULT_MODEL,
  VISUAL_PREMIUM_MODEL,
} from "../src/visual/policy.js";
import type { VisualProviderRequest } from "@factory/contracts";

const ENABLED = process.env.FACTORY_VISUAL_LIVE_PROOF === "1";
if (!ENABLED) {
  console.log("Visual live proof disabled (set FACTORY_VISUAL_LIVE_PROOF=1 to run).");
  process.exit(0);
}

const cred = resolveGeminiCredential();
if (!cred) {
  console.error(
    `No Gemini credentials found in environment (${GEMINI_API_KEY_ENV} or ${GEMINI_API_KEY_ENV_ALT}). Live proof cannot proceed.`,
  );
  process.exit(1);
}

console.log("--- GOOGLE GENAI VISUAL ASSET LIVE PROOF ---");
console.log("Credential kind:", cred.kind);

// 1. Preflight check (Zero-spend)
const adapter = new GoogleGenAiVisualAssetAdapter();
const preflightStarted = Date.now();
const preflight = await adapter.preflight();
const preflightDurationMs = Date.now() - preflightStarted;

console.log("PREFLIGHT:", JSON.stringify(preflight, null, 2));
console.log("Preflight duration:", preflightDurationMs, "ms (zero spend, client probe only)");

if (!preflight.configured) {
  console.error("Preflight failed:", preflight.reason);
  process.exit(1);
}

const reportedModels = preflight.configuredModels ?? preflight.verifiedModels;
if (!reportedModels || reportedModels.length === 0) {
  console.error("Preflight failed to report configured models.");
  process.exit(1);
}

console.log("CONFIGURED_MODELS:", reportedModels.join(", "));

// 2. Controlled Generation (Single Bounded Call)
const modelId = VISUAL_DEFAULT_MODEL;
console.log(`Executing controlled generation with pinned model: ${modelId}...`);

const request: VisualProviderRequest = {
  provider: "google-genai",
  model: modelId,
  operation: "generate",
  promptText: "Professional architectural photograph of modern residential roof restoration, clean lines, natural morning daylight, authentic documentary style",
  promptDigest: "0".repeat(64),
  requestDigest: "1".repeat(64),
  promptSnapshotId: "vps-live-proof",
  targetAspectRatio: "16:9",
  targetSize: "1280x720",
  sourceImages: [],
};

const genStarted = Date.now();
try {
  const result = await adapter.generateImage(request);
  const genDurationMs = Date.now() - genStarted;

  console.log("GENERATION RESULT:");
  console.log("  Duration:", genDurationMs, "ms");
  console.log("  Candidates returned:", result.candidates.length);

  if (result.candidates.length === 0) {
    console.error("FAIL: No candidates returned from live provider.");
    process.exit(1);
  }

  const firstCandidate = result.candidates[0]!;
  console.log("  Candidate 0 mediaType:", firstCandidate.mediaType);
  console.log("  Candidate 0 byteLength:", firstCandidate.bytes.byteLength);

  // Inspect image dimensions with sharp
  const metadata = await sharp(Buffer.from(firstCandidate.bytes)).metadata();
  console.log("  Candidate 0 dimensions:", metadata.width, "x", metadata.height);
  console.log("  Candidate 0 format:", metadata.format);

  if (!metadata.width || !metadata.height) {
    console.error("FAIL: Candidate bytes could not be decoded as an image.");
    process.exit(1);
  }

  console.log("LIVE PROOF SUCCESSFUL: Google GenAI Visual Asset provider connectivity and generation verified.");
  process.exit(0);
} catch (error) {
  console.error("Live generation error:", error);
  process.exit(1);
}
