import assert from "node:assert/strict";
import test from "node:test";
import { sql, eq, and } from "drizzle-orm";
import { setupMigratedTestDatabase } from "./helpers.js";
import { WriterStore } from "../../src/writer/writer-store.js";
import { PageArchetypeStore } from "../../src/page-authority/store.js";
import { pageArchetypeAuthorities, contentBriefs } from "../../src/persistence/schema.js";
import { seedProjectWithAcceptedInputs, samplePageTarget } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

/**
 * Transactional authority-integrity tests for WriterStore.saveBriefDraft().
 *
 * Invariant under test: a FAILED governed planning operation leaves ZERO
 * durable PageArchetypeAuthority mutation (no new row, no version bump) and no
 * ContentBrief mutation; a SUCCESSFUL operation commits the intended authority
 * state and the brief state atomically in ONE transaction.
 */

async function authorityRows(dbInst: FactoryDatabaseInstance, projectId: string) {
  return dbInst.db
    .select()
    .from(pageArchetypeAuthorities)
    .where(eq(pageArchetypeAuthorities.projectId, projectId))
    .orderBy(pageArchetypeAuthorities.version);
}

async function briefRows(dbInst: FactoryDatabaseInstance, projectId: string) {
  return dbInst.db.select().from(contentBriefs).where(eq(contentBriefs.projectId, projectId));
}

async function approvePolicy(store: WriterStore, projectId: string): Promise<void> {
  const draft = await store.deriveWriterPolicyDraft({ projectId });
  await store.approveWriterPolicy({
    projectId,
    policyId: draft.id,
    expectedVersion: draft.version,
    expectedDigest: draft.policyDigest,
  });
}

/** Drops the accepted gap snapshots of a project (missing-lineage path). */

