import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentRecord } from "../src/persistence/schema.js";
import {
  ProductionDelivery,
  type WranglerOperations,
  type DeliveryRuntime,
  type DeliveryStore,
} from "../src/delivery/service.js";
import { assertDeploymentTransition } from "../src/persistence/store.js";

test("deployment states reject bypass transitions", () => {
  assert.doesNotThrow(() => assertDeploymentTransition("preview_verified", "promoting"));
  assert.throws(
    () => assertDeploymentTransition("uploaded", "verified"),
    (error: unknown) => (error as { code?: string }).code === "deployment_transition_invalid",
  );
});

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  const now = new Date("2026-08-30T12:00:00.000Z");
  return {
    id: "deployment-1",
    siteId: "site-db-id",
    sourceCommit: "a".repeat(40),
    artifactDigest: null,
    versionId: null,
    previewUrl: null,
    previousVersionId: null,
    workerName: "factory-site",
    productionUrl: "https://example.com",
    status: "preparing",
    previewVerified: false,
    productionVerified: false,
    rolledBack: false,
    errorCode: null,
    errorMessage: null,
    artifactDirectory: ".factory/deployments/deployment-1",
    createdAt: now,
    updatedAt: now,
    promotedAt: null,
    verifiedAt: null,
    ...overrides,
  };
}

class MemoryStore implements DeliveryStore {
  current: DeploymentRecord;
  updates: string[] = [];
  constructor(initial: DeploymentRecord, private readonly knownGood: DeploymentRecord | null = null) {
    this.current = initial;
  }
  async updateDeployment(input: Parameters<DeliveryStore["updateDeployment"]>[0]): Promise<DeploymentRecord> {
    this.updates.push(input.status);
    this.current = { ...this.current, ...input, updatedAt: new Date() } as DeploymentRecord;
    return this.current;
  }
  async findLatestKnownGoodDeployment(): Promise<DeploymentRecord | null> {
    return this.knownGood;
  }
}

class FakeWrangler implements WranglerOperations {
  promoted: string[] = [];
  rolledBack: string[] = [];
  current: string | null;
  constructor(current: string | null) { this.current = current; }
  async assertTargetExists(): Promise<void> {}
  async upload() { return { versionId: "candidate-v2", previewUrl: "https://preview.example.workers.dev", workerName: "factory-site" }; }
  async currentProductionVersion() { return this.current; }
  async promote(_worker: string, version: string) { this.promoted.push(version); this.current = version; }
  async rollback(_worker: string, version: string) { this.rolledBack.push(version); this.current = version; }
}

function runtime(qaResults: boolean[]): DeliveryRuntime & { builds: number } {
  return {
    builds: 0,
    async build() { this.builds++; return "/tmp/dist"; },
    async digest() { return "b".repeat(64); },
    async qa() { return { passed: qaResults.shift() ?? false, exitCode: 0, timedOut: false }; },
    async assertSourceStillAccepted() {},
  };
}

test("preview failure prevents promotion and the artifact is built once", async () => {
  const store = new MemoryStore(record());
  const provider = new FakeWrangler(null);
  const rt = runtime([false]);
  const result = await new ProductionDelivery(store, provider, rt).execute(store.current);
  assert.equal(rt.builds, 1);
  assert.deepEqual(provider.promoted, []);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "preview_qa_failed");
});

test("promotion uses the exact uploaded preview-verified version and requires production QA", async () => {
  const store = new MemoryStore(record());
  const provider = new FakeWrangler(null);
  const rt = runtime([true, true]);
  const result = await new ProductionDelivery(store, provider, rt).execute(store.current);
  assert.equal(rt.builds, 1);
  assert.deepEqual(provider.promoted, ["candidate-v2"]);
  assert.equal(result.versionId, "candidate-v2");
  assert.equal(result.status, "verified");
  assert.equal(result.productionVerified, true);
  assert.ok(store.updates.indexOf("promoting") < store.updates.indexOf("promoted"));
});

