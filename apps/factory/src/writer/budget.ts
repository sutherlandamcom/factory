import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import { writerBudgetReservations, searchBudgetReservations } from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { FACTORY_BUDGET_RESERVATION_LOCK_KEY } from "../persistence/lock.js";

/**
 * WRITER BUDGET — durable reservation ledger for paid writer invocations.
 *
 * Reuses the EXACT lifecycle mechanism of the competitor budget ledger
 * (migration 0009 / competitor-store): ceiling-check + INSERT in one
 * transaction under the shared budget advisory xact lock, ACTIVE ->
 * ACCOUNTED | RELEASED transitions, trusted-usage retention across failures,
 * unknown cost accounted at the authorized conservative amount, and overrun
 * persisted in full with a typed budget_invariant_violation. The writer has
 * its own scoped table (migration 0010) and its own daily limit env:
 * FACTORY_WRITER_DAILY_LIMIT_USD.
 */

/** Default daily limit when no explicit limit is configured. */
export const DEFAULT_WRITER_DAILY_LIMIT_USD = 10;

/** Authoritative reservation lifecycle handle (same contract as competitors). */
export interface WriterBudgetReservationHandle {
  readonly id: string;
  readonly invocationDigest: string;
  /**
   * Durably account this invocation's spend. Unknown/untrusted cost accounts
   * at the authorized conservative amount. A trusted actual cost is accounted
   * IN FULL — never capped; an overrun persists the real amount and raises a
   * typed budget_invariant_violation after durable accounting.
   */
  account(actualTrustedMicros: number | null): Promise<void>;
  /** Release WITHOUT accounting — only for provably pre-submission failures. */
  releaseUnexecuted(): Promise<void>;
}

export interface WriterBudgetReservationInput {
  provider: string;
  model: string;
  authorizedMicros: number;
  invocationDigest: string;
  lineage?: Record<string, unknown>;
}

