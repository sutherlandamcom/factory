import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  DEPLOYMENT_PUBLISH_PERMISSION,
  qaRunPublicationEligible,
  type GovernedDeploymentView,
  type MonitoringSummary,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import type { FactoryDb } from "../persistence/db.js";
import type {
  DeploymentRecord,
  ProductionCandidateRecord,
  ProductionCandidateInputRecord,
  ProductionPageInputRecord,
  ReleaseApprovalRecord,
  SiteRecord,
} from "../persistence/schema.js";
import { sites } from "../persistence/schema.js";
import { loadWorktreeSiteProfile } from "../executor/site-profile.js";
import { FactoryStore } from "../persistence/store.js";
import { ProductionStore } from "../production/store.js";
import { loadProductionBuildIdentity } from "../production/identity.js";
import {
  ReleaseApprovalBoundary,
  verifyReleaseApprovalSeal,
} from "../trust/release-approval-boundary.js";
import { stageExactCandidateArtifact } from "./candidate-artifact.js";
import { assertCandidateReleaseQaProof } from "./release-preflight.js";
import { runRemoteQa, type RemoteQaResult } from "./qa.js";
import { MonitoringService } from "../monitoring/service.js";
import {
  ProductionDelivery,
  knownGoodVersion,
  type DeliveryRuntime,
  type WranglerOperations,
} from "./service.js";
import {
  prepareAcceptedWorktree,
  removeWorktree,
} from "./source.js";
import { WranglerClient } from "./wrangler.js";

export interface EffectivePageReleaseLineage {
  siteId: string;
  route: string;
  asOfTimestamp: string;
  effectiveDeployment: {
    id: string;
    versionId: string;
    workerName: string;
    productionUrl: string;
    sourceCommit: string;
    artifactDigest: string;
    promotedAt: string | null;
    verifiedAt: string | null;
    status: string;
  } | null;
  releaseApproval: {
    id: string;
    actorId: string;
    actorName: string;
    actorRole: string;
    sealedAt: string;
    sealStatus: string;
    verificationSeal: string | null;
  } | null;
  qaEvidence: {
    qaRunId: string;
    overall: string;
    publicationEligible: boolean;
    checkCount: number;
    checks: Array<{
      checkId: string;
      group: string;
      verdict: string;
      executionDigest?: string;
    }>;
  } | null;
  candidate: {
    id: string;
    artifactDigest: string;
    manifestSetDigest: string;
    repositorySha: string;
    lockfileDigest: string;
    rendererVersion: string;
    siteProfileDigest: string;
  } | null;
  pageAuthority: {
    pageIdentity: string;
    productionInputId: string;
    productionInputVersion: number;
    productionInputDigest: string;
    acceptedContent: {
      id: string;
      version: number;
      digest: string;
    };
    acceptedDesign: {
      id: string;
      version: number;
      digest: string;
    };
    acceptedVisualSet: {
      id: string;
      version: number;
      digest: string;
    };
    pageArchetype?: string | null;
    renderer: {
      id: string;
      version: string;
      policyVersion: string;
    };
  } | null;
}

export interface GovernedDeliveryDeps {
  db: FactoryDb;
  pool?: any;
  repoRoot: string;
  store: FactoryStore;
  productionStore: ProductionStore;
  releaseBoundary: ReleaseApprovalBoundary;
  monitoringService?: MonitoringService;
  wranglerFactory?: (worktree: string, artifactsDir: string) => WranglerOperations;
  worktreeProvider?: {
    prepare: (repoRoot: string, commit: string, id: string) => Promise<string>;
    remove: (repoRoot: string, worktree: string) => Promise<void>;
  };
  qaRunner?: (input: Parameters<typeof runRemoteQa>[0]) => Promise<RemoteQaResult>;
}

export class GovernedDeliveryService {
  private readonly db: FactoryDb;
  private readonly pool: any;
  private readonly repoRoot: string;
  private readonly store: FactoryStore;
  private readonly productionStore: ProductionStore;
  private readonly releaseBoundary: ReleaseApprovalBoundary;
  private readonly monitoringService: MonitoringService;
  private readonly wranglerFactory: (worktree: string, artifactsDir: string) => WranglerOperations;
  private readonly worktreeProvider: {
    prepare: (repoRoot: string, commit: string, id: string) => Promise<string>;
    remove: (repoRoot: string, worktree: string) => Promise<void>;
  };
  private readonly qaRunner: (input: Parameters<typeof runRemoteQa>[0]) => Promise<RemoteQaResult>;
  private static readonly memoryLocks = new Map<string, Promise<void>>();

  constructor(deps: GovernedDeliveryDeps) {
    this.db = deps.db;
    this.pool = deps.pool ?? (deps.db as any)?.$client ?? null;
    this.repoRoot = deps.repoRoot;
    this.store = deps.store;
    this.productionStore = deps.productionStore;
    this.releaseBoundary = deps.releaseBoundary;
    this.monitoringService =
      deps.monitoringService ??
      new MonitoringService({ db: this.db, store: this.store });
    this.wranglerFactory =
      deps.wranglerFactory ??
      ((worktree, artifacts) => new WranglerClient(path.join(worktree, "sites", "starter"), artifacts));
    this.worktreeProvider = deps.worktreeProvider ?? {
      prepare: prepareAcceptedWorktree,
      remove: removeWorktree,
    };
    this.qaRunner = deps.qaRunner ?? runRemoteQa;
  }