test("provider drift blocks promotion", async () => {
  const known = record({ id: "known", status: "verified", versionId: "known-v1", productionVerified: true });
  const store = new MemoryStore(record(), known);
  const provider = new FakeWrangler("unexpected-v9");
  const result = await new ProductionDelivery(store, provider, runtime([true])).execute(store.current);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "deployment_drift");
  assert.deepEqual(provider.promoted, []);
});

test("origin/main moving after preview prevents production promotion", async () => {
  const store = new MemoryStore(record());
  const provider = new FakeWrangler(null);
  const rt = runtime([true]);
  rt.assertSourceStillAccepted = async () => { throw new Error("source moved"); };
  const result = await new ProductionDelivery(store, provider, rt).execute(store.current);
  assert.equal(result.status, "failed");
  assert.deepEqual(provider.promoted, []);
});

test("failed production QA rolls back the exact trusted previous version and verifies it", async () => {
  const known = record({ id: "known", status: "verified", versionId: "known-v1", productionVerified: true });
  const store = new MemoryStore(record(), known);
  const provider = new FakeWrangler("known-v1");
  const result = await new ProductionDelivery(store, provider, runtime([true, false, true])).execute(store.current);
  assert.deepEqual(provider.promoted, ["candidate-v2"]);
  assert.deepEqual(provider.rolledBack, ["known-v1"]);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rolledBack, true);
  assert.equal(result.productionVerified, false);
});

test("rollback mutation failure can never report recovery", async () => {
  const known = record({ id: "known", status: "verified", versionId: "known-v1", productionVerified: true });
  const store = new MemoryStore(record(), known);
  const provider = new FakeWrangler("known-v1");
  provider.rollback = async () => { throw new Error("rollback unavailable"); };
  const result = await new ProductionDelivery(store, provider, runtime([true, false])).execute(store.current);
  assert.equal(result.status, "needs_review");
  assert.notEqual(result.status, "verified");
});

test("first deployment production failure never claims recovery without a rollback target", async () => {
  const store = new MemoryStore(record());
  const provider = new FakeWrangler(null);
  const result = await new ProductionDelivery(store, provider, runtime([true, false])).execute(store.current);
  assert.equal(result.status, "needs_review");
  assert.equal(result.errorCode, "production_qa_failed_no_rollback");
  assert.deepEqual(provider.rolledBack, []);
});

test("first managed deployment may restore the pre-existing active version only after rollback QA", async () => {
  const store = new MemoryStore(record());
  const provider = new FakeWrangler("preexisting-v1");
  const result = await new ProductionDelivery(store, provider, runtime([true, false, true])).execute(store.current);
  assert.deepEqual(provider.rolledBack, ["preexisting-v1"]);
  assert.equal(result.previousVersionId, "preexisting-v1");
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rolledBack, true);
});

test("stale promoting state reconciles against the actual candidate version", async () => {
  const stale = record({
    status: "promoting",
    versionId: "candidate-v2",
    previewUrl: "https://preview.example.workers.dev",
    previewVerified: true,
  });
  const store = new MemoryStore(stale);
  const provider = new FakeWrangler("candidate-v2");
  const result = await new ProductionDelivery(store, provider, runtime([true])).reconcile(stale);
  assert.equal(result.status, "verified");
  assert.equal(result.productionVerified, true);
});

test("stale state recognizes an already-restored previous version", async () => {
  const stale = record({
    status: "promoted",
    versionId: "candidate-v2",
    previousVersionId: "known-v1",
    previewVerified: true,
  });
  const store = new MemoryStore(stale);
  const provider = new FakeWrangler("known-v1");
  const result = await new ProductionDelivery(store, provider, runtime([true])).reconcile(stale);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rolledBack, true);
});

test("stale state with an unrelated active version fails closed as drift", async () => {
  const stale = record({
    status: "promoting",
    versionId: "candidate-v2",
    previousVersionId: "known-v1",
    previewVerified: true,
  });
  const store = new MemoryStore(stale);
  const provider = new FakeWrangler("unrelated-v9");
  const result = await new ProductionDelivery(store, provider, runtime([])).reconcile(stale);
  assert.equal(result.status, "needs_review");
  assert.equal(result.errorCode, "deployment_drift");
});
