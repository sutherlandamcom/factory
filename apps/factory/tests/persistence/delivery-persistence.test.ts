import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";

test("delivery persistence snapshots target configuration and known-good provenance", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  try {
    await store.createProject({ key: "delivery-project", name: "Delivery Project" });
    const site = await store.registerSite({
      projectKey: "delivery-project",
      key: "delivery-site",
      name: "Delivery Site",
    });
    const configured = await store.setSiteDeliveryConfiguration({
      siteKey: site.key,
      cloudflareWorkerName: "delivery-site",
      productionUrl: "https://example.com",
    });
    assert.equal(configured.cloudflareWorkerName, "delivery-site");
    assert.equal(configured.productionUrl, "https://example.com");

    const deployment = await store.createDeployment({
      id: "deployment-persistence-1",
      siteId: site.id,
      sourceCommit: "a".repeat(40),
      workerName: configured.cloudflareWorkerName!,
      productionUrl: configured.productionUrl!,
      artifactDirectory: ".factory/deployments/deployment-persistence-1",
    });
    await store.updateDeployment({
      id: deployment.id,
      status: "uploaded",
      artifactDigest: "b".repeat(64),
      versionId: "version-1",
      previewUrl: "https://preview.example.workers.dev",
    });
    await store.updateDeployment({
      id: deployment.id,
      status: "preview_verified",
      previewVerified: true,
    });
    await store.updateDeployment({
      id: deployment.id,
      status: "promoting",
    });
    await store.updateDeployment({
      id: deployment.id,
      status: "promoted",
      promotedAt: new Date(),
    });
    const verified = await store.updateDeployment({
      id: deployment.id,
      status: "verified",
      productionVerified: true,
      verifiedAt: new Date(),
    });
    assert.equal(verified.workerName, "delivery-site");
    assert.equal(verified.productionUrl, "https://example.com");
    assert.equal(
      (await store.findLatestKnownGoodDeployment(site.id, "delivery-site", "https://example.com"))?.versionId,
      "version-1",
    );

    const rollbackEvent = await store.createDeployment({
      id: "deployment-persistence-rollback-event",
      siteId: site.id,
      sourceCommit: "c".repeat(40),
      workerName: "delivery-site",
      productionUrl: "https://example.com",
      artifactDirectory: ".factory/deployments/deployment-persistence-rollback-event",
    });
    await store.updateDeployment({
      id: rollbackEvent.id,
      status: "promoting",
      artifactDigest: "d".repeat(64),
      versionId: "failed-version-2",
      previousVersionId: "version-1",
    });
    await store.updateDeployment({
      id: rollbackEvent.id,
      status: "rolled_back",
      rolledBack: true,
      verifiedAt: new Date("2100-01-01T00:00:00.000Z"),
    });
    assert.equal(
      (await store.findLatestKnownGoodDeployment(site.id, "delivery-site", "https://example.com"))?.id,
      rollbackEvent.id,
      "a verified rollback event is the latest effective production state",
    );
    assert.deepEqual(
      (await store.listCanonicalVerifiedDeployments(site.id, "delivery-site", "https://example.com"))
        .map((row) => row.id),
      [deployment.id],
      "rollback event rows must never become canonical release provenance",
    );

    await store.setSiteDeliveryConfiguration({
      siteKey: site.key,
      cloudflareWorkerName: "delivery-site-new",
      productionUrl: "https://new.example.com",
    });
    const historical = await store.getDeployment(deployment.id);
    assert.equal(historical?.workerName, "delivery-site");
    assert.equal(historical?.productionUrl, "https://example.com");
    assert.equal(
      await store.findLatestKnownGoodDeployment(site.id, "delivery-site-new", "https://new.example.com"),
      null,
      "known-good versions must not cross delivery target snapshots",
    );
    assert.deepEqual(
      await store.listCanonicalVerifiedDeployments(site.id, "delivery-site-new", "https://new.example.com"),
      [],
      "canonical history must remain scoped to the snapshotted target",
    );
  } finally {
    await dbInst.close();
  }
});
