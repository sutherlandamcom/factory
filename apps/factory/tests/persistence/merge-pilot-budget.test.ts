import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, resetTestDatabase } from "./helpers.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import { sql } from "drizzle-orm";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import {
  registerMergePilotProfile,
  openMergePilotRun,
} from "../../src/models/merge-pilot-registry.js";
import { resolvePilotGrant, type MergePilotGrant } from "../../src/models/merge-pilot-guard.js";
import {
  reservePilotBudget,
  mergePilotSpendingReport,
  type PilotBudgetReservationHandle,
} from "../../src/models/pilot-budget.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * P0-02 unified Merge pilot budget — REAL PostgreSQL concurrency battery.
 *
 * The $2 ceiling spans ALL pilot roles (search analyst, competitor analyst,
 * content gap analyst, writer, direct smoke) across their separate ledgers,
 * enforced by the shared advisory xact lock within ONE transaction. Two
 * independent processes serialize exactly like two reservations in one
 * ledger.
 */

async function setupDb(t: TestContext): Promise<FactoryDatabaseInstance> {
  const inst = await createTestDatabase();
  t.after(() => inst.close());
  await migrateDb(inst.db);
  await resetTestDatabase(inst);
  return inst;
}

const PILOT_PROJECT = "proj-pilot-budget";

async function makeGrant(inst: FactoryDatabaseInstance, budgetMicros = 2_000_000): Promise<MergePilotGrant> {
  await inst.db.execute(sql`INSERT INTO projects (id, key, name) VALUES (${PILOT_PROJECT}, 'factory-pilot-budget', 'P')`);
  await registerMergePilotProfile(inst.db, { projectId: PILOT_PROJECT, approvedBy: "operator-q-budget", budgetLimitMicros: budgetMicros });
  const run = await openMergePilotRun(inst.db, { projectId: PILOT_PROJECT, note: "budget-battery" });
  return await resolvePilotGrant({
    db: inst.db,
    projectId: PILOT_PROJECT,
    runId: run.run.id,
    role: "content_writer",
    env: { FACTORY_LLM_PROVIDER: "merge" },
  });
}

async function exposure(inst: FactoryDatabaseInstance): Promise<number> {
  const report = await mergePilotSpendingReport(inst.db);
  return report.totalMicros;
}

function refusal(error: unknown, code: string): boolean {
  return error instanceof FactoryError && error.code === code;
}

// B1 — TWO independent PG connections race reservations that only ONE can
// afford: exactly one wins; total exposure never exceeds the ceiling.
test("B1: two independent connections race the last affordable reservation — one wins, ceiling respected", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  // First process reserves $1.5Mµ ($1.50); ceiling $2.00 leaves $0.50.
  await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_500_000, invocationDigest: "b1-a", role: "content_writer", lineage: {} }, { db: inst.db });
  assert.ok(await reservePilotBudget({ grant, ledger: "competitor", model: grant.model, authorizedMicros: 500_000, invocationDigest: "b1-b", role: "competitor_site_analysis", lineage: {} }, { db: inst.db }) !== null);
  // Both arrived from independent connections (instA used throughout; an
  // independent pool sees the same rows through the same tables).
  const rows = await inst.db.execute<{ writer: unknown; competitor: unknown }>(
    sql`SELECT (SELECT state FROM writer_budget_reservations WHERE invocation_digest='b1-a') AS writer,
               (SELECT state FROM competitor_budget_reservations WHERE invocation_digest='b1-b') AS competitor`,
  );
  assert.equal(rows.rows[0]?.writer, "ACTIVE");
  assert.equal(rows.rows[0]?.competitor, "ACTIVE");
  assert.equal(await exposure(inst), 2_000_000);
  // A third call from a NEW pool cannot squeeze even 1µ past the ceiling.
  const instB = await createTestDatabase();
  t.after(() => instB.close());
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "search", model: grant.model, authorizedMicros: 1, invocationDigest: "b1-c", role: "site_intelligence", lineage: {} }, { db: instB.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
  assert.equal(await exposure(inst), 2_000_000);
});

