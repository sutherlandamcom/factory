import { randomUUID } from "node:crypto";
import type { DeploymentStatus } from "@factory/contracts";
import type { DeploymentRecord, ReleaseApprovalRecord } from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import type { RemoteQaResult } from "./qa.js";
import type { UploadedVersion } from "./wrangler.js";

export interface DeliveryStore {
  createDeployment?(input: any): Promise<DeploymentRecord>;
  updateDeployment(input: {
    id: string;
    status: DeploymentStatus;
    artifactDigest?: string | null;
    versionId?: string | null;
    previewUrl?: string | null;
    previousVersionId?: string | null;
    candidateId?: string | null;
    qaRunId?: string | null;
    releaseApprovalId?: string | null;
    candidateRoutes?: unknown;
    snapshotData?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    promotedAt?: Date | null;
    verifiedAt?: Date | null;
    previewVerified?: boolean;
    productionVerified?: boolean;
    rolledBack?: boolean;
    executionOrigin?: "REAL_CLOUDFLARE" | "TEST_SIMULATION" | "UNKNOWN" | null;
    operationId?: string | null;
  }): Promise<DeploymentRecord>;
  findLatestKnownGoodDeployment(
    siteId: string,
    workerName?: string,
    productionUrl?: string,
    excludeDeploymentId?: string,
  ): Promise<DeploymentRecord | null>;
  listCanonicalVerifiedDeployments?(
    siteId: string,
    workerName: string,
    productionUrl: string,
  ): Promise<DeploymentRecord[]>;
}

/** Test seam for the concrete Wrangler command set; not a provider abstraction. */
export interface WranglerOperations {
  assertTargetExists(workerName: string): Promise<void>;
  upload(workerName: string): Promise<UploadedVersion>;
  currentProductionVersion(workerName: string): Promise<string | null>;
  promote(workerName: string, versionId: string): Promise<void>;
  rollback(workerName: string, versionId: string): Promise<void>;
}

export interface DeliveryRuntime {
  build(): Promise<string>;
  digest(directory: string): Promise<string>;
  qa(targetUrl: string, phase: "preview" | "production" | "rollback"): Promise<RemoteQaResult>;
  assertSourceStillAccepted(sourceCommit: string): Promise<void>;
}

function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof FactoryError
    ? { code: error.code, message: error.message }
    : { code: "delivery_internal_error", message: error instanceof Error ? error.message : String(error) };
}

export function knownGoodVersion(record: DeploymentRecord | null): string | null {
  if (!record) return null;
  if (record.status === "rolled_back") {
    if (
      record.operationId?.startsWith("rb-") ||
      (record.snapshotData as any)?.targetDeploymentId ||
      (record.productionVerified && record.errorCode !== "production_qa_failed_rolled_back")
    ) {
      return record.versionId;
    }
    return record.previousVersionId ?? record.versionId;
  }
  return record.versionId;
}

export class ProductionDelivery {
  constructor(
    private readonly store: DeliveryStore,
    private readonly wrangler: WranglerOperations,
    private readonly runtime: DeliveryRuntime,
  ) {}

  /**
   * Prepare and remotely QA a preview without changing production.
   *
   * Run 13 uses this existing delivery application service after supplying
   * candidate-bound immutable bytes. Merely reaching preview_verified NEVER
   * conveys human release authority or permission to call promote().
   */
  async preparePreview(initial: DeploymentRecord): Promise<DeploymentRecord> {
    if (initial.status !== "preparing" || initial.versionId !== null || initial.previewVerified) {
      throw new FactoryError("deployment_transition_invalid", "Preview preparation requires a fresh, unuploaded deployment.");
    }
    let current = initial;
    try {
      await this.wrangler.assertTargetExists(initial.workerName);

      const dist = await this.runtime.build();
      const artifactDigest = await this.runtime.digest(dist);
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "preparing",
        artifactDigest,
      });