test("PG brief-atomicity T1: no approved WriterPolicy -> FAIL, zero authority mutation, no brief", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat1");
    // No approved WriterPolicy; no designBinding -> governed homepage fallback would apply.
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: { ...homeTarget, slug: "home" },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "writer_policy_not_approved"),
    );
    assert.equal((await authorityRows(dbInst, seed.projectId)).length, 0, "failed planning must not create authority");
    assert.equal(await pageArchetypeStore.getAuthority(seed.projectId, "home"), null);
    assert.equal((await briefRows(dbInst, seed.projectId)).length, 0, "failed planning must not create brief");
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T2: missing required gap lineage -> FAIL, zero authority mutation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat2");
    await approvePolicy(store, seed.projectId);
    // Remove accepted gap snapshot -> default path requires lineage.
    await dbInst.db.execute(sql`DELETE FROM accepted_content_gap_snapshots WHERE project_id = ${seed.projectId}`);
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: { ...homeTarget, slug: "home" },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "content_gap_lineage_missing"),
    );
    assert.equal((await authorityRows(dbInst, seed.projectId)).length, 0, "failed planning must not create authority");
    assert.equal(await pageArchetypeStore.getAuthority(seed.projectId, "home"), null);
    assert.equal((await briefRows(dbInst, seed.projectId)).length, 0);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T3: explicit non-home binding + later failure -> authority NOT created", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat3");
    await approvePolicy(store, seed.projectId);
    await dbInst.db.execute(sql`DELETE FROM accepted_content_gap_snapshots WHERE project_id = ${seed.projectId}`);
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: {
          ...samplePageTarget,
          slug: "offer-x92",
          designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "service" as const },
        },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "content_gap_lineage_missing"),
    );
    assert.equal(await pageArchetypeStore.getAuthority(seed.projectId, "offer-x92"), null, "non-home explicit binding failure must not create authority");
    assert.equal((await authorityRows(dbInst, seed.projectId)).length, 0);
    assert.equal((await briefRows(dbInst, seed.projectId)).length, 0);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T4: existing authority must not version-bump on failed conflicting attempt", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat4");
    // Standalone explicit planning: offer-x92 = service v1.
    await pageArchetypeStore.setPageArchetype({
      projectId: seed.projectId,
      pageIdentity: "offer-x92",
      archetype: "service",
    });
    await approvePolicy(store, seed.projectId);
    await dbInst.db.execute(sql`DELETE FROM accepted_content_gap_snapshots WHERE project_id = ${seed.projectId}`);

    // Conflicting explicit binding fails and must NOT create a v2 row.
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: {
          ...samplePageTarget,
          slug: "offer-x92",
          designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "editorial" as const },
        },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "page_archetype_conflict"),
    );
    const rows = await authorityRows(dbInst, seed.projectId);
    assert.equal(rows.length, 1, "failed conflicting attempt must not add authority rows");
    assert.equal(rows[0]!.archetype, "service");
    assert.equal(rows[0]!.version, 1);

    // Also: a non-conflicting attempt that fails LATER (gap lineage) must not bump.
    const { designBinding: _compatible, ...noBinding } = samplePageTarget;
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: { ...noBinding, slug: "offer-x92" },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "content_gap_lineage_missing"),
    );
    const rowsAfter = await authorityRows(dbInst, seed.projectId);
    assert.equal(rowsAfter.length, 1);
    assert.equal(rowsAfter[0]!.version, 1, "failed later-validation attempt must not bump authority version");
    assert.equal(rowsAfter[0]!.id, rows[0]!.id);
    assert.equal(rowsAfter[0]!.authorityDigest, rows[0]!.authorityDigest);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T5: successful atomic creation + idempotent repeat without authority bump", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat5");
    await approvePolicy(store, seed.projectId);
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;

    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...homeTarget, slug: "home" },
      contentBriefKeyPoints: ["Primary offer"],
    });
    const briefs = await briefRows(dbInst, seed.projectId);
    assert.equal(briefs.length, 1, "successful planning persists the brief");
    const authorities = await authorityRows(dbInst, seed.projectId);
    assert.equal(authorities.length, 1, "exactly one intended authority row");
    assert.equal(authorities[0]!.pageIdentity, "home");
    assert.equal(authorities[0]!.archetype, "homepage");
    assert.equal(authorities[0]!.version, 1);
    assert.equal(saved.version, 1);

    // Idempotent compatible repeat: existing draft updated in place; authority
    // must NOT receive a fake version bump.
    const saved2 = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...homeTarget, slug: "home" },
      contentBriefKeyPoints: ["Primary offer", "Secondary point"],
      expectedRevision: saved.version,
    });
    assert.equal(saved2.version, saved.version, "existing draft updates in place");
    const authoritiesAfter = await authorityRows(dbInst, seed.projectId);
    assert.equal(authoritiesAfter.length, 1, "idempotent repeat must not add authority rows");
    assert.equal(authoritiesAfter[0]!.version, 1, "idempotent repeat must not bump authority version");
    assert.equal(authoritiesAfter[0]!.id, authorities[0]!.id);
    assert.equal(authoritiesAfter[0]!.authorityDigest, authorities[0]!.authorityDigest);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T6: real rollback after authority write point (brief persistence failure)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  const triggerName = "bat6_block_brief_insert";
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat6");
    await approvePolicy(store, seed.projectId);
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;

    // Test-only deterministic failure AFTER the authority write point: a
    // project-scoped PostgreSQL trigger raises on the brief INSERT inside the
    // same transaction. This is a test-side DB mechanism, not a production seam.
    // CREATE TRIGGER cannot use bind parameters, so the generated test project
    // id is embedded literally.
    await dbInst.db.execute(sql`
      CREATE OR REPLACE FUNCTION ${sql.raw(triggerName)}_fn() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'bat6 test-only brief insert block';
      END;
      $$ LANGUAGE plpgsql
    `);
    await dbInst.db.execute(
      sql.raw(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON content_briefs FOR EACH ROW WHEN (NEW.project_id = '${seed.projectId}') EXECUTE FUNCTION ${triggerName}_fn()`,
      ),
    );

    try {
      await assert.rejects(
        store.saveBriefDraft({
          projectId: seed.projectId,
          pageTarget: { ...homeTarget, slug: "home" },
          contentBriefKeyPoints: [],
        }),
        (err: unknown) => {
          // Drizzle wraps driver errors in DrizzleQueryError ("Failed query: ...")
          // with the original pg error on .cause — walk the chain to confirm the
          // failure is the injected trigger, not an unrelated validation.
          let e: unknown = err;
          for (let depth = 0; e instanceof Error && depth < 5; depth += 1) {
            if (e.message.includes("bat6 test-only brief insert block")) return true;
            e = (e as Error & { cause?: unknown }).cause;
          }
          return false;
        },
      );
      // The whole transaction must roll back: authority write attempted inside
      // the tx is gone, brief insert is gone.
      assert.equal((await authorityRows(dbInst, seed.projectId)).length, 0, "rollback must remove the in-transaction authority write");
      assert.equal(await pageArchetypeStore.getAuthority(seed.projectId, "home"), null);
      assert.equal((await briefRows(dbInst, seed.projectId)).length, 0, "rollback must remove the failed brief insert");
    } finally {
      await dbInst.db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(triggerName)} ON content_briefs`);
      await dbInst.db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(triggerName)}_fn()`);
    }

    // After removing the test-only trigger, the same operation succeeds
    // atomically — proving the failure was the injected condition, not the plan.
    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...homeTarget, slug: "home" },
      contentBriefKeyPoints: [],
    });
    assert.equal(saved.version, 1);
    const authorities = await authorityRows(dbInst, seed.projectId);
    assert.equal(authorities.length, 1);
    assert.equal(authorities[0]!.archetype, "homepage");
    assert.equal(authorities[0]!.version, 1);
    assert.equal((await briefRows(dbInst, seed.projectId)).length, 1);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T7: concurrent planning serializes; loser fails closed with no authority duplication", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat7");
    await approvePolicy(store, seed.projectId);
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;
    const input = {
      projectId: seed.projectId,
      pageTarget: { ...homeTarget, slug: "home" },
      contentBriefKeyPoints: ["Concurrent"],
    };
    // Both operations target the same project advisory lock (104); the second
    // serializes behind the first and observes the committed draft state. With
    // no expectedRevision supplied, the second must FAIL CLOSED (typed revision
    // conflict) rather than blindly overwrite — and must not duplicate or bump
    // authority.
    const results = await Promise.allSettled([store.saveBriefDraft(input), store.saveBriefDraft(input)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent draft creation succeeds");
    assert.equal(rejected.length, 1, "the serialized loser fails closed");
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(isCode(reason, "writer_approval_failed"), `loser fails with typed revision conflict, got: ${String(reason)}`);

    const authorities = await authorityRows(dbInst, seed.projectId);
    assert.equal(authorities.length, 1, "concurrent planning must not create duplicate authority rows");
    assert.equal(authorities[0]!.version, 1);
    assert.equal(authorities[0]!.archetype, "homepage");
    const briefs = await briefRows(dbInst, seed.projectId);
    assert.equal(briefs.length, 1, "no torn brief state: exactly one draft row");
    assert.equal(briefs[0]!.version, 1);
  } finally {
    await dbInst.close();
  }
});

test("PG brief-atomicity T8: brief persistence failure implies no authority (reverse direction of T6 via staleness)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const pageArchetypeStore = new PageArchetypeStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "bat8");
    await approvePolicy(store, seed.projectId);
    // Stale gap: accepted gap bound to an older input snapshot. This fails
    // AFTER authority intent is determined but BEFORE any durable write.
    const { ProjectIntakeStore } = await import("../../src/operator/intake-store.js");
    const { buildIntakePayload } = await import("../fixtures/intake-payloads.js");
    const { deterministicDigest } = await import("../../src/intelligence/digest.js");
    const intake = new ProjectIntakeStore(dbInst.db);
    const pay2 = buildIntakePayload({ business: { name: "Summit Roofing", description: "Updated description." } });
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: 1, payload: pay2 });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: 2,
      expectedDigest: deterministicDigest(pay2),
    });
    const { designBinding: _omitted, ...homeTarget } = samplePageTarget;
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: { ...homeTarget, slug: "home" },
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "writer_artifact_stale"),
    );
    assert.equal((await authorityRows(dbInst, seed.projectId)).length, 0, "stale-gap failure must not create authority");
    assert.equal((await briefRows(dbInst, seed.projectId)).length, 0);
  } finally {
    await dbInst.close();
  }
});
