import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentRecord } from "../src/persistence/schema.js";
import {
  executeExplicitRollbackBoundary,
  resolveExplicitRollbackPlan,
} from "../src/delivery/driver.js";
import {
  ProductionDelivery,
  type DeliveryRuntime,
  type DeliveryStore,
  type WranglerOperations,
} from "../src/delivery/service.js";

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  const now = new Date("2026-08-30T12:00:00.000Z");
  return {
    id: "deployment-1",
    siteId: "site-1",
    sourceCommit: "a".repeat(40),
    artifactDigest: "d".repeat(64),
    versionId: "version-2",
    previewUrl: null,
    previousVersionId: null,
    workerName: "factory-site",
    productionUrl: "https://example.com",
    status: "verified",
    previewVerified: true,
    productionVerified: true,
    rolledBack: false,
    errorCode: null,
    errorMessage: null,
    artifactDirectory: null,
    createdAt: now,
    updatedAt: now,
    promotedAt: now,
    verifiedAt: now,
    ...overrides,
  };
}

test("explicit rollback rejects provider drift before selecting a target", () => {
  assert.throws(
    () => resolveExplicitRollbackPlan({
      actualVersion: "unexpected-version",
      effectiveRecord: record({ versionId: "expected-version" }),
      canonicalVerified: [record({ versionId: "older-version" })],
    }),
    (error: unknown) => (error as { code?: string }).code === "deployment_drift",
  );
});

test("rolled-back events determine effective state but never canonical rollback provenance", () => {
  const rolledBackEvent = record({
    id: "rollback-event",
    status: "rolled_back",
    productionVerified: false,
    sourceCommit: "f".repeat(40),
    versionId: "failed-candidate",
    previousVersionId: "version-2",
  });
  const canonical = record({
    id: "canonical-v1",
    sourceCommit: "1".repeat(40),
    artifactDigest: "c".repeat(64),
    versionId: "version-1",
  });
  const plan = resolveExplicitRollbackPlan({
    actualVersion: "version-2",
    effectiveRecord: rolledBackEvent,
    canonicalVerified: [canonical],
  });
  assert.deepEqual(plan, {
    sourceCommit: canonical.sourceCommit,
    artifactDigest: canonical.artifactDigest,
    versionId: "version-1",
    qaSourceCommit: canonical.sourceCommit,
  });
});

test("external bootstrap baselines cannot become explicit history targets", () => {
  const bootstrapRecovery = record({
    status: "rolled_back",
    productionVerified: false,
    versionId: "failed-first-candidate",
    previousVersionId: "external-baseline",
  });
  assert.throws(
    () => resolveExplicitRollbackPlan({
      actualVersion: "external-baseline",
      effectiveRecord: bootstrapRecovery,
      canonicalVerified: [],
    }),
    (error: unknown) => (error as { code?: string }).code === "rollback_target_unavailable",
  );
});

class RecoveryStore implements DeliveryStore {
  current: DeploymentRecord;
  constructor(stale: DeploymentRecord) {
    this.current = stale;
  }
  async updateDeployment(input: Parameters<DeliveryStore["updateDeployment"]>[0]): Promise<DeploymentRecord> {
    this.current = { ...this.current, ...input, updatedAt: new Date() } as DeploymentRecord;
    return this.current;
  }
  async findLatestKnownGoodDeployment(): Promise<DeploymentRecord | null> {
    return null;
  }
}

class RecoveryProvider implements WranglerOperations {
  rollbackMutations: string[] = [];
  constructor(private readonly active: string) {}
  async assertTargetExists(): Promise<void> {}
  async upload(): Promise<never> { throw new Error("not used during reconciliation"); }
  async currentProductionVersion(): Promise<string> { return this.active; }
  async promote(): Promise<never> { throw new Error("not used during reconciliation"); }
  async rollback(_workerName: string, versionId: string): Promise<void> {
    this.rollbackMutations.push(versionId);
  }
}

function recoveryRuntime(qaPassed: boolean): DeliveryRuntime {
  return {
    async build() { throw new Error("not used during reconciliation"); },
    async digest() { throw new Error("not used during reconciliation"); },
    async qa() { return { passed: qaPassed, exitCode: 0, timedOut: false }; },
    async assertSourceStillAccepted() {},
  };
}

async function invokeWithPendingRecovery(input: {
  stale: DeploymentRecord | null;
  active: string;
  qaPassed?: boolean;
}): Promise<{
  result: DeploymentRecord;
  historicalStarts: number;
  rollbackMutations: readonly string[];
}> {
  let historicalStarts = 0;
  const fallback = record({ id: "historical-rollback" });
  const provider = new RecoveryProvider(input.active);
  const store = new RecoveryStore(input.stale ?? fallback);
  const result = await executeExplicitRollbackBoundary({
    findPending: async () => input.stale,
    reconcilePending: async (stale) =>
      await new ProductionDelivery(store, provider, recoveryRuntime(input.qaPassed ?? true)).reconcile(stale),
    beginHistoricalRollback: async () => {
      historicalStarts += 1;
      return fallback;
    },
  });
  return { result, historicalStarts, rollbackMutations: provider.rollbackMutations };
}

test("explicit rollback reconciles a pre-promotion crash at the previous version and stops", async () => {
  const stale = record({
    id: "stale-v3",
    status: "promoting",
    versionId: "v3",
    previousVersionId: "v2",
    productionVerified: false,
  });
  const invocation = await invokeWithPendingRecovery({ stale, active: "v2" });
  assert.equal(invocation.result.id, stale.id);
  assert.equal(invocation.result.status, "rolled_back");
  assert.equal(invocation.historicalStarts, 0);
  assert.deepEqual(invocation.rollbackMutations, []);
});

test("explicit rollback resumes candidate production QA after a post-promotion crash and stops", async () => {
  const stale = record({
    id: "stale-v3",
    status: "promoted",
    versionId: "v3",
    previousVersionId: "v2",
    productionVerified: false,
  });
  const invocation = await invokeWithPendingRecovery({ stale, active: "v3" });
  assert.equal(invocation.result.id, stale.id);
  assert.equal(invocation.result.status, "verified");
  assert.equal(invocation.historicalStarts, 0);
  assert.deepEqual(invocation.rollbackMutations, []);
});

test("explicit rollback returns stale-state drift without starting historical rollback", async () => {
  const stale = record({
    id: "stale-v3",
    status: "promoting",
    versionId: "v3",
    previousVersionId: "v2",
    productionVerified: false,
  });
  const invocation = await invokeWithPendingRecovery({ stale, active: "unrelated-vX" });
  assert.equal(invocation.result.id, stale.id);
  assert.equal(invocation.result.status, "needs_review");
  assert.equal(invocation.result.errorCode, "deployment_drift");
  assert.equal(invocation.historicalStarts, 0);
  assert.deepEqual(invocation.rollbackMutations, []);
});

test("explicit rollback preserves the historical path when no dangerous state exists", async () => {
  const invocation = await invokeWithPendingRecovery({ stale: null, active: "v2" });
  assert.equal(invocation.result.id, "historical-rollback");
  assert.equal(invocation.historicalStarts, 1);
  assert.deepEqual(invocation.rollbackMutations, []);
});
