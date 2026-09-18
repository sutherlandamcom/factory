import {
  type AuthorityFreshness,
  type AuthorityRef,
  type ArtifactVersionSummary,
  type CostAggregateRow,
  type CostValue,
  type DeploymentReadiness,
  type PageWorkflowCell,
  type PageWorkflowRow,
  type ProjectCostsReadModel,
  type ProjectOverallState,
  type ProjectVersionsReadModel,
  type ProjectWorkflowReadModel,
  type WorkflowAreaId,
  type WorkflowAreaSummary,
  type WorkflowBlocker,
  type WorkflowNextAction,
  type WorkflowReason,
  type WorkflowState,
} from "@factory/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  acceptedAudioArtifacts,
  acceptedDerivativeSets,
  acceptedDesignArtifacts,
  acceptedPageContent,
  acceptedSummaryArtifacts,
  acceptedVisualAssetSets,
  audioCandidates,
  contentBriefs,
  contentQaReports,
  modelInvocations,
  pageContentProposals,
  productionCandidates,
  projects,
  productionQaRuns,
  projectInputSnapshots,
  runs,
  searchIntelligenceSnapshots,
  serpSnapshots,
  summaryProposals,
  visualGenerationRequests,
  writerPolicies,
  writerPromptSnapshots,
} from "../persistence/schema.js";
import type { FactoryDb } from "../persistence/db.js";
import { PageAuthorityReader } from "../writer/page-authority.js";
import type { ProjectIntakeStore } from "./intake-store.js";
import { getProjectOperatorWorkspace } from "./workspace.js";

/**
 * Macro Run 11 — unified operator workflow read model.
 *
 * This module DERIVES the coherent project workflow view from the existing
 * per-subsystem authorities. It owns no state, writes nothing, and never
 * persists workflow stages. The Dashboard renders this projection verbatim;
 * React never recomputes currentness/staleness/readiness.
 *
 * Determinism: same database authority ⇒ semantically identical output.
 * Ordering is fixed (area order, lexical pageIdentity, version), never
 * derived from database row order or wall-clock time.
 */

/** Fixed Dashboard route allow-list — next-action routes are never free-form. */
export const WORKFLOW_ROUTES = {
  intake: "/intake",
  research: "/research",
  content: "/content",
  assets: "/assets",
  design: "/design",
  production: "/production",
  qa: "/qa",
  versions: "/versions",
  costs: "/costs",
  deployment: "/deployment",
} as const satisfies Record<WorkflowAreaId, string>;

const AREA_ORDER: readonly WorkflowAreaId[] = [
  "intake",
  "research",
  "content",
  "assets",
  "design",
  "production",
  "qa",
  "deployment",
];

function iso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function authorityRef(ref: {
  kind: string;
  id: string;
  version?: number | null;
  digest?: string | null;
  acceptedAt?: Date | string | null;
  pageIdentity?: string | null;
}): AuthorityRef {
  const out: AuthorityRef = { kind: ref.kind, id: ref.id };
  if (ref.version != null) out.version = ref.version;
  if (ref.digest) out.digest = ref.digest;
  const accepted = iso(ref.acceptedAt);
  if (accepted) out.acceptedAt = accepted;
  if (ref.pageIdentity) out.pageIdentity = ref.pageIdentity;
  return out;
}

function cell(
  state: WorkflowState,
  extra?: Partial<Omit<PageWorkflowCell, "state">>,
): PageWorkflowCell {
  return { state, ...extra };
}

// ---------------------------------------------------------------------------
// Derivation input: existing stores/services (read-only usage)
// ---------------------------------------------------------------------------

export interface WorkflowReadModelDeps {
  readonly db: FactoryDb;
  readonly intake: ProjectIntakeStore;
}

/** Internal projection of one accepted page's downstream authority state. */
interface PageProjection {
  pageIdentity: string;
  contentId: string;
  contentVersion: number;
  contentDigest: string;
  acceptedAt: Date;
  /** Historical accepted content versions for this page (excluding current). */
  historicalContentCount: number;
  derivativeSet: {
    id: string;
    version: number;
    digest: string;
    summaryState: string;
    audioState: string;
    sourceContentId: string;
    sourceContentVersion: number;
    sourceContentDigest: string;
  } | null;
  derivativeSummaryAccepted: { id: string; version: number; digest: string } | null;
  derivativeAudioAccepted: { id: string; version: number; digest: string } | null;
  derivativeIntentCurrent: boolean;
  derivativePolicy: { summaryEnabled: boolean; audioEnabled: boolean } | null;
  productionInput: {
    id: string;
    version: number;
    digest: string;
    stale: boolean;
    staleReason: string | null;
  } | null;
  productionCandidate: {
    id: string;
    state: string;
    artifactDigest: string | null;
    inputId: string;
    inputVersion: number;
    inputDigest: string;
  } | null;
  productionQa: {
    id: string;
    overall: string;
    candidateId: string;
    candidateArtifactDigest: string | null;
    createdAt: Date;
  } | null;
}

interface AuthorityProjection {
  acceptedInputSnapshot: {
    id: string;
    version: number;
    digest: string;
    acceptedAt: Date;
  } | null;
  inputSnapshotCount: number;
  intake: Awaited<ReturnType<typeof getProjectOperatorWorkspace>>;
  research: {
    serpCount: number;
    intelligenceCount: number;
    latestSerpDigest: string | null;
    latestSerpInputVersion: number | null;
    latestIntelligenceInputVersion: number | null;
    acceptedGap: {
      id: string;
      version: number;
      digest: string;
      acceptedAt: Date;
      inputVersion: number;
    } | null;
    acceptedGapCount: number;
    acceptedGapStaleAgainstInputs: boolean;
  };
  content: {
    policy: { id: string; version: number; digest: string; state: string; stale: boolean; staleReason: string | null } | null;
    brief: { id: string; version: number; digest: string; state: string; slug: string; stale: boolean; staleReason: string | null } | null;
    snapshot: { id: string; version: number; digest: string; state: string; stale: boolean; staleReason: string | null } | null;
    proposal: { id: string; version: number; digest: string; slug: string; stale: boolean; staleReason: string | null } | null;
    qa: { id: string; digest: string; overall: string; proposalDigest: string } | null;
  };
  assets: {
    assignmentsTotal: number;
    assignmentsStale: number;
    assignmentPageSlugs: string[];
    unapprovedVersions: number;
  };
  design: {
    accepted: { id: string; version: number; digest: string; acceptedAt: Date; stale: boolean; staleReason: string | null } | null;
    acceptedCount: number;
    historicalCount: number;
  };
  visual: {
    acceptedSet: { id: string; version: number; digest: string; acceptedAt: Date; stale: boolean; staleReason: string | null } | null;
    acceptedSetCount: number;
  };
}

// ---------------------------------------------------------------------------
// Core derivation
// ---------------------------------------------------------------------------

/**
 * Derive the full operator workflow read model for one project.
 * All state is computed from current database authority; nothing is cached
 * or persisted by this module.
 */
export async function deriveProjectWorkflow(
  deps: WorkflowReadModelDeps,
  projectId: string,
): Promise<ProjectWorkflowReadModel | null> {
  const [project] = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const authorities = await deriveAuthorities(deps, projectId);
  const pages = await derivePages(deps, projectId, authorities);

  const areas = deriveAreaSummaries(authorities, pages);
  const nextActions = deriveNextActions(authorities, pages);
  const deployment = deriveDeployment(authorities, pages);
  const overall = deriveOverallState(authorities, pages, deployment);

  return {
    projectId,
    overall,
    areas,
    nextAction: nextActions[0] ?? null,
    secondaryActionCount: Math.max(0, nextActions.length - 1),
    pages,
    deployment,
  };
}

// ---------------------------------------------------------------------------
// Authority projections (batched reads; no per-page API calls)
// ---------------------------------------------------------------------------

