import type { DeploymentStatus } from "@factory/contracts";
import type { DeploymentRecord } from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import type { RemoteQaResult } from "./qa.js";
import type { UploadedVersion } from "./wrangler.js";

export interface DeliveryStore {
  updateDeployment(input: {
    id: string;
    status: DeploymentStatus;
    artifactDigest?: string | null;
    versionId?: string | null;
    previewUrl?: string | null;
    previousVersionId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    promotedAt?: Date | null;
    verifiedAt?: Date | null;
    previewVerified?: boolean;
    productionVerified?: boolean;
    rolledBack?: boolean;
  }): Promise<DeploymentRecord>;
  findLatestKnownGoodDeployment(
    siteId: string,
    workerName: string,
    productionUrl: string,
  ): Promise<DeploymentRecord | null>;
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
  return record.status === "rolled_back" ? record.previousVersionId : record.versionId;
}

export class ProductionDelivery {
  constructor(
    private readonly store: DeliveryStore,
    private readonly wrangler: WranglerOperations,
    private readonly runtime: DeliveryRuntime,
  ) {}

  async execute(initial: DeploymentRecord): Promise<DeploymentRecord> {
    let current = initial;
    try {
      // Read-only target validation happens before the one and only build.
      await this.wrangler.assertTargetExists(initial.workerName);

      const dist = await this.runtime.build();
      const artifactDigest = await this.runtime.digest(dist);
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "preparing",
        artifactDigest,
      });

      const uploaded = await this.wrangler.upload(initial.workerName);
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
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "preview_verified",
        previewVerified: true,
      });

      const providerVersion = await this.wrangler.currentProductionVersion(initial.workerName);
      const knownGood = knownGoodVersion(await this.store.findLatestKnownGoodDeployment(
        initial.siteId,
        initial.workerName,
        initial.productionUrl,
      ));
      if (knownGood !== null && providerVersion !== knownGood) {
        throw new FactoryError(
          "deployment_drift",
          `Cloudflare production version does not match Factory's latest known-good version.`,
        );
      }
      // On the first Factory-managed delivery, the version currently serving
      // 100% of production is the only possible rollback candidate. It is not
      // declared known-good until a rollback to it passes production QA.
      const previousVersionId = knownGood ?? providerVersion;

      await this.runtime.assertSourceStillAccepted(initial.sourceCommit);

      // Durable crash boundary: this write completes before the production mutation.
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "promoting",
        previousVersionId,
      });
      await this.wrangler.promote(initial.workerName, uploaded.versionId);
      current = await this.store.updateDeployment({
        id: initial.id,
        status: "promoted",
        promotedAt: new Date(),
      });

      const productionQa = await this.runtime.qa(initial.productionUrl, "production");
      if (productionQa.passed) {
        return await this.store.updateDeployment({
          id: initial.id,
          status: "verified",
          verifiedAt: new Date(),
          productionVerified: true,
          errorCode: null,
          errorMessage: null,
        });
      }
      return await this.rollbackAfterFailedProductionQa(current);
    } catch (error) {
      const info = errorInfo(error);
      const dangerous = current.status === "promoting" || current.status === "promoted";
      return await this.store.updateDeployment({
        id: initial.id,
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
