import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDatabase, resetTestDatabase } from "./helpers.js";
import { type FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import { CompetitorStore } from "../../src/competitors/competitor-store.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * P1-2: REAL PostgreSQL adversarial test for the durable budget reservation
 * ledger (migration 0009). Unlike the unit suites this never touches the
 * `{ } as never` in-memory seam: two independent database connection pools
 * exercise the actual table and the actual pg_advisory_xact_lock path.
 */

interface ReservationRow {
  id: string;
  state: string;
  authorized_micros: number;
  accounted_micros: number | null;
}

async function reservationRows(inst: FactoryDatabaseInstance): Promise<ReservationRow[]> {
  const result = await inst.db.execute(
    sql`SELECT id, state, authorized_micros, accounted_micros FROM competitor_budget_reservations ORDER BY created_at`,
  );
  return result.rows as unknown as ReservationRow[];
}

/** Two stores backed by two INDEPENDENT connection pools (cross-process stand-in). */
async function setupTwoPools(t: TestContext) {
  const instA = await createTestDatabase();
  t.after(() => instA.close());
  await migrateDb(instA.db);
  await resetTestDatabase(instA);
  const instB = await createTestDatabase();
  t.after(() => instB.close());
  return { instA, instB, storeA: new CompetitorStore(instA.db), storeB: new CompetitorStore(instB.db) };
}

const LIMIT_USD = 1; // 1,000,000 micros daily budget

test("PG: ACTIVE reservation persists and blocks concurrent reservation from an independent connection", async (t) => {
  const { instB, storeA, storeB } = await setupTwoPools(t);

  // A reserves near-limit budget.
  const handleA = await storeA.reserveBudget(600_000, LIMIT_USD);

  // The ACTIVE row is durably visible from the independent connection.
  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "ACTIVE");
  assert.equal(rows[0]!.authorized_micros, 600_000);

  // B's concurrent reservation must serialize on the budget advisory lock and
  // fail because A remains represented (600k + 500k > 1M budget).
  await assert.rejects(
    storeB.reserveBudget(500_000, LIMIT_USD),
    (err: unknown) => err instanceof FactoryError && err.code === "competitor_budget_blocked",
  );

  // True concurrency: two simultaneous reservations whose sum exceeds the
  // budget must serialize on the advisory lock — exactly one may win.
  await resetTestDatabase(instB);
  const outcomes = await Promise.allSettled([
    storeA.reserveBudget(600_000, LIMIT_USD),
    storeB.reserveBudget(600_000, LIMIT_USD),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one concurrent reservation may be authorized");
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]!.reason instanceof FactoryError &&
      (rejected[0]!.reason as FactoryError).code === "competitor_budget_blocked",
  );

  void handleA;
});

test("PG: ACCOUNTED transition is durable; active reservation no longer counted; accounted amount stays in budget total", async (t) => {
  const { instB, storeA, storeB } = await setupTwoPools(t);

  const handleA = await storeA.reserveBudget(700_000, LIMIT_USD);
  await handleA.account(650_000);

  // Durable state observed from the independent connection.
  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "ACCOUNTED");
  assert.equal(rows[0]!.accounted_micros, 650_000);

  // Active reservation no longer counted; accounted amount visible to the gate.
  const summary = await storeB.getBudgetSummary();
  assert.equal(summary.activeReservationMicros, 0, "accounted reservation must leave the ACTIVE sum");
  assert.equal(summary.accountedTodayMicros, 650_000);

  // Accounted spend remains in the budget total: exactly 350k of headroom left.
  const handleB = await storeB.reserveBudget(350_000, LIMIT_USD);
  await assert.rejects(
    storeA.reserveBudget(1, LIMIT_USD),
    (err: unknown) => err instanceof FactoryError && err.code === "competitor_budget_blocked",
  );
  await handleB.releaseUnexecuted();
});

test("PG: unknown actual cost accounts the authorized conservative amount", async (t) => {
  const { instB, storeA, storeB } = await setupTwoPools(t);

  const handle = await storeA.reserveBudget(300_000, LIMIT_USD);
  await handle.account(null);

  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "ACCOUNTED");
  assert.equal(rows[0]!.accounted_micros, 300_000, "unknown cost must persist the authorized amount");
  assert.equal(await storeB.sumTodayCompetitorCostMicros(), 300_000);
});

test("PG: provable unexecuted reservation releases and never counts as spend", async (t) => {
  const { instB, storeA, storeB } = await setupTwoPools(t);

  const handle = await storeA.reserveBudget(900_000, LIMIT_USD);
  await handle.releaseUnexecuted();

  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "RELEASED");
  assert.equal(rows[0]!.accounted_micros, null);

  const summary = await storeB.getBudgetSummary();
  assert.equal(summary.activeReservationMicros, 0);
  assert.equal(summary.accountedTodayMicros, 0, "released reservation must not count as spend");

  // Full budget is available again from the independent connection.
  const handleFull = await storeB.reserveBudget(1_000_000, LIMIT_USD);
  await handleFull.releaseUnexecuted();
});

test("PG: accounted overrun is durable and blocks subsequent reservations across connections", async (t) => {
  const { instB, storeA, storeB } = await setupTwoPools(t);

  const handle = await storeA.reserveBudget(100_000, LIMIT_USD);
  await assert.rejects(
    handle.account(150_000),
    (err: unknown) => err instanceof FactoryError && err.code === "budget_invariant_violation",
  );

  // The real (overrun) amount is durably accounted — never capped down.
  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "ACCOUNTED");
  assert.equal(rows[0]!.accounted_micros, 150_000);

  // The violation is visible from the independent connection and fails closed
  // even with ample budget headroom.
  await assert.rejects(
    storeB.reserveBudget(1, LIMIT_USD),
    (err: unknown) => err instanceof FactoryError && err.code === "budget_invariant_violation",
  );
});