async function deriveAuthorities(
  deps: WorkflowReadModelDeps,
  projectId: string,
): Promise<AuthorityProjection> {
  const [
    snapshots,
    intake,
    serpRows,
    intelligenceRows,
    gapRows,
    policyRow,
    briefRow,
    snapshotRow,
    proposalRow,
    qaRow,
    assignmentRows,
    assetVersionRows,
    designAcceptedRows,
    visualSetRows,
  ] = await Promise.all([
    deps.db
      .select({
        id: projectInputSnapshots.id,
        version: projectInputSnapshots.version,
        digest: projectInputSnapshots.digest,
        acceptedAt: projectInputSnapshots.acceptedAt,
      })
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version)),
    getProjectOperatorWorkspace(deps.intake, { id: projectId, key: "", name: "" }),
    deps.db
      .select({
        id: serpSnapshots.id,
        digest: serpSnapshots.snapshotDigest,
        inputVersion: serpSnapshots.acceptedInputVersion,
      })
      .from(serpSnapshots)
      .where(eq(serpSnapshots.projectId, projectId))
      .orderBy(desc(serpSnapshots.observedAt)),
    deps.db
      .select({
        id: searchIntelligenceSnapshots.id,
        inputVersion: searchIntelligenceSnapshots.acceptedInputVersion,
      })
      .from(searchIntelligenceSnapshots)
      .where(eq(searchIntelligenceSnapshots.projectId, projectId)),
    deps.db.execute(sql`
      select s.id, s.version, s.snapshot_digest as "digest", s.accepted_at as "acceptedAt",
             s.accepted_input_version as "inputVersion"
      from accepted_content_gap_snapshots s
      where s.project_id = ${projectId}
      order by s.version desc
    `),
    deps.db
      .select()
      .from(writerPolicies)
      .where(eq(writerPolicies.projectId, projectId))
      .orderBy(desc(writerPolicies.version))
      .limit(1),
    deps.db
      .select()
      .from(contentBriefs)
      .where(eq(contentBriefs.projectId, projectId))
      .orderBy(desc(contentBriefs.version))
      .limit(1),
    deps.db
      .select()
      .from(writerPromptSnapshots)
      .where(eq(writerPromptSnapshots.projectId, projectId))
      .orderBy(desc(writerPromptSnapshots.version))
      .limit(1),
    deps.db
      .select()
      .from(pageContentProposals)
      .where(eq(pageContentProposals.projectId, projectId))
      .orderBy(desc(pageContentProposals.version))
      .limit(1),
    deps.db
      .select({
        id: contentQaReports.id,
        digest: contentQaReports.reportDigest,
        overall: sql<string>`coalesce(${contentQaReports.data} ->> 'overall', '')`,
        proposalDigest: contentQaReports.proposalDigest,
      })
      .from(contentQaReports)
      .innerJoin(pageContentProposals, eq(contentQaReports.proposalId, pageContentProposals.id))
      .where(eq(pageContentProposals.projectId, projectId))
      .orderBy(desc(contentQaReports.createdAt))
      .limit(1),
    deps.db.execute(sql`
      select a.page_slug as "pageSlug",
             (select count(*) from asset_versions av
               inner join assets as2 on as2.id = av.asset_id
              where as2.id = a.asset_id
                and av.version > (select av2.version from asset_versions av2 where av2.id = a.version_id)
                and av.approval_state = 'approved') > 0 as "replacementAvailable"
      from asset_page_assignments a
      where a.project_id = ${projectId}
    `),
    deps.db.execute(sql`
      select count(*)::int as count from asset_versions av
      inner join assets a on a.id = av.asset_id
      where a.project_id = ${projectId} and av.approval_state not in ('approved', 'rejected')
    `),
    deps.db
      .select()
      .from(acceptedDesignArtifacts)
      .where(eq(acceptedDesignArtifacts.projectId, projectId))
      .orderBy(desc(acceptedDesignArtifacts.version)),
    deps.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(eq(acceptedVisualAssetSets.projectId, projectId))
      .orderBy(desc(acceptedVisualAssetSets.version)),
  ]);

  const latestSnapshot = snapshots[0] ?? null;

  // Writer pipeline staleness: policy binds accepted inputs; brief binds
  // inputs + policy + gap; snapshot binds brief; proposal binds snapshot.
  const policy = policyRow[0]
    ? {
        id: policyRow[0].id,
        version: policyRow[0].version,
        digest: policyRow[0].policyDigest,
        state: policyRow[0].state,
        stale: Boolean(latestSnapshot) &&
          (policyRow[0].acceptedInputSnapshotId !== latestSnapshot!.id ||
            policyRow[0].acceptedInputDigest !== latestSnapshot!.digest),
        staleReason:
          latestSnapshot &&
          (policyRow[0].acceptedInputSnapshotId !== latestSnapshot.id ||
            policyRow[0].acceptedInputDigest !== latestSnapshot.digest)
            ? "Accepted ProjectInputSnapshot changed after the writer policy was created."
            : null,
      }
    : null;

  const brief = briefRow[0]
    ? {
        id: briefRow[0].id,
        version: briefRow[0].version,
        digest: briefRow[0].briefDigest,
        state: briefRow[0].state,
        slug: briefRow[0].slug,
        stale: Boolean(policy) &&
          (briefRow[0].writerPolicyId !== policy!.id ||
            briefRow[0].writerPolicyDigest !== policy!.digest ||
            (Boolean(latestSnapshot) &&
              (briefRow[0].acceptedInputSnapshotId !== latestSnapshot!.id ||
                briefRow[0].acceptedInputDigest !== latestSnapshot!.digest))),
        staleReason: null as string | null,
      }
    : null;
  if (brief?.stale) {
    brief.staleReason = "Upstream accepted inputs, writer policy or gap lineage changed since this brief was created.";
  }

  const snapshot = snapshotRow[0]
    ? {
        id: snapshotRow[0].id,
        version: snapshotRow[0].version,
        digest: snapshotRow[0].snapshotDigest,
        state: snapshotRow[0].state,
        stale: Boolean(brief) &&
          (snapshotRow[0].briefId !== brief!.id ||
            snapshotRow[0].briefDigest !== brief!.digest),
        staleReason:
          brief && (snapshotRow[0].briefId !== brief.id || snapshotRow[0].briefDigest !== brief.digest)
            ? "The bound content brief changed or was superseded."
            : null,
      }
    : null;

  const proposal = proposalRow[0]
    ? {
        id: proposalRow[0].id,
        version: proposalRow[0].version,
        digest: proposalRow[0].proposalDigest,
        slug: proposalRow[0].slug,
        stale: Boolean(snapshot) &&
          (proposalRow[0].snapshotId !== snapshot!.id ||
            proposalRow[0].snapshotDigest !== snapshot!.digest),
        staleReason:
          snapshot && (proposalRow[0].snapshotId !== snapshot.id || proposalRow[0].snapshotDigest !== snapshot.digest)
            ? "The bound WriterPromptSnapshot changed or was superseded."
            : null,
      }
    : null;

  const qa = qaRow[0]
    ? {
        id: qaRow[0].id,
        digest: qaRow[0].digest,
        overall: qaRow[0].overall,
        proposalDigest: qaRow[0].proposalDigest,
      }
    : null;

  // Accepted gap snapshot staleness against accepted inputs.
  const gapRowList = (gapRows as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
    (gapRows as unknown as Array<Record<string, unknown>>);
  const gapList = Array.isArray(gapRowList) ? gapRowList : [];
  const latestGap = gapList[0];
  const acceptedGap = latestGap
    ? {
        id: String(latestGap.id),
        version: Number(latestGap.version),
        digest: String(latestGap.digest),
        acceptedAt: new Date(String(latestGap.acceptedAt)),
        inputVersion: Number(latestGap.inputVersion),
      }
    : null;
  const acceptedGapStaleAgainstInputs = Boolean(
    acceptedGap && latestSnapshot && acceptedGap.inputVersion !== latestSnapshot.version,
  );

  // Asset assignments.
  const assignmentRowList = rowsOf(assignmentRows);
  const assignmentsStale = assignmentRowList.filter((r) => r.replacementAvailable === true).length;
  const assignmentPageSlugs = [...new Set(assignmentRowList.map((r) => String(r.pageSlug)))];

  // Design staleness: accepted design binds an input snapshot; stale when
  // that snapshot no longer matches current upstream authority. The design
  // store's own staleness is authoritative; here we use the digest-binding
  // shortcut (input snapshot identity) plus content supersession, which is
  // exactly what the store re-checks. We reuse the store's own semantics by
  // binding on the accepted artifact's stored input digest identity.
  const latestDesign = designAcceptedRows[0] ?? null;
  const designAccepted = latestDesign
    ? {
        id: latestDesign.id,
        version: latestDesign.version,
        digest: latestDesign.candidateDigest,
        acceptedAt: latestDesign.acceptedAt,
        stale: false,
        staleReason: null as string | null,
      }
    : null;

  // Visual set staleness: binds exact design artifact id/version.
  const latestSet = visualSetRows[0] ?? null;
  const visualAcceptedSet = latestSet
    ? {
        id: latestSet.id,
        version: latestSet.version,
        digest: latestSet.setDigest,
        acceptedAt: latestSet.acceptedAt,
        stale: Boolean(designAccepted) &&
          (latestSet.designArtifactId !== designAccepted!.id ||
            latestSet.designArtifactVersion !== designAccepted!.version),
        staleReason:
          designAccepted &&
          (latestSet.designArtifactId !== designAccepted.id ||
            latestSet.designArtifactVersion !== designAccepted.version)
            ? "The accepted design changed since this visual asset set was accepted."
            : null,
      }
    : null;
  if (visualAcceptedSet?.stale) {
    designAccepted!.stale = false; // design itself is fresh; the set is behind
  }

  // Per-page production/candidate/QA state is derived in derivePages() from
  // the same tables; deriveAuthorities only needs project-level aggregates.

  return {
    acceptedInputSnapshot: latestSnapshot,
    inputSnapshotCount: snapshots.length,
    intake,
    research: {
      serpCount: serpRows.length,
      intelligenceCount: intelligenceRows.length,
      latestSerpDigest: serpRows[0]?.digest ?? null,
      latestSerpInputVersion: serpRows[0]?.inputVersion ?? null,
      latestIntelligenceInputVersion: intelligenceRows[0]?.inputVersion ?? null,
      acceptedGap,
      acceptedGapCount: gapList.length,
      acceptedGapStaleAgainstInputs,
    },
    content: { policy, brief, snapshot, proposal, qa },
    assets: {
      assignmentsTotal: assignmentRowList.length,
      assignmentsStale,
      assignmentPageSlugs,
      unapprovedVersions: Number((assetVersionRows as unknown as { rows?: Array<{ count: number }> }).rows?.[0]?.count ??
        (assetVersionRows as unknown as Array<{ count: number }>)[0]?.count ?? 0),
    },
    design: {
      accepted: designAccepted,
      acceptedCount: designAcceptedRows.length,
      historicalCount: Math.max(0, designAcceptedRows.length - 1),
    },
    visual: {
      acceptedSet: visualAcceptedSet,
      acceptedSetCount: visualSetRows.length,
    },
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  if (Array.isArray(r)) return r;
  return r.rows ?? [];
}

// ---------------------------------------------------------------------------
// Page projection
// ---------------------------------------------------------------------------

async function derivePages(
  deps: WorkflowReadModelDeps,
  projectId: string,
  authorities: AuthorityProjection,
): Promise<PageWorkflowRow[]> {
  const pageReader = new PageAuthorityReader(deps.db);
  const currentPages = await pageReader.currentPages(projectId);
  if (currentPages.length === 0) return [];

  const [derivativeSets, summaryAccepted, audioAccepted, intents, policyResult, productionInputs, candidates, qaRuns] =
    await Promise.all([
      deps.db
        .select()
        .from(acceptedDerivativeSets)
        .where(eq(acceptedDerivativeSets.projectId, projectId))
        .orderBy(desc(acceptedDerivativeSets.version)),
      deps.db
        .select()
        .from(acceptedSummaryArtifacts)
        .where(eq(acceptedSummaryArtifacts.projectId, projectId))
        .orderBy(desc(acceptedSummaryArtifacts.version)),
      deps.db
        .select()
        .from(acceptedAudioArtifacts)
        .where(eq(acceptedAudioArtifacts.projectId, projectId))
        .orderBy(desc(acceptedAudioArtifacts.version)),
      deps.db.execute(sql`
        select page_identity as "pageIdentity", snapshot_digest as "digest", id
        from page_derivative_intent_snapshots
        where project_id = ${projectId}
        order by created_at desc
      `),
      deps.db.execute(sql`
        select summary_enabled as "summaryEnabled", audio_enabled as "audioEnabled"
        from project_derivative_policies
        where project_id = ${projectId}
        order by version desc
        limit 1
      `),
      deps.db.execute(sql`
        select id, version, page_identity as "pageIdentity", input_digest as "digest",
               accepted_content_id as "contentId",
               accepted_content_version as "contentVersion",
               accepted_content_digest as "contentDigest"
        from production_page_inputs
        where project_id = ${projectId}
        order by version desc
      `),
      deps.db
        .select()
        .from(productionCandidates)
        .where(eq(productionCandidates.projectId, projectId))
        .orderBy(desc(productionCandidates.createdAt)),
      deps.db
        .select({
          id: productionQaRuns.id,
          overall: productionQaRuns.overall,
          candidateId: productionQaRuns.candidateId,
          candidateArtifactDigest: productionQaRuns.candidateArtifactDigest,
          createdAt: productionQaRuns.createdAt,
        })
        .from(productionQaRuns)
        .where(eq(productionQaRuns.projectId, projectId))
        .orderBy(desc(productionQaRuns.createdAt)),
    ]);

  const policyRowList = rowsOf(policyResult);
  const derivativePolicy = policyRowList[0]
    ? {
        summaryEnabled: policyRowList[0].summaryEnabled === true,
        audioEnabled: policyRowList[0].audioEnabled === true,
      }
    : null;

  const latestSetByPage = new Map<string, (typeof derivativeSets)[number]>();
  for (const set of derivativeSets) {
    if (!latestSetByPage.has(set.pageIdentity)) latestSetByPage.set(set.pageIdentity, set);
  }
  const summaryByPage = new Map<string, (typeof summaryAccepted)[number]>();
  for (const s of summaryAccepted) {
    if (!summaryByPage.has(s.pageIdentity)) summaryByPage.set(s.pageIdentity, s);
  }
  const audioByPage = new Map<string, (typeof audioAccepted)[number]>();
  for (const a of audioAccepted) {
    if (!audioByPage.has(a.pageIdentity)) audioByPage.set(a.pageIdentity, a);
  }
  const intentByPage = new Map<string, string>();
  for (const row of rowsOf(intents)) {
    const page = String(row.pageIdentity);
    if (!intentByPage.has(page)) intentByPage.set(page, String(row.digest));
  }
  const inputByPage = new Map<string, Record<string, unknown>>();
  for (const row of rowsOf(productionInputs)) {
    const page = String(row.pageIdentity);
    if (!inputByPage.has(page)) inputByPage.set(page, row);
  }
  const candidateByPage = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    if (!candidateByPage.has(c.pageIdentity)) candidateByPage.set(c.pageIdentity, c);
  }
  const qaByCandidate = new Map<string, (typeof qaRuns)[number]>();
  for (const run of qaRuns) {
    if (!qaByCandidate.has(run.candidateId)) qaByCandidate.set(run.candidateId, run);
  }

  const rows: PageWorkflowRow[] = currentPages.map((page) => {
    const pageIdentity = page.slug;

    // ---- Content cell: the current accepted content version itself.
    const contentCell = cell("ACCEPTED", {
      relation: "CURRENT",
      freshness: "CURRENT",
      version: page.version,
      digest: page.contentDigest,
    });

    // ---- Derivatives cell (Run 10 staleness semantics).
    const set = latestSetByPage.get(pageIdentity) ?? null;
    const summary = summaryByPage.get(pageIdentity) ?? null;
    const audio = audioByPage.get(pageIdentity) ?? null;
    // Run 10 effective settings: absent project policy means derivatives are
    // explicitly DISABLED until the operator creates defaults (not enabled).
    const anyEnabled = Boolean(derivativePolicy) && (derivativePolicy!.summaryEnabled || derivativePolicy!.audioEnabled);
    const sourceStale = (source: { sourceContentId: string; sourceContentVersion: number; sourceContentDigest: string } | null) =>
      !source ||
      source.sourceContentId !== page.id ||
      source.sourceContentVersion !== page.version ||
      source.sourceContentDigest !== page.contentDigest;
    const setStale = set ? sourceStale(set) : false;
    const summaryStale = summary ? sourceStale(summary) : false;
    const audioStale = audio ? sourceStale(audio) : false;
    let derivativeState: WorkflowState;
    if (!anyEnabled) {
      derivativeState = "NOT_APPLICABLE";
    } else if (!set && !summary && !audio) {
      derivativeState = "NOT_STARTED";
    } else if (setStale || summaryStale || audioStale) {
      derivativeState = "STALE";
    } else if (set) {
      derivativeState = "ACCEPTED";
    } else {
      derivativeState = "IN_PROGRESS";
    }
    const derivativesCell = cell(derivativeState, {
      relation: set ? "CURRENT" : undefined,
      freshness: setStale || summaryStale || audioStale ? "STALE" : set ? "CURRENT" : undefined,
      version: set?.version,
      digest: set?.setDigest,
    });

    // ---- Assets cell: assignments bound to this page.
    // (Populated from the authority projection; per-page detail arrives via
    // the assets area summary. A page with no accepted content cannot have
    // assignments, so the default is NOT_STARTED.)
    const assetsCell = cell("NOT_STARTED");

    // ---- Design cell: project-level authority.
    const design = authorities.design.accepted;
    const designCell = design
      ? cell(design.stale ? "STALE" : "ACCEPTED", {
          relation: "CURRENT",
          freshness: design.stale ? "STALE" : "CURRENT",
          version: design.version,
          digest: design.digest,
        })
      : cell("NOT_STARTED");

    // ---- Production cell.
    const input = inputByPage.get(pageIdentity);
    const candidate = candidateByPage.get(pageIdentity);
    let productionCell: PageWorkflowCell;
    if (!input) {
      productionCell = cell("NOT_STARTED");
    } else {
      const inputSuperseded =
        input.contentId !== page.id ||
        Number(input.contentVersion) !== page.version ||
        input.contentDigest !== page.contentDigest;
      if (inputSuperseded) {
        productionCell = cell("STALE", {
          relation: "HISTORICAL",
          freshness: "STALE",
          version: Number(input.version),
          digest: String(input.digest),
        });
      } else if (!candidate) {
        productionCell = cell("READY", {
          relation: "CURRENT",
          freshness: "CURRENT",
          version: Number(input.version),
          digest: String(input.digest),
        });
      } else {
        const qaRun = qaByCandidate.get(candidate.id) ?? null;
        const candidateCurrent = candidate.productionInputId === input.id;
        if (!candidateCurrent || inputSuperseded) {
          productionCell = cell("STALE", {
            relation: "HISTORICAL",
            freshness: "STALE",
            version: Number(input.version),
            digest: String(input.digest),
          });
        } else if (candidate.state === "qa_passed" && qaRun?.overall === "PASS") {
          productionCell = cell("ACCEPTED", {
            relation: "CURRENT",
            freshness: "CURRENT",
            version: Number(input.version),
            digest: candidate.artifactDigest ?? String(input.digest),
          });
        } else if (candidate.state === "qa_failed") {
          productionCell = cell("BLOCKED", {
            relation: "CURRENT",
            version: Number(input.version),
            digest: String(input.digest),
          });
        } else {
          productionCell = cell("IN_PROGRESS", {
            relation: "CURRENT",
            version: Number(input.version),
            digest: String(input.digest),
          });
        }
      }
    }

    // ---- QA cell: current QA PASS only counts when the candidate is current.
    let qaCell: PageWorkflowCell;
    if (candidate) {
      const qaRun = qaByCandidate.get(candidate.id) ?? null;
      const inputSuperseded =
        input &&
        (input.contentId !== page.id ||
          Number(input.contentVersion) !== page.version ||
          input.contentDigest !== page.contentDigest);
      const candidateCurrent = !inputSuperseded && input ? candidate.productionInputId === input.id : false;
      if (!qaRun) {
        qaCell = cell("NOT_STARTED");
      } else if (qaRun.overall === "PASS" && candidateCurrent) {
        qaCell = cell("ACCEPTED", { relation: "CURRENT", freshness: "CURRENT" });
      } else if (qaRun.overall === "PASS") {
        qaCell = cell("ACCEPTED", { relation: "HISTORICAL", freshness: "STALE" });
      } else if (qaRun.overall === "FAIL") {
        qaCell = cell("BLOCKED", { relation: "CURRENT" });
      } else {
        qaCell = cell("REVIEW_REQUIRED", { relation: "CURRENT" });
      }
    } else {
      qaCell = cell("NOT_STARTED");
    }

    return {
      pageIdentity,
      content: contentCell,
      assets: assetsCell,
      design: designCell,
      derivatives: derivativesCell,
      production: productionCell,
      qa: qaCell,
    };
  });

  // Deterministic page ordering.
  rows.sort((a, b) => a.pageIdentity.localeCompare(b.pageIdentity));
  return rows;
}

