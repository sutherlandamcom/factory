import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDatabase, resetTestDatabase } from "./helpers.js";
import { type FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { FACTORY_BUDGET_RESERVATION_LOCK_KEY } from "../../src/persistence/lock.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * REAL PostgreSQL adversarial test for the writer budget reservation ledger
 * (migration 0010). Mirrors the competitor ledger proof: two independent
 * connection pools exercise the actual table and the actual
 * pg_advisory_xact_lock path — never the in-memory seam.
 */

interface ReservationRow {
  id: string;
  state: string;
  authorized_micros: number;
  accounted_micros: number | null;
}

async function reservationRows(inst: FactoryDatabaseInstance): Promise<ReservationRow[]> {
  const result = await inst.db.execute(
    sql`SELECT id, state, authorized_micros, accounted_micros FROM writer_budget_reservations ORDER BY created_at`,
  );
  return result.rows as unknown as ReservationRow[];
}

async function setupTwoPools(t: TestContext) {
  const instA = await createTestDatabase();
  t.after(() => instA.close());
  await migrateDb(instA.db);
  await resetTestDatabase(instA);
  const instB = await createTestDatabase();
  t.after(() => instB.close());
  return { instA, instB, storeA: new WriterBudgetStore(instA.db), storeB: new WriterBudgetStore(instB.db) };
}

const LIMIT_USD = 1; // 1,000,000 micros daily budget

test("PG: writer ACTIVE reservation persists and blocks a concurrent reservation from an independent connection", async (t) => {
  const { instA, instB, storeA, storeB } = await setupTwoPools(t);

  const handleA = await storeA.reserveWriterBudget(
    {
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      authorizedMicros: 600_000,
      invocationDigest: "digest-a",
      lineage: { kind: "writer_proposal", projectId: "p1" },
    },
    LIMIT_USD,
  );

  // The ACTIVE row is durably visible from the independent connection.
  const rows = await reservationRows(instB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "ACTIVE");
  assert.equal(rows[0]!.authorized_micros, 600_000);

  // Force overlap: a separate physical connection holds the budget lock while
  // B enters the production reserve path — B must actually WAIT on the lock.
  const lockHolder = await instA.pool.connect();
  await lockHolder.query("BEGIN");
  await lockHolder.query("SELECT pg_advisory_xact_lock($1::bigint)", [FACTORY_BUDGET_RESERVATION_LOCK_KEY]);
  let completed = false;
  const pendingB = storeB
    .reserveWriterBudget(
      {
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        authorizedMicros: 500_000,
        invocationDigest: "digest-b",
      },
      LIMIT_USD,
    )
    .then(
      () => { completed = true; return null; },
      (error: unknown) => { completed = true; return error; },
    );
  try {
    let waiting = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const locks = await lockHolder.query(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1::oid AND NOT granted",
        [FACTORY_BUDGET_RESERVATION_LOCK_KEY],
      );
      if (locks.rows.length > 0) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "B must actually wait on the budget advisory lock");
    assert.equal(completed, false, "B must not complete while the lock is held");

    await lockHolder.query("COMMIT");
    const outcome = (await pendingB) as unknown;
    // 600k accounted-pending + 500k new > 1M ceiling -> blocked, fail closed.
    assert.ok(outcome instanceof FactoryError);
    assert.equal((outcome as FactoryError).code, "writer_budget_blocked");
  } finally {
    if (completed === false) {
      await lockHolder.query("COMMIT").catch(() => undefined);
      await pendingB.catch(() => undefined);
    }
    lockHolder.release();
  }

  await handleA.account(null); // unknown cost -> conservative accounting of 600k
  assert.equal(await storeA.sumTodayWriterCostMicros(), 600_000);
});

test("PG: accounting and release are durable across an independent connection; restart-safe", async (t) => {
  const { instA, instB, storeA, storeB } = await setupTwoPools(t);

  const handle = await storeA.reserveWriterBudget(
    {
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      authorizedMicros: 400_000,
      invocationDigest: "digest-c",
    },
    LIMIT_USD,
  );
  await handle.account(250_000); // trusted actual cost

  // Durable from the other pool.
  const rowsAfterAccount = await reservationRows(instB);
  assert.equal(rowsAfterAccount[0]!.state, "ACCOUNTED");
  assert.equal(rowsAfterAccount[0]!.accounted_micros, 250_000);
  assert.equal(await storeB.sumTodayWriterCostMicros(), 250_000);

  // Released reservation persists as RELEASED with no accounted amount.
  const handle2 = await storeA.reserveWriterBudget(
    {
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      authorizedMicros: 100_000,
      invocationDigest: "digest-d",
    },
    LIMIT_USD,
  );
  await handle2.releaseUnexecuted();
  const rows = await reservationRows(instB);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.state, "RELEASED");
  assert.equal(rows[1]!.accounted_micros, null);

  // Budget invariant violation is durable: accounted > authorized blocks ALL
  // new reservations from either store.
  const handle3 = await storeA.reserveWriterBudget(
    {
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      authorizedMicros: 100_000,
      invocationDigest: "digest-e",
    },
    LIMIT_USD,
  );
  await assert.rejects(handle3.account(200_000), (err: unknown) => {
    assert.ok(err instanceof FactoryError);
    assert.equal((err as FactoryError).code, "budget_invariant_violation");
    return true;
  });
  await assert.rejects(
    storeB.reserveWriterBudget(
      {
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        authorizedMicros: 1,
        invocationDigest: "digest-f",
      },
      LIMIT_USD,
    ),
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.equal((err as FactoryError).code, "budget_invariant_violation");
      return true;
    },
  );
});
