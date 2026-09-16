import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedDerivativeSets,
  acceptedSummaryArtifacts,
  acceptedAudioArtifacts,
  audioCandidates,
  narrationTextSnapshots,
  pageDerivativeIntentSnapshots,
  pageDerivativeOverrides,
  projectDerivativePolicies,
  summaryPromptSnapshots,
  summaryProposals,
} from "../persistence/schema.js";
import type {
  AcceptedDerivativeSetRecord,
  AcceptedSummaryArtifactRecord,
  AcceptedAudioArtifactRecord,
  AudioCandidateRecord,
  NarrationTextSnapshotRecord,
  PageDerivativeIntentSnapshotRecord,
  PageDerivativeOverrideRecord,
  ProjectDerivativePolicyRecord,
  SummaryPromptSnapshotRecord,
  SummaryProposalRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type {
  AcceptedDerivativeSetData,
  AcceptedSummaryArtifactData,
  AcceptedAudioArtifactData,
  AudioCandidateData,
  NarrationTextSnapshotData,
  PageDerivativeIntentSnapshotData,
  PageDerivativeOverrideData,
  ProjectDerivativePolicyData,
  SummaryPromptSnapshotData,
  SummaryProposalData,
} from "@factory/contracts";

/**
 * DERIVATIVES STORE — Run 10 persistence for the derivative authority chain.
 *
 * Every acceptance/transition that must remain coherent with content
 * authority runs inside the SHARED project advisory lock
 * (`pg_advisory_xact_lock(hashtextextended(projectId, 104))`) — the same
 * serialization namespace as design/visual/writer/production stores. No
 * second lock namespace is introduced. Unsafe already-stale acceptance is
 * impossible: acceptance re-verifies all bound digests inside the lock.
 */

export class DerivativesStore {
  constructor(private readonly db: FactoryDb) {}

  /** Run work under the shared project authority lock. */
  async withProjectLock<T>(projectId: string, work: (tx: FactoryDb) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 104))`);
      return work(tx as unknown as FactoryDb);
    });
  }

  // -- Project derivative policy ------------------------------------------

  async currentPolicy(projectId: string): Promise<ProjectDerivativePolicyRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectDerivativePolicies)
      .where(eq(projectDerivativePolicies.projectId, projectId))
      .orderBy(desc(projectDerivativePolicies.version))
      .limit(1);
    return row ?? null;
  }

  async policyVersions(projectId: string): Promise<ProjectDerivativePolicyRecord[]> {
    return this.db
      .select()
      .from(projectDerivativePolicies)
      .where(eq(projectDerivativePolicies.projectId, projectId))
      .orderBy(desc(projectDerivativePolicies.version));
  }

  /** Create the next immutable policy version. History is never rewritten. */
  async createPolicyVersion(input: {
    projectId: string;
    data: ProjectDerivativePolicyData;
    policyDigest: string;
  }): Promise<ProjectDerivativePolicyRecord> {
    return this.withProjectLock(input.projectId, async (tx) => {
      const store = new DerivativesStore(tx);
      const current = await store.currentPolicy(input.projectId);
      const version = (current?.version ?? 0) + 1;
      const data = { ...input.data, version };
      const policyDigest = deterministicDigest(data);
      const [row] = await tx
        .insert(projectDerivativePolicies)
        .values({
          id: `deriv_policy_${randomUUID()}`,
          projectId: input.projectId,
          version,
          summaryEnabled: data.summary.enabled,
          summaryLanguage: data.summary.language,
          summaryPolicyVersion: data.summary.policyVersion,
          audioEnabled: data.audio.enabled,
          audioLanguage: data.audio.language,
          audioVoiceId: data.audio.voiceId ?? null,
          audioPolicyVersion: data.audio.policyVersion,
          data,
          policyDigest,
        })
        .returning();
      return row!;
    });
  }

  // -- Page overrides -------------------------------------------------------

  async currentOverride(projectId: string, pageIdentity: string): Promise<PageDerivativeOverrideRecord | null> {
    const [row] = await this.db
      .select()
      .from(pageDerivativeOverrides)
      .where(
        and(eq(pageDerivativeOverrides.projectId, projectId), eq(pageDerivativeOverrides.pageIdentity, pageIdentity)),
      )
      .orderBy(desc(pageDerivativeOverrides.version))
      .limit(1);
    return row ?? null;
  }

  async createOverrideVersion(input: {
    projectId: string;
    data: PageDerivativeOverrideData;
    overrideDigest: string;
  }): Promise<PageDerivativeOverrideRecord> {
    return this.withProjectLock(input.projectId, async (tx) => {
      const store = new DerivativesStore(tx);
      const current = await store.currentOverride(input.projectId, input.data.pageIdentity);
      const version = (current?.version ?? 0) + 1;
      const data = { ...input.data, version };
      const overrideDigest = deterministicDigest(data);
      const [row] = await tx
        .insert(pageDerivativeOverrides)
        .values({
          id: `deriv_override_${randomUUID()}`,
          projectId: input.projectId,
          pageIdentity: data.pageIdentity,
          version,
          summaryMode: data.summary.mode,
          summaryLanguage: data.summary.language ?? null,
          audioMode: data.audio.mode,
          audioLanguage: data.audio.language ?? null,
          audioVoiceId: data.audio.voiceId ?? null,
          data,
          overrideDigest,
        })
        .returning();
      return row!;
    });
  }

  // -- Intent snapshots -----------------------------------------------------

  async findIntentSnapshot(projectId: string, pageIdentity: string, snapshotDigest: string) {
    const [row] = await this.db
      .select()
      .from(pageDerivativeIntentSnapshots)
      .where(
        and(
          eq(pageDerivativeIntentSnapshots.projectId, projectId),
          eq(pageDerivativeIntentSnapshots.pageIdentity, pageIdentity),
          eq(pageDerivativeIntentSnapshots.snapshotDigest, snapshotDigest),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async currentIntentSnapshot(projectId: string, pageIdentity: string): Promise<PageDerivativeIntentSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(pageDerivativeIntentSnapshots)
      .where(
        and(
          eq(pageDerivativeIntentSnapshots.projectId, projectId),
          eq(pageDerivativeIntentSnapshots.pageIdentity, pageIdentity),
        ),
      )
      .orderBy(desc(pageDerivativeIntentSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }

  async insertIntentSnapshot(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: PageDerivativeIntentSnapshotData;
    snapshotDigest: string;
  }): Promise<PageDerivativeIntentSnapshotRecord> {
    const [inserted] = await this.db
      .insert(pageDerivativeIntentSnapshots)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        acceptedContentId: row.data.acceptedContent.id,
        acceptedContentVersion: row.data.acceptedContent.version,
        acceptedContentDigest: row.data.acceptedContent.digest,
        projectPolicyId: row.data.projectPolicy?.id ?? null,
        projectPolicyVersion: row.data.projectPolicy?.version ?? null,
        projectPolicyDigest: row.data.projectPolicy?.digest ?? null,
        pageOverrideId: row.data.pageOverride?.id ?? null,
        pageOverrideVersion: row.data.pageOverride?.version ?? null,
        pageOverrideDigest: row.data.pageOverride?.digest ?? null,
        effectiveSummaryState: row.data.effectiveSummary.state,
        effectiveSummaryLanguage: row.data.effectiveSummary.language,
        effectiveSummaryPolicyVersion: row.data.effectiveSummary.policyVersion,
        effectiveAudioState: row.data.effectiveAudio.state,
        effectiveAudioLanguage: row.data.effectiveAudio.language,
        effectiveAudioVoiceId: row.data.effectiveAudio.voiceId,
        effectiveAudioPolicyVersion: row.data.effectiveAudio.policyVersion,
        data: row.data,
        snapshotDigest: row.snapshotDigest,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [existing] = await this.db
      .select()
      .from(pageDerivativeIntentSnapshots)
      .where(
        and(
          eq(pageDerivativeIntentSnapshots.projectId, row.projectId),
          eq(pageDerivativeIntentSnapshots.pageIdentity, row.pageIdentity),
          eq(pageDerivativeIntentSnapshots.snapshotDigest, row.snapshotDigest),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const current = await this.currentIntentSnapshot(row.projectId, row.pageIdentity);
    if (!current) {
      throw new FactoryError("derivative_intent_stale", "Failed to insert or find intent snapshot.");
    }
    return current;
  }

  // -- Summary prompt snapshots ---------------------------------------------

  async findPromptSnapshotByIntent(intentSnapshotId: string): Promise<SummaryPromptSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(summaryPromptSnapshots)
      .where(eq(summaryPromptSnapshots.intentSnapshotId, intentSnapshotId))
      .limit(1);
    return row ?? null;
  }

  async insertPromptSnapshot(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: SummaryPromptSnapshotData;
    promptDigest: string;
  }): Promise<SummaryPromptSnapshotRecord> {
    const [inserted] = await this.db
      .insert(summaryPromptSnapshots)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        intentSnapshotId: row.data.intentSnapshot.id,
        intentSnapshotDigest: row.data.intentSnapshot.digest,
        acceptedContentId: row.data.acceptedContent.id,
        acceptedContentVersion: row.data.acceptedContent.version,
        acceptedContentDigest: row.data.acceptedContent.digest,
        summaryPolicyVersion: row.data.summaryPolicyVersion,
        language: row.data.language,
        provider: row.data.provider,
        model: row.data.model,
        systemPrompt: row.data.systemPrompt,
        userPrompt: row.data.userPrompt,
        maxOutputTokens: row.data.maxOutputTokens,
        promptDigest: row.promptDigest,
      })
      .returning();
    return inserted!;
  }

  // -- Summary proposals ------------------------------------------------------

  async insertSummaryProposal(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: SummaryProposalData;
    proposalDigest: string;
  }): Promise<SummaryProposalRecord> {
    const [inserted] = await this.db
      .insert(summaryProposals)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        promptSnapshotId: row.data.promptSnapshot.id,
        promptSnapshotDigest: row.data.promptSnapshot.digest,
        acceptedContentId: row.data.acceptedContent.id,
        acceptedContentVersion: row.data.acceptedContent.version,
        acceptedContentDigest: row.data.acceptedContent.digest,
        providerMode: row.data.providerMode,
        isTestDouble: row.data.isTestDouble,
        provider: row.data.provider,
        model: row.data.model,
        summaryText: row.data.summaryText,
        providerRequestId: row.data.providerRequestId,
        usagePromptTokens: row.data.usage.promptTokens,
        usageCompletionTokens: row.data.usage.completionTokens,
        usageTotalTokens: row.data.usage.totalTokens,
        usageCostMicros: row.data.usage.costMicros,
        usageCurrency: row.data.usage.currency,
        proposalDigest: row.proposalDigest,
        state: "generated",
      })
      .returning();
    return inserted!;
  }

  async recordSummaryQa(input: { proposalId: string; qaReport: unknown; qaReportDigest: string; qaOverall: string }) {
    await this.db
      .update(summaryProposals)
      .set({ qaReport: input.qaReport, qaReportDigest: input.qaReportDigest, qaOverall: input.qaOverall, state: "review" })
      .where(eq(summaryProposals.id, input.proposalId));
  }

  async getSummaryProposal(projectId: string, proposalId: string): Promise<SummaryProposalRecord | null> {
    const [row] = await this.db
      .select()
      .from(summaryProposals)
      .where(and(eq(summaryProposals.projectId, projectId), eq(summaryProposals.id, proposalId)))
      .limit(1);
    return row ?? null;
  }

  // -- Accepted summary artifacts ---------------------------------------------

  async currentAcceptedSummary(projectId: string, pageIdentity: string): Promise<AcceptedSummaryArtifactRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedSummaryArtifacts)
      .where(
        and(
          eq(acceptedSummaryArtifacts.projectId, projectId),
          eq(acceptedSummaryArtifacts.pageIdentity, pageIdentity),
        ),
      )
      .orderBy(desc(acceptedSummaryArtifacts.version))
      .limit(1);
    return row ?? null;
  }

  async insertAcceptedSummary(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: AcceptedSummaryArtifactData;
    proposalId: string;
    artifactDigest: string;
    version: number;
  }): Promise<AcceptedSummaryArtifactRecord> {
    const [inserted] = await this.db
      .insert(acceptedSummaryArtifacts)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        version: row.version,
        sourceContentId: row.data.sourceContent.id,
        sourceContentVersion: row.data.sourceContent.version,
        sourceContentDigest: row.data.sourceContent.digest,
        intentSnapshotId: row.data.intentSnapshot.id,
        intentSnapshotDigest: row.data.intentSnapshot.digest,
        promptSnapshotId: row.data.promptSnapshot.id,
        promptSnapshotDigest: row.data.promptSnapshot.digest,
        proposalId: row.proposalId,
        proposalDigest: row.data.proposalDigest,
        providerMode: row.data.providerMode,
        isTestDouble: row.data.isTestDouble,
        provider: row.data.provider,
        model: row.data.model,
        language: row.data.language,
        summaryText: row.data.summaryText,
        qaReportDigest: row.data.qaReportDigest,
        qaOverall: row.data.qaOverall,
        artifactDigest: row.artifactDigest,
      })
      .returning();
    return inserted!;
  }

  // -- Narration snapshots ------------------------------------------------------

  async findNarrationSnapshot(projectId: string, pageIdentity: string, narrationDigest: string) {
    const [row] = await this.db
      .select()
      .from(narrationTextSnapshots)
      .where(
        and(
          eq(narrationTextSnapshots.projectId, projectId),
          eq(narrationTextSnapshots.pageIdentity, pageIdentity),
          eq(narrationTextSnapshots.narrationDigest, narrationDigest),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async currentNarrationSnapshot(projectId: string, pageIdentity: string): Promise<NarrationTextSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(narrationTextSnapshots)
      .where(
        and(eq(narrationTextSnapshots.projectId, projectId), eq(narrationTextSnapshots.pageIdentity, pageIdentity)),
      )
      .orderBy(desc(narrationTextSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }

  async insertNarrationSnapshot(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: NarrationTextSnapshotData;
    narrationDigest: string;
  }): Promise<NarrationTextSnapshotRecord> {
    const [inserted] = await this.db
      .insert(narrationTextSnapshots)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        sourceContentId: row.data.sourceContent.id,
        sourceContentVersion: row.data.sourceContent.version,
        sourceContentDigest: row.data.sourceContent.digest,
        narrationPolicyVersion: row.data.narrationPolicyVersion,
        language: row.data.language,
        narrationText: row.data.narrationText,
        narrationDigest: row.narrationDigest,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const existing = await this.findNarrationSnapshot(row.projectId, row.pageIdentity, row.narrationDigest);
    if (!existing) throw new FactoryError("derivative_generation_blocked", "Narration snapshot insert failed.");
    return existing;
  }

  // -- Audio candidates / accepted audio ---------------------------------------

  async insertAudioCandidate(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: AudioCandidateData;
    candidateDigest: string;
  }): Promise<AudioCandidateRecord> {
    const [inserted] = await this.db
      .insert(audioCandidates)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        narrationSnapshotId: row.data.narrationSnapshot.id,
        narrationSnapshotDigest: row.data.narrationSnapshot.digest,
        providerMode: row.data.providerMode,
        isTestDouble: row.data.isTestDouble,
        provider: row.data.provider,
        engine: row.data.engine,
        voiceId: row.data.voiceId,
        language: row.data.language,
        providerRequestId: row.data.providerRequestId,
        binaryDigest: row.data.binaryDigest,
        mimeType: row.data.mimeType,
        sizeBytes: row.data.sizeBytes,
        durationSeconds: row.data.durationSeconds,
        usageCharacters: row.data.usage.characters,
        usageCostMicros: row.data.usage.costMicros,
        usageCurrency: row.data.usage.currency,
        candidateDigest: row.candidateDigest,
        state: "generated",
      })
      .returning();
    return inserted!;
  }

  async getAudioCandidate(projectId: string, candidateId: string): Promise<AudioCandidateRecord | null> {
    const [row] = await this.db
      .select()
      .from(audioCandidates)
      .where(and(eq(audioCandidates.projectId, projectId), eq(audioCandidates.id, candidateId)))
      .limit(1);
    return row ?? null;
  }

  async currentAcceptedAudio(projectId: string, pageIdentity: string): Promise<AcceptedAudioArtifactRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedAudioArtifacts)
      .where(
        and(eq(acceptedAudioArtifacts.projectId, projectId), eq(acceptedAudioArtifacts.pageIdentity, pageIdentity)),
      )
      .orderBy(desc(acceptedAudioArtifacts.version))
      .limit(1);
    return row ?? null;
  }

  async insertAcceptedAudio(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: AcceptedAudioArtifactData;
    candidateId: string;
    artifactDigest: string;
    version: number;
  }): Promise<AcceptedAudioArtifactRecord> {
    const [inserted] = await this.db
      .insert(acceptedAudioArtifacts)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        version: row.version,
        sourceContentId: row.data.sourceContent.id,
        sourceContentVersion: row.data.sourceContent.version,
        sourceContentDigest: row.data.sourceContent.digest,
        narrationSnapshotId: row.data.narrationSnapshot.id,
        narrationSnapshotDigest: row.data.narrationSnapshot.digest,
        candidateId: row.candidateId,
        candidateDigest: row.data.candidateDigest,
        providerMode: row.data.providerMode,
        isTestDouble: row.data.isTestDouble,
        provider: row.data.provider,
        engine: row.data.engine,
        voiceId: row.data.voiceId,
        language: row.data.language,
        binaryDigest: row.data.binaryDigest,
        mimeType: row.data.mimeType,
        sizeBytes: row.data.sizeBytes,
        durationSeconds: row.data.durationSeconds,
        artifactDigest: row.artifactDigest,
      })
      .returning();
    return inserted!;
  }

  // -- Accepted derivative sets --------------------------------------------------

  async currentDerivativeSet(projectId: string, pageIdentity: string): Promise<AcceptedDerivativeSetRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedDerivativeSets)
      .where(
        and(eq(acceptedDerivativeSets.projectId, projectId), eq(acceptedDerivativeSets.pageIdentity, pageIdentity)),
      )
      .orderBy(desc(acceptedDerivativeSets.version))
      .limit(1);
    return row ?? null;
  }

  async getDerivativeSetById(projectId: string, setId: string): Promise<AcceptedDerivativeSetRecord | null> {
    const [row] = await this.db
      .select()
      .from(acceptedDerivativeSets)
      .where(and(eq(acceptedDerivativeSets.projectId, projectId), eq(acceptedDerivativeSets.id, setId)))
      .limit(1);
    return row ?? null;
  }

  async insertDerivativeSet(row: {
    id: string;
    projectId: string;
    pageIdentity: string;
    data: AcceptedDerivativeSetData;
    setDigest: string;
    version: number;
  }): Promise<AcceptedDerivativeSetRecord> {
    // Cross-project isolation: accepted artifacts bound into the set must
    // belong to the SAME project. Fail closed with the typed code (never a
    // raw FK error that could leak database existence information).
    if (row.data.summary.state === "accepted" && row.data.summary.acceptedArtifactId) {
      const [artifact] = await this.db
        .select({ projectId: acceptedSummaryArtifacts.projectId })
        .from(acceptedSummaryArtifacts)
        .where(eq(acceptedSummaryArtifacts.id, row.data.summary.acceptedArtifactId));
      if (!artifact || artifact.projectId !== row.projectId) {
        throw new FactoryError(
          "derivative_authority_wrong_project",
          "Accepted summary artifact does not belong to this project; cross-project derivative binding is forbidden.",
        );
      }
    }
    if (row.data.audio.state === "accepted" && row.data.audio.acceptedArtifactId) {
      const [artifact] = await this.db
        .select({ projectId: acceptedAudioArtifacts.projectId })
        .from(acceptedAudioArtifacts)
        .where(eq(acceptedAudioArtifacts.id, row.data.audio.acceptedArtifactId));
      if (!artifact || artifact.projectId !== row.projectId) {
        throw new FactoryError(
          "derivative_authority_wrong_project",
          "Accepted audio artifact does not belong to this project; cross-project derivative binding is forbidden.",
        );
      }
    }
    const [inserted] = await this.db
      .insert(acceptedDerivativeSets)
      .values({
        id: row.id,
        projectId: row.projectId,
        pageIdentity: row.pageIdentity,
        version: row.version,
        sourceContentId: row.data.sourceContent.id,
        sourceContentVersion: row.data.sourceContent.version,
        sourceContentDigest: row.data.sourceContent.digest,
        intentSnapshotId: row.data.intentSnapshot.id,
        intentSnapshotDigest: row.data.intentSnapshot.digest,
        summaryState: row.data.summary.state,
        summaryArtifactId: row.data.summary.acceptedArtifactId ?? null,
        summaryVersion: row.data.summary.version ?? null,
        summaryDigest: row.data.summary.digest ?? null,
        audioState: row.data.audio.state,
        audioArtifactId: row.data.audio.acceptedArtifactId ?? null,
        audioVersion: row.data.audio.version ?? null,
        audioDigest: row.data.audio.digest ?? null,
        audioBinaryDigest: row.data.audio.binaryDigest ?? null,
        data: row.data,
        setDigest: row.setDigest,
      })
      .returning();
    return inserted!;
  }
}
