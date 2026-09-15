import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import {
  audioCandidates as audioCandidatesTable,
  summaryPromptSnapshots as summaryPromptSnapshotsTable,
  acceptedAudioArtifacts as acceptedAudioArtifactsTable,
  summaryProposals as summaryProposalsTable,
} from "../persistence/schema.js";
import {
  type AcceptedDerivativeSetData,
  type AcceptedPageContentData,
  type AcceptedSummaryArtifactData,
  type AcceptedAudioArtifactData,
  type AudioCandidateData,
  type NarrationTextSnapshotData,
  type PageDerivativeIntentSnapshotData,
  type PageDerivativeOverrideData,
  type ProjectDerivativePolicyData,
  type SummaryProposalData,
  type SummaryQaReportData,
} from "@factory/contracts";
import { PageAuthorityReader } from "../writer/page-authority.js";
import { WriterBudgetStore } from "../writer/budget.js";
import { createAssetStorage, sha256HexBytes, type AssetStorage } from "../assets/storage.js";
import { DerivativesStore } from "./store.js";
import {
  NARRATION_POLICY_VERSION,
  FixtureAudioNarrationProvider,
  assertAudioProductionAuthority,
  type AudioNarrationProvider,
} from "./audio-provider.js";
import {
  assertSummaryProductionAuthority,
  deriveCurrentDerivativeIntentAuthority,
} from "./production-verifier.js";
import {
  SUMMARY_POLICY_VERSION,
  SUMMARY_MAX_OUTPUT_TOKENS,
  compileSummaryPrompt,
} from "./summary-prompt.js";
import {
  resolveSummaryModel,
  runSummaryInvocation,
  type SummaryProviderDeps,
} from "./summary-provider.js";
import { runSummaryQa } from "./summary-qa.js";
import {
  readAcceptedPageCopy,
  acceptedAudioArtifactDigest,
  acceptedDerivativeSetDigest,
  acceptedSummaryArtifactDigest,
  derivativeError,
  narrationTextSnapshotDigest,
  pageDerivativeIntentSnapshotDigest,
  projectDerivativePolicyDigest,
  pageDerivativeOverrideDigest,
  projectNarrationText,
  resolveEffectiveDerivativeSettings,
} from "./core.js";

/**
 * DERIVATIVES SERVICE — Run 10 application service.
 *
 * Owns the complete derivative lifecycle:
 *   policy/override management → intent snapshot (idempotent) →
 *   summary (prompt snapshot → provider → proposal → QA → human accept) →
 *   audio (narration snapshot → provider → candidate → human accept) →
 *   accepted derivative set.
 *
 * Business rules live here, not in route handlers. Every acceptance runs
 * under the shared project advisory lock and re-verifies all bound digests
 * inside the transaction (unsafe already-stale acceptance impossible).
 * Provider output is NEVER acceptance; fixture output is NEVER production
 * authority.
 */

export interface DerivativesServiceDeps {
  budget: WriterBudgetStore;
  summary?: Partial<SummaryProviderDeps>;
  audioProvider?: AudioNarrationProvider;
  storage?: AssetStorage;
}

