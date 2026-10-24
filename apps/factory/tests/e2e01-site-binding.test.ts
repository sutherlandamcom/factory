import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { loadProductionBuildIdentity } from "../src/production/identity.js";

test("E2E-P0-01: a Stark project cannot derive the shared Sutherland build identity without a binding", async () => {
  // A second argument is deliberately ignored by the audited implementation.
  const root = path.resolve(import.meta.dirname, "../../..");
  await assert.rejects(
    () => loadProductionBuildIdentity(root, {
      projectKey: "stark-engineering", siteKey: "stark-engineering",
      acceptedSiteIdentity: { siteName: "Stark Engineering", candidateDomain: "stark.example.test", language: "ru-RU", locale: "ru-RU" },
    }),
    /binding|configured/i,
  );
});

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadProjectSiteBinding } from "../src/production/site-binding.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import type { SiteProfile } from "@factory/contracts";

for (const company of ["Sutherland", "Stark"] as const) {
  test(`E2E-P0-01: ${company} binding is isolated and detects authoritative mutations`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "e2e01-binding-"));
    const identity = { siteName: company, candidateDomain: `${company.toLowerCase()}.example.test`, language: company === "Stark" ? "ru-RU" : "en", locale: company === "Stark" ? "ru-RU" : "en-GB" };
    const profile: SiteProfile = { version: "v0", siteId: company.toLowerCase(), siteName: company, canonicalOrigin: `https://${identity.candidateDomain}`, language: identity.language, navigation: [{ label: "Home", targetSlug: "/" }] };
    const context = { projectKey: company.toLowerCase(), siteKey: profile.siteId, acceptedSiteIdentity: identity };
    const binding = { version: "project-site-binding-v1", projectKey: context.projectKey, siteKey: context.siteKey, profileDigest: deterministicDigest(profile), acceptedSiteIdentityDigest: deterministicDigest(identity), delivery: { workerName: context.projectKey, productionUrl: profile.canonicalOrigin } };
    try {
      await mkdir(path.join(root, "sites/starter"), { recursive: true });
      await writeFile(path.join(root, "sites/starter/project-site-binding.json"), JSON.stringify(binding));
      const valid = await loadProjectSiteBinding(root, profile, context);
      assert.equal(valid.bindingDigest, deterministicDigest(binding));
      for (const mutation of [
        { ...context, projectKey: "another-project" },
        { ...context, siteKey: "another-site" },
        { ...context, acceptedSiteIdentity: { ...identity, language: "fr" } },
        { ...context, acceptedSiteIdentity: { ...identity, candidateDomain: "changed.example.test" } },
      ]) await assert.rejects(() => loadProjectSiteBinding(root, profile, mutation), /binding/i);
      await assert.rejects(() => loadProjectSiteBinding(root, { ...profile, canonicalOrigin: "https://other.example.test" }, context), /binding/i);
      await writeFile(path.join(root, "sites/starter/project-site-binding.json"), JSON.stringify({ ...binding, delivery: { ...binding.delivery, productionUrl: "javascript:alert(1)" } }));
      await assert.rejects(() => loadProjectSiteBinding(root, profile, context), /binding/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

import { createIsolatedProductionRoot } from "./fixtures/project-site-binding.js";

test("E2E-P0-01: isolated production copies retain exact trusted QA configuration", async () => {
  const sourceRoot = path.resolve(import.meta.dirname, "../../..");
  const root = await createIsolatedProductionRoot(sourceRoot);
  for (const relative of [".gitleaks.toml", "osv-scanner.toml", "sites/starter/lighthouserc.json"]) {
    assert.equal(await readFile(path.join(root, relative), "utf8"), await readFile(path.join(sourceRoot, relative), "utf8"), relative);
  }
});
