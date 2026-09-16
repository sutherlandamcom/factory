import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { WriterBudgetStore } from "../writer/budget.js";
import { DerivativesService } from "./service.js";
import { DerivativesStore } from "./store.js";
import { FixtureAudioNarrationProvider } from "./audio-provider.js";
import type { AcceptedDerivativeSetRecord } from "../persistence/schema.js";

/**
 * DERIVATIVES API FACADE — Run 10 operator surface over the application
 * service. Route handlers stay thin; business rules remain in
 * `DerivativesService`. Backend computes every status; UI state is never
 * authority.
 */

export interface DerivativeWorkspaceView {
  projectId: string;
  policy: {
    id: string;
    version: number;
    digest: string;
    summary: { enabled: boolean; language: string; policyVersion: string };
    audio: { enabled: boolean; language: string; voiceId: string | null; policyVersion: string };
  } | null;
  pages: Array<{
    pageIdentity: string;
    summary: { status: string; state: string; language: string; policyVersion: string };
    audio: { status: string; state: string; language: string; voiceId: string | null; policyVersion: string };
    intentSnapshotId: string | null;
    set: { id: string; version: number; digest: string; summaryState: string; audioState: string } | null;
  }>;
}

function derivativeError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}

export class DerivativesApiFacade {
  private readonly service: DerivativesService;
  private readonly store: DerivativesStore;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
    options: {
      /** Fixture summary invocation (tests/E2E); zero paid calls. */
      summaryInvoke?: unknown;
      dailyLimitUsd?: number;
    } = {},
  ) {
    const budget = new WriterBudgetStore(db);
    this.service = new DerivativesService(db, repoRoot, {
      budget,
      ...(options.summaryInvoke
        ? { summary: { invoke: options.summaryInvoke as never, ...(options.dailyLimitUsd !== undefined ? { dailyLimitUsd: options.dailyLimitUsd } : {}) } }
        : {}),
      audioProvider: new FixtureAudioNarrationProvider(),
    });
    this.store = new DerivativesStore(db);
  }

  async workspace(projectId: string): Promise<DerivativeWorkspaceView> {
    const policyRow = await this.store.currentPolicy(projectId);
    const policyData = policyRow?.data as
      | { summary: { enabled: boolean; language: string; policyVersion: string }; audio: { enabled: boolean; language: string; voiceId?: string; policyVersion: string } }
      | undefined;
    const pagesResult = await this.db.execute(
      // Distinct page identities that have accepted content in this project.
      // Raw SQL keeps this read-only and cheap; results are operator views only.
      (await import("drizzle-orm")).sql`select distinct slug from accepted_page_content where project_id = ${projectId}`,
    );
    const pages = new Set<string>(
      (pagesResult.rows as Array<{ slug?: unknown }>).map((row) => String(row.slug)),
    );
    const pageViews = [];
    for (const pageIdentity of [...pages].sort()) {
      const status = await this.service.derivativeStatus({ projectId, pageIdentity });
      pageViews.push({
        pageIdentity,
        summary: {
          status: status.summary.status,
          state: status.summary.effective.state,
          language: status.summary.effective.language,
          policyVersion: status.summary.effective.policyVersion,
        },
        audio: {
          status: status.audio.status,
          state: status.audio.effective.state,
          language: status.audio.effective.language,
          voiceId: status.audio.effective.voiceId,
          policyVersion: status.audio.effective.policyVersion,
        },
        intentSnapshotId: status.intent.snapshot?.id ?? null,
        set: status.set.set
          ? {
              id: status.set.set.id,
              version: status.set.set.version,
              digest: status.set.set.setDigest,
              summaryState: status.set.set.summaryState,
              audioState: status.set.set.audioState,
            }
          : null,
      });
    }
    return {
      projectId,
      policy: policyRow && policyData
        ? {
            id: policyRow.id,
            version: policyRow.version,
            digest: policyRow.policyDigest,
            summary: policyData.summary,
            audio: { enabled: policyData.audio.enabled, language: policyData.audio.language, voiceId: policyData.audio.voiceId ?? null, policyVersion: policyData.audio.policyVersion },
          }
        : null,
      pages: pageViews,
    };
  }

  async updatePolicy(input: {
    projectId: string;
    summary: { enabled: boolean; language: string; policyVersion: string };
    audio: { enabled: boolean; language: string; voiceId?: string; policyVersion: string };
  }) {
    return this.service.updateProjectPolicy(input);
  }

  async updateOverride(input: {
    projectId: string;
    pageIdentity: string;
    summary: { mode: "inherit" | "enabled" | "disabled"; language?: string };
    audio: { mode: "inherit" | "enabled" | "disabled"; language?: string; voiceId?: string };
  }) {
    return this.service.updatePageOverride(input);
  }

  async deriveIntent(input: { projectId: string; pageIdentity: string }) {
    const result = await this.service.deriveIntentSnapshot(input);
    return { id: result.snapshot.id, digest: result.snapshot.snapshotDigest, reused: result.reused };
  }

  async generateSummary(input: { projectId: string; pageIdentity: string }) {
    const result = await this.service.generateSummaryProposal(input);
    return {
      proposalId: result.proposal.id,
      proposalDigest: result.proposal.proposalDigest,
      qaOverall: result.qa.overall,
      qa: result.qa,
    };
  }

  async acceptSummary(input: { projectId: string; pageIdentity: string; proposalId: string }) {
    const artifact = await this.service.acceptSummary(input);
    return { id: artifact.id, version: artifact.version, digest: artifact.artifactDigest };
  }

  async generateAudio(input: { projectId: string; pageIdentity: string }) {
    const result = await this.service.generateAudioCandidate(input);
    return { candidateId: result.candidate.id, candidateDigest: result.candidate.candidateDigest, binaryDigest: result.binaryDigest, mimeType: result.mimeType };
  }

  async acceptAudio(input: { projectId: string; pageIdentity: string; candidateId: string }) {
    const artifact = await this.service.acceptAudio(input);
    return { id: artifact.id, version: artifact.version, digest: artifact.artifactDigest, binaryDigest: artifact.binaryDigest };
  }

  async acceptSet(input: { projectId: string; pageIdentity: string }): Promise<{ id: string; version: number; digest: string; reused: boolean }> {
    const result = await this.service.acceptDerivativeSet(input);
    const set = result.set as AcceptedDerivativeSetRecord;
    return { id: set.id, version: set.version, digest: set.setDigest, reused: result.reused };
  }

  /** Summary review payload for the Dashboard (source version, text, QA, provider, cost). */
  async summaryReview(projectId: string, proposalId: string) {
    const proposal = await this.store.getSummaryProposal(projectId, proposalId);
    if (!proposal) throw derivativeError("derivative_required_artifact_missing", "Summary proposal not found.");
    return {
      proposalId: proposal.id,
      pageIdentity: proposal.pageIdentity,
      sourceContent: { id: proposal.acceptedContentId, version: proposal.acceptedContentVersion },
      summaryText: proposal.summaryText,
      qa: proposal.qaReport,
      qaOverall: proposal.qaOverall,
      provider: proposal.provider,
      model: proposal.model,
      providerMode: proposal.providerMode,
      cost: proposal.usageCostMicros != null ? { micros: proposal.usageCostMicros, currency: proposal.usageCurrency } : { micros: null, currency: "UNKNOWN" },
    };
  }

  /** Audio review payload for the Dashboard (narration text, voice, provider, cost, player). */
  async audioReview(projectId: string, candidateId: string) {
    const candidate = await this.store.getAudioCandidate(projectId, candidateId);
    if (!candidate) throw derivativeError("derivative_required_artifact_missing", "Audio candidate not found.");
    const narration = await this.store.currentNarrationSnapshot(projectId, candidate.pageIdentity);
    return {
      candidateId: candidate.id,
      pageIdentity: candidate.pageIdentity,
      sourceContent: { id: candidate.narrationSnapshotId ? narration?.sourceContentId ?? null : null, version: narration?.sourceContentVersion ?? null },
      narrationText: narration?.narrationText ?? null,
      narrationDigest: narration?.narrationDigest ?? null,
      voiceId: candidate.voiceId,
      provider: candidate.provider,
      engine: candidate.engine,
      providerMode: candidate.providerMode,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes,
      durationSeconds: candidate.durationSeconds,
      cost: candidate.usageCostMicros != null ? { micros: candidate.usageCostMicros, currency: candidate.usageCurrency } : { micros: null, currency: "UNKNOWN" },
    };
  }

  /** Serve accepted audio bytes for the Dashboard player (governed storage read). */
  async audioBytes(projectId: string, artifactId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const { acceptedAudioArtifacts } = await import("../persistence/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const [artifact] = await this.db
      .select()
      .from(acceptedAudioArtifacts)
      .where(and(eq(acceptedAudioArtifacts.projectId, projectId), eq(acceptedAudioArtifacts.id, artifactId)))
      .limit(1);
    if (!artifact) return null;
    const { createAssetStorage } = await import("../assets/storage.js");
    const storage = createAssetStorage(this.repoRoot);
    const bytes = await storage.getObject(storage.derivativeKey(artifact.binaryDigest));
    return { bytes, mimeType: artifact.mimeType };
  }
}
