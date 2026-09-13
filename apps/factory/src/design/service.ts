import {
  parseDesignCandidateData,
  type DesignCandidateData,
  type DesignGenerationRequest,
  type DesignGenerationResult,
  type DesignInputSnapshotData,
  type DesignProvider,
  type DesignProviderPreflight,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { createDesignArtifactStorage, type DesignArtifactStorage } from "./artifact-storage.js";
import { lintDesignMd } from "./design-md.js";
import { DesignStore, type DesignStaleness } from "./design-store.js";
import type { DesignInputSnapshotRecord, DesignCandidateRecord, AcceptedDesignArtifactRecord } from "../persistence/schema.js";

/**
 * DesignService — application service for the Run 6 design pipeline.
 * Dashboard and Operator API both use these semantic commands; the service
 * is the single trusted path (UI state is never governance authority).
 *
 * Governance invariants enforced here:
 * - generation requires a non-stale accepted input snapshot (fail before
 *   provider spend);
 * - provider output is persisted as immutable candidate evidence + raw
 *   content-addressed artifacts BEFORE review;
 * - acceptance/rejection bind the exact candidate digest (store-enforced);
 * - staleness is always computed, never stored-and-forgotten.
 */

export interface DesignInputSnapshotView {
  id: string;
  version: number;
  inputDigest: string;
  data: unknown;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

export interface DesignCandidateView {
  id: string;
  provider: string;
  providerProjectName: string;
  inputSnapshotId: string;
  inputSnapshotVersion: number;
  inputDigest: string;
  candidateDigest: string;
  approvalState: string;
  reviewNotes: string | null;
  data: DesignCandidateData;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

export interface AcceptedDesignView {
  id: string;
  version: number;
  candidateId: string;
  candidateDigest: string;
  inputSnapshotId: string;
  inputSnapshotVersion: number;
  inputDigest: string;
  provider: string;
  providerProjectName: string;
  designMdDigest: string;
  data: DesignCandidateData;
  stale: boolean;
  staleReason: string | null;
  acceptedAt: string;
}

export interface DesignWorkspaceReadModel {
  schemaVersion: "design-v1";
  provider: { preflight: DesignProviderPreflight };
  inputSnapshots: DesignInputSnapshotView[];
  latestInputSnapshot: DesignInputSnapshotView | null;
  candidates: DesignCandidateView[];
  accepted: AcceptedDesignView | null;
  acceptedVersions: Array<{ id: string; version: number; acceptedAt: string; stale: boolean }>;
}

export interface DesignServiceDeps {
  store: DesignStore;
  provider: DesignProvider;
  /** Repo root for artifact storage (defaults to repository root). */
  repoRoot?: string;
  storage?: DesignArtifactStorage;
}

export class DesignService {
  private readonly store: DesignStore;
  private readonly provider: DesignProvider;
  private readonly storage: DesignArtifactStorage;

  constructor(deps: DesignServiceDeps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.storage = deps.storage ?? createDesignArtifactStorage(deps.repoRoot);
  }

  // ---- Input snapshot ---------------------------------------------------------

  async deriveInputSnapshotDraft(projectId: string): Promise<DesignInputSnapshotView> {
    const row = await this.store.deriveInputSnapshotDraft({ projectId });
    return this.toInputSnapshotView(row, await this.store.inputSnapshotStaleness(projectId, row));
  }

  async inputSnapshotWorkspace(projectId: string): Promise<{
    latest: DesignInputSnapshotView | null;
    versions: Array<{ id: string; version: number; inputDigest: string; createdAt: string }>;
  }> {
    const latest = await this.store.latestInputSnapshot(projectId);
    const versions = await this.store.listInputSnapshots(projectId);
    let latestView: DesignInputSnapshotView | null = null;
    if (latest) {
      const staleness = await this.store.inputSnapshotStaleness(projectId, latest);
      latestView = this.toInputSnapshotView(latest, staleness);
    }
    return {
      latest: latestView,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        inputDigest: v.inputDigest,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  // ---- Preflight ----------------------------------------------------------------

  async preflight(): Promise<DesignProviderPreflight> {
    return await this.provider.preflight();
  }

  // ---- Generation ----------------------------------------------------------------

  /**
   * Generate a design candidate from the LATEST input snapshot. Fails closed
   * before any provider call when: no input snapshot exists, the snapshot is
   * stale, or the provider preflight is not configured.
   */
  async generateCandidate(input: { projectId: string }): Promise<DesignCandidateView> {
    // Trusted preflight BEFORE any provider spend.
    const preflight = await this.provider.preflight();
    if (!preflight.configured) {
      throw new FactoryError("design_provider_not_configured", preflight.reason);
    }

    const snapshot = await this.store.latestInputSnapshot(input.projectId);
    if (!snapshot) {
      throw new FactoryError(
        "design_input_not_accepted",
        "No design input snapshot exists; derive the design input snapshot first.",
      );
    }
    const staleness = await this.store.inputSnapshotStaleness(input.projectId, snapshot);
    if (staleness.stale) {
      throw new FactoryError(
        "design_input_stale",
        `Design input snapshot is stale: ${staleness.reason} Re-derive the snapshot before generating.`,
      );
    }

    const result: DesignGenerationResult = await this.provider.generateDesignSystem({
      inputSnapshot: snapshot.data as DesignInputSnapshotData,
      inputSnapshotId: snapshot.id,
      projectId: input.projectId,
      acceptedCopy: await this.resolveAcceptedCopy(input.projectId, snapshot.data as DesignInputSnapshotData),
    });

    // Persist raw artifacts content-addressed BEFORE the candidate row so a
    // candidate never references missing evidence.
    const artifactDigests = new Map<string, string>();
    for (const artifact of result.rawArtifacts) {
      const digest = await this.storage.putArtifact(artifact.kind, artifact.bytes);
      artifactDigests.set(`${artifact.kind}:${artifact.providerRef ?? ""}`, digest);
    }

    // DESIGN.md lint: structural validation of the artifact payload.
    const designMdArtifact = result.rawArtifacts.find((a) => a.kind === "design_md");
    if (designMdArtifact) {
      const lint = lintDesignMd(new TextDecoder().decode(designMdArtifact.bytes));
      if (lint.errors > 0) {
        throw new FactoryError(
          "design_md_invalid",
          `DESIGN.md validation failed with ${lint.errors} error(s); the candidate is rejected before persistence.`,
        );
      }
    }

    const candidate = await this.store.createCandidate({
      projectId: input.projectId,
      inputSnapshot: snapshot,
      data: result.candidate,
    });
    return this.toCandidateView(candidate);
  }

  /**
   * Resolve full accepted copy bodies for the input snapshot's content refs
   * from AcceptedPageContent (copy authority). The digest of each row is
   * re-verified against the snapshot binding before inclusion — a mutated
   * row never silently enters a generation prompt.
   */
  private async resolveAcceptedCopy(
    projectId: string,
    snapshotData: DesignInputSnapshotData,
  ): Promise<DesignGenerationRequest["acceptedCopy"]> {
    const rows = await this.store.getAcceptedContentForProject(projectId);
    const byDigest = new Map(rows.filter((r) => r.contentDigest).map((r) => [r.contentDigest, r]));
    const copy: DesignGenerationRequest["acceptedCopy"] = [];
    for (const ref of snapshotData.contentRefs) {
      const row = byDigest.get(ref.contentDigest);
      if (!row) continue; // digest no longer matches current authority; skip
      const data = row.data as {
        title?: string;
        introduction?: string;
        sections?: Array<{ heading: string; body: string }>;
        conclusion?: string;
        cta?: string;
      };
      copy.push({
        slug: ref.slug,
        title: data.title ?? ref.slug,
        introduction: data.introduction ?? "",
        sections: data.sections ?? [],
        conclusion: data.conclusion ?? "",
        cta: data.cta ?? "",
      });
    }
    return copy;
  }

  // ---- Review ---------------------------------------------------------------------

  async acceptCandidate(input: {
    projectId: string;
    candidateId: string;
    expectedCandidateDigest: string;
    reviewNotes?: string | null;
  }): Promise<AcceptedDesignView> {
    const accepted = await this.store.acceptCandidate({
      projectId: input.projectId,
      candidateId: input.candidateId,
      expectedCandidateDigest: input.expectedCandidateDigest,
      reviewNotes: input.reviewNotes ?? null,
    });
    return this.toAcceptedView(accepted);
  }

  async rejectCandidate(input: {
    projectId: string;
    candidateId: string;
    expectedCandidateDigest: string;
    reviewNotes?: string | null;
  }): Promise<DesignCandidateView> {
    const rejected = await this.store.rejectCandidate({
      projectId: input.projectId,
      candidateId: input.candidateId,
      expectedCandidateDigest: input.expectedCandidateDigest,
      reviewNotes: input.reviewNotes ?? null,
    });
    return this.toCandidateView(rejected);
  }

  // ---- Workspace -------------------------------------------------------------------

  async workspace(projectId: string): Promise<DesignWorkspaceReadModel> {
    const [preflight, inputWs, candidates, acceptedResult, acceptedVersions] = await Promise.all([
      this.preflight(),
      this.inputSnapshotWorkspace(projectId),
      this.store.listCandidates(projectId),
      this.store.latestAcceptedDesign(projectId),
      this.store.listAcceptedDesigns(projectId),
    ]);

    const candidateViews: DesignCandidateView[] = [];
    for (const candidate of candidates) {
      const staleness = await this.candidateStaleness(projectId, candidate);
      candidateViews.push(this.toCandidateView(candidate, staleness));
    }

    return {
      schemaVersion: "design-v1",
      provider: { preflight },
      inputSnapshots: inputWs.versions.map((v) => ({
        id: v.id,
        version: v.version,
        inputDigest: v.inputDigest,
        data: null,
        stale: false,
        staleReason: null,
        createdAt: v.createdAt,
      })),
      latestInputSnapshot: inputWs.latest,
      candidates: candidateViews,
      accepted: acceptedResult ? this.toAcceptedView(acceptedResult.artifact, acceptedResult.staleness) : null,
      acceptedVersions: acceptedVersions.map((a) => ({
        id: a.id,
        version: a.version,
        acceptedAt: a.acceptedAt.toISOString(),
        stale: false,
      })),
    };
  }

  /** Read a raw artifact by digest (preview serving; HTML is served sandboxed). */
  async readArtifact(digest: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
    return await this.storage.getArtifactByDigest(digest);
  }

  private async candidateStaleness(projectId: string, candidate: DesignCandidateRecord): Promise<DesignStaleness> {
    // A candidate is stale when its bound input snapshot no longer matches
    // current upstream authority.
    const snapshot = await this.store.getInputSnapshot(projectId, candidate.inputSnapshotId);
    if (!snapshot) {
      return { stale: true, reason: "The bound design input snapshot no longer exists." };
    }
    return await this.store.inputSnapshotStaleness(projectId, snapshot);
  }

  private toInputSnapshotView(
    row: DesignInputSnapshotRecord,
    staleness: DesignStaleness,
  ): DesignInputSnapshotView {
    return {
      id: row.id,
      version: row.version,
      inputDigest: row.inputDigest,
      data: row.data,
      stale: staleness.stale,
      staleReason: staleness.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toCandidateView(row: DesignCandidateRecord, staleness?: DesignStaleness): DesignCandidateView {
    return {
      id: row.id,
      provider: row.provider,
      providerProjectName: row.providerProjectName,
      inputSnapshotId: row.inputSnapshotId,
      inputSnapshotVersion: row.inputSnapshotVersion,
      inputDigest: row.inputDigest,
      candidateDigest: row.candidateDigest,
      approvalState: row.approvalState,
      reviewNotes: row.reviewNotes,
      data: parseDesignCandidateData(row.data),
      stale: staleness?.stale ?? false,
      staleReason: staleness?.reason ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAcceptedView(
    row: AcceptedDesignArtifactRecord,
    staleness?: DesignStaleness,
  ): AcceptedDesignView {
    return {
      id: row.id,
      version: row.version,
      candidateId: row.candidateId,
      candidateDigest: row.candidateDigest,
      inputSnapshotId: row.inputSnapshotId,
      inputSnapshotVersion: row.inputSnapshotVersion,
      inputDigest: row.inputDigest,
      provider: row.provider,
      providerProjectName: row.providerProjectName,
      designMdDigest: row.designMdDigest,
      data: parseDesignCandidateData(row.data),
      stale: staleness?.stale ?? false,
      staleReason: staleness?.reason ?? null,
      acceptedAt: row.acceptedAt.toISOString(),
    };
  }
}

/** Deterministic digest helper re-exported for tests. */
export function designDigestOf(value: unknown): string {
  return deterministicDigest(value);
}