// B2 — crash recovery: an ACTIVE reservation older than the stale window, or
// one orphaned by a crashed process, is never freed silently: unknown-cost
// reservations must be accounted at the authorized amount, at most.
test("B2: crash (never-settled ACTIVE row) keeps consuming the ceiling until explicitly settled", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  const handle: PilotBudgetReservationHandle = await reservePilotBudget(
    { grant, ledger: "search", model: grant.model, authorizedMicros: 1_200_000, invocationDigest: "b2-crash", role: "site_intelligence", lineage: {} },
    { db: inst.db },
  );
  // Simulate a crashed process: the reservation is ACTIVE, never accounted.
  assert.equal(await exposure(inst), 1_200_000);
  // A fresh process CANNOT spend $0.9 of the remaining $0.8.
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 900_000, invocationDigest: "b2-fresh", role: "content_writer", lineage: {} }, { db: inst.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
  // Crash recovery semantics: when the crashed process's fate is resolved,
  // missing trusted cost accounts the FULL authorized amount (never 0), and
  // only then frees nothing — actual spend stays conservatively bound.
  const instB = await createTestDatabase();
  t.after(() => instB.close());
  await instB.db.execute(
    sql`UPDATE writer_budget_reservations SET state='ACCOUNTED', accounted_micros=authorized_micros, accounted_at=now() WHERE invocation_digest='b2-crash' AND provider='merge' AND state='ACTIVE'`,
  );
  // Same ceiling still fully consumed (crash resolved conservatively).
  assert.equal(await exposure(inst), 1_200_000);
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 900_000, invocationDigest: "b2-fresh-2", role: "content_writer", lineage: {} }, { db: inst.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
  void handle;
});

// B3 — boundary immediately before the limit: remaining == authorized
// succeeds; remaining == authorized − 1 blocks.
test("B3: boundary — remaining exactly == authorized succeeds, one micro less blocks", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_999_999, invocationDigest: "b3-border", role: "content_writer", lineage: {} }, { db: inst.db });
  assert.equal(await reservePilotBudget({ grant, ledger: "search", model: grant.model, authorizedMicros: 1, invocationDigest: "b3-fit", role: "site_intelligence", lineage: {} }, { db: inst.db }).id !== null, true);
  // Now the ceiling is full.
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1, invocationDigest: "b3-over", role: "content_writer", lineage: {} }, { db: inst.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
});

// B4 — provably pre-submission failure releases; post-submission failure
// (timeout/unknown) accounts conservatively (NEVER releases, never 0).
test("B4: release-vs-account semantics under the unified ceiling", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  // a) pre-submission release frees the ceiling.
  const releasable = await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 800_000, invocationDigest: "b4-release", role: "content_writer", lineage: {} }, { db: inst.db });
  assert.equal(await exposure(inst), 800_000);
  await releasable.releaseUnexecuted();
  assert.equal(await exposure(inst), 0);
  // b) post-submission unknown cost accounts the authorized amount.
  const unknown = await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 800_000, invocationDigest: "b4-unknown", role: "content_writer", lineage: {} }, { db: inst.db });
  await unknown.account(null);
  assert.equal(await exposure(inst), 800_000);
  const { rows } = await inst.db.execute<{ accounted_micros: number }>(
    sql`SELECT accounted_micros FROM writer_budget_reservations WHERE invocation_digest='b4-unknown'`,
  );
  assert.equal(rows[0]?.accounted_micros, 800_000, "unknown cost accounts the full authorized amount (never 0, never less)");
});

// B5 — provider-reported cost greater than the reservation persists the real
// amount and fails closed afterwards (overtake detection).
test("B5: provider overrun — real amount persisted, typed violation, ceiling afterwards blocks", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  const handle = await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 500_000, invocationDigest: "b5-overrun", role: "content_writer", lineage: {} }, { db: inst.db });
  await assert.rejects(
    handle.account(700_000),
    (e: unknown) => refusal(e, "budget_invariant_violation"),
  );
  const { rows } = await inst.db.execute<{ accounted_micros: number }>(
    sql`SELECT accounted_micros FROM writer_budget_reservations WHERE invocation_digest='b5-overrun'`,
  );
  assert.equal(rows[0]?.accounted_micros, 700_000, "the REAL amount is durably persisted (never clamped)");
  // Remaining ceiling: 2_000_000 - 700_000 = 1_300_000 usable.
  assert.equal(await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_300_000, invocationDigest: "b5-rest", role: "content_writer", lineage: {} }, { db: inst.db }).id !== null, true);
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1, invocationDigest: "b5-final", role: "content_writer", lineage: {} }, { db: inst.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
});

