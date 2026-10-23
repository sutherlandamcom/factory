import { sutherlandIntakePayload } from "./sutherland-intake.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
/** Test-only explicit configuration. Never writes the shared repository profile. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { desc, eq } from "drizzle-orm";
import type { FactoryDb } from "../../src/persistence/db.js";
import { projects, projectInputSnapshots, sites } from "../../src/persistence/schema.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import type { ProjectIntakePayload, SiteProfile } from "@factory/contracts";

export async function provisionTestSiteBinding(db: FactoryDb, root: string, projectId: string, options: { siteId?: string; canonicalOrigin?: string; route?: string } = {}) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  let [snapshot] = await db.select().from(projectInputSnapshots).where(eq(projectInputSnapshots.projectId, projectId)).orderBy(desc(projectInputSnapshots.version)).limit(1);
  if (!project) throw new Error("Test binding requires a real project.");
  if (!snapshot) {
    const intake = new ProjectIntakeStore(db);
    const draft = await intake.saveDraft({ projectId, baseRevision: 0, payload: structuredClone(sutherlandIntakePayload) });
    snapshot = await intake.accept({ projectId, expectedRevision: draft.revision, expectedDigest: draft.digest });
  }
  const payload = snapshot.payload as ProjectIntakePayload;
  const profile: SiteProfile = { version: "v0", siteId: options.siteId ?? project.key, siteName: payload.siteIdentity.siteName,
    canonicalOrigin: options.canonicalOrigin ?? "https://binding.example.test", language: payload.siteIdentity.language,
    navigation: [{ label: "Home", targetSlug: options.route ?? "/home" }] };
  const existingSites = await db.select().from(sites).where(eq(sites.projectId, projectId));
  if (existingSites.length > 1) throw new Error("Test fixture must explicitly select among multiple registered sites.");
  const site = existingSites[0] ?? await new FactoryStore(db).registerSite({ projectKey: project.key, key: `${project.key}-site`, name: profile.siteName });
  const delivery = { workerName: site.cloudflareWorkerName ?? `test-${project.key}`.slice(0, 63), productionUrl: site.productionUrl ?? "https://delivery.example.test" };
  await db.update(sites).set({ cloudflareWorkerName: delivery.workerName, productionUrl: delivery.productionUrl }).where(eq(sites.id, site.id));
  // Explicit test-only informational approval preserves existing fixture tests'
  // no-verified-contact semantics; it grants no live provider/review authority.
  const binding = { version: "project-site-binding-v1", projectKey: project.key, siteKey: site.key,
    profileDigest: deterministicDigest(profile), acceptedSiteIdentityDigest: deterministicDigest(payload.siteIdentity), delivery,
    informationalConversion: { acceptedInputDigest: snapshot.digest, reason: "Explicit isolated regression-fixture informational page" } };
  await mkdir(path.join(root, "sites/starter"), { recursive: true });
  await writeFile(path.join(root, "sites/starter/site-profile.json"), JSON.stringify(profile));
  await writeFile(path.join(root, "sites/starter/project-site-binding.json"), JSON.stringify(binding));
  return { siteId: profile.siteId, siteName: profile.siteName, canonicalOrigin: profile.canonicalOrigin,
    language: profile.language, profileDigest: deterministicDigest(profile), bindingDigest: deterministicDigest(binding) };
}

import { cp, mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after } from "node:test";

/** Source-isolated renderer copy; dependency/source metadata links are read-only test inputs. */
export async function createIsolatedProductionRoot(sourceRoot: string, cleanup = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e01-production-copy-"));
  if (cleanup) after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sites/starter"), { recursive: true });
  for (const relative of [".git", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "node_modules", "packages", "docs"]) {
    await symlink(path.join(sourceRoot, relative), path.join(root, relative));
  }
  for (const relative of ["src", "public", "astro.config.ts", "package.json", "tsconfig.json", "site-profile.json"]) {
    await cp(path.join(sourceRoot, "sites/starter", relative), path.join(root, "sites/starter", relative), { recursive: true });
  }
  await symlink(path.join(sourceRoot, "sites/starter/node_modules"), path.join(root, "sites/starter/node_modules"));
  return root;
}