  async withProjectLock<T>(projectId: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    const pool = this.pool ?? (this.db as any)?.$client;
    if (pool && typeof pool.connect === "function") {
      const client = await pool.connect();
      let acquired = false;
      const start = Date.now();
      try {
        while (Date.now() - start < timeoutMs) {
          const res = await client.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 104)) AS locked",
            [projectId],
          );
          if (res.rows?.[0]?.locked) {
            acquired = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!acquired) {
          throw new FactoryError(
            "concurrent_deployment_in_progress",
            `Could not acquire exclusive delivery lock for project '${projectId}' within ${timeoutMs}ms. Another deployment operation is in progress.`,
          );
        }
        return await fn();
      } finally {
        if (acquired) {
          try {
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 104))", [projectId]);
          } catch {
            // Ignore unlock errors during connection teardown
          }
        }
        client.release();
      }
    }

    // In-process serialization fallback for unit test environments without a real pg.Pool
    while (GovernedDeliveryService.memoryLocks.has(projectId)) {
      await GovernedDeliveryService.memoryLocks.get(projectId);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    GovernedDeliveryService.memoryLocks.set(projectId, lockPromise);
    try {
      return await fn();
    } finally {
      GovernedDeliveryService.memoryLocks.delete(projectId);
      resolveLock();
    }
  }

  private async assertComprehensiveUpstreamAuthority(params: {
    projectId: string;
    candidate: ProductionCandidateRecord;
    candidateInputs: readonly ProductionCandidateInputRecord[];
    currentInputs: readonly ProductionPageInputRecord[];
    buildIdentity: any;
    forPublication?: boolean;
  }): Promise<void> {
    const { projectId, candidate, candidateInputs, currentInputs, buildIdentity, forPublication } = params;

    // Reject synthetic fixture mode for publication
    if (forPublication) {
      const qaRun = await this.productionStore.latestQaRun(projectId, candidate.id);
      if (qaRun?.data && !qaRunPublicationEligible(qaRun.data)) {
        throw new FactoryError(
          "production_authority_stale",
          `Candidate '${candidate.id}' QA run is not publication-eligible (synthetic fixture mode or unreviewed claims).`,
        );
      }
    }

    // Verify candidate identity against current build identity
    if (typeof this.productionStore.candidateStaleness === "function") {
      const candStaleness = this.productionStore.candidateStaleness(candidate, buildIdentity);
      if (candStaleness.stale) {
        throw new FactoryError(
          "production_authority_stale",
          candStaleness.reason ?? "Candidate build identity is stale.",
        );
      }
    }

    // Revalidate each bound input against current ProductionPageInput and upstream authorities
    const currentInputMap = new Map(currentInputs.map((i) => [i.id, i]));

    for (const binding of candidateInputs) {
      const currentInput = currentInputMap.get(binding.productionInputId);
      if (!currentInput) {
        throw new FactoryError(
          "production_authority_stale",
          `Bound production input '${binding.productionInputId}' is no longer present in current site inputs.`,
        );
      }

      if (
        currentInput.version !== binding.productionInputVersion ||
        currentInput.inputDigest !== binding.productionInputDigest
      ) {
        throw new FactoryError(
          "production_authority_stale",
          `Production input '${binding.productionInputId}' version (${currentInput.version} vs bound ${binding.productionInputVersion}) or digest has changed.`,
        );
      }

      // Authoritative upstream verification: Content, Design, VisualSet, Slots, Archetype, Trust claims
      if (typeof this.productionStore.inputStaleness === "function") {
        const staleness = await this.productionStore.inputStaleness(currentInput, buildIdentity);
        if (staleness.stale) {
          throw new FactoryError(
            "production_authority_stale",
            `Production input '${currentInput.id}' for route '${binding.route}' is stale: ${staleness.reason}`,
          );
        }
      }
    }
  }

  private async resolveSite(projectId: string): Promise<SiteRecord> {
    let site = await this.store.findSiteByProjectId(projectId);
    if (!site) {
      const project = await this.store.getProjectById(projectId);
      if (!project) {
        throw new FactoryError("unknown_project", `Project '${projectId}' not found.`);
      }
      const profile = await loadWorktreeSiteProfile(this.repoRoot).catch(() => null);
      try {
        const registered = await this.store.registerSite({
          projectKey: project.key,
          key: project.key,
          name: project.name,
        });
        await this.db
          .update(sites)
          .set({
            cloudflareWorkerName: `factory-${project.key}`,
            productionUrl: profile?.canonicalOrigin ?? `https://${project.key}.pages.dev`,
          })
          .where(eq(sites.id, registered.id));
        site = (await this.store.getSiteById(registered.id))!;
      } catch (err) {
        site = await this.store.findSiteByProjectId(projectId);
        if (!site) throw err;
      }
    }
    if (!site.cloudflareWorkerName || !site.productionUrl) {
      const project = await this.store.getProjectById(projectId);
      const profile = await loadWorktreeSiteProfile(this.repoRoot).catch(() => null);
      if (this.db && project) {
        await this.db
          .update(sites)
          .set({
            cloudflareWorkerName: site.cloudflareWorkerName ?? `factory-${project.key}`,
            productionUrl: site.productionUrl ?? profile?.canonicalOrigin ?? `https://${project.key}.pages.dev`,
          })
          .where(eq(sites.id, site.id));
        site = (await this.store.getSiteById(site.id)) ?? site;
      }
    }
    if (!site.cloudflareWorkerName || !site.productionUrl) {
      throw new FactoryError(
        "delivery_target_unconfigured",
        `Site '${site.key}' does not have Cloudflare Worker and production URL configured.`,
      );
    }
    return site;
  }

  /**
   * Prepares a candidate-bound preview:
   * 1. Validates candidate & QA proof fail-closed.
   * 2. Stages exact immutable candidate bytes into isolated worktree Wrangler dir.
   * 3. Creates deployment row in PostgreSQL.
   * 4. Uploads version to Cloudflare.
   * 5. Runs candidate route Playwright QA on preview URL.
   * 6. Reaches preview_verified (NEVER promotes automatically).
   */
  async prepareCandidatePreview(input: {
    projectId: string;
    candidateId?: string;
    sessionToken?: string;
  }): Promise<DeploymentRecord> {
    if (this.releaseBoundary) {
      if (!input.sessionToken) {
        throw new FactoryError(
          "actor_unauthenticated",
          "IdP session token is required to prepare candidate preview.",
        );
      }
      await this.releaseBoundary.verifyActorPermission({
        sessionToken: input.sessionToken,
        projectId: input.projectId,
        requiredPermission: "DEPLOYMENT:PREVIEW",
      });
    }

    return await this.withProjectLock(input.projectId, async () => {
      const site = await this.resolveSite(input.projectId);

      // 1. Resolve candidate
      let candidate: ProductionCandidateRecord | null = null;
      if (input.candidateId) {
        candidate = await this.productionStore.getCandidate(input.projectId, input.candidateId);
      } else {
        const candidates = await this.productionStore.listCandidates(input.projectId);
        candidate = candidates.find((c) => c.state === "qa_passed") ?? candidates[0] ?? null;
      }

      if (!candidate) {
        throw new FactoryError("production_candidate_not_found", "No candidate found to preview.");
      }

      // 2. Resolve QA run & inputs
      const latestQa = await this.productionStore.latestQaRun(input.projectId, candidate.id);
      const candidateInputs = await this.productionStore.listCandidateInputs(input.projectId, candidate.id);
      const currentInputs = await this.productionStore.listProductionInputs(input.projectId);
      const currentPageInputIds = currentInputs.map((i) => i.id);

      const buildIdentity = await loadProductionBuildIdentity(this.repoRoot);

      // 3. Assert candidate release proof
      if (!site.productionUrl) {
        throw new FactoryError("invalid_site_configuration", `Site '${site.id}' does not have a configured productionUrl.`);
      }

      assertCandidateReleaseQaProof({
        projectId: input.projectId,
        candidate,
        latestQa,
        candidateInputs,
        currentPageInputIds,
        canonicalOrigin: site.productionUrl,
        buildIdentity,
      });

      // P0-02: Comprehensive upstream authority verification
      await this.assertComprehensiveUpstreamAuthority({
        projectId: input.projectId,
        candidate,
        candidateInputs,
        currentInputs,
        buildIdentity,
      });

      const candidateRoutes = candidateInputs.map((b) => b.route);

      // 4. Check for active unverified deployment
      const unverified = await this.store.findLatestUnverifiedDeployment(site.id);
      if (unverified) {
        throw new FactoryError(
          "concurrent_deployment_in_progress",
          `Deployment '${unverified.id}' is currently in progress (${unverified.status}).`,
        );
      }

      // 5. Create deployment record
      const deploymentId = `deployment-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const artifactDir = path.join(".factory", "deployments", deploymentId);
      const fullArtifactDir = path.join(this.repoRoot, artifactDir);
      await mkdir(fullArtifactDir, { recursive: true });

      const deployment = await this.store.createDeployment({
        id: deploymentId,
        siteId: site.id,
        sourceCommit: candidate.repositorySha!,
        workerName: site.cloudflareWorkerName!,
        productionUrl: site.productionUrl!,
        artifactDirectory: artifactDir,
        candidateId: candidate.id,
        qaRunId: latestQa!.id,
        candidateRoutes,
        snapshotData: {
          buildIdentity,
          manifestSetDigest: candidate.manifestSetDigest,
          redirectSnapshotDigest: candidate.redirectSnapshotDigest,
        },
      });

      // 6. Prepare isolated worktree and stage exact candidate bytes
      let worktree: string | null = null;
      try {
        worktree = await this.worktreeProvider.prepare(
          this.repoRoot,
          candidate.repositorySha!,
          deploymentId,
        );

        const staged = await stageExactCandidateArtifact({
          repositoryRoot: this.repoRoot,
          projectId: input.projectId,
          candidateId: candidate.id,
          artifactRef: candidate.artifactRef!,
          expectedDigest: candidate.artifactDigest!,
          wranglerSiteDirectory: path.join(worktree, "sites", "starter"),
        });

        const provider = this.wranglerFactory(worktree, fullArtifactDir);

        const deliveryRuntime: DeliveryRuntime = {
          build: async () => staged.stagedDirectory,
          digest: async () => staged.artifactDigest,
          qa: async (targetUrl, phase) =>
            await this.qaRunner({
              worktree: worktree!,
              targetUrl,
              productionUrl: site.productionUrl!,
              artifactDirectory: fullArtifactDir,
              phase,
              candidateRoutes,
            }),
          assertSourceStillAccepted: async () => {},
        };

        const delivery = new ProductionDelivery(this.store, provider, deliveryRuntime);
        return await delivery.preparePreview(deployment);
      } finally {
        if (worktree) {
          await this.worktreeProvider.remove(this.repoRoot, worktree).catch(() => {});
        }
      }
    });
  }

  /**
   * Approves a preview-verified release using genuine external IdP identity.
   */
  async approveRelease(input: {
    projectId: string;
    candidateId: string;
    previewVersionId: string;
    sessionToken: string;
  }): Promise<ReleaseApprovalRecord> {
    const site = await this.resolveSite(input.projectId);
    return await this.releaseBoundary.createReleaseApproval({
      projectId: input.projectId,
      siteId: site.id,
      candidateId: input.candidateId,
      previewVersionId: input.previewVersionId,
      sessionToken: input.sessionToken,
    });
  }

  /**
   * Publishes an approved preview version:
   * 1. Re-validates actor permission (DEPLOYMENT:PUBLISH) & approval seal.
   * 2. Re-validates 10 preflight invariants under project advisory lock.
   * 3. Transitions to promoting before external mutation.
   * 4. Calls Wrangler exact-version promote.
   * 5. Runs candidate-bound production QA.
   * 6. Automatically rolls back to known-good if production QA fails.
   */
  async publishApprovedRelease(input: {
    projectId: string;
    candidateId: string;
    previewVersionId: string;
    approvalId: string;
    sessionToken: string;
  }): Promise<DeploymentRecord> {
    return await this.withProjectLock(input.projectId, async () => {
      const site = await this.resolveSite(input.projectId);

      // 1. Verify actor has DEPLOYMENT:PUBLISH permission
      await this.releaseBoundary.verifyActorPermission({
        sessionToken: input.sessionToken,
        projectId: input.projectId,
        requiredPermission: DEPLOYMENT_PUBLISH_PERMISSION,
      });

      // 2. Validate release approval
      const approval = await this.releaseBoundary.assertValidReleaseApproval({
        approvalId: input.approvalId,
        projectId: input.projectId,
        siteId: site.id,
        candidateId: input.candidateId,
        previewVersionId: input.previewVersionId,
        targetWorkerName: site.cloudflareWorkerName!,
        targetProductionUrl: site.productionUrl!,
      });

      // 3. Find preview-verified deployment
      const previewDeployment = await this.store.findLatestDeploymentByCandidate(site.id, input.candidateId);
      if (
        !previewDeployment ||
        previewDeployment.status !== "preview_verified" ||
        !previewDeployment.previewVerified ||
        previewDeployment.versionId !== input.previewVersionId
      ) {
        throw new FactoryError(
          "deployment_transition_invalid",
          `Deployment for candidate '${input.candidateId}' and version '${input.previewVersionId}' is not in 'preview_verified' state.`,
        );
      }

      // Check for concurrent unverified deployments, attempting crash reconciliation if stalled in promoting/promoted
      let unverified = await this.store.findLatestUnverifiedDeployment(site.id);
      if (unverified && (unverified.status === "promoting" || unverified.status === "promoted")) {
        await this.reconcilePendingDeployments(site.id);
        unverified = await this.store.findLatestUnverifiedDeployment(site.id);
      }
      if (unverified && unverified.id !== previewDeployment.id) {
        throw new FactoryError(
          "concurrent_deployment_in_progress",
          `Deployment '${unverified.id}' is currently in progress (${unverified.status}).`,
        );
      }

      // 4. Re-verify candidate & strict QA proof
      const candidate = await this.productionStore.getCandidate(input.projectId, input.candidateId);
      if (!candidate || candidate.state !== "qa_passed") {
        throw new FactoryError("candidate_not_eligible", "Candidate is not in 'qa_passed' state.");
      }
      const latestQa = await this.productionStore.latestQaRun(input.projectId, candidate.id);
      const candidateInputs = await this.productionStore.listCandidateInputs(input.projectId, candidate.id);
      const currentInputs = await this.productionStore.listProductionInputs(input.projectId);
      const buildIdentity = await loadProductionBuildIdentity(this.repoRoot);

      if (!site.productionUrl) {
        throw new FactoryError("invalid_site_configuration", `Site '${site.id}' does not have a configured productionUrl.`);
      }

      assertCandidateReleaseQaProof({
        projectId: input.projectId,
        candidate,
        latestQa,
        candidateInputs,
        currentPageInputIds: currentInputs.map((i) => i.id),
        canonicalOrigin: site.productionUrl,
        buildIdentity,
      });

      // P0-02: Comprehensive upstream authority verification (strictly rejects synthetic fixture mode for publication)
      await this.assertComprehensiveUpstreamAuthority({
        projectId: input.projectId,
        candidate,
        candidateInputs,
        currentInputs,
        buildIdentity,
        forPublication: true,
      });

      const candidateRoutes = (previewDeployment.candidateRoutes as string[]) ?? candidateInputs.map((b) => b.route);
      const fullArtifactDir = path.join(this.repoRoot, previewDeployment.artifactDirectory!);

      // 5. Prepare worktree for deployment operations
      let worktree: string | null = null;
      try {
        worktree = await this.worktreeProvider.prepare(
          this.repoRoot,
          candidate.repositorySha!,
          `pub-${previewDeployment.id}`,
        );

        const provider = this.wranglerFactory(worktree, fullArtifactDir);

        const deliveryRuntime: DeliveryRuntime = {
          build: async () => path.join(worktree!, "sites", "starter", "dist"),
          digest: async () => candidate.artifactDigest!,
          qa: async (targetUrl, phase) =>
            await this.qaRunner({
              worktree: worktree!,
              targetUrl,
              productionUrl: site.productionUrl!,
              artifactDirectory: fullArtifactDir,
              phase,
              candidateRoutes,
            }),
          assertSourceStillAccepted: async () => {},
        };

        const delivery = new ProductionDelivery(this.store, provider, deliveryRuntime);
        const published = await delivery.publishApproved({
          previewDeployment,
          approval,
        });

        // R13-R5: Record post-publication technical verification and append-only effective transition
        if (published.status === "verified" && published.versionId) {
          await this.store.insertEffectiveTransition({
            id: `trans-${randomUUID()}`,
            projectId: input.projectId,
            siteId: site.id,
            deploymentId: published.id,
            versionId: published.versionId,
            candidateId: candidate.id,
            eventType: "PUBLISH",
            fromVersionId: previewDeployment.previousVersionId ?? null,
            toVersionId: published.versionId,
            actorId: approval.actorId,
            actorName: approval.actorName,
            actorRole: approval.actorRole,
            sessionId: approval.sessionId,
            candidateRoutes,
            artifactDigest: candidate.artifactDigest,
            evidenceRef: published.artifactDirectory ?? undefined,
            effectiveAt: published.verifiedAt ?? new Date(),
          });

          await this.monitoringService
            .recordTechnicalVerification({
              projectId: input.projectId,
              siteId: site.id,
              deploymentId: published.id,
              versionId: published.versionId,
              routes: candidateRoutes,
              passed: published.productionVerified,
              evidenceRef: published.artifactDirectory ?? undefined,
            })
            .catch(() => {});
        }

        return published;
      } finally {
        if (worktree) {
          await this.worktreeProvider.remove(this.repoRoot, worktree).catch(() => {});
        }
      }
    });
  }

  /**
   * Explicit operator-initiated rollback to an exact known-good version.
   */
  async rollbackExplicit(input: {
    projectId: string;
    targetVersionId?: string;
    sessionToken: string;
  }): Promise<DeploymentRecord> {
    return await this.withProjectLock(input.projectId, async () => {
      const site = await this.resolveSite(input.projectId);

      // Verify publisher permission
      const session = await this.releaseBoundary.verifyActorPermission({
        sessionToken: input.sessionToken,
        projectId: input.projectId,
        requiredPermission: DEPLOYMENT_PUBLISH_PERMISSION,
      });

      // Check for active unverified deployment, attempting crash reconciliation if stalled in promoting/promoted
      let unverified = await this.store.findLatestUnverifiedDeployment(site.id);
      if (unverified && (unverified.status === "promoting" || unverified.status === "promoted")) {
        await this.reconcilePendingDeployments(site.id);
        unverified = await this.store.findLatestUnverifiedDeployment(site.id);
      }
      if (unverified) {
        throw new FactoryError(
          "concurrent_deployment_in_progress",
          `Deployment '${unverified.id}' is currently in progress (${unverified.status}).`,
        );
      }

      const latestDeployment = (await this.store.listDeployments(site.id, 1))[0];
      if (!latestDeployment) {
        throw new FactoryError("deployment_not_found", "No deployment found to rollback.");
      }

      const canonicalDeployments = typeof this.store.listCanonicalVerifiedDeployments === "function"
        ? await this.store.listCanonicalVerifiedDeployments(
            site.id,
            site.cloudflareWorkerName!,
            site.productionUrl!,
          )
        : (await this.store.listDeployments(site.id, 50)).filter(
            (d) => d.status === "verified" && d.productionVerified && d.versionId && d.artifactDigest,
          );

      const knownGood = await this.store.findLatestKnownGoodDeployment(
        site.id,
        site.cloudflareWorkerName!,
        site.productionUrl!,
        latestDeployment.id,
      );

      const targetVersion =
        input.targetVersionId ??
        knownGood?.versionId ??
        latestDeployment.previousVersionId ??
        latestDeployment.versionId;
      if (!targetVersion) {
        throw new FactoryError("rollback_target_missing", "No target version specified and no previous known-good deployment found.");
      }

      const targetDeployment = input.targetVersionId
        ? canonicalDeployments.find((d) => d.versionId === input.targetVersionId)
        : (knownGood ?? canonicalDeployments[0] ?? latestDeployment);

      if (!targetDeployment || !targetDeployment.versionId) {
        throw new FactoryError(
          "rollback_target_invalid",
          `Target rollback version '${targetVersion}' is not an accepted canonical verified deployment.`,
        );
      }

      if (targetDeployment.siteId !== latestDeployment.siteId) {
        throw new FactoryError(
          "rollback_target_invalid",
          `Target rollback version does not belong to the same site.`,
        );
      }

      const targetRoutes = (targetDeployment.candidateRoutes as string[]) ?? ["/"];

      const fullArtifactDir = path.join(
        this.repoRoot,
        targetDeployment.artifactDirectory || latestDeployment.artifactDirectory || ".factory/deployments/rollback",
      );

      let worktree: string | null = null;
      try {
        if (targetDeployment.sourceCommit) {
          worktree = await this.worktreeProvider.prepare(
            this.repoRoot,
            targetDeployment.sourceCommit,
            `rb-${latestDeployment.id}`,
          );
        }

        const provider = this.wranglerFactory(worktree || this.repoRoot, fullArtifactDir);
        const deliveryRuntime: DeliveryRuntime = {
          build: async () => path.join(worktree || this.repoRoot, "sites", "starter", "dist"),
          digest: async () => targetDeployment.artifactDigest || "target-digest",
          qa: async (targetUrl, phase) =>
            await this.qaRunner({
              worktree: worktree || this.repoRoot,
              targetUrl,
              productionUrl: site.productionUrl!,
              artifactDirectory: fullArtifactDir,
              phase,
              candidateRoutes: targetRoutes,
            }),
          assertSourceStillAccepted: async () => {},
        };

        const delivery = new ProductionDelivery(this.store, provider, deliveryRuntime);
        const rolledBack = await delivery.rollbackExplicit({
          deployment: latestDeployment,
          targetVersionId: targetVersion,
          targetDeployment,
        });

        if (rolledBack.status === "rolled_back" && rolledBack.versionId) {
          await this.store.insertEffectiveTransition({
            id: `trans-${randomUUID()}`,
            projectId: input.projectId,
            siteId: site.id,
            deploymentId: rolledBack.id,
            versionId: targetVersion,
            candidateId: targetDeployment.candidateId,
            eventType: "ROLLBACK",
            fromVersionId: latestDeployment.versionId,
            toVersionId: targetVersion,
            actorId: session.actorId,
            actorName: session.actorName,
            actorRole: session.actorRole,
            sessionId: session.sessionId,
            candidateRoutes: targetRoutes,
            artifactDigest: targetDeployment.artifactDigest,
            evidenceRef: rolledBack.artifactDirectory ?? undefined,
            effectiveAt: rolledBack.verifiedAt ?? new Date(),
          });
        }

        return rolledBack;
      } finally {
        if (worktree) {
          await this.worktreeProvider.remove(this.repoRoot, worktree).catch(() => {});
        }
      }
    });
  }

  /**
   * P1-03: Crash reconciliation for uncommitted Cloudflare mutations.
   * If a previous deployment was interrupted in 'promoting' or 'promoted' state,
   * queries Cloudflare to determine if the version was actually activated:
   * - If Cloudflare active version matches: recovers deployment to 'verified' and records reconciled transition.
   * - If Cloudflare active version does NOT match: marks deployment as 'failed'.
   */
  async reconcilePendingDeployments(siteId: string): Promise<{ reconciled: boolean; details?: string }> {
    const unverified = await this.store.findLatestUnverifiedDeployment(siteId);
    if (!unverified) {
      return { reconciled: false, details: "No pending or unverified deployment found." };
    }

    if (unverified.status === "promoting" || unverified.status === "promoted") {
      const site = await this.store.getSiteById(siteId);
      if (!site || !site.cloudflareWorkerName) {
        return { reconciled: false, details: "Site or worker configuration missing." };
      }

      const fullArtifactDir = path.join(this.repoRoot, unverified.artifactDirectory || ".factory/deployments/reconcile");
      const provider = this.wranglerFactory(this.repoRoot, fullArtifactDir);
      let cfActiveVersion: string | null = null;
      try {
        cfActiveVersion = await provider.currentProductionVersion(site.cloudflareWorkerName);
      } catch (err: any) {
        return { reconciled: false, details: `Failed to query Cloudflare provider: ${err.message}` };
      }

      if (cfActiveVersion && cfActiveVersion === unverified.versionId) {
        await this.store.updateDeployment({
          id: unverified.id,
          status: "verified",
          productionVerified: true,
          verifiedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        });

        const routes = (unverified.candidateRoutes as string[]) ?? ["/"];
        await this.store.insertEffectiveTransition({
          id: `trans-rec-${randomUUID()}`,
          projectId: site.projectId,
          siteId: site.id,
          deploymentId: unverified.id,
          versionId: unverified.versionId,
          candidateId: unverified.candidateId ?? "unknown",
          eventType: "PUBLISH",
          fromVersionId: unverified.previousVersionId ?? null,
          toVersionId: unverified.versionId,
          actorId: "system:crash-recovery",
          actorName: "Crash Recovery Reconciler",
          actorRole: "SYSTEM",
          sessionId: "session:crash-recovery",
          candidateRoutes: routes,
          artifactDigest: unverified.artifactDigest ?? "reconciled-digest",
          evidenceRef: JSON.stringify({
            reconciled: true,
            reason: "crash_recovery_cloudflare_matched",
            recoveredAt: new Date().toISOString(),
          }),
          effectiveAt: new Date(),
        });

        return {
          reconciled: true,
          details: `Deployment '${unverified.id}' reconciled to verified; active Cloudflare version '${cfActiveVersion}' confirmed.`,
        };
      } else {
        await this.store.updateDeployment({
          id: unverified.id,
          status: "failed",
          errorCode: "delivery_interrupted",
          errorMessage: "Deployment interrupted before Cloudflare promotion completed. Reconciled to failed.",
        });

        return {
          reconciled: true,
          details: `Deployment '${unverified.id}' reconciled to failed; Cloudflare active version was '${cfActiveVersion}', expected '${unverified.versionId}'.`,
        };
      }
    }

    return { reconciled: false, details: `Deployment '${unverified.id}' is in status '${unverified.status}' (not reconcilable).` };
  }

  /**
   * Computes the full governed operator deployment read model.
   */
  /**
   * P1-01: Single authoritative resolver of current effective production state.
   * Derives active version, deployment ID, candidate, and execution origin
   * from append-only production_effective_transitions (or canonical deployments fallback).
   */
  async resolveCurrentEffectiveProduction(siteId: string): Promise<{
    activeVersionId: string | null;
    knownGoodVersionId: string | null;
    lastVerifiedAt: string | null;
    deploymentId: string | null;
    candidateId: string | null;
    executionOrigin: "REAL_CLOUDFLARE" | "TEST_SIMULATION";
    deliveryMode?: string;
  }> {
    const rawDeliveryMode = process.env.FACTORY_DELIVERY_MODE?.trim().toLowerCase();
    const isSimulated =
      rawDeliveryMode === "fixture" ||
      rawDeliveryMode === "test" ||
      rawDeliveryMode === "simulation";
    const executionOrigin: "REAL_CLOUDFLARE" | "TEST_SIMULATION" = isSimulated
      ? "TEST_SIMULATION"
      : "REAL_CLOUDFLARE";

    const transition = typeof this.store.getCurrentEffectiveTransition === "function"
      ? await this.store.getCurrentEffectiveTransition(siteId)
      : null;

    const site = (await (this.store as any).getSiteById?.(siteId)) ??
      (await this.store.findSiteByProjectId(siteId));

    const latestKnownGood = await this.store.findLatestKnownGoodDeployment(
      siteId,
      site?.cloudflareWorkerName ?? "",
      site?.productionUrl ?? "",
    );
    const knownGood = knownGoodVersion(latestKnownGood);

    if (transition) {
      const dep = await this.store.getDeployment(transition.deploymentId);
      return {
        activeVersionId: transition.versionId,
        knownGoodVersionId: knownGood,
        lastVerifiedAt: (dep?.verifiedAt ?? transition.effectiveAt).toISOString(),
        deploymentId: transition.deploymentId,
        candidateId: transition.candidateId,
        executionOrigin,
        deliveryMode: rawDeliveryMode || "production",
      };
    }

    if (latestKnownGood) {
      return {
        activeVersionId: latestKnownGood.versionId,
        knownGoodVersionId: knownGood,
        lastVerifiedAt: latestKnownGood.verifiedAt?.toISOString() ?? null,
        deploymentId: latestKnownGood.id,
        candidateId: latestKnownGood.candidateId,
        executionOrigin,
        deliveryMode: rawDeliveryMode || "production",
      };
    }

    return {
      activeVersionId: null,
      knownGoodVersionId: null,
      lastVerifiedAt: null,
      deploymentId: null,
      candidateId: null,
      executionOrigin,
      deliveryMode: rawDeliveryMode || "production",
    };
  }

  async getGovernedDeploymentView(projectId: string): Promise<GovernedDeploymentView> {
    const site = await this.resolveSite(projectId);

    const candidates = await this.productionStore.listCandidates(projectId);
    const currentCandidate = candidates.find((c) => c.state === "qa_passed") ?? candidates[0] ?? null;

    let candidateRoutes: string[] = [];
    let latestQa = null;
    if (currentCandidate) {
      const inputs = await this.productionStore.listCandidateInputs(projectId, currentCandidate.id);
      candidateRoutes = inputs.map((b) => b.route);
      const qaRun = await this.productionStore.latestQaRun(projectId, currentCandidate.id);
      if (qaRun) {
        latestQa = {
          id: qaRun.id,
          overall: qaRun.overall as "PASS" | "REVIEW" | "FAIL",
          publicationEligible: qaRunPublicationEligible(qaRun.data),
          createdAt: qaRun.createdAt.toISOString(),
        };
      }
    }

    const deploymentsList = await this.store.listDeployments(site.id, 20);

    const activePreviewDep = deploymentsList.find(
      (d) => d.status === "preview_verified" && d.previewVerified && d.versionId,
    );
    const activePreview = activePreviewDep
      ? {
          deploymentId: activePreviewDep.id,
          versionId: activePreviewDep.versionId!,
          previewUrl: activePreviewDep.previewUrl ?? "",
          previewVerified: activePreviewDep.previewVerified,
          createdAt: activePreviewDep.createdAt.toISOString(),
        }
      : null;

    let activeApproval = null;
    if (activePreview && currentCandidate) {
      const appr = await this.store.findReleaseApproval(currentCandidate.id, activePreview.versionId);
      if (appr && !appr.revoked) {
        activeApproval = {
          id: appr.id,
          projectId: appr.projectId,
          siteId: appr.siteId,
          candidateId: appr.candidateId,
          qaRunId: appr.qaRunId,
          artifactDigest: appr.artifactDigest,
          previewVersionId: appr.previewVersionId,
          targetWorkerName: appr.targetWorkerName,
          targetProductionUrl: appr.targetProductionUrl,
          actorId: appr.actorId,
          actorName: appr.actorName,
          actorRole: appr.actorRole,
          sessionId: appr.sessionId,
          isSynthetic: appr.isSynthetic,
          verificationSeal: appr.verificationSeal,
          sealKeyId: appr.sealKeyId,
          sealStatus: appr.sealStatus as "SEALED" | "LEGACY_UNSEALED",
          revoked: appr.revoked,
          createdAt: appr.createdAt.toISOString(),
        };
      }
    }

    const effectiveProd = await this.resolveCurrentEffectiveProduction(site.id);

    const blockers: Array<{ code: string; message: string; area: string }> = [];
    if (!currentCandidate) {
      blockers.push({
        code: "NO_PRODUCTION_CANDIDATE",
        message: "No production candidate built for this site.",
        area: "deployment",
      });
    } else if (currentCandidate.state !== "qa_passed") {
      blockers.push({
        code: "CANDIDATE_QA_NOT_PASSED",
        message: `Candidate is in state '${currentCandidate.state}', not 'qa_passed'.`,
        area: "deployment",
      });
    }

    if (!site.cloudflareWorkerName || !site.productionUrl) {
      blockers.push({
        code: "DELIVERY_TARGET_UNCONFIGURED",
        message: "Cloudflare Worker and production URL are not configured.",
        area: "deployment",
      });
    }

    return {
      projectId,
      siteId: site.id,
      siteKey: site.key,
      targetWorkerName: site.cloudflareWorkerName ?? "",
      targetProductionUrl: site.productionUrl ?? "https://example.com",
      readinessState: blockers.length === 0 ? "READY_FOR_DEPLOYMENT" : "BLOCKED",
      candidate: currentCandidate
        ? {
            id: currentCandidate.id,
            route: currentCandidate.route,
            canonicalUrl: currentCandidate.canonicalUrl,
            state: currentCandidate.state,
            artifactDigest: currentCandidate.artifactDigest,
            repositorySha: currentCandidate.repositorySha,
            createdAt: currentCandidate.createdAt.toISOString(),
            routes: candidateRoutes,
          }
        : null,
      latestQa,
      activePreview,
      activeApproval,
      currentProduction: {
        activeVersionId: effectiveProd.activeVersionId,
        knownGoodVersionId: effectiveProd.knownGoodVersionId,
        lastVerifiedAt: effectiveProd.lastVerifiedAt,
        executionOrigin: effectiveProd.executionOrigin,
        deliveryMode: effectiveProd.deliveryMode,
      },
      history: deploymentsList.map((d) => ({
        id: d.id,
        siteId: d.siteId,
        candidateId: d.candidateId,
        sourceCommit: d.sourceCommit,
        artifactDigest: d.artifactDigest,
        versionId: d.versionId,
        previewUrl: d.previewUrl,
        productionUrl: d.productionUrl,
        previousVersionId: d.previousVersionId,
        status: d.status as any,
        previewVerified: d.previewVerified,
        productionVerified: d.productionVerified,
        rolledBack: d.rolledBack,
        errorCode: d.errorCode,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt.toISOString(),
        promotedAt: d.promotedAt?.toISOString() ?? null,
        verifiedAt: d.verifiedAt?.toISOString() ?? null,
      })),
      blockers,
    };
  }

  /**
   * Run 13 / Checkpoint R13-R4: Historical Reconstruction & Lineage Query
   * Answers: "Which exact accepted content, design, image files, asset versions,
   * templates, renderer, QA evidence, source commit and Cloudflare deployment
   * produced a particular production page on a particular historical date?"
   */
  async getEffectiveReleaseAsOf(params: {
    siteId: string;
    route: string;
    asOf: Date;
  }): Promise<EffectivePageReleaseLineage> {
    const { siteId, route, asOf } = params;
    const normalizedRoute = route === "" ? "/" : route.startsWith("/") ? route : `/${route}`;

    // 1. Locate the transition that was active as of that timestamp (P0-E truthful as-of historical lineage)
    let effectiveDeployment: DeploymentRecord | null = null;
    let effectiveCandidateId: string | null = null;

    const transition = typeof this.store.getEffectiveTransitionAsOf === "function"
      ? await this.store.getEffectiveTransitionAsOf(siteId, asOf)
      : null;

    if (transition) {
      effectiveDeployment = await this.store.getDeployment(transition.deploymentId);
      if (!effectiveDeployment) {
        effectiveDeployment = await this.store.findDeploymentByVersion(siteId, transition.versionId);
      }
      effectiveCandidateId = transition.candidateId;
    } else {
      // P0-03: If transition history is present for this site but no transition existed at or before asOf,
      // return UNKNOWN/null without falling back to scanning recent deployments.
      const currentTrans = typeof this.store.getCurrentEffectiveTransition === "function"
        ? await this.store.getCurrentEffectiveTransition(siteId)
        : null;

      if (!currentTrans) {
        // Pre-migration legacy fallback only if site has zero transition records:
        const allDeployments = await this.store.listDeployments(siteId, 200);
        effectiveDeployment = allDeployments
          .filter((d) => {
            const effectiveTime = d.verifiedAt ?? d.promotedAt ?? d.createdAt;
            return (
              d.productionVerified &&
              d.versionId &&
              effectiveTime <= asOf &&
              (d.status === "verified" || d.status === "rolled_back")
            );
          })
          .sort((a, b) => {
            const timeA = (a.verifiedAt ?? a.promotedAt ?? a.createdAt).getTime();
            const timeB = (b.verifiedAt ?? b.promotedAt ?? b.createdAt).getTime();
            return timeB - timeA;
          })[0] ?? null;

        effectiveCandidateId = effectiveDeployment?.candidateId ?? null;
      }
    }

    if (!effectiveDeployment || !effectiveCandidateId) {
      return {
        siteId,
        route: normalizedRoute,
        asOfTimestamp: asOf.toISOString(),
        effectiveDeployment: effectiveDeployment
          ? {
              id: effectiveDeployment.id,
              versionId: effectiveDeployment.versionId!,
              workerName: effectiveDeployment.workerName,
              productionUrl: effectiveDeployment.productionUrl,
              sourceCommit: effectiveDeployment.sourceCommit,
              artifactDigest: effectiveDeployment.artifactDigest ?? "",
              promotedAt: effectiveDeployment.promotedAt?.toISOString() ?? null,
              verifiedAt: effectiveDeployment.verifiedAt?.toISOString() ?? null,
              status: effectiveDeployment.status,
            }
          : null,
        releaseApproval: null,
        qaEvidence: null,
        candidate: null,
        pageAuthority: null,
      };
    }

    // 2. Load candidate
    const site = (await this.store.findSiteByProjectId(effectiveDeployment.siteId)) ??
      (await (this.store as any).getSiteById?.(siteId));
    const projectId = site?.projectId ?? "";

    const candidate = await this.productionStore.getCandidate(projectId, effectiveCandidateId);
    const candidateInputs = await this.productionStore.listCandidateInputs(projectId, effectiveCandidateId);
    const matchedBinding = candidateInputs.find(
      (b) => b.route === normalizedRoute || (normalizedRoute === "/" && b.route === "/"),
    );

    // 3. Load bound ProductionPageInput
    let pageAuthority = null;
    if (matchedBinding) {
      const input = typeof this.productionStore.getProductionInputById === "function"
        ? await this.productionStore.getProductionInputById(matchedBinding.productionInputId)
        : (await this.productionStore.listProductionInputs(projectId)).find((i) => i.id === matchedBinding.productionInputId);
      if (input) {
        pageAuthority = {
          pageIdentity: input.pageIdentity,
          productionInputId: input.id,
          productionInputVersion: input.version,
          productionInputDigest: input.inputDigest,
          acceptedContent: {
            id: input.acceptedContentId,
            version: input.acceptedContentVersion,
            digest: input.acceptedContentDigest,
          },
          acceptedDesign: {
            id: input.acceptedDesignId,
            version: input.acceptedDesignVersion,
            digest: input.acceptedDesignDigest,
          },
          acceptedVisualSet: {
            id: input.acceptedVisualSetId,
            version: input.acceptedVisualSetVersion,
            digest: input.acceptedVisualSetDigest,
          },
          pageArchetype: input.pageType ?? null,
          renderer: {
            id: input.rendererId,
            version: input.rendererVersion,
            policyVersion: input.rendererPolicyVersion,
          },
        };
      }
    }

    // 4. Load release approval
    let releaseApproval = null;
    if (effectiveDeployment.releaseApprovalId) {
      const appr = await this.store.getReleaseApproval(effectiveDeployment.releaseApprovalId);
      if (appr) {
        releaseApproval = {
          id: appr.id,
          actorId: appr.actorId,
          actorName: appr.actorName,
          actorRole: appr.actorRole,
          sealedAt: appr.createdAt.toISOString(),
          sealStatus: appr.sealStatus,
          verificationSeal: appr.verificationSeal,
        };
      }
    }

    // 5. Load QA evidence
    let qaEvidence = null;
    if (effectiveDeployment.qaRunId) {
      const qaRun = typeof this.productionStore.getQaRun === "function"
        ? await this.productionStore.getQaRun(effectiveDeployment.qaRunId)
        : (effectiveDeployment.candidateId ? await this.productionStore.latestQaRun(projectId, effectiveDeployment.candidateId) : null);
      if (qaRun) {
        const qaData = qaRun.data as any;
        qaEvidence = {
          qaRunId: qaRun.id,
          overall: qaRun.overall,
          publicationEligible: qaRunPublicationEligible(qaData),
          checkCount: Array.isArray(qaData?.checks) ? qaData.checks.length : 0,
          checks: (qaData?.checks ?? []).map((c: any) => ({
            checkId: c.checkId,
            group: c.group,
            verdict: c.verdict,
            executionDigest: c.executionDigest,
          })),
        };
      }
    }

    return {
      siteId,
      route: normalizedRoute,
      asOfTimestamp: asOf.toISOString(),
      effectiveDeployment: {
        id: effectiveDeployment.id,
        versionId: effectiveDeployment.versionId!,
        workerName: effectiveDeployment.workerName,
        productionUrl: effectiveDeployment.productionUrl,
        sourceCommit: effectiveDeployment.sourceCommit,
        artifactDigest: effectiveDeployment.artifactDigest ?? "",
        promotedAt: effectiveDeployment.promotedAt?.toISOString() ?? null,
        verifiedAt: effectiveDeployment.verifiedAt?.toISOString() ?? null,
        status: effectiveDeployment.status,
      },
      releaseApproval,
      qaEvidence,
      candidate: candidate
        ? {
            id: candidate.id,
            artifactDigest: candidate.artifactDigest ?? "",
            manifestSetDigest: candidate.manifestSetDigest ?? "",
            repositorySha: candidate.repositorySha ?? "",
            lockfileDigest: candidate.lockfileDigest ?? "",
            rendererVersion: candidate.rendererVersion ?? "",
            siteProfileDigest: candidate.siteProfileDigest ?? "",
          }
        : null,
      pageAuthority,
    };
  }

  /**
   * Retrieves operational monitoring summary for this project.
   */
  async getMonitoringSummary(projectId: string): Promise<MonitoringSummary> {
    await this.resolveSite(projectId).catch(() => null);
    return await this.monitoringService.getMonitoringSummary(projectId);
  }

  /**
   * Triggers an on-demand operational check across verification and monitoring providers.
   * Server-side boundary strictly requires valid operator session token and DEPLOYMENT:MONITOR permission.
   */
  async runMonitoringCheck(projectId: string, sessionToken: string): Promise<MonitoringSummary> {
    if (!sessionToken || sessionToken.trim().length === 0) {
      throw new FactoryError("permission_denied", "Valid sessionToken with DEPLOYMENT:MONITOR permission is required.");
    }
    if (this.releaseBoundary) {
      await this.releaseBoundary.verifyActorPermission({
        sessionToken,
        projectId,
        requiredPermission: "DEPLOYMENT:MONITOR",
      });
    }
    await this.resolveSite(projectId).catch(() => null);
    return await this.monitoringService.runOperationalCheck(projectId);
  }

  /**
   * Internal trusted execution boundary for scheduled background checks or automated tasks.
   */
  async runMonitoringCheckInternal(projectId: string): Promise<MonitoringSummary> {
    await this.resolveSite(projectId).catch(() => null);
    return await this.monitoringService.runOperationalCheck(projectId);
  }
}