export class DerivativesService {
  private readonly store: DerivativesStore;
  private readonly audioProvider: AudioNarrationProvider;
  private readonly storage: AssetStorage;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
    private readonly deps: DerivativesServiceDeps,
  ) {
    this.store = new DerivativesStore(db);
    this.audioProvider = deps.audioProvider ?? new FixtureAudioNarrationProvider();
    this.storage = deps.storage ?? createAssetStorage(repoRoot);
  }

  // -- Policy / overrides -----------------------------------------------------

  async updateProjectPolicy(input: {
    projectId: string;
    summary: { enabled: boolean; language: string; policyVersion: string };
    audio: { enabled: boolean; language: string; voiceId?: string; policyVersion: string };
  }) {
    const draft: ProjectDerivativePolicyData = {
      schemaVersion: "derivatives-v1",
      projectId: input.projectId,
      summary: input.summary,
      audio: {
        enabled: input.audio.enabled,
        language: input.audio.language,
        voiceId: input.audio.voiceId,
        policyVersion: input.audio.policyVersion,
      },
      version: 0,
    };
    // Version assigned durably inside the project lock; digest recomputed there.
    const row = await this.store.createPolicyVersion({
      projectId: input.projectId,
      data: draft,
      policyDigest: "",
    });
    return row;
  }

  async updatePageOverride(input: {
    projectId: string;
    pageIdentity: string;
    summary: { mode: "inherit" | "enabled" | "disabled"; language?: string };
    audio: { mode: "inherit" | "enabled" | "disabled"; language?: string; voiceId?: string };
  }) {
    const draft: PageDerivativeOverrideData = {
      schemaVersion: "derivatives-v1",
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      summary: input.summary,
      audio: input.audio,
      version: 0,
    };
    const row = await this.store.createOverrideVersion({
      projectId: input.projectId,
      data: draft,
      overrideDigest: "",
    });
    return row;
  }

  // -- Intent snapshot ----------------------------------------------------------

  /**
   * Derive (or reuse) the immutable intent snapshot for the current accepted
   * content. Idempotent: identical authoritative inputs return the existing
   * snapshot row.
   */
  async deriveIntentSnapshot(input: { projectId: string; pageIdentity: string }) {
    return this.store.withProjectLock(input.projectId, async (tx) => {
      const txStore = new DerivativesStore(tx);
      const content = await this.requireCurrentContent(input.projectId, input.pageIdentity);
      const { data, digest: snapshotDigest } = await deriveCurrentDerivativeIntentAuthority(
        txStore,
        input.projectId,
        input.pageIdentity,
        { id: content.id, version: content.version, digest: content.contentDigest },
      );

      const existing = await txStore.findIntentSnapshot(input.projectId, input.pageIdentity, snapshotDigest);
      if (existing) return { snapshot: existing, reused: true, content };

      const inserted = await txStore.insertIntentSnapshot({
        id: `deriv_intent_${randomUUID()}`,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        data,
        snapshotDigest,
      });
      return { snapshot: inserted, reused: false, content };
    });
  }

  // -- Summary lifecycle ----------------------------------------------------------

  /** Compile (or reuse) the immutable SummaryPromptSnapshot for an intent snapshot. */
  async compileSummaryPromptSnapshot(input: { projectId: string; pageIdentity: string }) {
    const { snapshot, content } = await this.deriveIntentSnapshot(input);
    if (snapshot.effectiveSummaryState !== "enabled") {
      throw derivativeError(
        "derivative_generation_blocked",
        "Summary is disabled by effective derivative policy; generation is blocked.",
      );
    }
    const existing = await this.store.findPromptSnapshotByIntent(snapshot.id);
    if (existing) return { promptSnapshot: existing, reused: true, content };

    const resolved = resolveSummaryModel();
    const compiled = compileSummaryPrompt({
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
      acceptedContent: { id: content.id, version: content.version, digest: content.contentDigest },
      content: readAcceptedPageCopy(content.data),
      effectiveSummary: {
        state: "enabled",
        language: snapshot.effectiveSummaryLanguage,
        policyVersion: snapshot.effectiveSummaryPolicyVersion,
      },
      provider: resolved.policy.gateway,
      model: resolved.model,
    });
    const inserted = await this.store.insertPromptSnapshot({
      id: `summary_prompt_${randomUUID()}`,
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      data: compiled.data,
      promptDigest: compiled.promptDigest,
    });
    return { promptSnapshot: inserted, reused: false, content };
  }

  /** Generate a summary proposal from the current prompt snapshot (provider call under budget). */
  async generateSummaryProposal(input: { projectId: string; pageIdentity: string }) {
    const { promptSnapshot, content } = await this.compileSummaryPromptSnapshot(input);
    const contentData = readAcceptedPageCopy(content.data);

    // Preflight: content must still be current at generation time.
    await this.requireCurrentContentRef(input.projectId, input.pageIdentity, {
      id: content.id,
      version: content.version,
      digest: content.contentDigest,
    });

    const result = await runSummaryInvocation(
      {
        promptSnapshotDigest: promptSnapshot.promptDigest,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        systemPrompt: promptSnapshot.systemPrompt,
        userPrompt: promptSnapshot.userPrompt,
      },
      {
        budget: this.deps.budget,
        ...(this.deps.summary ?? {}),
      },
    );

    const resolved = resolveSummaryModel();
    const proposalData: SummaryProposalData = {
      schemaVersion: "derivatives-v1",
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      promptSnapshot: { id: promptSnapshot.id, digest: promptSnapshot.promptDigest },
      acceptedContent: { id: content.id, version: content.version, digest: content.contentDigest },
      providerMode: this.deps.summary?.invoke ? "fixture" : "live",
      isTestDouble: Boolean(this.deps.summary?.invoke),
      provider: resolved.policy.gateway,
      model: result.model,
      summaryText: result.content.trim(),
      providerRequestId: result.providerRequestId,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        costMicros: null,
        currency: "UNKNOWN",
      },
    };
    const proposalDigest = deterministicDigest({
      ...proposalData,
      summaryText: proposalData.summaryText,
    });
    const inserted = await this.store.insertSummaryProposal({
      id: `summary_proposal_${randomUUID()}`,
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      data: proposalData,
      proposalDigest,
    });

    // Deterministic QA runs immediately; the report binds to the proposal digest.
    const qa: SummaryQaReportData = runSummaryQa({
      proposalId: inserted.id,
      proposalDigest,
      summaryText: proposalData.summaryText,
      sourceContent: contentData,
      expectedLanguage: proposalData.providerMode === "fixture" ? promptSnapshot.language : promptSnapshot.language,
    });
    const qaReportDigest = deterministicDigest(qa);
    await this.store.recordSummaryQa({
      proposalId: inserted.id,
      qaReport: qa,
      qaReportDigest,
      qaOverall: qa.overall,
    });

    return { proposal: inserted, qa, qaReportDigest, promptSnapshot };
  }

  /** Human acceptance gate: provider success is NOT acceptance. */
  async acceptSummary(input: { projectId: string; pageIdentity: string; proposalId: string }) {
    return this.store.withProjectLock(input.projectId, async (tx) => {
      const txStore = new DerivativesStore(tx);
      const proposal = await txStore.getSummaryProposal(input.projectId, input.proposalId);
      if (!proposal) {
        throw derivativeError("derivative_required_artifact_missing", "Summary proposal not found for this project.");
      }
      if (proposal.state === "accepted" || proposal.state === "superseded") {
        throw derivativeError("derivative_artifact_immutable", `Proposal is already ${proposal.state}.`);
      }
      if (proposal.qaOverall === "FAIL" || proposal.qaOverall == null) {
        throw derivativeError("derivative_qa_failed", "Summary QA has not passed; acceptance is blocked.");
      }

      // Production authority gate (Section 12, 13, 18):
      // Fixture output can never be accepted as production authority.
      assertSummaryProductionAuthority({
        providerMode: proposal.providerMode,
        isTestDouble: proposal.isTestDouble,
        provider: proposal.provider,
      });

      // Content must STILL be current inside the acceptance lock.
      const content = await this.requireCurrentContentRefTx(tx, input.projectId, input.pageIdentity, {
        id: proposal.acceptedContentId,
        version: proposal.acceptedContentVersion,
        digest: proposal.acceptedContentDigest,
      });

      // The bound intent snapshot must be the current effective policy.
      const { snapshot } = await this.deriveIntentSnapshotInTx(txStore, input.projectId, input.pageIdentity, content);
      if (snapshot.id !== (await this.promptIntentId(tx, proposal.promptSnapshotId))) {
        throw derivativeError(
          "derivative_authority_stale",
          "Bound prompt snapshot no longer matches the current effective intent; regenerate the summary.",
        );
      }

      const data: AcceptedSummaryArtifactData = {
        schemaVersion: "derivatives-v1",
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        sourceContent: {
          id: proposal.acceptedContentId,
          version: proposal.acceptedContentVersion,
          digest: proposal.acceptedContentDigest,
        },
        intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
        promptSnapshot: { id: proposal.promptSnapshotId, digest: proposal.promptSnapshotDigest },
        providerMode: proposal.providerMode as "live" | "fixture",
        isTestDouble: proposal.isTestDouble,
        provider: proposal.provider,
        model: proposal.model,
        language: await this.promptLanguage(tx, proposal.promptSnapshotId),
        proposalDigest: proposal.proposalDigest,
        summaryText: proposal.summaryText,
        qaReportDigest: proposal.qaReportDigest!,
        qaOverall: proposal.qaOverall as "PASS" | "REVIEW",
      };
      const artifactDigest = acceptedSummaryArtifactDigest(data);
      const current = await txStore.currentAcceptedSummary(input.projectId, input.pageIdentity);
      const version = (current?.version ?? 0) + 1;
      const inserted = await txStore.insertAcceptedSummary({
        id: `accepted_summary_${randomUUID()}`,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        data,
        proposalId: input.proposalId,
        artifactDigest,
        version,
      });
      await tx
        .update(summaryProposalsTable)
        .set({ state: "accepted" })
        .where(eq(summaryProposalsTable.id, input.proposalId));
      return inserted;
    });
  }

  // -- Audio lifecycle ------------------------------------------------------------

  /** Derive (or reuse) the deterministic NarrationTextSnapshot for current content. */
  async deriveNarrationSnapshot(input: { projectId: string; pageIdentity: string }) {
    const content = await this.requireCurrentContent(input.projectId, input.pageIdentity);
    const contentData = readAcceptedPageCopy(content.data);
    const { snapshot } = await this.deriveIntentSnapshot(input);
    if (snapshot.effectiveAudioState !== "enabled") {
      throw derivativeError(
        "derivative_generation_blocked",
        "Audio is disabled by effective derivative policy; narration is blocked.",
      );
    }
    const narrationText = projectNarrationText(contentData);
    const data: NarrationTextSnapshotData = {
      schemaVersion: "derivatives-v1",
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      sourceContent: { id: content.id, version: content.version, digest: content.contentDigest },
      narrationPolicyVersion: NARRATION_POLICY_VERSION,
      language: snapshot.effectiveAudioLanguage,
      narrationText,
    };
    const narrationDigest = narrationTextSnapshotDigest(data);
    const existing = await this.store.findNarrationSnapshot(input.projectId, input.pageIdentity, narrationDigest);
    if (existing) return { snapshot: existing, reused: true, intent: snapshot };

    const inserted = await this.store.insertNarrationSnapshot({
      id: `narration_${randomUUID()}`,
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      data,
      narrationDigest,
    });
    return { snapshot: inserted, reused: false, intent: snapshot };
  }

  /** Generate an audio candidate from the current narration snapshot (fail-before-spend preflight). */
  async generateAudioCandidate(input: { projectId: string; pageIdentity: string }) {
    const { snapshot: narration, intent } = await this.deriveNarrationSnapshot(input);

    // Preflight: narration must still be current; voice valid; provider ready.
    await this.requireCurrentContentRef(input.projectId, input.pageIdentity, {
      id: narration.sourceContentId,
      version: narration.sourceContentVersion,
      digest: narration.sourceContentDigest,
    });
    await this.audioProvider.preflight({ voiceId: intent.effectiveAudioVoiceId ?? "", language: narration.language });

    const result = await this.audioProvider.synthesize({
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      narrationSnapshotDigest: narration.narrationDigest,
      narrationText: narration.narrationText,
      language: narration.language,
      voiceId: intent.effectiveAudioVoiceId ?? "none",
    });

    // Binary integrity: digest over the EXACT bytes returned.
    const binaryDigest = sha256HexBytes(result.bytes);
    await this.storage.putObject(this.storage.derivativeKey(binaryDigest), result.bytes);

    const data: AudioCandidateData = {
      schemaVersion: "derivatives-v1",
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      narrationSnapshot: { id: narration.id, digest: narration.narrationDigest },
      providerMode: this.audioProvider.providerMode,
      isTestDouble: this.audioProvider.isTestDouble,
      provider: result.provider,
      engine: result.engine,
      voiceId: intent.effectiveAudioVoiceId ?? "none",
      language: narration.language,
      providerRequestId: result.providerRequestId,
      binaryDigest,
      mimeType: result.mimeType,
      sizeBytes: result.bytes.length,
      durationSeconds: result.durationSeconds,
      usage: {
        characters: result.usage.characters,
        costMicros: result.usage.costMicros,
        currency: result.usage.currency,
      },
    };
    const candidateDigest = deterministicDigest(data);
    const inserted = await this.store.insertAudioCandidate({
      id: `audio_candidate_${randomUUID()}`,
      projectId: input.projectId,
      pageIdentity: input.pageIdentity,
      data,
      candidateDigest,
    });
    return { candidate: inserted, binaryDigest, mimeType: result.mimeType };
  }

  /** Human acceptance gate for audio (operator has listened/reviewed). */
  async acceptAudio(input: { projectId: string; pageIdentity: string; candidateId: string }) {
    return this.store.withProjectLock(input.projectId, async (tx) => {
      const txStore = new DerivativesStore(tx);
      const candidate = await txStore.getAudioCandidate(input.projectId, input.candidateId);
      if (!candidate) {
        throw derivativeError("derivative_required_artifact_missing", "Audio candidate not found for this project.");
      }
      if (candidate.state === "accepted" || candidate.state === "superseded") {
        throw derivativeError("derivative_artifact_immutable", `Candidate is already ${candidate.state}.`);
      }

      // Production authority gate: fixture output can never be accepted as
      // production authority (LIVE TTS PROVIDER ACTIVATION PENDING PROVIDER POLICY).
      assertAudioProductionAuthority({
        providerMode: candidate.providerMode,
        isTestDouble: candidate.isTestDouble,
        provider: candidate.provider,
      });

      // Narration must STILL be current inside the acceptance lock.
      const narrationCurrent = await txStore.currentNarrationSnapshot(input.projectId, input.pageIdentity);
      if (
        !narrationCurrent ||
        narrationCurrent.id !== candidate.narrationSnapshotId ||
        narrationCurrent.narrationDigest !== candidate.narrationSnapshotDigest
      ) {
        throw derivativeError(
          "derivative_authority_stale",
          "Narration snapshot is stale versus current accepted content; re-derive narration before accepting audio.",
        );
      }
      // The narration's source content must be the CURRENT accepted content.
      await this.requireCurrentContentRefTx(tx, input.projectId, input.pageIdentity, {
        id: narrationCurrent.sourceContentId,
        version: narrationCurrent.sourceContentVersion,
        digest: narrationCurrent.sourceContentDigest,
      });

      // Binary integrity: stored bytes must exist and match the recorded
      // digest. Missing or mismatched bytes both fail closed as a forged
      // binary digest (never leak raw storage errors).
      let stored: Uint8Array;
      try {
        stored = await this.storage.getObject(this.storage.derivativeKey(candidate.binaryDigest));
      } catch {
        throw derivativeError(
          "derivative_binary_digest_mismatch",
          "No audio binary is stored under the recorded digest (forged binary digest).",
        );
      }
      if (sha256HexBytes(stored) !== candidate.binaryDigest) {
        throw derivativeError(
          "derivative_binary_digest_mismatch",
          "Stored audio bytes do not match the recorded binary digest (forged or corrupted binary).",
        );
      }

      const data: AcceptedAudioArtifactData = {
        schemaVersion: "derivatives-v1",
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        sourceContent: {
          id: narrationCurrent.sourceContentId,
          version: narrationCurrent.sourceContentVersion,
          digest: narrationCurrent.sourceContentDigest,
        },
        narrationSnapshot: { id: narrationCurrent.id, digest: narrationCurrent.narrationDigest },
        providerMode: candidate.providerMode as "live" | "fixture",
        isTestDouble: candidate.isTestDouble,
        provider: candidate.provider,
        engine: candidate.engine,
        voiceId: candidate.voiceId,
        language: candidate.language,
        candidateDigest: candidate.candidateDigest,
        binaryDigest: candidate.binaryDigest,
        mimeType: candidate.mimeType as AcceptedAudioArtifactData["mimeType"],
        sizeBytes: candidate.sizeBytes,
        durationSeconds: candidate.durationSeconds,
      };
      const artifactDigest = acceptedAudioArtifactDigest(data);
      const current = await txStore.currentAcceptedAudio(input.projectId, input.pageIdentity);
      const version = (current?.version ?? 0) + 1;
      const inserted = await txStore.insertAcceptedAudio({
        id: `accepted_audio_${randomUUID()}`,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        data,
        candidateId: input.candidateId,
        artifactDigest,
        version,
      });
      await tx
        .update(audioCandidatesTable)
        .set({ state: "accepted" })
        .where(eq(audioCandidatesTable.id, input.candidateId));
      return inserted;
    });
  }

  // -- Accepted derivative set ------------------------------------------------------

  /** Accept the page-level derivative set from currently accepted artifacts. */
  async acceptDerivativeSet(input: { projectId: string; pageIdentity: string }) {
    return this.store.withProjectLock(input.projectId, async (tx) => {
      const txStore = new DerivativesStore(tx);
      const { snapshot, content } = await this.deriveIntentSnapshotInTx(txStore, input.projectId, input.pageIdentity, null);

      const summaryCurrent = await txStore.currentAcceptedSummary(input.projectId, input.pageIdentity);
      const audioCurrent = await txStore.currentAcceptedAudio(input.projectId, input.pageIdentity);

      const summaryState = snapshot.effectiveSummaryState === "enabled" ? "accepted" : "disabled";
      const audioState = snapshot.effectiveAudioState === "enabled" ? "accepted" : "disabled";

      // Readiness rule: enabled-but-missing current accepted artifact FAILS.
      if (summaryState === "accepted" && !summaryCurrent) {
        throw derivativeError(
          "derivative_required_artifact_missing",
          "Effective policy enables summary but no current accepted summary exists.",
        );
      }
      if (audioState === "accepted" && !audioCurrent) {
        throw derivativeError(
          "derivative_required_artifact_missing",
          "Effective policy enables audio but no current accepted audio exists.",
        );
      }
      // Accepted artifacts must bind the CURRENT content.
      if (summaryCurrent && (summaryCurrent.sourceContentId !== content.id || summaryCurrent.sourceContentVersion !== content.version || summaryCurrent.sourceContentDigest !== content.contentDigest)) {
        throw derivativeError("derivative_authority_stale", "Accepted summary is stale versus current accepted content.");
      }
      if (audioCurrent && (audioCurrent.sourceContentId !== content.id || audioCurrent.sourceContentVersion !== content.version || audioCurrent.sourceContentDigest !== content.contentDigest)) {
        throw derivativeError("derivative_authority_stale", "Accepted audio is stale versus current accepted content.");
      }

      // Production authority gate (Section 12, 13, 18):
      // Fixture/test-double derivative output can never become production authority.
      if (summaryState === "accepted" && summaryCurrent) {
        assertSummaryProductionAuthority({
          providerMode: summaryCurrent.providerMode,
          isTestDouble: summaryCurrent.isTestDouble,
          provider: summaryCurrent.provider,
        });
      }
      if (audioState === "accepted" && audioCurrent) {
        assertAudioProductionAuthority({
          providerMode: audioCurrent.providerMode,
          isTestDouble: audioCurrent.isTestDouble,
          provider: audioCurrent.provider,
        });
      }

      const baseData = {
        schemaVersion: "derivatives-v1" as const,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        sourceContent: { id: content.id, version: content.version, digest: content.contentDigest },
        intentSnapshot: { id: snapshot.id, digest: snapshot.snapshotDigest },
        summary:
          summaryState === "accepted" && summaryCurrent
            ? {
                state: "accepted" as const,
                acceptedArtifactId: summaryCurrent.id,
                version: summaryCurrent.version,
                digest: summaryCurrent.artifactDigest,
              }
            : { state: "disabled" as const },
        audio:
          audioState === "accepted" && audioCurrent
            ? {
                state: "accepted" as const,
                acceptedArtifactId: audioCurrent.id,
                version: audioCurrent.version,
                digest: audioCurrent.artifactDigest,
                binaryDigest: audioCurrent.binaryDigest,
              }
            : { state: "disabled" as const },
      };

      const current = await txStore.currentDerivativeSet(input.projectId, input.pageIdentity);
      if (current) {
        const candidateForCurrent: AcceptedDerivativeSetData = {
          ...baseData,
          version: current.version,
        };
        if (acceptedDerivativeSetDigest(candidateForCurrent) === current.setDigest) {
          return { set: current, reused: true };
        }
      }

      // Canonical Option A: calculate final version first, construct final data,
      // compute setDigest on final data, then insert.
      const nextVersion = (current?.version ?? 0) + 1;
      const finalData: AcceptedDerivativeSetData = {
        ...baseData,
        version: nextVersion,
      };
      const setDigest = acceptedDerivativeSetDigest(finalData);
      const inserted = await txStore.insertDerivativeSet({
        id: `derivative_set_${randomUUID()}`,
        projectId: input.projectId,
        pageIdentity: input.pageIdentity,
        data: finalData,
        setDigest,
        version: nextVersion,
      });
      if (current) await txStore.markSetSuperseded(input.projectId, current.id);
      return { set: inserted, reused: false };
    });
  }

  // -- Status / staleness -------------------------------------------------------------

  /** Backend-computed operator status for one page's derivatives. */
  async derivativeStatus(input: { projectId: string; pageIdentity: string }) {
    const content = await this.currentContentOrNull(input.projectId, input.pageIdentity);
    const policyRow = await this.store.currentPolicy(input.projectId);
    const overrideRow = await this.store.currentOverride(input.projectId, input.pageIdentity);
    const effective = resolveEffectiveDerivativeSettings({
      projectPolicy: policyRow ? (policyRow.data as ProjectDerivativePolicyData) : null,
      pageOverride: overrideRow ? (overrideRow.data as PageDerivativeOverrideData) : null,
    });
    const intent = await this.store.currentIntentSnapshot(input.projectId, input.pageIdentity);
    const summary = await this.store.currentAcceptedSummary(input.projectId, input.pageIdentity);
    const audio = await this.store.currentAcceptedAudio(input.projectId, input.pageIdentity);
    const set = await this.store.currentDerivativeSet(input.projectId, input.pageIdentity);

    const sourceStale = (source: { sourceContentId: string; sourceContentVersion: number; sourceContentDigest: string } | null) =>
      !content || !source ||
      source.sourceContentId !== content.id ||
      source.sourceContentVersion !== content.version ||
      source.sourceContentDigest !== content.contentDigest;

    const summaryStatus =
      effective.summary.state === "disabled"
        ? "DISABLED"
        : !summary
          ? "READY"
          : sourceStale(summary) || (intent ? summary.intentSnapshotDigest !== intent.snapshotDigest : false)
            ? "STALE"
            : "ACCEPTED";
    // Audio is stale when its source content moved, its narration snapshot is
    // superseded, OR the current effective intent (policy/voice) no longer
    // matches the intent the audio's narration was derived from. Voice-only
    // mutation changes the intent but leaves the summary policy untouched, so
    // the summary stays current while audio goes stale.
    const narrationCurrent = await this.store.currentNarrationSnapshot(input.projectId, input.pageIdentity);
    const narrationSuperseded =
      Boolean(narrationCurrent) && Boolean(audio) && narrationCurrent!.narrationDigest !== audio!.narrationSnapshotDigest;
    // Voice-only mutation: the accepted audio was synthesized with the old
    // effective voice; the current effective voice differs → stale. The
    // summary policy is untouched, so the summary stays current.
    const voiceSuperseded = Boolean(audio) && audio!.voiceId !== effective.audio.voiceId;
    const audioStatus =
      effective.audio.state === "disabled"
        ? "DISABLED"
        : !audio
          ? "READY"
          : sourceStale(audio) || narrationSuperseded || voiceSuperseded
            ? "STALE"
            : "ACCEPTED";
    const setStatus = !set ? (effective.summary.state === "disabled" && effective.audio.state === "disabled" ? "DISABLED" : "READY") : sourceStale(set) ? "STALE" : "ACCEPTED";

    return {
      summary: { status: summaryStatus, effective: effective.summary, artifact: summary },
      audio: { status: audioStatus, effective: effective.audio, artifact: audio },
      set: { status: setStatus, set },
      intent: { snapshot: intent },
    };
  }

  // -- Internal helpers -----------------------------------------------------------------

  private async currentContentOrNull(projectId: string, pageIdentity: string) {
    const pages = await new PageAuthorityReader(this.db).currentPages(projectId);
    return pages.find((row) => row.slug === pageIdentity) ?? null;
  }

  private async requireCurrentContent(projectId: string, pageIdentity: string) {
    const page = await this.currentContentOrNull(projectId, pageIdentity);
    if (!page) {
      throw derivativeError("derivative_required_artifact_missing", `No current accepted content for page ${pageIdentity}.`);
    }
    return page;
  }

  private async requireCurrentContentRef(
    projectId: string,
    pageIdentity: string,
    ref: { id: string; version: number; digest: string },
  ) {
    const page = await this.requireCurrentContent(projectId, pageIdentity);
    if (page.id !== ref.id || page.version !== ref.version || page.contentDigest !== ref.digest) {
      throw derivativeError(
        "derivative_authority_stale",
        "Bound accepted content is stale versus current accepted content; re-derive derivatives.",
      );
    }
    return page;
  }

  private async requireCurrentContentRefTx(
    tx: FactoryDb,
    projectId: string,
    pageIdentity: string,
    ref: { id: string; version: number; digest: string },
  ) {
    const page = await new PageAuthorityReader(tx).currentPages(projectId);
    const current = page.find((row) => row.slug === pageIdentity);
    if (!current) throw derivativeError("derivative_required_artifact_missing", "No current accepted content.");
    if (current.id !== ref.id || current.version !== ref.version || current.contentDigest !== ref.digest) {
      throw derivativeError("derivative_authority_stale", "Bound accepted content is stale.");
    }
    return current;
  }

  private async deriveIntentSnapshotInTx(
    txStore: DerivativesStore,
    projectId: string,
    pageIdentity: string,
    content: { id: string; version: number; contentDigest: string } | null,
  ) {
    const resolvedContent = content ?? (await this.requireCurrentContent(projectId, pageIdentity));
    const { data, digest: snapshotDigest } = await deriveCurrentDerivativeIntentAuthority(
      txStore,
      projectId,
      pageIdentity,
      { id: resolvedContent.id, version: resolvedContent.version, digest: resolvedContent.contentDigest },
    );
    const existing = await txStore.findIntentSnapshot(projectId, pageIdentity, snapshotDigest);
    const snapshot = existing ?? (await txStore.insertIntentSnapshot({
      id: `deriv_intent_${randomUUID()}`,
      projectId,
      pageIdentity,
      data,
      snapshotDigest,
    }));
    return { snapshot, content: resolvedContent };
  }

  private async promptIntentId(tx: FactoryDb, promptSnapshotId: string): Promise<string> {
    const [row] = await tx.select().from(summaryPromptSnapshotsTable).where(eq(summaryPromptSnapshotsTable.id, promptSnapshotId)).limit(1);
    if (!row) throw derivativeError("derivative_required_artifact_missing", "Prompt snapshot not found.");
    return row.intentSnapshotId;
  }

  private async promptLanguage(tx: FactoryDb, promptSnapshotId: string): Promise<string> {
    const [row] = await tx.select().from(summaryPromptSnapshotsTable).where(eq(summaryPromptSnapshotsTable.id, promptSnapshotId)).limit(1);
    return row?.language ?? "en";
  }
}