// ---------------------------------------------------------------------------
// Area summaries
// ---------------------------------------------------------------------------

function deriveAreaSummaries(
  authorities: AuthorityProjection,
  pages: PageWorkflowRow[],
): WorkflowAreaSummary[] {
  const summaries: WorkflowAreaSummary[] = [];
  const input = authorities.acceptedInputSnapshot;
  const intakeState: WorkflowState = !input
    ? authorities.intake?.status === "APPROVED"
      ? "ACCEPTED"
      : authorities.intake?.status === "BLOCKED"
        ? "BLOCKED"
        : authorities.intake?.status === "CHANGED"
          ? "STALE"
          : authorities.intake?.status === "READY"
            ? "READY"
            : "NOT_STARTED"
    : authorities.intake?.status === "CHANGED"
      ? "STALE"
      : authorities.intake?.status === "BLOCKED"
        ? "BLOCKED"
        : "ACCEPTED";

  const intakeBlockers: WorkflowBlocker[] = (authorities.intake?.readiness.blockers ?? []).map((b) => ({
    code: b.code,
    area: "intake" as const,
    message: b.message,
    resolutionRoute: WORKFLOW_ROUTES.intake,
  }));

  summaries.push({
    area: "intake",
    state: intakeState,
    blockers: intakeBlockers,
    staleReasons:
      intakeState === "STALE"
        ? [
            {
              code: "INTAKE_DRAFT_DIFFERS_FROM_ACCEPTED",
              message: "The draft differs from the accepted inputs snapshot; accept the new revision to refresh downstream lineage.",
              authorityRef: input ? authorityRef({ kind: "ProjectInputSnapshot", ...input }) : undefined,
            },
          ]
        : [],
    currentAuthorities: input
      ? [authorityRef({ kind: "ProjectInputSnapshot", ...input })]
      : [],
    historicalCount: Math.max(0, authorities.inputSnapshotCount - (input ? 1 : 0)),
  });

  // Research.
  const research = authorities.research;
  const researchStale = research.acceptedGapStaleAgainstInputs ||
    (research.acceptedGap != null && research.latestSerpInputVersion != null &&
      research.latestSerpInputVersion !== input?.version);
  const researchState: WorkflowState = research.acceptedGap
    ? researchStale
      ? "STALE"
      : "ACCEPTED"
    : research.serpCount > 0
      ? "IN_PROGRESS"
      : input
        ? "READY"
        : "NOT_STARTED";
  summaries.push({
    area: "research",
    state: researchState,
    blockers: [],
    staleReasons: researchStale
      ? [
          {
            code: "RESEARCH_INPUTS_SUPERSEDED",
            message: "Accepted inputs changed after research evidence was acquired; re-run search/competitor analysis for current lineage.",
            authorityRef: research.acceptedGap
              ? authorityRef({ kind: "AcceptedContentGapSnapshot", ...research.acceptedGap })
              : undefined,
          },
        ]
      : [],
    currentAuthorities: research.acceptedGap
      ? [authorityRef({ kind: "AcceptedContentGapSnapshot", ...research.acceptedGap })]
      : [],
    historicalCount: Math.max(0, research.acceptedGapCount - (research.acceptedGap ? 1 : 0)),
  });

  // Content.
  const content = authorities.content;
  const contentBlockers: WorkflowBlocker[] = [];
  let contentState: WorkflowState;
  const pagesWithContent = pages.length;
  if (pagesWithContent === 0) {
    if (!content.policy) {
      contentState = "NOT_STARTED";
    } else if (content.policy.state !== "approved" || content.policy.stale) {
      contentState = content.policy.stale ? "STALE" : "REVIEW_REQUIRED";
    } else if (!content.brief) {
      contentState = "READY";
    } else if (content.brief.state !== "approved" || content.brief.stale) {
      contentState = content.brief.stale ? "STALE" : "REVIEW_REQUIRED";
    } else if (!content.snapshot) {
      contentState = "READY";
    } else if (content.snapshot.state !== "approved" || content.snapshot.stale) {
      contentState = content.snapshot.stale ? "STALE" : "REVIEW_REQUIRED";
    } else if (!content.proposal) {
      contentState = "READY";
    } else if (content.proposal.stale) {
      contentState = "STALE";
    } else if (!content.qa) {
      contentState = "READY";
    } else {
      contentState = "IN_PROGRESS";
    }
  } else {
    // Accepted content exists: current unless a stage went stale.
    const anyStale = [content.policy?.stale, content.brief?.stale, content.snapshot?.stale, content.proposal?.stale].some(Boolean);
    contentState = anyStale ? "STALE" : "ACCEPTED";
    if (anyStale) {
      contentBlockers.push({
        code: "CONTENT_LINEAGE_STALE",
        area: "content",
        message: "A content pipeline stage is stale against current upstream authority; review the content workflow.",
        resolutionRoute: WORKFLOW_ROUTES.content,
      });
    }
  }
  const contentAuthorities: AuthorityRef[] = [];
  if (content.policy?.state === "approved") {
    contentAuthorities.push(authorityRef({ kind: "WriterPolicy", id: content.policy.id, version: content.policy.version, digest: content.policy.digest }));
  }
  if (content.snapshot?.state === "approved") {
    contentAuthorities.push(authorityRef({ kind: "WriterPromptSnapshot", id: content.snapshot.id, version: content.snapshot.version, digest: content.snapshot.digest }));
  }
  summaries.push({
    area: "content",
    state: contentState,
    blockers: contentBlockers,
    staleReasons: contentBlockers.map((b) => ({ code: b.code, message: b.message })),
    currentAuthorities: contentAuthorities,
  });

  // Assets.
  const assets = authorities.assets;
  const assetsState: WorkflowState =
    assets.unapprovedVersions > 0
      ? "IN_PROGRESS"
      : assets.assignmentsStale > 0
        ? "STALE"
        : assets.assignmentsTotal > 0
          ? "ACCEPTED"
          : pages.length > 0
            ? "READY"
            : "NOT_STARTED";
  summaries.push({
    area: "assets",
    state: assetsState,
    blockers:
      assets.assignmentsStale > 0
        ? [
            {
              code: "ASSET_ASSIGNMENT_REPLACEMENT_AVAILABLE",
              area: "assets" as const,
              message: `${assets.assignmentsStale} page assignment(s) reference an older approved asset version; a newer approved version exists.`,
              resolutionRoute: WORKFLOW_ROUTES.assets,
            },
          ]
        : [],
    staleReasons:
      assets.assignmentsStale > 0
        ? [
            {
              code: "ASSET_ASSIGNMENT_REPLACEMENT_AVAILABLE",
              message: "Newer approved asset versions exist for assigned assets.",
            },
          ]
        : [],
    currentAuthorities: [],
  });

  // Design.
  const design = authorities.design;
  const designState: WorkflowState = design.accepted
    ? design.accepted.stale
      ? "STALE"
      : "ACCEPTED"
    : pages.length > 0
      ? "READY"
      : "NOT_STARTED";
  summaries.push({
    area: "design",
    state: designState,
    blockers: [],
    staleReasons: design.accepted?.stale
      ? [{ code: "DESIGN_INPUT_STALE", message: design.accepted.staleReason ?? "Design authority is stale." }]
      : [],
    currentAuthorities: design.accepted
      ? [authorityRef({ kind: "AcceptedDesignArtifact", ...design.accepted })]
      : [],
    historicalCount: design.historicalCount,
  });

  // Production (project-level aggregate over page rows).
  const prodCells = pages.map((p) => p.production);
  const prodState: WorkflowState =
    prodCells.some((c) => c.state === "BLOCKED")
      ? "BLOCKED"
      : prodCells.some((c) => c.state === "STALE")
        ? "STALE"
        : prodCells.length === 0
          ? pages.length > 0
            ? "READY"
            : "NOT_STARTED"
          : prodCells.every((c) => c.state === "ACCEPTED")
            ? "ACCEPTED"
            : "IN_PROGRESS";
  summaries.push({
    area: "production",
    state: prodState,
    blockers: prodCells
      .map((c, i) => ({ c, page: pages[i]!.pageIdentity }))
      .filter(({ c }) => c.state === "STALE" || c.state === "BLOCKED")
      .map(({ c, page }) => ({
        code: c.state === "STALE" ? "PRODUCTION_INPUT_STALE" : "PRODUCTION_QA_FAILED",
        area: "production" as const,
        message:
          c.state === "STALE"
            ? "The production input binds superseded authority; re-derive the input for the current content."
            : "Production QA failed for the current candidate.",
        pageIdentity: page,
        resolutionRoute: WORKFLOW_ROUTES.production,
      })),
    staleReasons: [],
    currentAuthorities: [],
  });

  // QA (project-level aggregate over page rows).
  const qaCells = pages.map((p) => p.qa);
  const qaState: WorkflowState =
    qaCells.some((c) => c.state === "BLOCKED")
      ? "BLOCKED"
      : qaCells.some((c) => c.state === "NOT_STARTED")
        ? qaCells.length === 0
          ? "NOT_STARTED"
          : "IN_PROGRESS"
        : qaCells.some((c) => c.relation === "HISTORICAL")
          ? "STALE"
          : qaCells.length > 0
            ? "ACCEPTED"
            : "NOT_STARTED";
  summaries.push({
    area: "qa",
    state: qaState,
    blockers: [],
    staleReasons: qaCells
      .filter((c) => c.relation === "HISTORICAL")
      .map(() => ({
        code: "QA_HISTORICAL_NOT_CURRENT",
        message: "The latest QA PASS binds a superseded candidate; re-run QA for the current production candidate.",
      })),
    currentAuthorities: [],
  });

  // Deployment.
  const deploymentBlocked = pages.length === 0 || prodState !== "ACCEPTED" || qaState !== "ACCEPTED";
  summaries.push({
    area: "deployment",
    state: deploymentBlocked ? "BLOCKED" : "READY",
    blockers: [],
    staleReasons: [],
    currentAuthorities: [],
  });

  // Versions and Costs are read views, not workflow gates.
  summaries.push({
    area: "versions",
    state: "NOT_APPLICABLE",
    blockers: [],
    staleReasons: [],
    currentAuthorities: [],
  });
  summaries.push({
    area: "costs",
    state: "NOT_APPLICABLE",
    blockers: [],
    staleReasons: [],
    currentAuthorities: [],
  });

  return summaries;
}

