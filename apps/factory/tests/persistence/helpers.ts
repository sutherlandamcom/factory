import { sql } from "drizzle-orm";
import { resolveDatabaseConfig } from "../../src/persistence/config.js";
import { createDatabaseInstance, type FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import { FactoryError } from "../../src/executor/errors.js";

/** The only database name persistence tests are allowed to mutate. */
export const REQUIRED_TEST_DATABASE_NAME = "factory_test";

/**
 * Resolves the test database URL from FACTORY_TEST_DATABASE_URL.
 *
 * Persistence integration tests perform real database mutations, so the
 * harness MUST NEVER guess or fall back to a default connection string: a
 * silent fallback could point tests at an unrelated local PostgreSQL
 * instance (another project's dev DB, another test container, or worse).
 * Fail closed before any connection attempt instead.
 */
export function resolveTestDatabaseUrl(): string {
  const raw = process.env.FACTORY_TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new FactoryError(
      "test_database_url_required",
      "FACTORY_TEST_DATABASE_URL is required for persistence integration tests. " +
        "Persistence tests perform database mutations and must never guess which local PostgreSQL instance is safe to use. " +
        "Set FACTORY_TEST_DATABASE_URL explicitly to the dedicated Factory test database " +
        "(CI supplies its own; locally, point it at your dedicated test container).",
    );
  }

  // Safety assertion: only the dedicated test database may be targeted.
  // This is an explicit, stable rule (not a port heuristic) so different
  // environments can expose the test database on any host port.
  let dbName: string;
  try {
    dbName = new URL(raw).pathname.replace(/^\//, "");
  } catch {
    throw new FactoryError(
      "test_database_url_invalid",
      `FACTORY_TEST_DATABASE_URL is not a valid PostgreSQL URL: '${raw}'`,
    );
  }
  if (dbName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new FactoryError(
      "test_database_url_invalid",
      `Refusing to run persistence tests against database "${dbName}": ` +
        `FACTORY_TEST_DATABASE_URL must target the dedicated "${REQUIRED_TEST_DATABASE_NAME}" test database.`,
    );
  }

  return raw;
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl();

export async function createTestDatabase(): Promise<FactoryDatabaseInstance> {
  const config = resolveDatabaseConfig({
    test: true,
    url: TEST_DATABASE_URL,
    requireConfigured: true,
  });
  return createDatabaseInstance(config);
}

export async function resetTestDatabase(dbInst: FactoryDatabaseInstance): Promise<void> {
  // Truncate all tables in dependency order
  await dbInst.db.execute(sql`
    TRUNCATE TABLE
      deployments,
      model_invocations,
      quality_results,
      attempts,
      tasks,
      runs,
      sites,
      projects,
      search_intelligence_snapshots,
      grounded_search_snapshots,
      serp_snapshots,
      search_runs,
      project_input_snapshots,
      project_input_drafts
    CASCADE;
  `);
}

export async function setupMigratedTestDatabase(): Promise<FactoryDatabaseInstance> {
  const dbInst = await createTestDatabase();
  await migrateDb(dbInst.db);
  await resetTestDatabase(dbInst);
  return dbInst;
}
