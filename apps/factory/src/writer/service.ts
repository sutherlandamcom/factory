import type { PageTarget } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { WriterStore } from "./writer-store.js";
import type { ContentBriefRecord, WriterPolicyRecord } from "../persistence/schema.js";

/**
 * WriterService — application service for the writer pipeline (Macro Run 4).
 * Dashboard and Operator API both use these semantic commands; the service is
 * the single trusted path (UI state is never governance authority).
 */

export interface WriterPolicyView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  lineage: {
    acceptedInputSnapshotId: string;
    acceptedInputSnapshotVersion: number;
    acceptedInputDigest: string;
  };
  rules: unknown;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ContentBriefView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  slug: string;
  lineage: unknown;
  pageTarget: PageTarget;
  noGapLineageAcknowledged: boolean;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export class WriterService {
  constructor(private readonly store: WriterStore) {}

  // ---- Writer Policy -----------------------------------------------------------

  async deriveWriterPolicyDraft(projectId: string): Promise<WriterPolicyView> {
    const row = await this.store.deriveWriterPolicyDraft({ projectId });
    return this.toPolicyView(row, false, null);
  }

  async approveWriterPolicy(input: {
    projectId: string;
    policyId: string;
    expectedVersion: number;
    expectedDigest: string;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.approveWriterPolicy(input);
  }

  async writerPolicyWorkspace(projectId: string): Promise<{
    latest: WriterPolicyView | null;
    versions: Array<{ id: string; version: number; state: string; digest: string; createdAt: string }>;
  }> {
    const latest = await this.store.latestWriterPolicy(projectId);
    const versionRows = await this.store.listWriterPolicyVersions(projectId);
    const versions = versionRows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));
    let latestView: WriterPolicyView | null = null;
    if (latest) {
      const staleness = await this.store.writerPolicyStaleness(projectId, latest);
      latestView = this.toPolicyView(latest, staleness.stale, staleness.reason);
    }
    return { latest: latestView, versions };
  }

  // ---- Content Production Brief --------------------------------------------------

  async saveBriefDraft(input: {
    projectId: string;
    pageTarget: unknown;
    contentBriefKeyPoints: string[];
    expectedRevision?: number | null;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.saveBriefDraft(input);
  }

  async approveBrief(input: {
    projectId: string;
    briefId: string;
    expectedVersion: number;
    expectedDigest: string;
    noGapLineageAcknowledged?: boolean;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.approveBrief(input);
  }

  async briefWorkspace(projectId: string): Promise<{
    latest: ContentBriefView | null;
    versions: Array<{ id: string; version: number; state: string; digest: string; slug: string; createdAt: string }>;
  }> {
    const latest = await this.store.latestBrief(projectId);
    const versionRows = await this.store.listBriefVersions(projectId);
    const versions = versionRows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));
    let latestView: ContentBriefView | null = null;
    if (latest) {
      const staleness = await this.store.briefStaleness(projectId, latest);
      latestView = this.toBriefView(latest, staleness.stale, staleness.reason);
    }
    return { latest: latestView, versions };
  }

  async briefDetail(projectId: string, version: number): Promise<ContentBriefView> {
    const row = await this.store.briefVersion(projectId, version);
    if (!row) throw new FactoryError("writer_artifact_not_found", "Content brief version not found.");
    const staleness = await this.store.briefStaleness(projectId, row);
    return this.toBriefView(row, staleness.stale, staleness.reason);
  }

  // ---- Views ---------------------------------------------------------------------

  private toPolicyView(row: WriterPolicyRecord, stale: boolean, staleReason: string | null): WriterPolicyView {
    return {
      id: row.id,
      version: row.version,
      state: row.state as "draft" | "approved",
      digest: row.policyDigest,
      lineage: {
        acceptedInputSnapshotId: row.acceptedInputSnapshotId,
        acceptedInputSnapshotVersion: row.acceptedInputVersion,
        acceptedInputDigest: row.acceptedInputDigest,
      },
      rules: row.data,
      stale,
      staleReason,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toBriefView(row: ContentBriefRecord, stale: boolean, staleReason: string | null): ContentBriefView {
    const data = row.data as {
      lineage: unknown;
      pageTarget: PageTarget;
    };
    return {
      id: row.id,
      version: row.version,
      state: row.state as "draft" | "approved",
      digest: row.briefDigest,
      slug: row.slug,
      lineage: data.lineage,
      pageTarget: data.pageTarget,
      noGapLineageAcknowledged: row.noGapLineageAcknowledged,
      stale,
      staleReason,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