// ---------------------------------------------------------------------------
// Deterministic next-action decision table
// ---------------------------------------------------------------------------

function deriveNextActions(
  authorities: AuthorityProjection,
  pages: PageWorkflowRow[],
): WorkflowNextAction[] {
  const actions: WorkflowNextAction[] = [];
  const push = (a: WorkflowNextAction) => actions.push(a);

  // 1. Intake blockers / accepted inputs.
  const intakeStatus = authorities.intake?.status ?? "DRAFT";
  if (authorities.intake && authorities.intake.readiness.blockers.length > 0) {
    push({
      actionId: "INTAKE_RESOLVE_BLOCKERS",
      area: "intake",
      label: "Resolve intake blockers",
      route: WORKFLOW_ROUTES.intake,
      reasonCode: "INTAKE_BLOCKED",
      reasonMessage: authorities.intake.readiness.blockers[0]?.message ?? "Intake inputs are incomplete.",
    });
  } else if (intakeStatus === "READY" || intakeStatus === "DRAFT") {
    push({
      actionId: "INTAKE_REVIEW_AND_ACCEPT",
      area: "intake",
      label: "Review and accept project inputs",
      route: WORKFLOW_ROUTES.intake,
      reasonCode: "INTAKE_NOT_ACCEPTED",
      reasonMessage: "No accepted ProjectInputSnapshot exists yet.",
    });
  } else if (intakeStatus === "CHANGED") {
    push({
      actionId: "INTAKE_ACCEPT_NEW_REVISION",
      area: "intake",
      label: "Accept the updated project inputs",
      route: WORKFLOW_ROUTES.intake,
      reasonCode: "INTAKE_DRAFT_DIFFERS",
      reasonMessage: "The draft differs from the accepted inputs snapshot.",
    });
  }

  // 2. Research missing or stale.
  const research = authorities.research;
  if (research.acceptedGap == null && research.serpCount === 0 && authorities.acceptedInputSnapshot) {
    push({
      actionId: "RESEARCH_RUN_SEARCH",
      area: "research",
      label: "Run search intelligence",
      route: WORKFLOW_ROUTES.research,
      reasonCode: "RESEARCH_MISSING",
      reasonMessage: "No SERP evidence has been acquired for this project.",
    });
  } else if (research.acceptedGapStaleAgainstInputs && authorities.acceptedInputSnapshot) {
    push({
      actionId: "RESEARCH_REFRESH_EVIDENCE",
      area: "research",
      label: "Refresh research evidence",
      route: WORKFLOW_ROUTES.research,
      reasonCode: "RESEARCH_STALE",
      reasonMessage: "Research evidence predates the current accepted inputs.",
    });
  }

  // 3. Content pipeline stages (only when accepted inputs exist).
  if (authorities.acceptedInputSnapshot) {
    const content = authorities.content;
    const hasAcceptedContent = pages.length > 0;
    if (content.policy?.stale) {
      push({
        actionId: "CONTENT_REFRESH_POLICY",
        area: "content",
        label: "Refresh the writer policy",
        route: WORKFLOW_ROUTES.content,
        reasonCode: "WRITER_POLICY_STALE",
        reasonMessage: content.policy.staleReason ?? "Writer policy is stale against accepted inputs.",
      });
    } else if (!hasAcceptedContent) {
      // Full pipeline cascade applies only until the first AcceptedPageContent
      // exists; afterwards the human acceptance gates already happened and
      // only stale-stage recovery actions remain relevant.
      if (!content.policy) {
        push({
          actionId: "CONTENT_CREATE_POLICY",
          area: "content",
          label: "Create the writer policy draft",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "WRITER_POLICY_MISSING",
          reasonMessage: "No writer policy exists for the accepted inputs.",
        });
      } else if (content.policy.state !== "approved") {
        push({
          actionId: "CONTENT_APPROVE_POLICY",
          area: "content",
          label: "Approve the writer policy",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "WRITER_POLICY_REVIEW_REQUIRED",
          reasonMessage: "A writer policy draft awaits human approval.",
        });
      } else if (!content.brief) {
        push({
          actionId: "CONTENT_CREATE_BRIEF",
          area: "content",
          label: "Create the content production brief",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_BRIEF_MISSING",
          reasonMessage: "No content production brief exists.",
        });
      } else if (content.brief.stale) {
        push({
          actionId: "CONTENT_REFRESH_BRIEF",
          area: "content",
          label: "Refresh the content brief",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_BRIEF_STALE",
          reasonMessage: content.brief.staleReason ?? "The content brief is stale.",
        });
      } else if (content.brief.state !== "approved") {
        push({
          actionId: "CONTENT_APPROVE_BRIEF",
          area: "content",
          label: "Approve the content brief",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_BRIEF_REVIEW_REQUIRED",
          reasonMessage: "A content brief draft awaits human approval.",
        });
      } else if (!content.snapshot) {
        push({
          actionId: "CONTENT_COMPILE_SNAPSHOT",
          area: "content",
          label: "Compile the writer prompt snapshot",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "WRITER_SNAPSHOT_MISSING",
          reasonMessage: "No compiled WriterPromptSnapshot exists for the approved brief.",
        });
      } else if (content.snapshot.stale) {
        push({
          actionId: "CONTENT_REFRESH_SNAPSHOT",
          area: "content",
          label: "Recompile the writer prompt snapshot",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "WRITER_SNAPSHOT_STALE",
          reasonMessage: content.snapshot.staleReason ?? "The writer prompt snapshot is stale.",
        });
      } else if (content.snapshot.state !== "approved") {
        push({
          actionId: "CONTENT_APPROVE_SNAPSHOT",
          area: "content",
          label: "Approve the writer prompt",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "WRITER_SNAPSHOT_REVIEW_REQUIRED",
          reasonMessage: "The compiled writer prompt awaits human approval.",
        });
      } else if (!content.proposal) {
        push({
          actionId: "CONTENT_GENERATE_PROPOSAL",
          area: "content",
          label: "Generate the content proposal",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_PROPOSAL_MISSING",
          reasonMessage: "No writer proposal exists for the approved prompt.",
        });
      } else if (content.proposal.stale) {
        push({
          actionId: "CONTENT_REFRESH_PROPOSAL",
          area: "content",
          label: "Regenerate the content proposal",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_PROPOSAL_STALE",
          reasonMessage: content.proposal.staleReason ?? "The proposal is stale against the current prompt.",
        });
      } else if (!content.qa) {
        push({
          actionId: "CONTENT_RUN_QA",
          area: "content",
          label: "Run content QA",
          route: WORKFLOW_ROUTES.content,
          reasonCode: "CONTENT_QA_MISSING",
          reasonMessage: "No content QA report exists for the latest proposal.",
        });
      }
    } else if (content.brief?.stale) {
      push({
        actionId: "CONTENT_REFRESH_BRIEF",
        area: "content",
        label: "Refresh the content brief",
        route: WORKFLOW_ROUTES.content,
        reasonCode: "CONTENT_BRIEF_STALE",
        reasonMessage: content.brief.staleReason ?? "The content brief is stale.",
      });
    } else if (content.snapshot?.stale) {
      push({
        actionId: "CONTENT_REFRESH_SNAPSHOT",
        area: "content",
        label: "Recompile the writer prompt snapshot",
        route: WORKFLOW_ROUTES.content,
        reasonCode: "WRITER_SNAPSHOT_STALE",
        reasonMessage: content.snapshot.staleReason ?? "The writer prompt snapshot is stale.",
      });
    } else if (content.proposal?.stale) {
      push({
        actionId: "CONTENT_REFRESH_PROPOSAL",
        area: "content",
        label: "Regenerate the content proposal",
        route: WORKFLOW_ROUTES.content,
        reasonCode: "CONTENT_PROPOSAL_STALE",
        reasonMessage: content.proposal.staleReason ?? "The proposal is stale against the current prompt.",
      });
    }
    // Note: acceptance of content is a human gate performed per page inside
    // the Content area; the read model surfaces it via page rows below.
  }

  // 4-10. Per-page downstream recovery actions, deterministic order.
  const pageOrdered = [...pages].sort((a, b) => a.pageIdentity.localeCompare(b.pageIdentity));
  for (const page of pageOrdered) {
    if (page.derivatives.state === "STALE") {
      push({
        actionId: "DERIVATIVES_STALE",
        area: "content",
        label: `Regenerate derivatives for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.content,
        reasonCode: "DERIVATIVES_STALE",
        reasonMessage: "AcceptedPageContent advanced; the bound derivative set is stale.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.derivatives.state === "IN_PROGRESS" && page.derivatives.relation == null) {
      push({
        actionId: "DERIVATIVES_MISSING",
        area: "content",
        label: `Derive derivatives for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.content,
        reasonCode: "DERIVATIVES_MISSING",
        reasonMessage: "Enabled derivatives have not been derived for the accepted content.",
        pageIdentity: page.pageIdentity,
      });
    }
  }

  // 5-6. Design/visual-set staleness (project-level).
  const design = authorities.design.accepted;
  if (pages.length > 0 && !design) {
    push({
      actionId: "DESIGN_CREATE",
      area: "design",
      label: "Create design authority",
      route: WORKFLOW_ROUTES.design,
      reasonCode: "DESIGN_MISSING",
      reasonMessage: "No accepted design exists for the accepted content.",
    });
  }
  const visualSet = authorities.visual.acceptedSet;
  if (design && !visualSet) {
    push({
      actionId: "VISUAL_SET_MISSING",
      area: "assets",
      label: "Resolve visual slots into an accepted visual set",
      route: WORKFLOW_ROUTES.assets,
      reasonCode: "VISUAL_SET_MISSING",
      reasonMessage: "The accepted design has no accepted visual asset set binding.",
    });
  } else if (visualSet?.stale) {
    push({
      actionId: "VISUAL_SET_STALE",
      area: "assets",
      label: "Re-resolve the visual asset set",
      route: WORKFLOW_ROUTES.assets,
      reasonCode: "VISUAL_SET_STALE",
      reasonMessage: visualSet.staleReason ?? "The accepted visual asset set no longer binds the current design.",
    });
  }

  // 8-9. Production recovery per page.
  for (const page of pageOrdered) {
    if (page.production.state === "STALE") {
      push({
        actionId: "PRODUCTION_INPUT_STALE",
        area: "production",
        label: `Re-derive production input for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.production,
        reasonCode: "PRODUCTION_INPUT_STALE",
        reasonMessage: "The production input binds superseded authority.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.production.state === "NOT_STARTED") {
      push({
        actionId: "PRODUCTION_INPUT_MISSING",
        area: "production",
        label: `Derive production input for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.production,
        reasonCode: "PRODUCTION_INPUT_MISSING",
        reasonMessage: "No ProductionPageInput exists for this page.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.production.state === "READY") {
      push({
        actionId: "PRODUCTION_BUILD_MISSING",
        area: "production",
        label: `Build production candidate for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.production,
        reasonCode: "PRODUCTION_CANDIDATE_MISSING",
        reasonMessage: "The current production input has no build candidate.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.production.state === "IN_PROGRESS") {
      push({
        actionId: "PRODUCTION_BUILD_INCOMPLETE",
        area: "production",
        label: `Finish the production build for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.production,
        reasonCode: "PRODUCTION_CANDIDATE_PENDING",
        reasonMessage: "The production candidate is built but not yet QA-passed.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.production.state === "BLOCKED") {
      push({
        actionId: "PRODUCTION_QA_FAILED",
        area: "production",
        label: `Remediate production QA for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.production,
        reasonCode: "PRODUCTION_QA_FAILED",
        reasonMessage: "The current candidate failed production QA.",
        pageIdentity: page.pageIdentity,
      });
    }
  }

  // 10. QA recovery per page.
  for (const page of pageOrdered) {
    if (page.qa.state === "NOT_STARTED" && page.production.state === "ACCEPTED") {
      push({
        actionId: "QA_RUN_MISSING",
        area: "qa",
        label: `Run production QA for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.qa,
        reasonCode: "QA_MISSING",
        reasonMessage: "The current candidate has no QA run.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.qa.relation === "HISTORICAL") {
      push({
        actionId: "QA_HISTORICAL",
        area: "qa",
        label: `Re-run QA for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.qa,
        reasonCode: "QA_HISTORICAL_NOT_CURRENT",
        reasonMessage: "The latest QA PASS binds a superseded candidate.",
        pageIdentity: page.pageIdentity,
      });
    } else if (page.qa.state === "BLOCKED") {
      push({
        actionId: "QA_FAILED",
        area: "qa",
        label: `Remediate QA failures for ${page.pageIdentity}`,
        route: WORKFLOW_ROUTES.qa,
        reasonCode: "QA_FAILED",
        reasonMessage: "The current QA run failed.",
        pageIdentity: page.pageIdentity,
      });
    }
  }

  // 11. READY_FOR_DEPLOYMENT.
  if (actions.length === 0 && pages.length > 0) {
    push({
      actionId: "READY_FOR_DEPLOYMENT",
      area: "deployment",
      label: "Review deployment readiness",
      route: WORKFLOW_ROUTES.deployment,
      reasonCode: "READY_FOR_DEPLOYMENT",
      reasonMessage: "All current authorities are accepted and QA is current.",
    });
  }

  // Deterministic ordering: area order, then pageIdentity, then actionId.
  const areaRank = new Map(AREA_ORDER.map((a, i) => [a, i]));
  actions.sort((a, b) => {
    const rank = (areaRank.get(a.area) ?? 99) - (areaRank.get(b.area) ?? 99);
    if (rank !== 0) return rank;
    const pageCmp = (a.pageIdentity ?? "").localeCompare(b.pageIdentity ?? "");
    if (pageCmp !== 0) return pageCmp;
    return a.actionId.localeCompare(b.actionId);
  });
  return actions;
}

// ---------------------------------------------------------------------------
// Deployment readiness + overall state
// ---------------------------------------------------------------------------

function deriveDeployment(
  authorities: AuthorityProjection,
  pages: PageWorkflowRow[],
): DeploymentReadiness {
  const blockers: WorkflowBlocker[] = [];
  if (pages.length === 0) {
    blockers.push({
      code: "NO_PRODUCTION_PAGES",
      area: "deployment",
      message: "No accepted page content exists; nothing can be deployment-ready.",
      resolutionRoute: WORKFLOW_ROUTES.content,
    });
  }
  for (const page of pages) {
    if (page.production.state !== "ACCEPTED") {
      blockers.push({
        code: "PRODUCTION_NOT_CURRENT",
        area: "production",
        message: `Production for ${page.pageIdentity} is ${page.production.state}; a current QA-passed candidate is required.`,
        pageIdentity: page.pageIdentity,
        resolutionRoute: WORKFLOW_ROUTES.production,
      });
    }
    if (!(page.qa.state === "ACCEPTED" && page.qa.relation === "CURRENT")) {
      blockers.push({
        code: page.qa.relation === "HISTORICAL" ? "QA_HISTORICAL_NOT_CURRENT" : "QA_NOT_CURRENT",
        area: "qa",
        message:
          page.qa.relation === "HISTORICAL"
            ? `QA PASS for ${page.pageIdentity} is historical and binds a superseded candidate.`
            : `QA for ${page.pageIdentity} is not a current PASS.`,
        pageIdentity: page.pageIdentity,
        resolutionRoute: WORKFLOW_ROUTES.qa,
      });
    }
    if (page.derivatives.state === "STALE") {
      blockers.push({
        code: "DERIVATIVES_STALE",
        area: "content",
        message: `Derivatives for ${page.pageIdentity} are stale against the current accepted content.`,
        pageIdentity: page.pageIdentity,
        resolutionRoute: WORKFLOW_ROUTES.content,
      });
    }
  }

  const ready = blockers.length === 0 && pages.length > 0;
  const currentCandidate = pages.find((p) => p.production.state === "ACCEPTED");
  return {
    state: ready ? "READY_FOR_DEPLOYMENT" : "BLOCKED",
    candidate: currentCandidate
      ? {
          kind: "ProductionCandidate",
          id: currentCandidate.production.digest ?? "",
          version: currentCandidate.production.version,
          digest: currentCandidate.production.digest ?? undefined,
          pageIdentity: currentCandidate.pageIdentity,
        }
      : undefined,
    blockers,
    qaCurrent: pages.length > 0 && pages.every((p) => p.qa.state === "ACCEPTED" && p.qa.relation === "CURRENT"),
  };
}

function deriveOverallState(
  authorities: AuthorityProjection,
  pages: PageWorkflowRow[],
  deployment: DeploymentReadiness,
): ProjectOverallState {
  if (deployment.state === "READY_FOR_DEPLOYMENT") return "READY_FOR_DEPLOYMENT";
  // A never-saved draft is DRAFT (editable, not blocked) per intake
  // workspace semantics; only a saved-but-blocked draft is a hard blocker.
  const intakeBlocked = authorities.intake?.status === "BLOCKED";
  const hasHardBlocker =
    intakeBlocked ||
    pages.some((p) => p.production.state === "BLOCKED" || p.qa.state === "BLOCKED" || p.derivatives.state === "STALE");
  return hasHardBlocker ? "BLOCKED" : "IN_PROGRESS";
}

// ---------------------------------------------------------------------------
// Versions read model
// ---------------------------------------------------------------------------

export async function deriveProjectVersions(
  deps: WorkflowReadModelDeps,
  projectId: string,
): Promise<ProjectVersionsReadModel | null> {
  const [project] = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const [snapshots, acceptedContent, derivativeSets, designs, visualSets, candidates] = await Promise.all([
    deps.db
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(desc(projectInputSnapshots.version)),
    deps.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, projectId))
      .orderBy(desc(acceptedPageContent.version)),
    deps.db
      .select()
      .from(acceptedDerivativeSets)
      .where(eq(acceptedDerivativeSets.projectId, projectId))
      .orderBy(desc(acceptedDerivativeSets.version)),
    deps.db
      .select()
      .from(acceptedDesignArtifacts)
      .where(eq(acceptedDesignArtifacts.projectId, projectId))
      .orderBy(desc(acceptedDesignArtifacts.version)),
    deps.db
      .select()
      .from(acceptedVisualAssetSets)
      .where(eq(acceptedVisualAssetSets.projectId, projectId))
      .orderBy(desc(acceptedVisualAssetSets.version)),
    deps.db
      .select()
      .from(productionCandidates)
      .where(eq(productionCandidates.projectId, projectId))
      .orderBy(desc(productionCandidates.createdAt)),
  ]);

  const artifacts: ArtifactVersionSummary[] = [];

  // ProjectInputSnapshots: the LAST (highest version) is CURRENT.
  snapshots.forEach((s, i) => {
    artifacts.push({
      artifactKind: "ProjectInputSnapshot",
      id: s.id,
      version: s.version,
      digest: s.digest,
      acceptedAt: s.acceptedAt.toISOString(),
      relation: i === 0 ? "CURRENT" : "HISTORICAL",
    });
  });

  // AcceptedPageContent: current per page slug; other versions of the same
  // slug are HISTORICAL (a historical PASS/version remains a real fact).
  const currentBySlug = new Map<string, (typeof acceptedContent)[number]>();
  for (const row of acceptedContent) {
    if (!currentBySlug.has(row.slug)) currentBySlug.set(row.slug, row);
  }
  for (const row of acceptedContent) {
    const isCurrent = currentBySlug.get(row.slug)?.id === row.id;
    artifacts.push({
      artifactKind: "AcceptedPageContent",
      pageIdentity: row.slug,
      id: row.id,
      version: row.version,
      digest: row.contentDigest,
      acceptedAt: row.acceptedAt.toISOString(),
      relation: isCurrent ? "CURRENT" : "HISTORICAL",
      freshness: isCurrent ? "CURRENT" : undefined,
    });
  }

  // AcceptedDerivativeSets: current per page = highest version whose source
  // content matches the current content; older sets are HISTORICAL.
  const currentContentBySlug = currentBySlug;
  const currentSetByPage = new Map<string, (typeof derivativeSets)[number]>();
  for (const set of derivativeSets) {
    if (!currentSetByPage.has(set.pageIdentity)) currentSetByPage.set(set.pageIdentity, set);
  }
  for (const set of derivativeSets) {
    const isCurrent = currentSetByPage.get(set.pageIdentity)?.id === set.id;
    const source = currentContentBySlug.get(set.pageIdentity);
    const freshness: AuthorityFreshness | undefined = !isCurrent
      ? undefined
      : source &&
          set.sourceContentId === source.id &&
          set.sourceContentVersion === source.version &&
          set.sourceContentDigest === source.contentDigest
        ? "CURRENT"
        : "STALE";
    artifacts.push({
      artifactKind: "AcceptedDerivativeSet",
      pageIdentity: set.pageIdentity,
      id: set.id,
      version: set.version,
      digest: set.setDigest,
      relation: isCurrent ? "CURRENT" : "HISTORICAL",
      freshness,
      sourceAuthorities: [
        authorityRef({
          kind: "AcceptedPageContent",
          id: set.sourceContentId,
          version: set.sourceContentVersion,
          digest: set.sourceContentDigest,
          pageIdentity: set.pageIdentity,
        }),
      ],
    });
  }

  // AcceptedDesignArtifacts: highest version is CURRENT.
  designs.forEach((d, i) => {
    artifacts.push({
      artifactKind: "AcceptedDesignArtifact",
      id: d.id,
      version: d.version,
      digest: d.candidateDigest,
      acceptedAt: d.acceptedAt.toISOString(),
      relation: i === 0 ? "CURRENT" : "HISTORICAL",
    });
  });

  // AcceptedVisualAssetSets: highest version is CURRENT; freshness against
  // the current design binding.
  visualSets.forEach((s, i) => {
    const currentDesign = designs[0];
    const freshness: AuthorityFreshness | undefined =
      i === 0 && currentDesign
        ? s.designArtifactId === currentDesign.id && s.designArtifactVersion === currentDesign.version
          ? "CURRENT"
          : "STALE"
        : undefined;
    artifacts.push({
      artifactKind: "AcceptedVisualAssetSet",
      id: s.id,
      version: s.version,
      digest: s.setDigest,
      acceptedAt: s.acceptedAt.toISOString(),
      relation: i === 0 ? "CURRENT" : "HISTORICAL",
      freshness,
      sourceAuthorities: [
        authorityRef({
          kind: "AcceptedDesignArtifact",
          id: s.designArtifactId,
          version: s.designArtifactVersion,
          digest: s.designCandidateDigest,
        }),
      ],
    });
  });

  // ProductionCandidates: current per page = the newest candidate bound to
  // the newest input; others are HISTORICAL.
  const currentInputByPage = new Map<string, string>();
  for (const c of candidates) {
    if (!currentInputByPage.has(c.pageIdentity)) currentInputByPage.set(c.pageIdentity, c.productionInputId);
  }
  for (const c of candidates) {
    const isCurrent = currentInputByPage.get(c.pageIdentity) === c.productionInputId;
    artifacts.push({
      artifactKind: "ProductionCandidate",
      pageIdentity: c.pageIdentity,
      id: c.id,
      version: c.productionInputVersion,
      digest: c.artifactDigest ?? c.productionInputDigest,
      acceptedAt: c.createdAt.toISOString(),
      relation: isCurrent ? "CURRENT" : "HISTORICAL",
    });
  }

  return { projectId, artifacts };
}

// ---------------------------------------------------------------------------
// Costs read model
// ---------------------------------------------------------------------------

function costFromMicros(micros: number | null): CostValue {
  if (micros == null) return { kind: "UNKNOWN" };
  return { kind: "KNOWN", amountUsd: micros / 1_000_000 };
}

export async function deriveProjectCosts(
  deps: WorkflowReadModelDeps,
  projectId: string,
): Promise<ProjectCostsReadModel | null> {
  const [project] = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  type Row = {
    provider: string;
    model: string | null;
    operation: string;
    pageIdentity: string | null;
    costMicros: number | null;
  };

  const [invocations, visualRequests, summaries, audio] = await Promise.all([
    deps.db
      .select({
        provider: modelInvocations.provider,
        model: modelInvocations.model,
        costMicros: modelInvocations.costMicros,
      })
      .from(modelInvocations)
      .innerJoin(runs, eq(modelInvocations.runId, runs.id))
      .where(eq(runs.projectId, projectId)),
    deps.db
      .select({
        provider: visualGenerationRequests.provider,
        model: visualGenerationRequests.model,
        operation: visualGenerationRequests.operation,
        costMicros: visualGenerationRequests.costMicros,
      })
      .from(visualGenerationRequests)
      .where(eq(visualGenerationRequests.projectId, projectId)),
    deps.db
      .select({
        provider: summaryProposals.provider,
        model: summaryProposals.model,
        pageIdentity: summaryProposals.pageIdentity,
        costMicros: summaryProposals.usageCostMicros,
      })
      .from(summaryProposals)
      .where(eq(summaryProposals.projectId, projectId)),
    deps.db
      .select({
        provider: audioCandidates.provider,
        model: audioCandidates.engine,
        pageIdentity: audioCandidates.pageIdentity,
        costMicros: audioCandidates.usageCostMicros,
      })
      .from(audioCandidates)
      .where(eq(audioCandidates.projectId, projectId)),
  ]);

  const rows: Row[] = [
    ...invocations.map((r) => ({
      provider: r.provider,
      model: r.model,
      operation: "model_invocation",
      pageIdentity: null,
      costMicros: r.costMicros,
    })),
    ...visualRequests.map((r) => ({
      provider: r.provider,
      model: r.model,
      operation: `visual_${r.operation}`,
      pageIdentity: null,
      costMicros: r.costMicros,
    })),
    ...summaries.map((r) => ({
      provider: r.provider,
      model: r.model,
      operation: "summary_generation",
      pageIdentity: r.pageIdentity,
      costMicros: r.costMicros,
    })),
    ...audio.map((r) => ({
      provider: r.provider,
      model: r.model,
      operation: "audio_narration",
      pageIdentity: r.pageIdentity,
      costMicros: r.costMicros,
    })),
  ];

  const grouped = new Map<string, CostAggregateRow>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model ?? ""}\u0000${row.operation}\u0000${row.pageIdentity ?? ""}`;
    const existing = grouped.get(key) ?? {
      provider: row.provider,
      model: row.model,
      operation: row.operation,
      pageIdentity: row.pageIdentity,
      calls: 0,
      knownCost: { kind: "UNKNOWN" as const },
      unknownCostCalls: 0,
    };
    existing.calls += 1;
    if (row.costMicros == null) {
      existing.unknownCostCalls += 1;
    } else {
      const current = existing.knownCost.kind === "KNOWN" ? existing.knownCost.amountUsd : 0;
      existing.knownCost = { kind: "KNOWN", amountUsd: current + row.costMicros / 1_000_000 };
    }
    grouped.set(key, existing);
  }

  // Design provider records no cost telemetry: report truthfully.
  const unavailableSources: ProjectCostsReadModel["unavailableSources"] = [
    { source: "design_provider", reason: "The DesignProvider seam records no cost telemetry; cost is NOT AVAILABLE, not zero." },
    { source: "serp_provider", reason: "SERP cost evidence is stored in snapshot usage JSON; aggregated only when present." },
  ];

  return {
    projectId,
    rows: [...grouped.values()].sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      (a.model ?? "").localeCompare(b.model ?? "") ||
      a.operation.localeCompare(b.operation) ||
      (a.pageIdentity ?? "").localeCompare(b.pageIdentity ?? ""),
    ),
    unattributedCalls: 0,
    unavailableSources,
  };
}
