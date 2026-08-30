import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deploymentResultSchema,
  type DeploymentResult,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { acquireControlPlaneLock } from "../persistence/lock.js";
import type { DeploymentRecord, SiteRecord } from "../persistence/schema.js";
import { FactoryStore } from "../persistence/store.js";
import { createDatabaseInstance } from "../persistence/db.js";
import { resolveDatabaseConfig } from "../persistence/config.js";
import { digestArtifact } from "./artifact.js";
import { requireDeliveryTarget } from "./config.js";
import { runRemoteQa } from "./qa.js";
import { ProductionDelivery, knownGoodVersion } from "./service.js";
import {
  buildAcceptedSite,
  assertAcceptedSourceUnchanged,
  prepareAcceptedWorktree,
  removeWorktree,
  resolveTrustedControlPlaneSource,
} from "./source.js";
import { WranglerClient } from "./wrangler.js";

function deploymentId(): string {
  return `deployment-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function artifactDirectory(repoRoot: string, id: string): { absolute: string; relative: string } {
  const relative = path.join(".factory", "deployments", id);
  return { absolute: path.join(repoRoot, relative), relative };
}

function resultFromRecord(record: DeploymentRecord, siteKey: string): DeploymentResult {
  return deploymentResultSchema.parse({
    deploymentId: record.id,
    siteId: siteKey,
    status: record.status,
    sourceCommit: record.sourceCommit,
    artifactDigest: record.artifactDigest,
    versionId: record.versionId,
    previewUrl: record.previewUrl,
    productionUrl: record.productionUrl,
    previousVersionId: record.previousVersionId,
    previewVerified: record.previewVerified,
    productionVerified: record.productionVerified,
    rolledBack: record.rolledBack,
    error: record.errorCode
      ? { code: record.errorCode, message: record.errorMessage ?? record.errorCode }
      : null,
    timestamps: {
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      promotedAt: record.promotedAt?.toISOString() ?? null,
      verifiedAt: record.verifiedAt?.toISOString() ?? null,
    },
  });
}

async function writeResult(directory: string, result: DeploymentResult): Promise<void> {
  await writeFile(path.join(directory, "deployment-result.json"), JSON.stringify(result, null, 2), "utf8");
}

function workflow(input: {
  store: FactoryStore;
  repoRoot: string;
  worktree: string;
  artifacts: string;
  productionUrl: string;
}): ProductionDelivery {
  const provider = new WranglerClient(path.join(input.worktree, "sites", "starter"), input.artifacts);
  return new ProductionDelivery(input.store, provider, {
    build: async () => await buildAcceptedSite(input.worktree, input.productionUrl),
    digest: digestArtifact,
    assertSourceStillAccepted: async (sourceCommit) => {
      await assertAcceptedSourceUnchanged(input.repoRoot, sourceCommit);
    },
    qa: async (targetUrl, phase) => await runRemoteQa({
      worktree: input.worktree,
      targetUrl,
      productionUrl: input.productionUrl,
      artifactDirectory: input.artifacts,
      phase,
    }),
  });
}

async function resolveSite(store: FactoryStore, siteKey: string): Promise<SiteRecord> {
  const resolved = await store.findSiteByGlobalKey(siteKey);
  if (!resolved) throw new FactoryError("unknown_site", `Site '${siteKey}' is not registered.`);
  return resolved.site;
}

async function reconcilePendingDeployment(input: {
  store: FactoryStore;
  repoRoot: string;
  siteKey: string;
  stale: DeploymentRecord;
}): Promise<{ result: DeploymentResult; worktree: string }> {
  const artifacts = path.join(
    input.repoRoot,
    input.stale.artifactDirectory ?? path.join(".factory", "deployments", input.stale.id),
  );
  await mkdir(artifacts, { recursive: true });
  let worktree: string | null = null;
  try {
    worktree = await prepareAcceptedWorktree(
      input.repoRoot,
      input.stale.sourceCommit,
      `reconcile-${input.stale.id}`,
    );
    const reconciled = await workflow({
      store: input.store,
      repoRoot: input.repoRoot,
      worktree,
      artifacts,
      productionUrl: input.stale.productionUrl,
    }).reconcile(input.stale);
    const result = resultFromRecord(reconciled, input.siteKey);
    await writeResult(artifacts, result);
    return { result, worktree };
  } catch (error) {
    if (worktree) await removeWorktree(input.repoRoot, worktree);
    throw error;
  }
}

export async function executeExplicitRollbackBoundary<T>(input: {
  findPending: () => Promise<DeploymentRecord | null>;
  reconcilePending: (stale: DeploymentRecord) => Promise<T>;
  beginHistoricalRollback: () => Promise<T>;
}): Promise<T> {
  const stale = await input.findPending();
  if (stale) return await input.reconcilePending(stale);
  return await input.beginHistoricalRollback();
}

export interface ExplicitRollbackPlan {
  sourceCommit: string;
  artifactDigest: string;
  versionId: string;
  qaSourceCommit: string;
}

export function resolveExplicitRollbackPlan(input: {
  actualVersion: string | null;
  effectiveRecord: DeploymentRecord | null;
  canonicalVerified: readonly DeploymentRecord[];
}): ExplicitRollbackPlan {
  const expectedVersion = knownGoodVersion(input.effectiveRecord);
  if (expectedVersion === null || input.actualVersion !== expectedVersion) {
    throw new FactoryError(
      "deployment_drift",
      "Cloudflare production version does not match Factory's effective known-good version.",
    );
  }
  const canonical = input.canonicalVerified.find((record) =>
    record.status === "verified"
      && record.productionVerified
      && record.versionId !== null
      && record.artifactDigest !== null
      && record.versionId !== input.actualVersion,
  );
  if (!canonical?.versionId || !canonical.artifactDigest) {
    throw new FactoryError(
      "rollback_target_unavailable",
      "No earlier canonical verified Cloudflare version is available.",
    );
  }
  return {
    sourceCommit: canonical.sourceCommit,
    artifactDigest: canonical.artifactDigest,
    versionId: canonical.versionId,
    qaSourceCommit: canonical.sourceCommit,
  };
}

export async function runProductionDelivery(input: {
  repoRoot: string;
  siteKey: string;
  databaseUrl?: string;
}): Promise<DeploymentResult> {
  const db = createDatabaseInstance(resolveDatabaseConfig({
    url: input.databaseUrl,
    requireConfigured: true,
  }));
  const lock = await acquireControlPlaneLock(db.pool);
  let worktree: string | null = null;
  try {
    const store = new FactoryStore(db.db);
    const site = await resolveSite(store, input.siteKey);
    const target = requireDeliveryTarget(site);
    const sourceCommit = await resolveTrustedControlPlaneSource(input.repoRoot);

    // Reconcile only dangerous persisted states and return their outcome. A
    // recovery invocation never starts a second deployment implicitly.
    const stale = await store.findLatestUnverifiedDeployment(site.id);
    if (stale) {
      const recovery = await reconcilePendingDeployment({
        store,
        repoRoot: input.repoRoot,
        siteKey: input.siteKey,
        stale,
      });
      worktree = recovery.worktree;
      return recovery.result;
    }

    const id = deploymentId();
    const artifacts = artifactDirectory(input.repoRoot, id);
    await mkdir(artifacts.absolute, { recursive: true });
    await writeFile(path.join(artifacts.absolute, "source-commit.txt"), `${sourceCommit}\n`, "utf8");
    let record = await store.createDeployment({
      id,
      siteId: site.id,
      sourceCommit,
      workerName: target.workerName,
      productionUrl: target.productionUrl,
      artifactDirectory: artifacts.relative,
    });

    try {
      worktree = await prepareAcceptedWorktree(input.repoRoot, sourceCommit, id);
      record = await workflow({
        store,
        repoRoot: input.repoRoot,
        worktree,
        artifacts: artifacts.absolute,
        productionUrl: target.productionUrl,
      }).execute(record);
    } catch (error) {
      const info = error instanceof FactoryError
        ? error
        : new FactoryError("delivery_internal_error", error instanceof Error ? error.message : String(error));
      record = await store.updateDeployment({
        id,
        status: "failed",
        errorCode: info.code,
        errorMessage: info.message,
      });
    }

    if (record.artifactDigest) {
      await writeFile(path.join(artifacts.absolute, "artifact-digest.txt"), `${record.artifactDigest}\n`, "utf8");
    }
    const result = resultFromRecord(record, input.siteKey);
    await writeResult(artifacts.absolute, result);
    return result;
  } finally {
    if (worktree) await removeWorktree(input.repoRoot, worktree);
    await lock.release();
    await db.close();
  }
}

export async function runExplicitRollback(input: {
  repoRoot: string;
  siteKey: string;
  databaseUrl?: string;
}): Promise<DeploymentResult> {
  const db = createDatabaseInstance(resolveDatabaseConfig({
    url: input.databaseUrl,
    requireConfigured: true,
  }));
  const lock = await acquireControlPlaneLock(db.pool);
  let worktree: string | null = null;
  try {
    const store = new FactoryStore(db.db);
    const site = await resolveSite(store, input.siteKey);
    const target = requireDeliveryTarget(site);
    await resolveTrustedControlPlaneSource(input.repoRoot);
    return await executeExplicitRollbackBoundary({
      findPending: async () => await store.findLatestUnverifiedDeployment(site.id),
      reconcilePending: async (stale) => {
        const recovery = await reconcilePendingDeployment({
          store,
          repoRoot: input.repoRoot,
          siteKey: input.siteKey,
          stale,
        });
        worktree = recovery.worktree;
        return recovery.result;
      },
      beginHistoricalRollback: async () => {
        const id = deploymentId();
        const artifacts = artifactDirectory(input.repoRoot, id);
        await mkdir(artifacts.absolute, { recursive: true });
        const controlPlaneProvider = new WranglerClient(
          path.join(input.repoRoot, "sites", "starter"),
          artifacts.absolute,
        );
        await controlPlaneProvider.assertTargetExists(target.workerName);
        const active = await controlPlaneProvider.currentProductionVersion(target.workerName);
        const effectiveRecord = await store.findLatestKnownGoodDeployment(
          site.id,
          target.workerName,
          target.productionUrl,
        );
        const canonicalVerified = await store.listCanonicalVerifiedDeployments(
          site.id,
          target.workerName,
          target.productionUrl,
        );
        const rollback = resolveExplicitRollbackPlan({
          actualVersion: active,
          effectiveRecord,
          canonicalVerified,
        });
        worktree = await prepareAcceptedWorktree(input.repoRoot, rollback.qaSourceCommit, `rollback-${id}`);
        const provider = new WranglerClient(path.join(worktree, "sites", "starter"), artifacts.absolute);
        await provider.assertTargetExists(target.workerName);
        const activeBeforeMutation = await provider.currentProductionVersion(target.workerName);
        if (activeBeforeMutation !== active) {
          throw new FactoryError(
            "deployment_drift",
            "Cloudflare production version changed while the rollback was being prepared.",
          );
        }

        let record = await store.createDeployment({
          id,
          siteId: site.id,
          sourceCommit: rollback.sourceCommit,
          workerName: target.workerName,
          productionUrl: target.productionUrl,
          artifactDirectory: artifacts.relative,
        });
        record = await store.updateDeployment({
          id,
          status: "promoting",
          artifactDigest: rollback.artifactDigest,
          versionId: rollback.versionId,
          previousVersionId: rollback.versionId,
        });
        try {
          await provider.rollback(target.workerName, rollback.versionId);
          const qa = await runRemoteQa({
            worktree,
            targetUrl: target.productionUrl,
            productionUrl: target.productionUrl,
            artifactDirectory: artifacts.absolute,
            phase: "rollback",
          });
          record = await store.updateDeployment({
            id,
            status: qa.passed ? "rolled_back" : "needs_review",
            rolledBack: qa.passed,
            verifiedAt: qa.passed ? new Date() : null,
            errorCode: qa.passed ? null : "rollback_qa_failed",
            errorMessage: qa.passed ? null : "Explicit rollback mutation completed but production QA failed.",
          });
        } catch (error) {
          record = await store.updateDeployment({
            id,
            status: "needs_review",
            errorCode: error instanceof FactoryError ? error.code : "rollback_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        const result = resultFromRecord(record, input.siteKey);
        await writeResult(artifacts.absolute, result);
        return result;
      },
    });
  } finally {
    if (worktree) await removeWorktree(input.repoRoot, worktree);
    await lock.release();
    await db.close();
  }
}
