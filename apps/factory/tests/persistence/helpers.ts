import { sql } from "drizzle-orm";
import { resolveDatabaseConfig } from "../../src/persistence/config.js";
import { createDatabaseInstance, type FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { migrateDb } from "../../src/persistence/migrate.js";

export const TEST_DATABASE_URL =
  process.env.FACTORY_TEST_DATABASE_URL ||
  "postgresql://factory:factory_test_password@localhost:5432/factory_test";

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
      model_invocations,
      quality_results,
      attempts,
      tasks,
      runs,
      sites,
      projects
    CASCADE;
  `);
}

export async function setupMigratedTestDatabase(): Promise<FactoryDatabaseInstance> {
  const dbInst = await createTestDatabase();
  await migrateDb(dbInst.db);
  await resetTestDatabase(dbInst);
  return dbInst;
}
