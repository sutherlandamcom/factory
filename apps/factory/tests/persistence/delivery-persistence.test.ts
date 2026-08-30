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
  } finally {
    await dbInst.close();
  }
});
