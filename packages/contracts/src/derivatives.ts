import { z } from "zod";
import {
  productionIdSchema,
  productionDigestSchema,
  productionAuthorityRefSchema,
} from "./production.js";
import { qaVerdictSchema } from "./writer-content.js";

/**
 * DERIVATIVE CONTRACTS — Macro Run 10 (Page Derivatives: AI Summary + Audio).
 *
 * Summary and audio are DERIVATIVES of exact accepted authority. They are
 * never part of `AcceptedPageContent` and never mutate it:
 *
 *   AcceptedPageContent C1 (immutable, Runs 4–9 authority)
 *     → ProjectDerivativePolicy / PageDerivativeOverride (versioned policy)
 *     → PageDerivativeIntentSnapshot   (immutable effective-policy snapshot)
 *         ├── SummaryPromptSnapshot → SummaryProposal → AcceptedSummaryArtifact
 *         └── NarrationTextSnapshot → AudioCandidate  → AcceptedAudioArtifact
 *     → AcceptedDerivativeSet          (page-level derivative authority)
 *     → ProductionPageInput (production-v2, binds the exact derivative set)
 *
 * Every significant artifact is version/digest-bound; mutating an
 * authoritative dependency makes downstream artifacts stale. Old accepted
 * versions remain immutable history.
 */

export const DERIVATIVES_SCHEMA_VERSION = "derivatives-v1" as const;

/** Reuse the production digest/id shapes: canonical-JSON sha256 hex digests. */
export const derivativeDigestSchema = productionDigestSchema;
export const derivativeIdSchema = productionIdSchema;

/** BCP-47-style bounded language tag (e.g. "en", "en-GB", "fr"). */
export const derivativeLanguageSchema = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, {
    message: 'language must be a BCP-47-style tag like "en" or "en-GB"',
  });

/** Bounded voice identity (provider-namespace string; never free-form config). */
export const derivativeVoiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message: "voiceId must be a bounded provider voice identifier",
  });

/** Provider execution mode truthfulness (mirrors existing Factory convention). */
export const derivativeProviderModeSchema = z.enum(["live", "fixture"]);

/** Page override mode: inherit project defaults, or force enable/disable. */
export const derivativeOverrideModeSchema = z.enum(["inherit", "enabled", "disabled"]);

/** Derivative-set member state: explicit disabled or exact accepted authority. */
export const derivativeSetStateSchema = z.enum(["disabled", "accepted"]);

/** Lifecycle states surfaced to operators (backend-computed, never UI authority). */
export const derivativeLifecycleStatusSchema = z.enum([
  "DISABLED",
  "READY",
  "GENERATING",
  "REVIEW",
  "ACCEPTED",
  "STALE",
]);

// ---------------------------------------------------------------------------
// ProjectDerivativePolicy — versioned project-level defaults
// ---------------------------------------------------------------------------

export const derivativeSummaryPolicySchema = z
  .object({
    enabled: z.boolean(),
    language: derivativeLanguageSchema,
    /** Policy vocabulary version governing summary generation/QA semantics. */
    policyVersion: z.string().trim().min(1).max(60),
  })
  .strict();

export const derivativeAudioPolicySchema = z
  .object({
    enabled: z.boolean(),
    language: derivativeLanguageSchema,
    /** Required when enabled; identifies the narration voice for TTS. */
    voiceId: derivativeVoiceIdSchema.optional(),
    policyVersion: z.string().trim().min(1).max(60),
  })
  .strict();

export const projectDerivativePolicyDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    summary: derivativeSummaryPolicySchema,
    audio: derivativeAudioPolicySchema,
    version: z.number().int().min(1),
  })
  .strict();
export type ProjectDerivativePolicyData = z.infer<typeof projectDerivativePolicyDataSchema>;

// ---------------------------------------------------------------------------
// PageDerivativeOverride — narrow per-page deviation from project defaults
// ---------------------------------------------------------------------------

export const derivativeSummaryOverrideSchema = z
  .object({
    mode: derivativeOverrideModeSchema,
    /** Optional language override; only meaningful when mode forces enabled. */
    language: derivativeLanguageSchema.optional(),
  })
  .strict();

export const derivativeAudioOverrideSchema = z
  .object({
    mode: derivativeOverrideModeSchema,
    language: derivativeLanguageSchema.optional(),
    voiceId: derivativeVoiceIdSchema.optional(),
  })
  .strict();