export class WriterBudgetStore {
  private readonly inMemoryLedger = new Map<
    string,
    { state: "ACTIVE" | "ACCOUNTED" | "RELEASED"; authorizedMicros: number; accountedMicros: number | null }
  >();
  private reservationLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: FactoryDb, private readonly table: typeof writerBudgetReservations | typeof searchBudgetReservations = writerBudgetReservations) {}

  private get hasDb(): boolean {
    return (this.db as { dialect?: unknown }).dialect !== undefined && this.db.transaction !== undefined;
  }

  private async withReservationLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.reservationLock;
    let release: (value?: unknown) => void = () => {};
    this.reservationLock = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Accounted writer spend today (UTC), from the durable ledger. */
  async sumTodayWriterCostMicros(): Promise<number> {
    if (!this.hasDb) {
      let accounted = 0;
      for (const row of this.inMemoryLedger.values()) {
        if (row.state === "ACCOUNTED") accounted += row.accountedMicros ?? row.authorizedMicros;
      }
      return accounted;
    }
    const rows = await this.db
      .select({
        authorizedMicros: this.table.authorizedMicros,
        accountedMicros: this.table.accountedMicros,
      })
      .from(this.table)
      .where(
        sql`(${this.table.state} = 'ACCOUNTED'
             AND ${this.table.accountedAt} >= date_trunc('day', now() at time zone 'utc'))`,
      );
    let total = 0;
    for (const row of rows) total += row.accountedMicros ?? row.authorizedMicros;
    return total;
  }

  async getWriterBudgetSummary(): Promise<{ accountedTodayMicros: number; activeReservationMicros: number }> {
    if (!this.hasDb) {
      let accountedToday = 0;
      let active = 0;
      for (const row of this.inMemoryLedger.values()) {
        if (row.state === "ACTIVE") active += row.authorizedMicros;
        else if (row.state === "ACCOUNTED") accountedToday += row.accountedMicros ?? row.authorizedMicros;
      }
      return { accountedTodayMicros: accountedToday, activeReservationMicros: active };
    }
    const rows = await this.db
      .select({
        state: this.table.state,
        authorizedMicros: this.table.authorizedMicros,
        accountedMicros: this.table.accountedMicros,
      })
      .from(this.table)
      .where(
        sql`(${this.table.state} = 'ACTIVE'
             OR (${this.table.state} = 'ACCOUNTED'
                 AND ${this.table.accountedAt} >= date_trunc('day', now() at time zone 'utc')))`,
      );
    let accountedToday = 0;
    let active = 0;
    for (const row of rows) {
      if (row.state === "ACTIVE") active += row.authorizedMicros;
      else if (row.state === "ACCOUNTED") accountedToday += row.accountedMicros ?? row.authorizedMicros;
    }
    return { accountedTodayMicros: accountedToday, activeReservationMicros: active };
  }

  /** Transitional Search spend predating reservations is still part of today's ceiling. */
  async unreservedSearchCost(db: FactoryDb = this.db): Promise<number> {
    if (this.table !== searchBudgetReservations || !this.hasDb) return 0;
    const result = await db.execute(sql`
      SELECT s.usage->>'costMicros' AS cost, s.provider FROM serp_snapshots s
      WHERE s.created_at >= date_trunc('day', now() at time zone 'utc')
        AND NOT EXISTS (SELECT 1 FROM search_budget_reservations r WHERE r.lineage->>'runId' = s.run_id AND r.lineage->>'stage' = 'serp')
      UNION ALL
      SELECT s.usage->>'costMicros' AS cost, s.provider FROM grounded_search_snapshots s
      WHERE s.created_at >= date_trunc('day', now() at time zone 'utc')
        AND NOT EXISTS (SELECT 1 FROM search_budget_reservations r WHERE r.lineage->>'runId' = s.run_id AND r.lineage->>'stage' = 'grounded')
    `);
    let total = 0;
    for (const row of result.rows as Array<{ cost: string | null; provider: string }>) {
      if (row.cost == null && row.provider.startsWith("fixture")) continue;
      if (row.cost == null || !Number.isFinite(Number(row.cost)) || Number(row.cost) < 0) {
        throw new FactoryError("search_provider_budget_blocked", "Today's legacy Search spend is unknown; reconcile it before paid execution.");
      }
      total += Math.round(Number(row.cost));
    }
    return total;
  }

  private static readonly STALE_RESERVATION_MS = 24 * 60 * 60 * 1000;

  private async reconcileStaleReservations(tx: FactoryDb): Promise<void> {
    await tx.execute(sql`
      UPDATE ${this.table}
      SET state = 'ACCOUNTED',
          accounted_micros = authorized_micros,
          accounted_at = now()
      WHERE state = 'ACTIVE'
        AND created_at < now() - (${WriterBudgetStore.STALE_RESERVATION_MS} || ' milliseconds')::interval
    `);
  }

  /** Fail-closed invariant scan (identical semantics to the competitor ledger). */
  private static assertNoBudgetInvariantViolation(
    rows: ReadonlyArray<{ state: string; authorizedMicros: number; accountedMicros: number | null }>,
  ): void {
    for (const row of rows) {
      if (row.state === "ACCOUNTED" && row.accountedMicros != null && row.accountedMicros > row.authorizedMicros) {
        throw new FactoryError(
          "budget_invariant_violation",
          `Writer budget ledger records accounted spend (${row.accountedMicros} micros) exceeding its authorized reservation (${row.authorizedMicros} micros). ` +
            "Trusted pricing no longer covers reality; paid execution fails closed until pricing is corrected.",
        );
      }
    }
  }

  /**
   * Concurrency-safe, DURABLE writer budget reservation. Hard ceiling:
   * accountedToday + activeReservations + authorizedMicros <= dailyBudget,
   * checked + inserted in ONE transaction under the shared budget advisory
   * xact lock.
   */
  async reserveWriterBudget(
    input: WriterBudgetReservationInput,
    dailyLimitUsd?: number,
  ): Promise<WriterBudgetReservationHandle> {
    const limitUsd = dailyLimitUsd ?? DEFAULT_WRITER_DAILY_LIMIT_USD;
    if (!Number.isFinite(limitUsd) || limitUsd < 0 || !Number.isSafeInteger(input.authorizedMicros) || input.authorizedMicros < 0) {
      throw new FactoryError("budget_invariant_violation", "Budget and reservation must be finite nonnegative amounts.");
    }
    return await this.withReservationLock(async () => {
      const budgetMicros = Math.round(limitUsd * 1_000_000);
      if (!this.hasDb) {
        WriterBudgetStore.assertNoBudgetInvariantViolation([...this.inMemoryLedger.values()]);
        const summary = await this.getWriterBudgetSummary();
        const persistedSpend = await this.sumTodayWriterCostMicros();
        if (
          Math.max(summary.accountedTodayMicros, persistedSpend) +
            summary.activeReservationMicros +
            input.authorizedMicros >
          budgetMicros
        ) {
          throw new FactoryError(
            "writer_budget_blocked",
            `Daily writer budget reached (${(budgetMicros / 1_000_000).toFixed(2)} USD).`,
          );
        }
        return this.makeHandle(`res-${randomUUID()}`, input);
      }
      const id = `wres-${randomUUID()}`;
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(FACTORY_BUDGET_RESERVATION_LOCK_KEY)})`);
        await this.reconcileStaleReservations(tx as unknown as FactoryDb);
        const rows = await tx
          .select({
            state: this.table.state,
            authorizedMicros: this.table.authorizedMicros,
            accountedMicros: this.table.accountedMicros,
          })
          .from(this.table)
          .where(
            sql`(${this.table.state} = 'ACTIVE'
                 OR (${this.table.state} = 'ACCOUNTED'
                     AND (${this.table.accountedAt} >= date_trunc('day', now() at time zone 'utc')
                          OR ${this.table.accountedMicros} > ${this.table.authorizedMicros})))`,
          );
        WriterBudgetStore.assertNoBudgetInvariantViolation(rows);
        let total = await this.unreservedSearchCost(tx as unknown as FactoryDb);
        for (const row of rows) {
          total += row.state === "ACTIVE" ? row.authorizedMicros : (row.accountedMicros ?? row.authorizedMicros);
        }
        if (total + input.authorizedMicros > budgetMicros) {
          throw new FactoryError(
            "writer_budget_blocked",
            `Daily writer budget reached (${(budgetMicros / 1_000_000).toFixed(2)} USD).`,
          );
        }
        await tx.insert(this.table).values({
          id,
          provider: input.provider,
          model: input.model,
          authorizedMicros: input.authorizedMicros,
          state: "ACTIVE",
          invocationDigest: input.invocationDigest,
          lineage: input.lineage ?? null,
        });
        return this.makeHandle(id, input);
      });
    });
  }

  private makeHandle(id: string, input: WriterBudgetReservationInput): WriterBudgetReservationHandle {
    const hasDb = this.hasDb;
    const inMemoryRows = hasDb ? null : this.inMemoryLedger;
    if (inMemoryRows) {
      inMemoryRows.set(id, { state: "ACTIVE", authorizedMicros: input.authorizedMicros, accountedMicros: null });
    }
    let settled = false;
    return {
      id,
      invocationDigest: input.invocationDigest,
      account: async (actualTrustedMicros: number | null): Promise<void> => {
        if (settled) return;
        settled = true;
        const accounted =
          actualTrustedMicros != null && Number.isFinite(actualTrustedMicros) && actualTrustedMicros >= 0
            ? Math.round(actualTrustedMicros)
            : input.authorizedMicros;
        if (hasDb) {
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(FACTORY_BUDGET_RESERVATION_LOCK_KEY)})`);
            await tx
              .update(this.table)
              .set({ state: "ACCOUNTED", accountedMicros: accounted, accountedAt: new Date() })
              .where(
                and(eq(this.table.id, id), eq(this.table.state, "ACTIVE")),
              );
          });
        } else if (inMemoryRows) {
          const row = inMemoryRows.get(id);
          if (row && row.state === "ACTIVE") {
            row.state = "ACCOUNTED";
            row.accountedMicros = accounted;
          }
        }
        if (accounted > input.authorizedMicros) {
          throw new FactoryError(
            "budget_invariant_violation",
            `Trusted actual cost (${accounted} micros) exceeded the authorized reservation (${input.authorizedMicros} micros) for writer reservation ${id}. ` +
              "The real amount is durably accounted; subsequent paid execution fails closed until trusted pricing is corrected.",
          );
        }
      },
      releaseUnexecuted: async (): Promise<void> => {
        if (settled) return;
        settled = true;
        if (hasDb) {
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(FACTORY_BUDGET_RESERVATION_LOCK_KEY)})`);
            await tx
              .update(this.table)
              .set({ state: "RELEASED", accountedAt: new Date() })
              .where(
                and(eq(this.table.id, id), eq(this.table.state, "ACTIVE")),
              );
          });
        } else if (inMemoryRows) {
          const row = inMemoryRows.get(id);
          if (row && row.state === "ACTIVE") row.state = "RELEASED";
        }
      },
    };
  }
}
