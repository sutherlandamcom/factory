import { deterministicDigest } from "../intelligence/digest.js";
import { FactoryError } from "../executor/errors.js";
import type {
  AcceptedDerivativeSetData,
  AcceptedPageContentData,
  EffectiveAudioSettings,
  EffectiveSummarySettings,
  PageDerivativeIntentSnapshotData,
  PageDerivativeOverrideData,
  ProjectDerivativePolicyData,
} from "@factory/contracts";

/**
 * DERIVATIVE DIGEST CORE — Run 10.
 *
 * One canonical digest function family for every derivative authority.
 * Digests cover ONLY authority fields: identity, versions, digests of
 * upstream authority, and effective settings. They never include database
 * ids unrelated to authority, createdAt, execution metadata or UI state
 * (the Run 7 digest lesson). The digest core itself (canonical JSON +
 * sha256) is the proven RFC 8785-aligned serializer and is used as-is.
 */

export function derivativeError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}

/** Digest of a validated project derivative policy (authority fields only). */
export function projectDerivativePolicyDigest(
  data: Omit<ProjectDerivativePolicyData, "version"> & { version: number },
): string {
  return deterministicDigest({
    schemaVersion: data.schemaVersion,
    projectId: data.projectId,
    summary: data.summary,
    audio: data.audio,
    version: data.version,
  });
}

/** Digest of a validated page derivative override (authority fields only). */
export function pageDerivativeOverrideDigest(data: PageDerivativeOverrideData): string {
  return deterministicDigest({
    schemaVersion: data.schemaVersion,
    projectId: data.projectId,
    pageIdentity: data.pageIdentity,
    summary: data.summary,
    audio: data.audio,
    version: data.version,
  });
}

/** Digest of a validated derivative intent snapshot (authority fields only). */
export function pageDerivativeIntentSnapshotDigest(data: PageDerivativeIntentSnapshotData): string {
  return deterministicDigest({
    schemaVersion: data.schemaVersion,
    projectId: data.projectId,
    pageIdentity: data.pageIdentity,
    acceptedContent: data.acceptedContent,
    projectPolicy: data.projectPolicy,
    pageOverride: data.pageOverride,
    effectiveSummary: data.effectiveSummary,
    effectiveAudio: data.effectiveAudio,
  });
}

/** Digest of the exact accepted summary artifact. */
export function acceptedSummaryArtifactDigest(data: {
  schemaVersion: string;
  projectId: string;
  pageIdentity: string;
  sourceContent: { id: string; version: number; digest: string };
  intentSnapshot: { id: string; digest: string };
  promptSnapshot: { id: string; digest: string };
  providerMode: string;
  provider: string;
  model: string;
  language: string;
  proposalDigest: string;
  summaryText: string;
  qaReportDigest: string;
  qaOverall: string;
}): string {
  return deterministicDigest(data);
}

/** Digest of the exact narration snapshot (text is authority). */
export function narrationTextSnapshotDigest(data: {
  schemaVersion: string;
  projectId: string;
  pageIdentity: string;
  sourceContent: { id: string; version: number; digest: string };
  narrationPolicyVersion: string;
  language: string;
  narrationText: string;
}): string {
  return deterministicDigest(data);
}

/** Digest of the exact accepted audio artifact. */
export function acceptedAudioArtifactDigest(data: {
  schemaVersion: string;
  projectId: string;
  pageIdentity: string;
  sourceContent: { id: string; version: number; digest: string };
  narrationSnapshot: { id: string; digest: string };
  providerMode: string;
  provider: string;
  engine: string;
  voiceId: string;
  language: string;
  candidateDigest: string;
  binaryDigest: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
}): string {
  return deterministicDigest(data);
}

/**
 * Digest of the exact accepted derivative set. Only authority fields:
 * source content ref, intent snapshot ref, per-derivative state + accepted
 * artifact refs. No createdAt, no database surrogate ids, no UI state.
 */
export function acceptedDerivativeSetDigest(data: AcceptedDerivativeSetData): string {
  return deterministicDigest({
    schemaVersion: data.schemaVersion,
    projectId: data.projectId,
    pageIdentity: data.pageIdentity,
    sourceContent: data.sourceContent,
    intentSnapshot: data.intentSnapshot,
    summary: data.summary,
    audio: data.audio,
    version: data.version,
  });
}

// ---------------------------------------------------------------------------
// Effective policy resolution — pure and deterministic
// ---------------------------------------------------------------------------