export const pageDerivativeOverrideDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    summary: derivativeSummaryOverrideSchema,
    audio: derivativeAudioOverrideSchema,
    version: z.number().int().min(1),
  })
  .strict();
export type PageDerivativeOverrideData = z.infer<typeof pageDerivativeOverrideDataSchema>;

// ---------------------------------------------------------------------------
// Effective derivative settings — resolved view compiled into the snapshot
// ---------------------------------------------------------------------------

export const effectiveSummarySettingsSchema = z
  .object({
    state: z.enum(["enabled", "disabled"]),
    language: derivativeLanguageSchema,
    policyVersion: z.string().trim().min(1).max(60),
  })
  .strict();

export const effectiveAudioSettingsSchema = z
  .object({
    state: z.enum(["enabled", "disabled"]),
    language: derivativeLanguageSchema,
    voiceId: derivativeVoiceIdSchema,
    policyVersion: z.string().trim().min(1).max(60),
  })
  .strict();

export type EffectiveSummarySettings = z.infer<typeof effectiveSummarySettingsSchema>;
export type EffectiveAudioSettings = z.infer<typeof effectiveAudioSettingsSchema>;

// ---------------------------------------------------------------------------
// PageDerivativeIntentSnapshot — immutable effective-policy authority
// ---------------------------------------------------------------------------

export const pageDerivativeIntentSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    /** Exact accepted content this intent is derived from. */
    acceptedContent: productionAuthorityRefSchema,
    /** Exact project policy version/digest applied (absent policy = null). */
    projectPolicy: z
      .object({
        id: derivativeIdSchema,
        version: z.number().int().min(1),
        digest: derivativeDigestSchema,
      })
      .strict()
      .nullable(),
    /** Exact page override version/digest applied (no override = null). */
    pageOverride: z
      .object({
        id: derivativeIdSchema,
        version: z.number().int().min(1),
        digest: derivativeDigestSchema,
      })
      .strict()
      .nullable(),
    effectiveSummary: effectiveSummarySettingsSchema,
    effectiveAudio: effectiveAudioSettingsSchema,
  })
  .strict();
export type PageDerivativeIntentSnapshotData = z.infer<typeof pageDerivativeIntentSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// SummaryPromptSnapshot — immutable compiled prompt authority
// ---------------------------------------------------------------------------

export const summaryPromptSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    /** Exact intent snapshot this prompt was compiled from. */
    intentSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    /** Exact accepted content bound into the prompt. */
    acceptedContent: productionAuthorityRefSchema,
    summaryPolicyVersion: z.string().trim().min(1).max(60),
    language: derivativeLanguageSchema,
    /** Governed provider/model identity resolved through the policy seam. */
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    /** The exact compiled prompt packet sent to the summarizer. */
    systemPrompt: z.string().min(1).max(32_000),
    userPrompt: z.string().min(1).max(64_000),
    maxOutputTokens: z.number().int().min(1).max(64_000),
  })
  .strict();
export type SummaryPromptSnapshotData = z.infer<typeof summaryPromptSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// SummaryProposal — provider output under review (never production authority)
// ---------------------------------------------------------------------------

export const summaryProposalDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    promptSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    acceptedContent: productionAuthorityRefSchema,
    /** Provider execution truth: mode + test-double marking. */
    providerMode: derivativeProviderModeSchema,
    isTestDouble: z.boolean(),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    /** The exact proposed summary text (verbatim provider output). */
    summaryText: z.string().min(1).max(20_000),
    /** Provider request identity for lineage (opaque string). */
    providerRequestId: z.string().trim().min(1).max(200),
    /** Usage/cost telemetry captured for this invocation. */
    usage: z
      .object({
        promptTokens: z.number().int().min(0).nullable(),
        completionTokens: z.number().int().min(0).nullable(),
        totalTokens: z.number().int().min(0).nullable(),
        costMicros: z.number().int().min(0).nullable(),
        currency: z.enum(["USD", "UNKNOWN"]),
      })
      .strict(),
  })
  .strict();
export type SummaryProposalData = z.infer<typeof summaryProposalDataSchema>;

