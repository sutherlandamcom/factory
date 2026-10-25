/**
 * E2E/truncate helper (trusted test tooling, not product code).
 * Truncates all Factory tables in the dedicated test database using the
 * same safety rules and the SAME table list as the persistence test
 * harness (`resetTestDatabase`) — never a general/dev database.
 *
 * The budget ledger tables (visual/writer/competitor/search budget
 * reservations) have no foreign key to `projects`, so a plain
 * `TRUNCATE projects CASCADE` leaves stale daily-budget rows behind and
 * long-lived shared test databases exhaust their fixture budgets across
 * runs. The operator E2E must start each day/test run from a neutral
 * ledger exactly like persistence tests do.
 *
 * Usage: pnpm --filter @factory/factory exec tsx scripts/truncate-test-db.ts
 */
import { resolveDatabaseConfig } from "../src/persistence/config.js";
import { createDatabaseInstance } from "../src/persistence/db.js";
import { resetTestDatabase } from "../tests/persistence/helpers.js";

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
await resetTestDatabase(inst);
console.log("[truncate-test-db] done");
await inst.close();
process.exit(0);
