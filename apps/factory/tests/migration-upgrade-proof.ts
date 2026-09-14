/** Explicit populated-upgrade proof; run after the baseline migration seed, outside ordinary CI. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTestDatabase } from "./persistence/helpers.js";
import { migrateDb } from "../src/persistence/migrate.js";
const before = JSON.parse(await readFile(process.env.FACTORY_MIGRATION_MANIFEST ?? "/tmp/runs-migration-before.json", "utf8"));
const db = await createTestDatabase();
try {
  await migrateDb(db.db);
  const content = (await db.pool.query("SELECT * FROM accepted_page_content ORDER BY id")).rows;
  assert.deepEqual(JSON.parse(JSON.stringify(content)), before.content);
  const assignments = (await db.pool.query("SELECT * FROM asset_page_assignments ORDER BY id")).rows;
  for (const row of assignments) {
    assert.equal(row.accepted_page_content_id, null);
    assert.equal(row.accepted_page_content_version, null);
    assert.equal(row.accepted_page_content_digest, null);
    delete row.accepted_page_content_id; delete row.accepted_page_content_version; delete row.accepted_page_content_digest;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(assignments)), before.assignments);
  await migrateDb(db.db);
  console.log(JSON.stringify({ result: "PASS", preservedAcceptedRows: content.length, unqualifiedLegacyAssignments: assignments.length, migrationReplay: "PASS" }));
} finally { await db.close(); }