/** Deterministic summary QA gates (typed evidence; no numeric quality score). */
export const summaryQaCheckIdSchema = z.enum([
  "summary.non_empty",
  "summary.source_bound",
  "summary.no_placeholder",
  "summary.no_new_numeric_claims",
  "summary.no_new_urls",
  "summary.no_cta_injection",
  "summary.reasonable_size",
  "summary.language",
]);
export type SummaryQaCheckId = z.infer<typeof summaryQaCheckIdSchema>;

export const summaryQaCheckResultSchema = z
  .object({
    checkId: summaryQaCheckIdSchema,
    verdict: qaVerdictSchema,
    detail: z.string().min(1).max(2000),
  })
  .strict();
export type SummaryQaCheckResult = z.infer<typeof summaryQaCheckResultSchema>;

export const summaryQaReportDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    proposalId: derivativeIdSchema,
    proposalDigest: derivativeDigestSchema,
    checks: z.array(summaryQaCheckResultSchema).max(20),
    /** FAIL if any FAIL; REVIEW if any REVIEW; else PASS. */
    overall: qaVerdictSchema,
  })
  .strict();
export type SummaryQaReportData = z.infer<typeof summaryQaReportDataSchema>;

// ---------------------------------------------------------------------------
// AcceptedSummaryArtifact — human-accepted immutable summary authority
// ---------------------------------------------------------------------------

export const acceptedSummaryArtifactDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    /** Exact accepted source content. */
    sourceContent: productionAuthorityRefSchema,
    intentSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    promptSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    providerMode: derivativeProviderModeSchema,
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    language: derivativeLanguageSchema,
    /** Digest of the exact proposal this artifact accepted. */
    proposalDigest: derivativeDigestSchema,
    /** The accepted summary text (verbatim from the accepted proposal). */
    summaryText: z.string().min(1).max(20_000),
    /** QA evidence bound at acceptance time. */
    qaReportDigest: derivativeDigestSchema,
    qaOverall: qaVerdictSchema,
  })
  .strict();
export type AcceptedSummaryArtifactData = z.infer<typeof acceptedSummaryArtifactDataSchema>;

// ---------------------------------------------------------------------------
// NarrationTextSnapshot — deterministic narration projection authority
// ---------------------------------------------------------------------------

export const narrationTextSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    /** Exact accepted content projected into narration text. */
    sourceContent: productionAuthorityRefSchema,
    narrationPolicyVersion: z.string().trim().min(1).max(60),
    language: derivativeLanguageSchema,
    /** The exact deterministic narration text (verbatim accepted copy). */
    narrationText: z.string().min(1).max(200_000),
  })
  .strict();
export type NarrationTextSnapshotData = z.infer<typeof narrationTextSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// AudioCandidate / AcceptedAudioArtifact — TTS lineage
// ---------------------------------------------------------------------------

export const audioCandidateDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    narrationSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    providerMode: derivativeProviderModeSchema,
    isTestDouble: z.boolean(),
    provider: z.string().trim().min(1).max(100),
    engine: z.string().trim().min(1).max(200),
    voiceId: derivativeVoiceIdSchema,
    language: derivativeLanguageSchema,
    providerRequestId: z.string().trim().min(1).max(200),
    /** SHA-256 over the exact audio bytes (binary identity). */
    binaryDigest: derivativeDigestSchema,
    mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]),
    sizeBytes: z.number().int().min(1),
    durationSeconds: z.number().min(0).nullable(),
    usage: z
      .object({
        characters: z.number().int().min(0).nullable(),
        costMicros: z.number().int().min(0).nullable(),
        currency: z.enum(["USD", "UNKNOWN"]),
      })
      .strict(),
  })
  .strict();
export type AudioCandidateData = z.infer<typeof audioCandidateDataSchema>;

export const acceptedAudioArtifactDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    sourceContent: productionAuthorityRefSchema,
    narrationSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    providerMode: derivativeProviderModeSchema,
    provider: z.string().trim().min(1).max(100),
    engine: z.string().trim().min(1).max(200),
    voiceId: derivativeVoiceIdSchema,
    language: derivativeLanguageSchema,
    /** Digest of the exact accepted candidate. */
    candidateDigest: derivativeDigestSchema,
    binaryDigest: derivativeDigestSchema,
    mimeType: audioCandidateDataSchema.shape.mimeType,
    sizeBytes: z.number().int().min(1),
    durationSeconds: z.number().min(0).nullable(),
  })
  .strict();
