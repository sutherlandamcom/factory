import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GovernedDeliveryService } from "../src/delivery/governed-service.js";
import { ProductionDelivery } from "../src/delivery/service.js";
import { SimulatedWrangler } from "../src/delivery/simulated-wrangler.js";
import type { DeploymentRecord } from "../src/persistence/schema.js";

const routes = ["/", "/about", "/contact", "/insights", "/services", "/services/executive-search"];
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { simulated?: boolean; targetOrigin?: string | null; currentOrigin?: string | null; targetRoutes?: unknown; pendingOrigin?: string | null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "factory-rollback-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = options.simulated === false ? "REAL_CLOUDFLARE" : "TEST_SIMULATION";
  const now = new Date();
  const target = { id: "target", siteId: "site", sourceCommit: "a".repeat(40), artifactDigest: "b".repeat(64), versionId: "A", previousVersionId: null, workerName: "worker", productionUrl: "https://example.com", status: "verified", previewVerified: true, productionVerified: true, rolledBack: false, artifactDirectory: "evidence", candidateId: "candidate-A", qaRunId: "qa-A", releaseApprovalId: null, candidateRoutes: options.targetRoutes === undefined ? routes : options.targetRoutes, executionOrigin: options.targetOrigin === undefined ? origin : options.targetOrigin, createdAt: now, updatedAt: now, verifiedAt: now } as DeploymentRecord;
  const latest = { ...target, id: "latest", versionId: "B", candidateId: "candidate-B", executionOrigin: options.currentOrigin === undefined ? origin : options.currentOrigin } as DeploymentRecord;
  const pending = { ...target, id: "pending", status: "promoting", rolledBack: true, productionVerified: false, versionId: "A", previousVersionId: "B", operationId: "rb-pending", executionOrigin: options.pendingOrigin === undefined ? origin : options.pendingOrigin, snapshotData: { operationType: "ROLLBACK", targetDeploymentId: "target", toVersionId: "A", fromVersionId: "B", targetQaRunId: "qa-A", initiatingActor: { actorId: "operator", actorName: "Operator", actorRole: "ADMIN", sessionId: "session" } } } as DeploymentRecord;
  let recovering = false;
  const records = new Map([[target.id, target], [latest.id, latest], [pending.id, pending]]);
  const mutations: string[] = []; const transitions: any[] = []; const qaCalls: any[] = []; const intents: any[] = [];
  const store = {
    findSiteByProjectId: async () => ({ id: "site", projectId: "project", cloudflareWorkerName: "worker", productionUrl: "https://example.com" }),
    getSiteById: async () => ({ id: "site", projectId: "project", cloudflareWorkerName: "worker", productionUrl: "https://example.com" }),
    findLatestUnverifiedDeployment: async () => recovering && ["promoting", "promoted"].includes(records.get("pending")!.status) ? records.get("pending")! : null,
    listDeployments: async () => [latest, target], listCanonicalVerifiedDeployments: async () => [latest, target], findLatestKnownGoodDeployment: async () => target,
    getCurrentEffectiveTransition: async () => ({ deploymentId: "latest", executionOrigin: latest.executionOrigin, versionId: "B" }),
    getDeployment: async (id: string) => records.get(id),
    createDeployment: async (input: any) => { intents.push(input); const row = { ...target, ...input }; records.set(row.id, row); return row; },
    updateDeployment: async (input: any) => { const row = { ...records.get(input.id)!, ...input }; records.set(row.id, row); return row; },
    finalizeDeploymentAndTransitionAtomic: async (input: any) => { transitions.push(input.transition); const row = { ...records.get(input.deploymentId)!, status: input.status, executionOrigin: input.executionOrigin, productionVerified: true }; records.set(row.id, row); return { deployment: row, transition: input.transition }; },
  };
  const provider = new SimulatedWrangler("A");
  Object.defineProperty(provider, "isSimulated", { value: options.simulated !== false });
  const original = provider.rollback.bind(provider);
  provider.rollback = async (worker, version) => { mutations.push(version); return original(worker, version); };
  const service = new GovernedDeliveryService({ db: {} as any, repoRoot: root, store: store as any, productionStore: { getQaRun: async () => ({ overall: "PASS", candidateId: "candidate-A", candidateArtifactDigest: target.artifactDigest }) } as any, releaseBoundary: { verifyActorPermission: async () => ({ actorId: "operator", actorName: "Operator", actorRole: "ADMIN", sessionId: "session" }) } as any, wranglerFactory: () => provider, worktreeProvider: { prepare: async () => root, remove: async () => {} }, qaRunner: async input => { qaCalls.push(input); return { passed: true, exitCode: 0, timedOut: false }; } });
  return { service, store, provider, target, latest, records, mutations, transitions, qaCalls, intents, recover: async () => { recovering = true; return service.reconcilePendingDeployments("site"); } };
}

