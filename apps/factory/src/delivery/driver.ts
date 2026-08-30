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
  resolveAcceptedSource,
} from "./source.js";
import { WranglerClient } from "./wrangler.js";

function deploymentId(): string {
  return `deployment-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function artifactDirectory(repoRoot: string, id: string): { absolute: string; relative: string } {
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

    // Reconcile only dangerous persisted states and return their outcome. A
    // recovery invocation never starts a second deployment implicitly.
    const stale = await store.findLatestUnverifiedDeployment(site.id);
    if (stale) {
      const artifacts = path.join(input.repoRoot, stale.artifactDirectory ?? path.join(".factory", "deployments", stale.id));
      await mkdir(artifacts, { recursive: true });
      worktree = await prepareAcceptedWorktree(input.repoRoot, stale.sourceCommit, `reconcile-${stale.id}`);
      const reconciled = await workflow({
        store,
        repoRoot: input.repoRoot,
        worktree,
        artifacts,
        productionUrl: stale.productionUrl,
      }).reconcile(stale);
      const result = resultFromRecord(reconciled, input.siteKey);
      await writeResult(artifacts, result);
      return result;
    }

    const sourceCommit = await resolveAcceptedSource(input.repoRoot);
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
    const sourceCommit = await resolveAcceptedSource(input.repoRoot);
    const id = deploymentId();
    const artifacts = artifactDirectory(input.repoRoot, id);
    await mkdir(artifacts.absolute, { recursive: true });
    worktree = await prepareAcceptedWorktree(input.repoRoot, sourceCommit, `rollback-${id}`);
    const provider = new WranglerClient(path.join(worktree, "sites", "starter"), artifacts.absolute);
    await provider.assertTargetExists(target.workerName);
    const active = await provider.currentProductionVersion(target.workerName);
    const trusted = await store.listKnownGoodDeployments(
      site.id,
      target.workerName,
      target.productionUrl,
    );
    const rollbackSource = trusted.find((record) => {
      const version = knownGoodVersion(record);
      return version !== null && version !== active;
    });
    const rollbackVersion = knownGoodVersion(rollbackSource ?? null);
    if (!rollbackSource || !rollbackVersion) {
      throw new FactoryError("rollback_target_unavailable", "No earlier trusted known-good Cloudflare version is available.");
    }

    let record = await store.createDeployment({
      id,
      siteId: site.id,
      sourceCommit: rollbackSource.sourceCommit,
      workerName: target.workerName,
      productionUrl: target.productionUrl,
      artifactDirectory: artifacts.relative,
    });
    record = await store.updateDeployment({
      id,
      status: "promoting",
      artifactDigest: rollbackSource.artifactDigest,
      versionId: rollbackVersion,
      previousVersionId: rollbackVersion,
    });
    try {
      await provider.rollback(target.workerName, rollbackVersion);
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
  } finally {
    if (worktree) await removeWorktree(input.repoRoot, worktree);
    await lock.release();
    await db.close();
  }
}
