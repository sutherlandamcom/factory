#!/usr/bin/env node
/**
 * E2E database preparation (test harness only — NOT a product action).
 *
 * Ensures the dedicated factory_test database has the current schema and is
 * empty before the operator journey. Uses the repository's own migration
 * path plus the trusted truncate helper (apps/factory/scripts/
 * truncate-test-db.ts) — never a general/dev database.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(__dirname, "../../factory");

if (!process.env.FACTORY_TEST_DATABASE_URL?.trim()) {
  console.error("[e2e-setup] FACTORY_TEST_DATABASE_URL is required (dedicated factory_test DB).");
  process.exit(1);
}
const dbName = new URL(process.env.FACTORY_TEST_DATABASE_URL).pathname.replace(/^\//, "");
if (dbName !== "factory_test") {
  console.error(`[e2e-setup] refusing: database must be "factory_test", got "${dbName}".`);
  process.exit(1);
}

function run(args) {
  const res = spawnSync(process.execPath, args, {
    cwd: FACTORY_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(`[e2e-setup] command failed: ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

const tsxCli = path.join(FACTORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

// The CLI migrate command reads FACTORY_DATABASE_URL; the E2E always targets
// the dedicated test database validated above, so point the production var
// at the validated test URL for the child process only.
process.env.FACTORY_DATABASE_URL = process.env.FACTORY_TEST_DATABASE_URL;

// 1. Migrate to the current schema (idempotent).
run([tsxCli, "src/index.ts", "db", "migrate"]);

// 2. Truncate all tables in the dedicated test database (trusted helper).
run([tsxCli, "scripts/truncate-test-db.ts"]);

console.log("[e2e-setup] ready");
