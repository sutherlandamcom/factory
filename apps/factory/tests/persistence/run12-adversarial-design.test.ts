import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { ProductionStore } from "../../src/production/store.js";

/**
 * RUN 12 BLOCK 48 — adversarial design: missing design authority.
 *
 * Proves the fail-closed path when a project has accepted content but NO
 * AcceptedDesignArtifact: production input derivation must reject with
 * production_authority_not_found (no silent approximation, no default design).
 */
test("ADVERSARIAL DESIGN: missing design authority fails closed at production input derivation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "adv-design-1");
    const production = new ProductionStore(dbInst.db);
    await assert.rejects(
      production.deriveProductionInput({
        projectId,
        pageSlug: "home",
        siteIdentity: {
          siteId: "s",
          siteName: "S",
          canonicalOrigin: "https://example.com",
          language: "en",
          profileDigest: "a".repeat(64),
        },
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v3",
      }),
      (err: { code?: string }) => err.code === "production_authority_not_found",
    );
  } finally {
    await dbInst.close();
  }
});