      const uploaded = await this.wrangler.upload(initial.workerName);
      if (uploaded.workerName !== initial.workerName) {
        throw new FactoryError("provider_identity_mismatch", "Uploaded version belongs to another Worker.");
      }
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "uploaded",
        versionId: uploaded.versionId,
        previewUrl: uploaded.previewUrl,
      });

      const previewQa = await this.runtime.qa(uploaded.previewUrl, "preview");
      if (!previewQa.passed) {
        return await this.store.updateDeployment({
          id: initial.id,
          status: "failed",
          errorCode: "preview_qa_failed",
          errorMessage: "Cloudflare version preview failed the existing Playwright quality oracle.",
        });
      }
      return await this.store.updateDeployment({
        id: initial.id,
        status: "preview_verified",
        previewVerified: true,
      });
    } catch (error) {
      const info = errorInfo(error);
      return await this.store.updateDeployment({
        id: initial.id,
        status: "failed",
        errorCode: info.code,
        errorMessage: info.message,
      });
    }
  }

  /**
   * Run 13: Governed publication of an approved preview.
   * Promotes the exact approved preview version, verifies production,
   * and automatically rolls back to known-good version if production QA fails.
   */
  async publishApproved(input: {
    previewDeployment: DeploymentRecord;
    approval: ReleaseApprovalRecord;
    deferFinalization?: boolean;
  }): Promise<DeploymentRecord> {
    const { previewDeployment: preview, approval } = input;
    if (preview.status !== "preview_verified" || !preview.previewVerified || !preview.versionId) {
      throw new FactoryError("deployment_transition_invalid", "Cannot promote an unverified preview.");
    }
    if (preview.versionId !== approval.previewVersionId) {
      throw new FactoryError("release_version_mismatch", "Approved version does not match preview version.");
    }
    if (preview.candidateId && approval.candidateId !== preview.candidateId) {
      throw new FactoryError("release_candidate_mismatch", "Approved candidate does not match preview candidate.");
    }
    if (preview.artifactDigest && approval.artifactDigest !== preview.artifactDigest) {
      throw new FactoryError("release_digest_mismatch", "Approved artifact digest does not match preview digest.");
    }
    if (approval.revoked) {
      throw new FactoryError("release_approval_revoked", "Release approval has been revoked.");
    }

    let current = preview;
    try {
      const providerVersion = await this.wrangler.currentProductionVersion(preview.workerName);
      const knownGood = knownGoodVersion(await this.store.findLatestKnownGoodDeployment(
        preview.siteId,
        preview.workerName,
        preview.productionUrl,
      ));
      if (knownGood !== null && providerVersion !== knownGood) {
        throw new FactoryError(
          "deployment_drift",
          "Cloudflare production version does not match Factory's latest known-good version.",
        );
      }
      const previousVersionId = knownGood ?? providerVersion;
      await this.runtime.assertSourceStillAccepted(preview.sourceCommit);

      current = await this.store.updateDeployment({
        id: preview.id,
        status: "promoting",
        previousVersionId,
        releaseApprovalId: approval.id,
        operationId: `pub-${preview.id}`,
        snapshotData: {
          ...((preview.snapshotData as any) ?? {}),
          operationType: "PUBLISH",
        },
      });
      await this.wrangler.promote(preview.workerName, preview.versionId);
      current = await this.store.updateDeployment({
        id: preview.id,
        status: "promoted",
        promotedAt: new Date(),
      });

      const productionQa = await this.runtime.qa(preview.productionUrl, "production");
      const activeAfter = await this.wrangler.currentProductionVersion(preview.workerName);
      if (activeAfter !== preview.versionId) {
        throw new FactoryError(
          "deployment_drift",
          "Cloudflare active version after promotion does not match candidate version.",
        );
      }

      if (productionQa.passed) {
        const executionOrigin =
          (preview.executionOrigin as "REAL_CLOUDFLARE" | "TEST_SIMULATION" | "UNKNOWN" | null) ??
          ((this.wrangler as any)?.isSimulated ? "TEST_SIMULATION" : "REAL_CLOUDFLARE");
        if (input.deferFinalization) {
          return {
            ...current,
            status: "promoted",
            productionVerified: true,
            executionOrigin,
            errorCode: null,
            errorMessage: null,
          };
        }
        return await this.store.updateDeployment({
          id: preview.id,
          status: "verified",
          verifiedAt: new Date(),
          productionVerified: true,
          executionOrigin,
          errorCode: null,
          errorMessage: null,
        });
      }
      return await this.rollbackAfterFailedProductionQa(current);
    } catch (error) {
      const info = errorInfo(error);
      const dangerous = current.status === "promoting" || current.status === "promoted";
      return await this.store.updateDeployment({
        id: preview.id,
        status: dangerous ? "needs_review" : "failed",
        errorCode: info.code,
        errorMessage: info.message,
      });
    }
  }

  async rollbackExplicit(input: {
    deployment: DeploymentRecord;
    targetVersionId: string;
    targetDeployment?: DeploymentRecord;
    deferFinalization?: boolean;
    pendingDeployment?: DeploymentRecord;
    initiatingActor?: {
      actorId: string;
      actorName: string;
      actorRole: string;
      sessionId?: string;
    };
  }): Promise<DeploymentRecord> {
    const knownGoodRaw = await this.store.findLatestKnownGoodDeployment(
      input.deployment.siteId,
      input.deployment.workerName,
      input.deployment.productionUrl,
      input.deployment.id,
    );
    const knownGood = knownGoodVersion(knownGoodRaw);

    const canonicals = typeof this.store.listCanonicalVerifiedDeployments === "function"
      ? await this.store.listCanonicalVerifiedDeployments(
          input.deployment.siteId,
          input.deployment.workerName,
          input.deployment.productionUrl,
        )
      : [];

    const isCanonical =
      canonicals.some((d: DeploymentRecord) => d.versionId === input.targetVersionId) ||
      (input.deployment.versionId === input.targetVersionId && input.deployment.productionVerified);

    if (!knownGood && !isCanonical) {
      throw new FactoryError("rollback_target_invalid", "Target rollback version is not a verified known-good version.");
    }

    if (knownGood && knownGood !== input.targetVersionId && !isCanonical) {
      throw new FactoryError("rollback_target_invalid", "Target rollback version is not a verified known-good version.");
    }

    const targetDep =
      input.targetDeployment ??
      canonicals.find((d: DeploymentRecord) => d.versionId === input.targetVersionId) ??
      (input.deployment.versionId === input.targetVersionId && input.deployment.productionVerified ? input.deployment : null) ??
      (knownGoodRaw && typeof knownGoodRaw === "object" && knownGoodRaw.versionId === input.targetVersionId ? knownGoodRaw : null);

    if (!targetDep || !targetDep.versionId) {
      throw new FactoryError("rollback_target_invalid", "Target rollback deployment record could not be resolved.");
    }

    if (targetDep.siteId !== input.deployment.siteId) {
      throw new FactoryError("rollback_target_invalid", "Target rollback version does not belong to the same site.");
    }

    let rollbackDep = input.pendingDeployment ?? null;
    try {
      // P1: Persist durable rollback intent before external mutation if not already provided
      if (!rollbackDep && typeof this.store.createDeployment === "function") {
        const rollbackDepId = `dep-rb-${randomUUID()}`;
        const executionOrigin =
          (targetDep.executionOrigin as "REAL_CLOUDFLARE" | "TEST_SIMULATION" | "UNKNOWN" | null) ??
          ((this.wrangler as any)?.isSimulated ? "TEST_SIMULATION" : "REAL_CLOUDFLARE");
        rollbackDep = await this.store.createDeployment({
          id: rollbackDepId,
          siteId: input.deployment.siteId,
          sourceCommit: targetDep.sourceCommit,
          artifactDigest: targetDep.artifactDigest,
          versionId: input.targetVersionId,
          previousVersionId: input.deployment.versionId,
          workerName: targetDep.workerName || input.deployment.workerName,
          productionUrl: targetDep.productionUrl || input.deployment.productionUrl,
          status: "promoting",
          previewVerified: true,
          productionVerified: false,
          rolledBack: true,
          candidateId: targetDep.candidateId,
          qaRunId: targetDep.qaRunId ?? null, // R13-F3-P1-01: exact target QA preserved
          releaseApprovalId: targetDep.releaseApprovalId,
          candidateRoutes: targetDep.candidateRoutes,
          artifactDirectory: targetDep.artifactDirectory,
          executionOrigin,
          operationId: `rb-${rollbackDepId}`,
          snapshotData: {
            operationType: "ROLLBACK",
            targetDeploymentId: targetDep.id,
            fromVersionId: input.deployment.versionId,
            toVersionId: input.targetVersionId,
            initiatingActor: input.initiatingActor ?? null,
            targetQaRunId: targetDep.qaRunId ?? null,
            targetCandidateId: targetDep.candidateId,
            targetArtifactDigest: targetDep.artifactDigest,
          },
          promotedAt: new Date(),
        });
      }

      await this.wrangler.rollback(input.deployment.workerName, input.targetVersionId);

      if (rollbackDep) {
        rollbackDep = await this.store.updateDeployment({
          id: rollbackDep.id,
          status: "promoted",
          promotedAt: new Date(),
        });
      }

      // P0-C: Independent verification that Cloudflare actually switched to target version
      const activeAfterRollback = await this.wrangler.currentProductionVersion(input.deployment.workerName);
      if (activeAfterRollback !== input.targetVersionId) {
        throw new FactoryError(
          "rollback_drift",
          `Cloudflare active version after rollback ('${activeAfterRollback}') does not match expected target version ('${input.targetVersionId}').`,
        );
      }

      const rollbackQa = await this.runtime.qa(input.deployment.productionUrl, "rollback");
      if (!rollbackQa.passed) {
        if (rollbackDep) {
          return await this.store.updateDeployment({
            id: rollbackDep.id,
            status: "needs_review",
            errorCode: "rollback_qa_failed",
            errorMessage: "Manual rollback completed but production verification failed.",
          });
        }
        return await this.store.updateDeployment({
          id: input.deployment.id,
          status: "needs_review",
          errorCode: "rollback_qa_failed",
          errorMessage: "Manual rollback completed but production verification failed.",
        });
      }

      // P0-D & P0-02 & P1-01: Preserve historical publication facts and restore target release identity.
      if (rollbackDep) {
        const executionOrigin =
          (targetDep.executionOrigin as "REAL_CLOUDFLARE" | "TEST_SIMULATION" | "UNKNOWN" | null) ??
          ((this.wrangler as any)?.isSimulated ? "TEST_SIMULATION" : "REAL_CLOUDFLARE");
        if (input.deferFinalization) {
          return {
            ...rollbackDep,
            status: "promoted",
            productionVerified: true,
            executionOrigin,
            snapshotData: {
              ...(rollbackDep.snapshotData as any),
              rollbackQaPassed: rollbackQa.passed,
              rollbackQaRunId: (rollbackQa as any)?.qaRunId ?? null,
            },
            verifiedAt: new Date(),
          };
        }
        return await this.store.updateDeployment({
          id: rollbackDep.id,
          status: "rolled_back",
          productionVerified: true,
          executionOrigin,
          snapshotData: {
            ...(rollbackDep.snapshotData as any),
            rollbackQaPassed: rollbackQa.passed,
            rollbackQaRunId: (rollbackQa as any)?.qaRunId ?? null,
          },
          verifiedAt: new Date(),
        });
      }

      return await this.store.updateDeployment({
        id: input.deployment.id,
        status: input.deferFinalization ? "promoted" : "rolled_back",
        previousVersionId: input.targetVersionId,
        rolledBack: true,
        verifiedAt: new Date(),
      });
    } catch (error) {
      const info = errorInfo(error);
      if (rollbackDep) {
        return await this.store.updateDeployment({
          id: rollbackDep.id,
          status: "needs_review",
          errorCode: info.code === "delivery_internal_error" ? "rollback_failed" : info.code,
          errorMessage: info.message,
        });
      }
      return await this.store.updateDeployment({
        id: input.deployment.id,
        status: "needs_review",
        errorCode: info.code === "delivery_internal_error" ? "rollback_failed" : info.code,
        errorMessage: info.message,
      });
    }
  }

  /**
   * Historic CLI one-shot delivery entrypoint. Governed sites MUST NOT
   * reach this entrypoint until it is gated by Run 13 release authority.
   * Never expose this method directly through the Dashboard.
   */
  async execute(initial: DeploymentRecord): Promise<DeploymentRecord> {
    if (initial.candidateId) {
      throw new FactoryError(
        "governed_site_requires_release_approval",
        "Governed candidate releases require explicit human release approval. Legacy execute() bypass is prohibited.",
      );
    }
    const preview = await this.preparePreview(initial);
    if (preview.status !== "preview_verified") return preview;
    return await this.promoteLegacyPreview(preview);
  }

  private async promoteLegacyPreview(preview: DeploymentRecord): Promise<DeploymentRecord> {
    let current = preview;
    try {
      if (preview.status !== "preview_verified" || !preview.previewVerified || !preview.versionId) {
        throw new FactoryError("deployment_transition_invalid", "Cannot promote an unverified preview.");
      }
      const providerVersion = await this.wrangler.currentProductionVersion(preview.workerName);
      const knownGood = knownGoodVersion(await this.store.findLatestKnownGoodDeployment(
        preview.siteId,
        preview.workerName,
        preview.productionUrl,
      ));
      if (knownGood !== null && providerVersion !== knownGood) {
        throw new FactoryError(
          "deployment_drift",
          "Cloudflare production version does not match Factory's latest known-good version.",
        );
      }
      const previousVersionId = knownGood ?? providerVersion;
      await this.runtime.assertSourceStillAccepted(preview.sourceCommit);

      current = await this.store.updateDeployment({
        id: preview.id,
        status: "promoting",
        previousVersionId,
      });
      await this.wrangler.promote(preview.workerName, preview.versionId);
      current = await this.store.updateDeployment({
        id: preview.id,
        status: "promoted",
        promotedAt: new Date(),
      });

      const productionQa = await this.runtime.qa(preview.productionUrl, "production");
      if (productionQa.passed) {
        const executionOrigin =
          (preview.executionOrigin as "REAL_CLOUDFLARE" | "TEST_SIMULATION" | "UNKNOWN" | null) ??
          ((this.wrangler as any)?.isSimulated ? "TEST_SIMULATION" : "REAL_CLOUDFLARE");
        return await this.store.updateDeployment({
          id: preview.id,
          status: "verified",
          verifiedAt: new Date(),
          productionVerified: true,
          executionOrigin,
          errorCode: null,
          errorMessage: null,
        });
      }
      return await this.rollbackAfterFailedProductionQa(current);
    } catch (error) {
      const info = errorInfo(error);
      const dangerous = current.status === "promoting" || current.status === "promoted";
      return await this.store.updateDeployment({
        id: preview.id,
        status: dangerous ? "needs_review" : "failed",
        errorCode: info.code,
        errorMessage: info.message,
      });
    }
  }

  async reconcile(stale: DeploymentRecord): Promise<DeploymentRecord> {
    if (!stale.versionId) {
      return await this.store.updateDeployment({
        id: stale.id,
        status: "needs_review",
        errorCode: "deployment_state_invalid",
        errorMessage: "Nonterminal production deployment has no candidate version ID.",
      });
    }
    try {
      const active = await this.wrangler.currentProductionVersion(stale.workerName);
      if (active === stale.versionId) {
        const qa = await this.runtime.qa(stale.productionUrl, "production");
        if (qa.passed) {
          return await this.store.updateDeployment({
            id: stale.id,
            status: "verified",
            promotedAt: stale.promotedAt ?? new Date(),
            verifiedAt: new Date(),
            productionVerified: true,
            errorCode: null,
            errorMessage: null,
          });
        }
        return await this.rollbackAfterFailedProductionQa(stale);
      }
      if (stale.previousVersionId && active === stale.previousVersionId) {
        const qa = await this.runtime.qa(stale.productionUrl, "rollback");
        return await this.store.updateDeployment({
          id: stale.id,
          status: qa.passed ? "rolled_back" : "needs_review",
          verifiedAt: qa.passed ? new Date() : null,
          rolledBack: qa.passed,
          errorCode: qa.passed ? "production_qa_failed_rolled_back" : "rollback_qa_failed",
          errorMessage: qa.passed
            ? "Candidate failed production QA and the previous version is restored."
            : "Previous version is active but failed rollback verification.",
        });
      }
      throw new FactoryError("deployment_drift", "Cloudflare active version matches neither candidate nor previous version.");
    } catch (error) {
      const info = errorInfo(error);
      return await this.store.updateDeployment({
        id: stale.id,
        status: "needs_review",
        errorCode: info.code,
        errorMessage: info.message,
      });
    }
  }

  private async rollbackAfterFailedProductionQa(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    if (!deployment.previousVersionId) {
      return await this.store.updateDeployment({
        id: deployment.id,
        status: "needs_review",
        errorCode: "production_qa_failed_no_rollback",
        errorMessage: "Production QA failed and no trusted previous version exists.",
      });
    }
    try {
      await this.wrangler.rollback(deployment.workerName, deployment.previousVersionId);
      const rollbackQa = await this.runtime.qa(deployment.productionUrl, "rollback");
      if (!rollbackQa.passed) {
        return await this.store.updateDeployment({
          id: deployment.id,
          status: "needs_review",
          errorCode: "rollback_qa_failed",
          errorMessage: "Rollback mutation completed but production verification failed.",
        });
      }
      return await this.store.updateDeployment({
        id: deployment.id,
        status: "rolled_back",
        verifiedAt: new Date(),
        rolledBack: true,
        errorCode: "production_qa_failed_rolled_back",
        errorMessage: "Candidate failed production QA; exact previous known-good version restored and verified.",
      });
    } catch (error) {
      const info = errorInfo(error);
      return await this.store.updateDeployment({
        id: deployment.id,
        status: "needs_review",
        errorCode: info.code === "delivery_internal_error" ? "rollback_failed" : info.code,
        errorMessage: info.message,
      });
    }
  }
}
