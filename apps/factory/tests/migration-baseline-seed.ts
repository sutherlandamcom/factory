import { createTestDatabase } from "./persistence/helpers.js";
import { seedProjectWithAcceptedInputs } from "./fixtures/writer-seeds.js";
import { acceptFixturePage } from "./fixtures/accepted-page.js";
import { writeFile } from "node:fs/promises";
const db = await createTestDatabase();
try {
  const seed = await seedProjectWithAcceptedInputs(db, "upgrade-preserved-content");
  await acceptFixturePage(db, seed.projectId, "home");
  const content = (await db.pool.query("SELECT * FROM accepted_page_content ORDER BY id")).rows;
  const assignments = (await db.pool.query("SELECT * FROM asset_page_assignments ORDER BY id")).rows;
  await writeFile(process.env.FACTORY_MIGRATION_MANIFEST ?? "/tmp/runs-migration-before.json", JSON.stringify({content, assignments}));
  console.log(JSON.stringify({acceptedContentRows:content.length, legacyAssignmentRows:assignments.length}));
} finally { await db.close(); }