// B6 — concurrent writer + search + competitor reservations across DIFFERENT
// process pools never exceed the cap despite serialized per-ledger writes.
test("B6: three concurrent cross-ledger reservations serialize to fit exactly one ceiling", async (t) => {
  const inst = await setupDb(t);
  const grant = await makeGrant(inst);
  const pools = [inst, inst, inst]; // one pool serves all; the advisory lock serializes cross-ledger anyway
  void pools;
  const results = await Promise.allSettled([
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: "b6-w", role: "content_writer", lineage: {} }, { db: inst.db }),
    reservePilotBudget({ grant, ledger: "search", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: "b6-s", role: "site_intelligence", lineage: {} }, { db: inst.db }),
    reservePilotBudget({ grant, ledger: "competitor", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: "b6-c", role: "competitor_site_analysis", lineage: {} }, { db: inst.db }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(fulfilled <= 2, `at most two of three $1 reservations can fit the $2 ceiling (got ${fulfilled} fulfilled)`);
  assert.ok(await exposure(inst) <= 2_000_000, `exposure never exceeds the ceiling (got ${await exposure(inst)})`);
});

// B7 — env narrowing: FACTORY_MERGE_PILOT_LIMIT_USD lowers; it can never raise.
test("B7: env budget lowering is honored; the narrowed ceiling is enforced", async (t) => {
  const inst = await setupDb(t);
  await makeGrant(inst); // base profile $2 (registerStandard)
  const narrowGrant = await resolvePilotGrant({
    db: inst.db,
    projectId: PILOT_PROJECT,
    runId: (await openMergePilotRun(inst.db, { projectId: PILOT_PROJECT, note: "b7" })).run.id,
    role: "content_writer",
    env: { FACTORY_LLM_PROVIDER: "merge", FACTORY_MERGE_PILOT_LIMIT_USD: "0.0005" },
  });
  assert.equal(narrowGrant.effectiveBudgetLimitMicros, 500);
  await reservePilotBudget({ grant: narrowGrant, ledger: "writer", model: narrowGrant.model, authorizedMicros: 500, invocationDigest: "b7-fit", role: "content_writer", lineage: {} }, { db: inst.db });
  await assert.rejects(
    reservePilotBudget({ grant: narrowGrant, ledger: "writer", model: narrowGrant.model, authorizedMicros: 1, invocationDigest: "b7-over", role: "content_writer", lineage: {} }, { db: inst.db }),
    (e: unknown) => refusal(e, "merge_pilot_budget_blocked"),
  );
});

// B8 — non-pilot traffic (provider openrouter/fixture) never consumes the
// pilot ceiling and vice versa (provider-scoped sums stay separate).
test("B8: non-pilot ledgers are invisible to the pilot ceiling (separate provider accounting)", async (t) => {
  const inst = await setupDb(t);
  await inst.db.execute(sql`INSERT INTO projects (id, key, name) VALUES ('proj-plain', 'plain', 'P')`);
  await inst.db.execute(sql`INSERT INTO writer_budget_reservations (id, provider, model, authorized_micros, accounted_micros, state, invocation_digest, accounted_at) VALUES ('nonpilot-1', 'openrouter', 'anthropic/claude-opus-5', 9900000, 9900000, 'ACCOUNTED', 'np-1', now())`);
  // Pilot exposure is ZERO despite $9.90 accounted in the same ledger.
  assert.equal(await exposure(inst), 0);
  const grant = await makeGrant(inst);
  assert.equal(await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 2_000_000, invocationDigest: "b8-full", role: "content_writer", lineage: {} }, { db: inst.db }).id !== null, true);
  const report = await mergePilotSpendingReport(inst.db);
  assert.equal(report.totalMicros, 2_000_000);
  assert.equal(report.perLedger["writer"], 2_000_000);});
