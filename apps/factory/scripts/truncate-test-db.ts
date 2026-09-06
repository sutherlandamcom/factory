/**
 * E2E/truncate helper (trusted test tooling, not product code).
 * Truncates all Factory tables in the dedicated test database using the
 * same safety rules as the persistence test harness (explicit env URL,
 * factory_test-only).
 *
 * Usage: pnpm --filter @factory/factory exec tsx scripts/truncate-test-db.ts
 */
import { sql } from "drizzle-orm";
import { resolveDatabaseConfig } from "../src/persistence/config.js";
import { createDatabaseInstance } from "../src/persistence/db.js";

const raw = process.env.FACTORY_TEST_DATABASE_URL?.trim();
if (!raw) {
  console.error(
    "FACTORY_TEST_DATABASE_URL is required: the E2E/truncate helper must never guess a database.",
  );
  process.exit(1);
}
const dbName = new URL(raw).pathname.replace(/^\//, "");
if (dbName !== "factory_test") {
  console.error(
    `Refusing: helper may only target the dedicated "factory_test" database, got "${dbName}".`,
  );
  process.exit(1);
}

const inst = createDatabaseInstance(
  resolveDatabaseConfig({ test: true, url: raw, requireConfigured: true }),
);
await inst.db.execute(
  sql`TRUNCATE TABLE accepted_content_gap_snapshots, content_gap_decisions, content_gap_reports, competitor_page_analyses, competitor_classification_overrides, competitor_page_snapshots, competitor_runs, deployments, model_invocations, quality_results, attempts, tasks, runs, sites, projects, project_input_snapshots, project_input_drafts CASCADE;`,
);
console.log("[truncate-test-db] done");
await inst.close();
process.exit(0);
