import { and, eq } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedDerivativeSets,
  acceptedSummaryArtifacts,
  acceptedAudioArtifacts,
  type AcceptedDerivativeSetRecord,
} from "../persistence/schema.js";
import {
  parseAcceptedDerivativeSetData,
  parseAcceptedSummaryArtifactData,
  parseAcceptedAudioArtifactData,
  type AcceptedDerivativeSetData,
  type EffectiveSummarySettings,
  type EffectiveAudioSettings,
  type PageDerivativeIntentSnapshotData,
  type ProjectDerivativePolicyData,
  type PageDerivativeOverrideData,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import {
  acceptedDerivativeSetDigest,
  acceptedSummaryArtifactDigest,
  acceptedAudioArtifactDigest,
  pageDerivativeIntentSnapshotDigest,
  resolveEffectiveDerivativeSettings,
} from "./core.js";
import { DerivativesStore } from "./store.js";
import { sha256HexBytes, type AssetStorage } from "../assets/storage.js";
import { assertAudioProductionAuthority } from "./audio-provider.js";

/** Production authority gate: fixture/test-double summary output can never be production authority. */
export function assertSummaryProductionAuthority(result: {
  providerMode: string;
  isTestDouble: boolean;
  provider: string;
}): void {
  if (result.providerMode !== "live" || result.isTestDouble) {
    throw new FactoryError(
      "derivative_fixture_not_production_authority",
      `Summary from provider "${result.provider}" (mode=${result.providerMode}, testDouble=${result.isTestDouble}) is fixture/test-double output and cannot become production authority.`,
    );
  }
}

export { assertAudioProductionAuthority };

/**
 * Derive the current derivative intent authority from current policy and page override.
 *
 * Single canonical definition used across DerivativesService, ProductionStore,
 * and requireProductionDerivativeSet.
 */
export async function deriveCurrentDerivativeIntentAuthority(
  derivStore: DerivativesStore,
  projectId: string,
  pageIdentity: string,
  content: { id: string; version: number; digest: string },
): Promise<{
  data: PageDerivativeIntentSnapshotData;
  digest: string;
  policyRow: Awaited<ReturnType<typeof derivStore.currentPolicy>>;
  overrideRow: Awaited<ReturnType<typeof derivStore.currentOverride>>;
  effective: { summary: EffectiveSummarySettings; audio: EffectiveAudioSettings };
}> {
  const policyRow = await derivStore.currentPolicy(projectId);
  const overrideRow = await derivStore.currentOverride(projectId, pageIdentity);

  const projectPolicy = policyRow ? (policyRow.data as ProjectDerivativePolicyData) : null;
  const pageOverride = overrideRow ? (overrideRow.data as PageDerivativeOverrideData) : null;

  const effective = resolveEffectiveDerivativeSettings({ projectPolicy, pageOverride });

  const data: PageDerivativeIntentSnapshotData = {
    schemaVersion: "derivatives-v1",
    projectId,
    pageIdentity,
    acceptedContent: {
      id: content.id,
      version: content.version,
      digest: content.digest,
    },
    projectPolicy: policyRow
      ? { id: policyRow.id, version: policyRow.version, digest: policyRow.policyDigest }
      : null,
    pageOverride: overrideRow
      ? { id: overrideRow.id, version: overrideRow.version, digest: overrideRow.overrideDigest }
      : null,
    effectiveSummary: effective.summary,
    effectiveAudio: effective.audio,
  };
  const digest = pageDerivativeIntentSnapshotDigest(data);
  return { data, digest, policyRow, overrideRow, effective };
}

export interface RequireProductionDerivativeSetInput {
  db: FactoryDb;
  projectId: string;
  pageIdentity: string;
  setId: string;
  setVersion: number;
  setDigest: string;
  currentContent: {
    id: string;
    version: number;
    digest: string;
  };
  storage?: AssetStorage;
}

export interface VerifiedProductionDerivativeSet {
  set: AcceptedDerivativeSetRecord;
  setData: AcceptedDerivativeSetData;
  summary:
    | {
        state: "accepted";
        acceptedId: string;
        acceptedVersion: number;
        acceptedDigest: string;
        language: string;
        summaryText: string;
      }
    | {
        state: "disabled";
      };
  audio:
    | {
        state: "accepted";
        acceptedId: string;
        acceptedVersion: number;
        acceptedDigest: string;
        binaryDigest: string;
        mimeType: string;
        durationSeconds: number | null;
        bytes?: Uint8Array;
      }
    | {
        state: "disabled";
      };
}

/**
 * Single canonical production derivative verifier.
 *
 * Enforces all 10+ production authority invariants across ProductionStore
 * and RenderManifestCompiler.
 */
export async function requireProductionDerivativeSet(
  input: RequireProductionDerivativeSetInput,
): Promise<VerifiedProductionDerivativeSet> {
  const derivStore = new DerivativesStore(input.db);
  const [setRow] = await input.db
    .select()
    .from(acceptedDerivativeSets)
    .where(
      and(
        eq(acceptedDerivativeSets.id, input.setId),
        eq(acceptedDerivativeSets.projectId, input.projectId),
      ),
    );

  // 1. Set exists
  if (!setRow) {
    throw new FactoryError(
      "derivative_required_artifact_missing",
      `Bound AcceptedDerivativeSet "${input.setId}" does not exist in project "${input.projectId}".`,
    );
  }

  // 2. Same project
  if (setRow.projectId !== input.projectId) {
    throw new FactoryError(
      "derivative_authority_wrong_project",
      `AcceptedDerivativeSet belongs to project "${setRow.projectId}", not "${input.projectId}".`,
    );
  }

  // 3. Same page identity
  if (setRow.pageIdentity !== input.pageIdentity) {
    throw new FactoryError(
      "derivative_authority_digest_mismatch",
      `AcceptedDerivativeSet page identity "${setRow.pageIdentity}" does not match requested "${input.pageIdentity}".`,
    );
  }

  // 4. Exact version
  if (setRow.version !== input.setVersion) {
    throw new FactoryError(
      "derivative_authority_digest_mismatch",
      `AcceptedDerivativeSet version ${setRow.version} does not match requested version ${input.setVersion}.`,
    );
  }

  // 5. Exact stored setDigest
  if (setRow.setDigest !== input.setDigest) {
    throw new FactoryError(
      "derivative_authority_digest_mismatch",
      `AcceptedDerivativeSet digest "${setRow.setDigest}" does not match requested digest "${input.setDigest}".`,
    );
  }

  // 6. Recomputed canonical digest from persisted set.data == stored setDigest
  const setData = parseAcceptedDerivativeSetData(setRow.data);
  const recomputedSetDigest = acceptedDerivativeSetDigest(setData);
  if (recomputedSetDigest !== setRow.setDigest) {
    throw new FactoryError(
      "derivative_authority_digest_mismatch",
      `AcceptedDerivativeSet persisted data recomputed digest "${recomputedSetDigest}" does not match stored digest "${setRow.setDigest}" (forged or corrupted set row).`,
    );
  }

  // 7. Source content exact id/version/digest
  if (
    setRow.sourceContentId !== input.currentContent.id ||
    setRow.sourceContentVersion !== input.currentContent.version ||
    setRow.sourceContentDigest !== input.currentContent.digest ||
    setData.sourceContent.id !== input.currentContent.id ||
    setData.sourceContent.version !== input.currentContent.version ||
    setData.sourceContent.digest !== input.currentContent.digest
  ) {
    throw new FactoryError(
      "production_authority_stale",
      "AcceptedDerivativeSet is stale versus current accepted content; re-accept derivatives.",
    );
  }

  // 8. Intent snapshot exact id/digest in set
  if (
    setData.intentSnapshot.id !== setRow.intentSnapshotId ||
    setData.intentSnapshot.digest !== setRow.intentSnapshotDigest
  ) {
    throw new FactoryError(
      "derivative_authority_digest_mismatch",
      "AcceptedDerivativeSet intent snapshot binding is internally inconsistent.",
    );
  }

  // 9. Intent is still current effective intent (freshly derived)
  const currentIntent = await deriveCurrentDerivativeIntentAuthority(
    derivStore,
    input.projectId,
    input.pageIdentity,
    input.currentContent,
  );
  if (setRow.intentSnapshotDigest !== currentIntent.digest) {
    throw new FactoryError(
      "production_authority_stale",
      "AcceptedDerivativeSet intent snapshot is stale versus current effective derivative policy; re-accept derivatives.",
    );
  }

  // 10. Summary member verification
  let summaryResult: VerifiedProductionDerivativeSet["summary"];
  if (setData.summary.state === "accepted") {
    if (setRow.summaryState !== "accepted" || !setRow.summaryArtifactId) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Derivative set row summary state mismatch.",
      );
    }
    const [summaryArtifact] = await input.db
      .select()
      .from(acceptedSummaryArtifacts)
      .where(
        and(
          eq(acceptedSummaryArtifacts.id, setRow.summaryArtifactId),
          eq(acceptedSummaryArtifacts.projectId, input.projectId),
        ),
      );
    if (!summaryArtifact) {
      throw new FactoryError(
        "derivative_required_artifact_missing",
        `Bound accepted summary "${setRow.summaryArtifactId}" does not exist.`,
      );
    }
    if (summaryArtifact.projectId !== input.projectId) {
      throw new FactoryError(
        "derivative_authority_wrong_project",
        "Accepted summary belongs to a different project.",
      );
    }
    if (summaryArtifact.pageIdentity !== input.pageIdentity) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Accepted summary page identity mismatch.",
      );
    }
    if (
      summaryArtifact.version !== setData.summary.version ||
      summaryArtifact.artifactDigest !== setData.summary.digest ||
      summaryArtifact.version !== setRow.summaryVersion ||
      summaryArtifact.artifactDigest !== setRow.summaryDigest
    ) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Bound accepted summary drifted from the derivative set.",
      );
    }
    // Truth-based production gate (Section 12, 13)
    assertSummaryProductionAuthority({
      providerMode: summaryArtifact.providerMode,
      isTestDouble: summaryArtifact.isTestDouble,
      provider: summaryArtifact.provider,
    });
    const summaryData = parseAcceptedSummaryArtifactData({
      schemaVersion: "derivatives-v1",
      projectId: summaryArtifact.projectId,
      pageIdentity: summaryArtifact.pageIdentity,
      sourceContent: {
        id: summaryArtifact.sourceContentId,
        version: summaryArtifact.sourceContentVersion,
        digest: summaryArtifact.sourceContentDigest,
      },
      intentSnapshot: {
        id: summaryArtifact.intentSnapshotId,
        digest: summaryArtifact.intentSnapshotDigest,
      },
      promptSnapshot: {
        id: summaryArtifact.promptSnapshotId,
        digest: summaryArtifact.promptSnapshotDigest,
      },
      providerMode: summaryArtifact.providerMode,
      isTestDouble: summaryArtifact.isTestDouble,
      provider: summaryArtifact.provider,
      model: summaryArtifact.model,
      language: summaryArtifact.language,
      proposalDigest: summaryArtifact.proposalDigest,
      summaryText: summaryArtifact.summaryText,
      qaReportDigest: summaryArtifact.qaReportDigest,
      qaOverall: summaryArtifact.qaOverall,
    });
    const recomputedSummaryDigest = acceptedSummaryArtifactDigest(summaryData);
    if (recomputedSummaryDigest !== summaryArtifact.artifactDigest) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Accepted summary recomputed digest mismatch (forged summary artifact).",
      );
    }
    if (
      summaryArtifact.sourceContentId !== input.currentContent.id ||
      summaryArtifact.sourceContentVersion !== input.currentContent.version ||
      summaryArtifact.sourceContentDigest !== input.currentContent.digest
    ) {
      throw new FactoryError(
        "production_authority_stale",
        "Accepted summary is stale versus current accepted content.",
      );
    }
    if (summaryArtifact.intentSnapshotDigest !== currentIntent.digest) {
      throw new FactoryError(
        "production_authority_stale",
        "Accepted summary intent snapshot is stale versus current effective derivative policy.",
      );
    }
    summaryResult = {
      state: "accepted",
      acceptedId: summaryArtifact.id,
      acceptedVersion: summaryArtifact.version,
      acceptedDigest: summaryArtifact.artifactDigest,
      language: summaryArtifact.language,
      summaryText: summaryArtifact.summaryText,
    };
  } else {
    if (setRow.summaryState !== "disabled") {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Derivative set row summary state is not disabled.",
      );
    }
    summaryResult = { state: "disabled" };
  }

  // 11. Audio member verification
  let audioResult: VerifiedProductionDerivativeSet["audio"];
  if (setData.audio.state === "accepted") {
    if (setRow.audioState !== "accepted" || !setRow.audioArtifactId) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Derivative set row audio state mismatch.",
      );
    }
    const [audioArtifact] = await input.db
      .select()
      .from(acceptedAudioArtifacts)
      .where(
        and(
          eq(acceptedAudioArtifacts.id, setRow.audioArtifactId),
          eq(acceptedAudioArtifacts.projectId, input.projectId),
        ),
      );
    if (!audioArtifact) {
      throw new FactoryError(
        "derivative_required_artifact_missing",
        `Bound accepted audio "${setRow.audioArtifactId}" does not exist.`,
      );
    }
    if (audioArtifact.projectId !== input.projectId) {
      throw new FactoryError(
        "derivative_authority_wrong_project",
        "Accepted audio belongs to a different project.",
      );
    }
    if (audioArtifact.pageIdentity !== input.pageIdentity) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Accepted audio page identity mismatch.",
      );
    }
    if (
      audioArtifact.version !== setData.audio.version ||
      audioArtifact.artifactDigest !== setData.audio.digest ||
      audioArtifact.binaryDigest !== setData.audio.binaryDigest ||
      audioArtifact.version !== setRow.audioVersion ||
      audioArtifact.artifactDigest !== setRow.audioDigest ||
      audioArtifact.binaryDigest !== setRow.audioBinaryDigest
    ) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Bound accepted audio drifted from the derivative set.",
      );
    }
    // Truth-based production gate (Section 14)
    assertAudioProductionAuthority({
      providerMode: audioArtifact.providerMode,
      isTestDouble: audioArtifact.isTestDouble,
      provider: audioArtifact.provider,
    });
    const audioData = parseAcceptedAudioArtifactData({
      schemaVersion: "derivatives-v1",
      projectId: audioArtifact.projectId,
      pageIdentity: audioArtifact.pageIdentity,
      sourceContent: {
        id: audioArtifact.sourceContentId,
        version: audioArtifact.sourceContentVersion,
        digest: audioArtifact.sourceContentDigest,
      },
      narrationSnapshot: {
        id: audioArtifact.narrationSnapshotId,
        digest: audioArtifact.narrationSnapshotDigest,
      },
      providerMode: audioArtifact.providerMode,
      isTestDouble: audioArtifact.isTestDouble,
      provider: audioArtifact.provider,
      engine: audioArtifact.engine,
      voiceId: audioArtifact.voiceId,
      language: audioArtifact.language,
      candidateDigest: audioArtifact.candidateDigest,
      binaryDigest: audioArtifact.binaryDigest,
      mimeType: audioArtifact.mimeType,
      sizeBytes: audioArtifact.sizeBytes,
      durationSeconds: audioArtifact.durationSeconds,
    });
    const recomputedAudioDigest = acceptedAudioArtifactDigest(audioData);
    if (recomputedAudioDigest !== audioArtifact.artifactDigest) {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Accepted audio recomputed digest mismatch (forged audio artifact).",
      );
    }
    if (
      audioArtifact.sourceContentId !== input.currentContent.id ||
      audioArtifact.sourceContentVersion !== input.currentContent.version ||
      audioArtifact.sourceContentDigest !== input.currentContent.digest
    ) {
      throw new FactoryError(
        "production_authority_stale",
        "Accepted audio is stale versus current accepted content.",
      );
    }
    // Check current narration snapshot
    const currentNarration = await derivStore.currentNarrationSnapshot(
      input.projectId,
      input.pageIdentity,
    );
    if (
      !currentNarration ||
      currentNarration.id !== audioArtifact.narrationSnapshotId ||
      currentNarration.narrationDigest !== audioArtifact.narrationSnapshotDigest ||
      currentNarration.sourceContentId !== input.currentContent.id ||
      currentNarration.sourceContentVersion !== input.currentContent.version ||
      currentNarration.sourceContentDigest !== input.currentContent.digest
    ) {
      throw new FactoryError(
        "production_authority_stale",
        "Accepted audio narration snapshot is stale versus current accepted content.",
      );
    }

    let bytes: Uint8Array | undefined;
    if (input.storage) {
      try {
        bytes = await input.storage.getObject(
          input.storage.derivativeKey(audioArtifact.binaryDigest),
        );
      } catch {
        throw new FactoryError(
          "derivative_binary_digest_mismatch",
          "Stored audio bytes not found under recorded digest.",
        );
      }
      if (sha256HexBytes(bytes) !== audioArtifact.binaryDigest) {
        throw new FactoryError(
          "derivative_binary_digest_mismatch",
          "Stored audio bytes do not match the accepted binary digest.",
        );
      }
    }

    audioResult = {
      state: "accepted",
      acceptedId: audioArtifact.id,
      acceptedVersion: audioArtifact.version,
      acceptedDigest: audioArtifact.artifactDigest,
      binaryDigest: audioArtifact.binaryDigest,
      mimeType: audioArtifact.mimeType,
      durationSeconds: audioArtifact.durationSeconds,
      bytes,
    };
  } else {
    if (setRow.audioState !== "disabled") {
      throw new FactoryError(
        "derivative_authority_digest_mismatch",
        "Derivative set row audio state is not disabled.",
      );
    }
    audioResult = { state: "disabled" };
  }

  return {
    set: setRow,
    setData,
    summary: summaryResult,
    audio: audioResult,
  };
}