test("SF-F02 rollback rejects conflicting target, current or unknown provenance before intent and mutation", async t => {
  for (const options of [
    { targetOrigin: "REAL_CLOUDFLARE" },
    { simulated: false, targetOrigin: "TEST_SIMULATION" },
    { targetOrigin: "UNKNOWN" }, { targetOrigin: null },
    { currentOrigin: "REAL_CLOUDFLARE" }, { currentOrigin: "UNKNOWN" },
  ]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.service.rollbackExplicit({ projectId: "project", targetVersionId: "A", sessionToken: "test" }));
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.intents, []); assert.deepEqual(f.transitions, []);
  });
});
test("SF-F02 lower-level rollback cannot bypass provider provenance checks", async t => {
  const f = await fixture(t, { targetOrigin: "REAL_CLOUDFLARE" });
  const delivery = new ProductionDelivery(f.store as any, f.provider, { build: async () => "", digest: async () => "", assertSourceStillAccepted: async () => {}, qa: async () => ({ passed: true, exitCode: 0, timedOut: false }) });
  await assert.rejects(delivery.rollbackExplicit({ deployment: f.latest, targetDeployment: f.target, targetVersionId: "A" }));
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.intents, []);
});
test("SF-F02 recovery mode conflict preserves evidence and creates no transition", async t => {
  for (const options of [{ pendingOrigin: "REAL_CLOUDFLARE" }, { targetOrigin: "REAL_CLOUDFLARE" }, { currentOrigin: "REAL_CLOUDFLARE" }]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options); await f.recover();
    assert.equal(f.records.get("pending")!.status, "needs_review");
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.transitions, []); assert.deepEqual(f.qaCalls, []);
  });
});
test("SF-F02 same-mode rollback preserves deployment and transition origins", async t => {
  for (const simulated of [true, false]) await t.test(String(simulated), async t => {
    const f = await fixture(t, { simulated });
    const result = await f.service.rollbackExplicit({ projectId: "project", targetVersionId: "A", sessionToken: "test" });
    assert.equal(result.status, "rolled_back"); assert.equal(result.executionOrigin, simulated ? "TEST_SIMULATION" : "REAL_CLOUDFLARE");
    assert.equal(f.transitions[0].executionOrigin, result.executionOrigin);
    assert.equal(f.transitions[0].actorId, "operator"); assert.equal(f.transitions[0].eventType, "ROLLBACK");
    assert.deepEqual(f.qaCalls[0].candidateRoutes, routes);
    await f.recover();
    assert.equal(f.records.get("pending")!.status, "rolled_back");
    assert.equal(f.records.get("pending")!.executionOrigin, result.executionOrigin);
    assert.equal(f.transitions.at(-1).executionOrigin, result.executionOrigin);
  });
});
test("SF-F03 ordinary rollback rejects missing or invalid historical routes without side effects, including retry", async t => {
  for (const manifest of [null, [], ["bad"], ["/", "/"], Array.from({ length: 201 }, (_, i) => `/page-${i}`)]) await t.test(JSON.stringify(manifest).slice(0, 55), async t => {
    const f = await fixture(t, { targetRoutes: manifest });
    for (let retry = 0; retry < 2; retry++) await assert.rejects(f.service.rollbackExplicit({ projectId: "project", targetVersionId: "A", sessionToken: "test" }));
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.intents, []); assert.deepEqual(f.transitions, []); assert.deepEqual(f.target.candidateRoutes, manifest);
  });
});
test("SF-F03 genuine root-only and six-page manifests remain exact through rollback and recovery", async t => {
  for (const manifest of [["/"], routes]) await t.test(String(manifest.length), async t => {
    const f = await fixture(t, { targetRoutes: manifest });
    await f.service.rollbackExplicit({ projectId: "project", targetVersionId: "A", sessionToken: "test" });
    assert.deepEqual(f.intents[0].candidateRoutes, manifest); assert.deepEqual(f.qaCalls[0].candidateRoutes, manifest); assert.deepEqual(f.transitions[0].candidateRoutes, manifest);
    await f.recover(); assert.deepEqual(f.qaCalls.at(-1).candidateRoutes, manifest);
  });
});
