import { FactoryError } from "../executor/errors.js";

/**
 * Redacts passwords and sensitive userinfo from database connection URLs or error messages.
 */
export function sanitizeDatabaseUrl(urlOrError: string): string {
  if (!urlOrError) return "";
  // Match postgresql:// or postgres:// with user:password@
  return urlOrError.replace(
    /((?:postgres|postgresql):\/\/[^:]+:)([^@]+)(@)/gi,
    "$1***$3",
  );
}

export interface DatabaseConfig {
  connectionString: string;
  isTest: boolean;
}

export interface ResolveDatabaseConfigOptions {
  test?: boolean;
  url?: string;
  requireConfigured?: boolean;
}

/**
 * Resolves and validates the Factory database connection string.
 * Uses FACTORY_TEST_DATABASE_URL when test is true, otherwise FACTORY_DATABASE_URL.
 */
export function resolveDatabaseConfig(
  opts: ResolveDatabaseConfigOptions = {},
): DatabaseConfig {
  const isTest = Boolean(opts.test);
  const rawUrl =
    opts.url ??
    (isTest
      ? process.env.FACTORY_TEST_DATABASE_URL
      : process.env.FACTORY_DATABASE_URL);

  if (!rawUrl || rawUrl.trim() === "") {
    const varName = isTest ? "FACTORY_TEST_DATABASE_URL" : "FACTORY_DATABASE_URL";
    if (opts.requireConfigured ?? true) {
      throw new FactoryError(
        "persistence_unavailable",
        `${varName} is not set. Persistent control-plane execution requires a valid PostgreSQL database URL.`,
      );
    }
  }

  const urlToParse = (rawUrl ?? "").trim();
  try {
    const parsed = new URL(urlToParse);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error(`Invalid protocol '${parsed.protocol}'. Expected 'postgres:' or 'postgresql:'.`);
    }
    return {
      connectionString: urlToParse,
      isTest,
    };
  } catch (err) {
    const safeMsg = sanitizeDatabaseUrl(err instanceof Error ? err.message : String(err));
    throw new FactoryError(
      "database_configuration_invalid",
      `Invalid database connection URL: ${safeMsg}`,
    );
  }
}
