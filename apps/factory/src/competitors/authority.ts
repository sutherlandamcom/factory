import type { CompetitorClassification } from "@factory/contracts";
import type { AcceptedContentGapSnapshotRecord } from "../persistence/schema.js";
import type { ProjectIntakeStore } from "../operator/intake-store.js";
import type { CompetitorStore } from "./competitor-store.js";
import { deterministicDigest } from "../intelligence/digest.js";

/** One authoritative Run 3 freshness calculation. Stores may use a transaction handle. */
export class GapAuthorityReader {
  constructor(private readonly deps: { intake: Pick<ProjectIntakeStore, "listSnapshots">; competitorStore: CompetitorStore }) {}
  async evaluateUpstreamStaleness(
    projectId: string,
    bound: {
      acceptedInputSnapshotId: string;
      acceptedInputVersion: number;
      acceptedInputDigest: string;
      serpSnapshotId: string;
      serpSnapshotDigest: string;
      intelligenceSnapshotId: string;
      intelligenceSnapshotDigest: string;
      pageSnapshotRefs: Array<{ id: string; digest: string }>;
      analysisRefs: Array<{ id: string; digest: string }>;
      classificationDigest?: string;
      effectiveClassifications?: Array<{ pageSnapshotId: string; classification: CompetitorClassification; reason?: string }>;
      competitorRunId?: string;
    },
  ): Promise<{ stale: boolean; staleReasons: string[] }> {
    const reasons: string[] = [];

    // 1. Accepted Project Inputs
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latestInput = snapshots.at(-1) ?? null;
    if (!latestInput) {
      reasons.push("No accepted project input found.");
    } else if (
      latestInput.version !== bound.acceptedInputVersion ||
      latestInput.digest !== bound.acceptedInputDigest
    ) {
      reasons.push(
        `Accepted project inputs changed (bound v${bound.acceptedInputVersion}, current v${latestInput.version}).`,
      );
    }

    // 2. Authoritative SERP snapshot (matched by full search identity, not query alone)
    const boundSerp = await this.deps.competitorStore.getSerpSnapshot(projectId, bound.serpSnapshotId);
    if (!boundSerp) {
      reasons.push(`Bound SERP snapshot "${bound.serpSnapshotId}" no longer exists.`);
    } else if (boundSerp.snapshotDigest !== bound.serpSnapshotDigest) {
      reasons.push("Bound SERP snapshot digest mismatch.");
    } else {
      const latestSerp = await this.deps.competitorStore.getLatestSerpForSearchIdentity(projectId, {
        query: boundSerp.query,
        location: boundSerp.location,
        language: boundSerp.language,
        device: boundSerp.device,
      });
      if (
        latestSerp &&
        latestSerp.id !== bound.serpSnapshotId &&
        latestSerp.observedAt > boundSerp.observedAt
      ) {
        reasons.push(`A newer SERP snapshot was observed for query "${boundSerp.query}".`);
      }
    }

    // 3. Authoritative Search Intelligence snapshot (matched by full search identity)
    const boundIntel = await this.deps.competitorStore.getIntelligenceSnapshot(
      projectId,
      bound.intelligenceSnapshotId,
    );
    if (!boundIntel) {
      reasons.push(
        `Bound search intelligence snapshot "${bound.intelligenceSnapshotId}" no longer exists.`,
      );
    } else if (boundIntel.snapshotDigest !== bound.intelligenceSnapshotDigest) {
      reasons.push("Bound search intelligence snapshot digest mismatch.");
    } else if (boundSerp) {
      const latestIntel = await this.deps.competitorStore.getLatestIntelligenceForSearchIdentity(
        projectId,
        {
          query: boundSerp.query,
          location: boundSerp.location,
          language: boundSerp.language,
          device: boundSerp.device,
        },
      );
      if (
        latestIntel &&
        latestIntel.id !== bound.intelligenceSnapshotId &&
        latestIntel.createdAt > boundIntel.createdAt
      ) {
        reasons.push(
          `A newer search intelligence snapshot was created for query "${boundSerp.query}".`,
        );
      }
    }

    if (boundIntel) {
      const refs = (boundIntel.data as { evidenceRefs?: unknown })?.evidenceRefs;
      const digests = boundIntel.evidenceDigests as Record<string, unknown> | null;
      const expected = [{ kind: "serp_snapshot", id: boundIntel.serpSnapshotId, digest: boundSerp?.snapshotDigest }];
      if (boundIntel.groundedSnapshotId) {
        const grounded = await this.deps.competitorStore.getGroundedSnapshot(projectId, boundIntel.groundedSnapshotId);
        expected.push({ kind: "grounded_snapshot", id: boundIntel.groundedSnapshotId, digest: grounded?.snapshotDigest });
      }
      if (!Array.isArray(refs) || refs.length !== expected.length || expected.some(ref =>
        typeof ref.digest !== "string" || !/^[0-9a-f]{64}$/.test(ref.digest) ||
        digests?.[ref.kind === "serp_snapshot" ? "serp" : "grounded"] !== ref.digest ||
        !refs.some(actual => actual?.kind === ref.kind && actual?.id === ref.id && actual?.digest === ref.digest))) {
        reasons.push("Search intelligence evidence lineage is malformed or no longer matches persisted evidence.");
      }
    }

    // 4. Bound competitor run supersession
    if (bound.competitorRunId) {
      const boundRun = await this.deps.competitorStore.getRun(projectId, bound.competitorRunId);
      const latestRun = await this.deps.competitorStore.latestSucceededRunForSerp(
        projectId,
        bound.serpSnapshotId,
      );
      if (
        boundRun &&
        latestRun &&
        latestRun.id !== bound.competitorRunId &&
        latestRun.createdAt > boundRun.createdAt
      ) {
        reasons.push("A newer competitor run was executed for this SERP evidence.");
      }
    }

    // 5. Bound competitor page snapshots & analyses (including URL content change check)
    if (bound.pageSnapshotRefs && bound.pageSnapshotRefs.length > 0) {
      const pageIds = bound.pageSnapshotRefs.map((r) => r.id);
      const pages = await this.deps.competitorStore.pageSnapshotsByIds(projectId, pageIds);
      const pageMap = new Map(pages.map((p) => [p.id, p]));
      for (const ref of bound.pageSnapshotRefs) {
        const page = pageMap.get(ref.id);
        if (!page) {
          reasons.push(`Bound competitor page snapshot "${ref.id}" no longer exists.`);
        } else if (page.snapshotDigest !== ref.digest) {
          reasons.push(`Bound competitor page snapshot "${ref.id}" digest changed.`);
        } else {
          const latestPage = await this.deps.competitorStore.getLatestPageSnapshotForUrl(
            projectId,
            page.requestedUrl,
          );
          if (
            latestPage &&
            latestPage.id !== page.id &&
            latestPage.observedAt > page.observedAt &&
            latestPage.contentDigest !== page.contentDigest
          ) {
            reasons.push(
              `Competitor page content changed for "${page.requestedUrl}".`,
            );
          }
        }
      }
    }

    if (bound.analysisRefs && bound.analysisRefs.length > 0) {
      const analysisIds = bound.analysisRefs.map((r) => r.id);
      const analyses = await this.deps.competitorStore.analysesByIds(projectId, analysisIds);
      const analysisMap = new Map(analyses.map((a) => [a.id, a]));
      for (const ref of bound.analysisRefs) {
        const analysis = analysisMap.get(ref.id);
        if (!analysis) {
          reasons.push(`Bound competitor analysis "${ref.id}" no longer exists.`);
        } else if (analysis.snapshotDigest !== ref.digest) {
          reasons.push(`Bound competitor analysis "${ref.id}" digest changed.`);
        }
      }
    }

    // 6. Bound candidate classification overrides
    if (bound.classificationDigest && bound.effectiveClassifications && bound.effectiveClassifications.length > 0) {
      const pageIds = bound.effectiveClassifications.map((c) => c.pageSnapshotId);
      const overrides = await this.deps.competitorStore.getLatestClassificationOverridesForPages(projectId, pageIds);
      const pages = await this.deps.competitorStore.pageSnapshotsByIds(projectId, pageIds);
      const pageMap = new Map(pages.map((p) => [p.id, p]));
      const currentEffective = bound.effectiveClassifications
        .map((item) => {
          const page = pageMap.get(item.pageSnapshotId);
          const baseClassification = page?.classification ?? item.classification;
          const override = overrides.get(item.pageSnapshotId);
          const effective = (override?.classification ?? baseClassification) as CompetitorClassification;
          return {
            pageSnapshotId: item.pageSnapshotId,
            classification: effective,
          };
        })
        .sort((a, b) => (a.pageSnapshotId < b.pageSnapshotId ? -1 : a.pageSnapshotId > b.pageSnapshotId ? 1 : 0));
      const currentDigest = deterministicDigest(currentEffective);
      if (currentDigest !== bound.classificationDigest) {
        reasons.push("Competitor candidate classification changed.");
      }
    }

    return { stale: reasons.length > 0, staleReasons: reasons };
  }

