import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FactoryDb } from "./db.js";
import { FactoryError } from "../executor/errors.js";
import { sanitizeDatabaseUrl } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrateOptions {
  migrationsFolder?: string;
}

/**
 * Runs versioned Drizzle Kit migrations against the provided Factory database.
 * Safe to run repeatedly against an up-to-date database.
 */
export async function migrateDb(
  db: FactoryDb,
  opts: MigrateOptions = {},
): Promise<{ applied: boolean; migrationsFolder: string }> {
  // Default migrations folder: apps/factory/drizzle
  const migrationsFolder =
    opts.migrationsFolder ?? path.resolve(__dirname, "../../drizzle");

  try {
    await migrate(db, { migrationsFolder });
    return { applied: true, migrationsFolder };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = sanitizeDatabaseUrl(rawMsg);
    throw new FactoryError(
      "migration_failed",
      `Failed to apply database migrations from ${migrationsFolder}: ${safeMsg}`,
    );
  }
}
