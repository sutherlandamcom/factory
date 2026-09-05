import { defineConfig } from "@playwright/test";

/**
 * Real-browser Operator journey E2E.
 *
 * Topology (production-like, fully local):
 * - dedicated real PostgreSQL test database (FACTORY_TEST_DATABASE_URL —
 *   the dedicated `factory_test` database; never a dev/general DB);
 * - the actual Operator service (apps/factory operator server) started by
 *   scripts/operator-e2e-server.mjs, serving the BUILT dashboard (dist);
 * - Playwright drives a real Chromium browser through the built UI.
 *
 * No API mocking, no JSON editing, no direct SQL in the journey itself.
 * The supervisor script owns the server lifecycle so the required
 * "restart the operator service WITHOUT resetting the DB" step is a real
 * process restart.
 */

const operatorPort = Number(process.env.FACTORY_OPERATOR_PORT || 4175);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${operatorPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "operator-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
