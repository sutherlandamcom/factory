import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentRecord } from "../src/persistence/schema.js";
import { resolveExplicitRollbackPlan } from "../src/delivery/driver.js";

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
