import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { sites } from "../../src/persistence/schema.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { sutherlandIntakePayload } from "../fixtures/sutherland-intake.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { requireProjectSiteAuthority } from "../../src/production/site-binding.js";
import { ProductionStore } from "../../src/production/store.js";
import type { SiteProfile } from "@factory/contracts";

test("E2E-P0-01 PG: two isolated project configurations, wrong-project rejection and identity/target mutation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const roots: string[] = [];
  try {
    const store = new FactoryStore(dbInst.db);
    const intake = new ProjectIntakeStore(dbInst.db);
    const configurations = [];
    for (const key of ["sutherland", "stark"]) {
      const root = await mkdtemp(path.join(tmpdir(), `e2e01-${key}-`)); roots.push(root);
      const payload = key === "sutherland" ? structuredClone(sutherlandIntakePayload) : buildIntakePayload();
      if (key === "stark") {
        payload.siteIdentity = { siteName: "Stark Engineering", candidateDomain: "stark.example.test", language: "ru-RU", locale: "ru-RU" };
        payload.markets = { geographies: ["Russia"], priorityLocations: [] };
        payload.conversion = { primaryObjective: "Discuss an industrial project", ctaType: "contact", ctaDestinationType: "url", ctaDestination: "https://contact.stark.example.test/", verificationState: "VERIFIED" };
      }
      const project = await store.createProject({ key: `e2e01-${key}`, name: payload.siteIdentity.siteName });
      const draft = await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
      const snapshot = await intake.accept({ projectId: project.id, expectedRevision: draft.revision, expectedDigest: draft.digest });
      const site = await store.registerSite({ projectKey: project.key, key, name: project.name });
      const delivery = { workerName: `e2e01-${key}`, productionUrl: `https://${key}.example.test` };
      await dbInst.db.update(sites).set({ cloudflareWorkerName: delivery.workerName, productionUrl: delivery.productionUrl }).where(eq(sites.id, site.id));
      const profile: SiteProfile = { version: "v0", siteId: key, siteName: payload.siteIdentity.siteName, canonicalOrigin: key === "sutherland" ? "https://sutherlandam.com" : "https://stark.example.test", language: payload.siteIdentity.language, navigation: [{ label: "Home", targetSlug: "/" }] };
      const binding = { version: "project-site-binding-v1", projectKey: project.key, siteKey: site.key, profileDigest: deterministicDigest(profile), acceptedSiteIdentityDigest: deterministicDigest(payload.siteIdentity), delivery };
      await mkdir(path.join(root, "sites/starter"), { recursive: true });
      await writeFile(path.join(root, "sites/starter/site-profile.json"), JSON.stringify(profile));
      await writeFile(path.join(root, "sites/starter/project-site-binding.json"), JSON.stringify(binding));
      configurations.push({ root, project, site, payload, profile, binding, snapshot });
    }
    const [a, b] = configurations;
    assert.ok(a && b);
    const [authorityA, authorityB] = await Promise.all(configurations.map(c => requireProjectSiteAuthority(dbInst.db, c.root, c.project.id)));
    assert.equal(authorityA!.profile.canonicalOrigin, "https://sutherlandam.com");
    assert.equal(authorityB!.profile.language, "ru-RU");
    assert.notEqual(authorityA!.bindingDigest, authorityB!.bindingDigest);
    await assert.rejects(() => requireProjectSiteAuthority(dbInst.db, a.root, b.project.id), /binding/i);
    await assert.rejects(() => new ProductionStore(dbInst.db, { repoRoot: a.root }).deriveProductionInput({ projectId: b.project.id, pageSlug: "home", siteIdentity: { ...authorityA!.profile, profileDigest: deterministicDigest(a.profile) } as never, rendererVersion: "7.3.3", rendererPolicyVersion: "production-policy-v4" }), /binding|authority|content/i);
    await dbInst.db.update(sites).set({ cloudflareWorkerName: a.binding.delivery.workerName }).where(eq(sites.id, b.site.id));
    await assert.rejects(() => requireProjectSiteAuthority(dbInst.db, b.root, b.project.id), /destination/i);
    const changed = structuredClone(a.payload); changed.siteIdentity.language = "fr";
    const draft = await intake.saveDraft({ projectId: a.project.id, baseRevision: 1, payload: changed });
    await intake.accept({ projectId: a.project.id, expectedRevision: draft.revision, expectedDigest: draft.digest });
    await assert.rejects(() => requireProjectSiteAuthority(dbInst.db, a.root, a.project.id), /binding/i);
  } finally { await dbInst.close(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
});
