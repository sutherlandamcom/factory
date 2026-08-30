import pg from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { resolveDatabaseConfig, type DatabaseConfig } from "./config.js";

const { Pool } = pg;

export type FactoryDb = NodePgDatabase<typeof schema>;

export interface FactoryDatabaseInstance {
  db: FactoryDb;
  pool: pg.Pool;
  close: () => Promise<void>;
}

let defaultInstance: FactoryDatabaseInstance | null = null;

export function createDatabaseInstance(config?: DatabaseConfig | string): FactoryDatabaseInstance {
  const connectionString =
    typeof config === "string"
      ? config
      : config?.connectionString ?? resolveDatabaseConfig().connectionString;

  const pool = new Pool({
    connectionString,
    application_name: "factory-control-plane",
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export function getDefaultDb(config?: DatabaseConfig): FactoryDatabaseInstance {
  if (!defaultInstance) {
    defaultInstance = createDatabaseInstance(config);
  }
  return defaultInstance;
}

export async function closeDefaultDb(): Promise<void> {
  if (defaultInstance) {
    const inst = defaultInstance;
    defaultInstance = null;
    await inst.close();
  }
}