/**
 * Resolve the effective summary settings for a page.
 *
 * Absence of a project policy resolves to EXPLICIT DISABLED for both
 * derivatives (Run 10 planning decision): pre-Run-10 projects keep
 * rebuilding unchanged and operators opt in by creating a policy. A page
 * override may force enable/disable or refine language, but can never
 * enable a derivative the project policy does not offer a language/policy
 * basis for — an override forcing `enabled` without any project policy is
 * rejected (fail closed).
 */
export function resolveEffectiveDerivativeSettings(input: {
  projectPolicy: ProjectDerivativePolicyData | null;
  pageOverride: PageDerivativeOverrideData | null;
}): { summary: EffectiveSummarySettings; audio: EffectiveAudioSettings } {
  const { projectPolicy, pageOverride } = input;

  if (!projectPolicy) {
    if (pageOverride && (pageOverride.summary.mode === "enabled" || pageOverride.audio.mode === "enabled")) {
      throw derivativeError(
        "derivative_policy_not_found",
        "Page override forces a derivative enabled but no project derivative policy exists; create project defaults first.",
      );
    }
    return {
      summary: {
        state: "disabled",
        language: "en",
        policyVersion: "derivative-policy-none",
      },
      audio: {
        state: "disabled",
        language: "en",
        voiceId: "none",
        policyVersion: "derivative-policy-none",
      },
    };
  }

  const summaryMode = pageOverride?.summary.mode ?? "inherit";
  const audioMode = pageOverride?.audio.mode ?? "inherit";

  const summaryEnabled = summaryMode === "inherit" ? projectPolicy.summary.enabled : summaryMode === "enabled";
  const audioEnabled = audioMode === "inherit" ? projectPolicy.audio.enabled : audioMode === "enabled";

  const summaryLanguage =
    pageOverride?.summary.language ?? projectPolicy.summary.language;
  const audioLanguage =
    pageOverride?.audio.language ?? projectPolicy.audio.language;
  const audioVoiceId =
    pageOverride?.audio.voiceId ?? projectPolicy.audio.voiceId;

  if (audioEnabled && !audioVoiceId) {
    throw derivativeError(
      "derivative_generation_blocked",
      "Effective audio is enabled but no voiceId is configured in project policy or page override.",
    );
  }

  return {
    summary: {
      state: summaryEnabled ? "enabled" : "disabled",
      language: summaryLanguage,
      policyVersion: projectPolicy.summary.policyVersion,
    },
    audio: {
      state: audioEnabled ? "enabled" : "disabled",
      language: audioLanguage,
      voiceId: audioVoiceId ?? "none",
      policyVersion: projectPolicy.audio.policyVersion,
    },
  };
}

// ---------------------------------------------------------------------------
// Accepted copy reader — tolerant of the actual stored authority shape
// ---------------------------------------------------------------------------

/**
 * Read the accepted page copy fields from stored `accepted_page_content.data`.
 *
 * The writer pipeline persists the accepted `PageContentProposalData` object
 * (flat: title/metaDescription/introduction/sections/conclusion/cta/
 * internalLinks on top level), matching what the design service reads.
 * This reader therefore accepts the flat proposal shape directly and also
 * tolerates a fully nested `AcceptedPageContentData` wrapper should the
 * stored shape ever gain one. It NEVER mutates or rewrites accepted copy.
 */
export interface AcceptedPageCopy {
  title: string;
  metaDescription: string;
  introduction: string;
  sections: Array<{ heading: string; body: string }>;
  conclusion: string;
  cta: string;
  internalLinks: string[];
}

export function readAcceptedPageCopy(data: unknown): AcceptedPageCopy {
  if (data === null || typeof data !== "object") {
    throw derivativeError("derivative_required_artifact_missing", "Accepted content data is missing or malformed.");
  }
  const record = data as Record<string, unknown>;
  const source =
    record.content !== null && typeof record.content === "object" && !Array.isArray(record.content)
      ? (record.content as Record<string, unknown>)
      : record;
  const title = source.title;
  const introduction = source.introduction;
  const conclusion = source.conclusion;
  if (typeof title !== "string" || title.length === 0 || typeof introduction !== "string" || typeof conclusion !== "string") {
    throw derivativeError("derivative_required_artifact_missing", "Accepted content data lacks the required narrative fields.");
  }
  if (!Array.isArray(source.sections)) {
    throw derivativeError("derivative_required_artifact_missing", "Accepted content data lacks sections.");
  }
  return {
    title,
    metaDescription: typeof source.metaDescription === "string" ? source.metaDescription : "",
    introduction,
    sections: (source.sections as Array<{ heading: unknown; body: unknown }>).map((section) => ({
      heading: String(section.heading ?? ""),
      body: String(section.body ?? ""),
    })),
    conclusion,
    cta: typeof source.cta === "string" ? source.cta : "",
    internalLinks: Array.isArray(source.internalLinks) ? (source.internalLinks as string[]) : [],
  };
}


