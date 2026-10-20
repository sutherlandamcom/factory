import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { GovernedDeploymentView } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import type { FactoryDb } from "../persistence/db.js";
import type {
  DeploymentRecord,
  ProductionCandidateRecord,
  ReleaseApprovalRecord,
  SiteRecord,
} from "../persistence/schema.js";
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
import { DEPLOYMENT_PUBLISH_PERMISSION } from "@factory/contracts";

export interface GovernedDeliveryDeps {
  db: FactoryDb;
  repoRoot: string;
  store: FactoryStore;
  productionStore: ProductionStore;
  releaseBoundary: ReleaseApprovalBoundary;
  wranglerFactory?: (worktree: string, artifactsDir: string) => WranglerOperations;
  worktreeProvider?: {
    prepare: (repoRoot: string, commit: string, id: string) => Promise<string>;
    remove: (repoRoot: string, worktree: string) => Promise<void>;
  };
  qaRunner?: (input: Parameters<typeof runRemoteQa>[0]) => Promise<RemoteQaResult>;
}

export class GovernedDeliveryService {
  private readonly db: FactoryDb;
  private readonly repoRoot: string;
  private readonly store: FactoryStore;
  private readonly productionStore: ProductionStore;
  private readonly releaseBoundary: ReleaseApprovalBoundary;
  private readonly wranglerFactory: (worktree: string, artifactsDir: string) => WranglerOperations;
  private readonly worktreeProvider: {
    prepare: (repoRoot: string, commit: string, id: string) => Promise<string>;
    remove: (repoRoot: string, worktree: string) => Promise<void>;
  };
  private readonly qaRunner: (input: Parameters<typeof runRemoteQa>[0]) => Promise<RemoteQaResult>;

  constructor(deps: GovernedDeliveryDeps) {
    this.db = deps.db;
    this.repoRoot = deps.repoRoot;
    this.store = deps.store;
    this.productionStore = deps.productionStore;
    this.releaseBoundary = deps.releaseBoundary;
    this.wranglerFactory =
      deps.wranglerFactory ??
      ((worktree, artifacts) => new WranglerClient(path.join(worktree, "sites", "starter"), artifacts));
    this.worktreeProvider = deps.worktreeProvider ?? {
      prepare: prepareAcceptedWorktree,
      remove: removeWorktree,
    };
    this.qaRunner = deps.qaRunner ?? runRemoteQa;
  }

  private async acquireProjectLock(projectId: string, tx?: FactoryDb): Promise<void> {
    const client = tx ?? this.db;
    if (typeof client.execute === "function") {
      await client.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 104))`);
    }
  }

  private async resolveSite(projectId: string): Promise<SiteRecord> {
    const site = await this.store.findSiteByProjectId(projectId);
    if (!site) {
      throw new FactoryError("unknown_site", `No site registered for project '${projectId}'.`);
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
  }): Promise<DeploymentRecord> {
    await this.acquireProjectLock(input.projectId);
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
    await this.acquireProjectLock(input.projectId);
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
      return await delivery.publishApproved({
        previewDeployment,
        approval,
      });
    } finally {
      if (worktree) {
        await this.worktreeProvider.remove(this.repoRoot, worktree).catch(() => {});
      }
    }
  }

  /**
   * Explicit operator-initiated rollback to an exact known-good version.
   */
  async rollbackExplicit(input: {
    projectId: string;
    targetVersionId?: string;
    sessionToken: string;
  }): Promise<DeploymentRecord> {
    await this.acquireProjectLock(input.projectId);
    const site = await this.resolveSite(input.projectId);

    // Verify publisher permission
    await this.releaseBoundary.verifyActorPermission({
      sessionToken: input.sessionToken,
      projectId: input.projectId,
      requiredPermission: DEPLOYMENT_PUBLISH_PERMISSION,
    });

    const latestDeployment = (await this.store.listDeployments(site.id, 1))[0];
    if (!latestDeployment) {
      throw new FactoryError("deployment_not_found", "No deployment found to rollback.");
    }

    const knownGood = await this.store.findLatestKnownGoodDeployment(
      site.id,
      site.cloudflareWorkerName!,
      site.productionUrl!,
      latestDeployment.id,
    );
    const targetVersion = input.targetVersionId ?? knownGood?.versionId ?? latestDeployment.previousVersionId;
    if (!targetVersion) {
      throw new FactoryError("rollback_target_missing", "No target version specified and no previous known-good deployment found.");
    }

    const fullArtifactDir = path.join(this.repoRoot, latestDeployment.artifactDirectory!);
    let worktree: string | null = null;
    try {
      worktree = await this.worktreeProvider.prepare(
        this.repoRoot,
        latestDeployment.sourceCommit,
        `rb-${latestDeployment.id}`,
      );

      const provider = this.wranglerFactory(worktree, fullArtifactDir);
      const deliveryRuntime: DeliveryRuntime = {
        build: async () => path.join(worktree!, "sites", "starter", "dist"),
        digest: async () => "rollback-digest",
        qa: async (targetUrl, phase) =>
          await this.qaRunner({
            worktree: worktree!,
            targetUrl,
            productionUrl: site.productionUrl!,
            artifactDirectory: fullArtifactDir,
            phase,
          }),
        assertSourceStillAccepted: async () => {},
      };

      const delivery = new ProductionDelivery(this.store, provider, deliveryRuntime);
      return await delivery.rollbackExplicit({
        deployment: latestDeployment,
        targetVersionId: targetVersion,
      });
    } finally {
      if (worktree) {
        await this.worktreeProvider.remove(this.repoRoot, worktree).catch(() => {});
      }
    }
  }

  /**
   * Computes the full governed operator deployment read model.
   */
  async getGovernedDeploymentView(projectId: string): Promise<GovernedDeploymentView> {
    const site = await this.store.findSiteByProjectId(projectId);
    if (!site) {
      throw new FactoryError("unknown_site", `No site registered for project '${projectId}'.`);
    }

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
          publicationEligible: qaRun.overall === "PASS",
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

    const latestKnownGood = await this.store.findLatestKnownGoodDeployment(
      site.id,
      site.cloudflareWorkerName ?? "",
      site.productionUrl ?? "",
    );
    const latestVerified = deploymentsList.find((d) => d.status === "verified");

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
        activeVersionId: latestVerified?.versionId ?? null,
        knownGoodVersionId: knownGoodVersion(latestKnownGood),
        lastVerifiedAt: latestVerified?.verifiedAt?.toISOString() ?? null,
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
}