export type AcceptedAudioArtifactData = z.infer<typeof acceptedAudioArtifactDataSchema>;

// ---------------------------------------------------------------------------
// AcceptedDerivativeSet — page-level derivative authority
// ---------------------------------------------------------------------------

export const derivativeSetMemberSchema = z
  .object({
    state: derivativeSetStateSchema,
    /** Present only when state === "accepted". */
    acceptedArtifactId: derivativeIdSchema.optional(),
    version: z.number().int().min(1).optional(),
    digest: derivativeDigestSchema.optional(),
  })
  .strict();

export const derivativeSetAudioMemberSchema = derivativeSetMemberSchema.extend({
  /** Binary digest of the accepted audio (present when accepted). */
  binaryDigest: derivativeDigestSchema.optional(),
});

export const acceptedDerivativeSetDataSchema = z
  .object({
    schemaVersion: z.literal(DERIVATIVES_SCHEMA_VERSION),
    projectId: derivativeIdSchema,
    pageIdentity: derivativeIdSchema,
    sourceContent: productionAuthorityRefSchema,
    intentSnapshot: z
      .object({ id: derivativeIdSchema, digest: derivativeDigestSchema })
      .strict(),
    summary: derivativeSetMemberSchema,
    audio: derivativeSetAudioMemberSchema,
    version: z.number().int().min(1),
  })
  .strict();
export type AcceptedDerivativeSetData = z.infer<typeof acceptedDerivativeSetDataSchema>;

// ---------------------------------------------------------------------------
// Error codes — fail-closed derivative authority violations
// ---------------------------------------------------------------------------

export const DERIVATIVE_ERROR_CODES = [
  /** No project derivative policy and none required (explicit disabled default). */
  "derivative_policy_not_found",
  /** The referenced policy/override/intent snapshot is stale vs current authority. */
  "derivative_authority_stale",
  /** A bound authority digest does not match (forged or drifted binding). */
  "derivative_authority_digest_mismatch",
  /** Artifact belongs to a different project (cross-project misuse). */
  "derivative_authority_wrong_project",
  /** Required derivative artifact does not exist or is not current. */
  "derivative_required_artifact_missing",
  /** Fixture/test-double output cannot become production authority. */
  "derivative_fixture_not_production_authority",
  /** Audio binary digest does not match stored bytes (forged binary). */
  "derivative_binary_digest_mismatch",
  /** Derivative artifact is immutable; a new version is required. */
  "derivative_artifact_immutable",
  /** Derivative generation blocked (preflight failed before provider spend). */
  "derivative_generation_blocked",
  /** QA report verdict FAIL blocks acceptance. */
  "derivative_qa_failed",
] as const;
export type DerivativeErrorCode = (typeof DERIVATIVE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseProjectDerivativePolicyData(input: unknown): ProjectDerivativePolicyData {
  return projectDerivativePolicyDataSchema.parse(input);
}
export function parsePageDerivativeOverrideData(input: unknown): PageDerivativeOverrideData {
  return pageDerivativeOverrideDataSchema.parse(input);
}
export function parsePageDerivativeIntentSnapshotData(input: unknown): PageDerivativeIntentSnapshotData {
  return pageDerivativeIntentSnapshotDataSchema.parse(input);
}
export function parseSummaryPromptSnapshotData(input: unknown): SummaryPromptSnapshotData {
  return summaryPromptSnapshotDataSchema.parse(input);
}
export function parseSummaryProposalData(input: unknown): SummaryProposalData {
  return summaryProposalDataSchema.parse(input);
}
export function parseAcceptedSummaryArtifactData(input: unknown): AcceptedSummaryArtifactData {
  return acceptedSummaryArtifactDataSchema.parse(input);
}
export function parseNarrationTextSnapshotData(input: unknown): NarrationTextSnapshotData {
  return narrationTextSnapshotDataSchema.parse(input);
}
export function parseAudioCandidateData(input: unknown): AudioCandidateData {
  return audioCandidateDataSchema.parse(input);
}
export function parseAcceptedAudioArtifactData(input: unknown): AcceptedAudioArtifactData {
  return acceptedAudioArtifactDataSchema.parse(input);
}
export function parseAcceptedDerivativeSetData(input: unknown): AcceptedDerivativeSetData {
  return acceptedDerivativeSetDataSchema.parse(input);
}