export const NARRATION_POLICY_VERSION = "narration-projection-v1";

/**
 * Deterministically project exact accepted page copy into narration text.
 *
 * INCLUDED: page title, introduction, section headings + bodies, conclusion.
 * EXCLUDED: meta description, canonical/SEO metadata, structured data,
 * breadcrumbs, navigation, internal links, image alt text, CTA button
 * targets, any technical asset data.
 *
 * The projection NEVER paraphrases, rewrites, shortens or expands accepted
 * copy. It only performs narrow deterministic formatting: verbatim text
 * joined with narration-friendly separators.
 */
export function projectNarrationText(content: AcceptedPageCopy): string {
  const parts: string[] = [];
  parts.push(content.title);
  if (content.introduction.trim().length > 0) parts.push(content.introduction);
  for (const section of content.sections) {
    parts.push(section.heading);
    parts.push(section.body);
  }
  if (content.conclusion.trim().length > 0) parts.push(content.conclusion);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Staleness evaluation — pure functions over authority refs
// ---------------------------------------------------------------------------

export interface StalenessVerdict {
  stale: boolean;
  reason?: string;
}

/** An accepted artifact is stale when its source content ref no longer matches current authority. */
export function derivativeSourceStaleness(input: {
  artifactSource: { id: string; version: number; digest: string };
  currentContent: { id: string; version: number; digest: string } | null;
}): StalenessVerdict {
  if (!input.currentContent) return { stale: true, reason: "Source accepted content no longer exists." };
  if (
    input.currentContent.id !== input.artifactSource.id ||
    input.currentContent.version !== input.artifactSource.version ||
    input.currentContent.digest !== input.artifactSource.digest
  ) {
    return {
      stale: true,
      reason: `Source content moved from ${input.artifactSource.id}@v${input.artifactSource.version} to ${input.currentContent.id}@v${input.currentContent.version}.`,
    };
  }
  return { stale: false };
}

/** A derivative set is stale when any bound authority is stale or superseded. */
export function derivativeSetStaleness(input: {
  set: AcceptedDerivativeSetData;
  currentContent: { id: string; version: number; digest: string } | null;
  currentIntentSnapshot: { id: string; digest: string } | null;
  currentSummary: { id: string; version: number; digest: string } | null;
  currentAudio: { id: string; version: number; digest: string; binaryDigest: string } | null;
}): StalenessVerdict {
  const source = derivativeSourceStaleness({
    artifactSource: input.set.sourceContent,
    currentContent: input.currentContent,
  });
  if (source.stale) return source;

  if (input.set.intentSnapshot) {
    if (!input.currentIntentSnapshot) {
      return { stale: true, reason: "Bound intent snapshot no longer exists." };
    }
    if (
      input.currentIntentSnapshot.id !== input.set.intentSnapshot.id ||
      input.currentIntentSnapshot.digest !== input.set.intentSnapshot.digest
    ) {
      return { stale: true, reason: "Intent snapshot superseded by a newer effective policy." };
    }
  }

  if (input.set.summary.state === "accepted") {
    if (!input.currentSummary) return { stale: true, reason: "Accepted summary artifact no longer exists." };
    if (
      input.currentSummary.id !== input.set.summary.acceptedArtifactId ||
      input.currentSummary.version !== input.set.summary.version ||
      input.currentSummary.digest !== input.set.summary.digest
    ) {
      return { stale: true, reason: "Accepted summary superseded." };
    }
  }

  if (input.set.audio.state === "accepted") {
    if (!input.currentAudio) return { stale: true, reason: "Accepted audio artifact no longer exists." };
    if (
      input.currentAudio.id !== input.set.audio.acceptedArtifactId ||
      input.currentAudio.version !== input.set.audio.version ||
      input.currentAudio.digest !== input.set.audio.digest ||
      input.currentAudio.binaryDigest !== input.set.audio.binaryDigest
    ) {
      return { stale: true, reason: "Accepted audio superseded." };
    }
  }

  return { stale: false };
}
