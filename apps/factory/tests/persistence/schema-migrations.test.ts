import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createTestDatabase, resetTestDatabase } from "./helpers.js";
import { migrateDb } from "../../src/persistence/migrate.js";

test("schema & migrations: clean DB migration succeeds and is idempotent", async () => {
  const dbInst = await createTestDatabase();
  try {
    // 1. Clean migration
    const firstRun = await migrateDb(dbInst.db);
    assert.equal(firstRun.applied, true);

    // 2. Second migration against up-to-date database must succeed without error
    const secondRun = await migrateDb(dbInst.db);
    assert.equal(secondRun.applied, true);

    // 3. Verify all 8 tables exist
    const tablesRes = await dbInst.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const tableNames = tablesRes.rows.map((r) => r.table_name);

    const expectedTables = [
      "attempts",
      "deployments",
      "model_invocations",
      "projects",
      "quality_results",
      "runs",
      "sites",
      "tasks",
    ];

    for (const table of expectedTables) {
      assert.ok(tableNames.includes(table), `Table '${table}' must exist in public schema`);
    }

    // 4. Verify check constraints exist
    const constraintsRes = await dbInst.pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'c'
      ORDER BY conname;
    `);
    const constraintNames = constraintsRes.rows.map((r) => r.conname);

    assert.ok(
      constraintNames.includes("attempts_attempt_number_bounds"),
      "attempts_attempt_number_bounds check constraint must exist",
    );
    assert.ok(
      constraintNames.includes("attempts_duration_ms_non_negative"),
      "attempts_duration_ms_non_negative check constraint must exist",
    );
    assert.ok(
      constraintNames.includes("runs_duration_ms_non_negative"),
      "runs_duration_ms_non_negative check constraint must exist",
    );
    assert.ok(
      constraintNames.includes("model_invocations_duration_ms_non_negative"),
      "model_invocations_duration_ms_non_negative check constraint must exist",
    );
    assert.ok(
      constraintNames.includes("deployments_status_valid"),
      "deployments_status_valid check constraint must exist",
    );
  } finally {
    await dbInst.close();
  }
});