  async evaluateAcceptedSnapshotStaleness(
    projectId: string,
    snapshot: AcceptedContentGapSnapshotRecord,
  ): Promise<{ stale: boolean; staleReasons: string[] }> {
    const report = await this.deps.competitorStore.getGapReport(projectId, snapshot.reportId);
    const snapData = snapshot.data as {
      classificationDigest?: string;
      effectiveClassifications?: Array<{ pageSnapshotId: string; classification: CompetitorClassification }>;
    };
    return await this.evaluateUpstreamStaleness(projectId, {
      acceptedInputSnapshotId: snapshot.acceptedInputSnapshotId,
      acceptedInputVersion: snapshot.acceptedInputVersion,
      acceptedInputDigest: snapshot.acceptedInputDigest,
      serpSnapshotId: snapshot.serpSnapshotId,
      serpSnapshotDigest: snapshot.serpSnapshotDigest,
      intelligenceSnapshotId: snapshot.intelligenceSnapshotId,
      intelligenceSnapshotDigest: snapshot.intelligenceSnapshotDigest,
      pageSnapshotRefs: (snapshot.pageSnapshotRefs as Array<{ id: string; digest: string }>) ?? [],
      analysisRefs: (snapshot.analysisRefs as Array<{ id: string; digest: string }>) ?? [],
      classificationDigest: snapData.classificationDigest,
      effectiveClassifications: snapData.effectiveClassifications,
      competitorRunId: report?.runId,
    });
  }

}
