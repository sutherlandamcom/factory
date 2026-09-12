import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import { writerBudgetReservations } from "../persistence/schema.js";
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

  constructor(private readonly db: FactoryDb) {}

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
        authorizedMicros: writerBudgetReservations.authorizedMicros,
        accountedMicros: writerBudgetReservations.accountedMicros,
      })
      .from(writerBudgetReservations)
      .where(
        sql`(${writerBudgetReservations.state} = 'ACCOUNTED'
             AND ${writerBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc'))`,
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
        state: writerBudgetReservations.state,
        authorizedMicros: writerBudgetReservations.authorizedMicros,
        accountedMicros: writerBudgetReservations.accountedMicros,
      })
      .from(writerBudgetReservations)
      .where(
        sql`(${writerBudgetReservations.state} = 'ACTIVE'
             OR (${writerBudgetReservations.state} = 'ACCOUNTED'
                 AND ${writerBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc')))`,
      );
    let accountedToday = 0;
    let active = 0;
    for (const row of rows) {
      if (row.state === "ACTIVE") active += row.authorizedMicros;
      else if (row.state === "ACCOUNTED") accountedToday += row.accountedMicros ?? row.authorizedMicros;
    }
    return { accountedTodayMicros: accountedToday, activeReservationMicros: active };
  }

  private static readonly STALE_RESERVATION_MS = 24 * 60 * 60 * 1000;

  private async reconcileStaleReservations(tx: FactoryDb): Promise<void> {
    await tx.execute(sql`
      UPDATE writer_budget_reservations
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
            state: writerBudgetReservations.state,
            authorizedMicros: writerBudgetReservations.authorizedMicros,
            accountedMicros: writerBudgetReservations.accountedMicros,
          })
          .from(writerBudgetReservations)
          .where(
            sql`(${writerBudgetReservations.state} = 'ACTIVE'
                 OR (${writerBudgetReservations.state} = 'ACCOUNTED'
                     AND (${writerBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc')
                          OR ${writerBudgetReservations.accountedMicros} > ${writerBudgetReservations.authorizedMicros})))`,
          );
        WriterBudgetStore.assertNoBudgetInvariantViolation(rows);
        let total = 0;
        for (const row of rows) {
          total += row.state === "ACTIVE" ? row.authorizedMicros : (row.accountedMicros ?? row.authorizedMicros);
        }
        if (total + input.authorizedMicros > budgetMicros) {
          throw new FactoryError(
            "writer_budget_blocked",
            `Daily writer budget reached (${(budgetMicros / 1_000_000).toFixed(2)} USD).`,
          );
        }
        await tx.insert(writerBudgetReservations).values({
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
              .update(writerBudgetReservations)
              .set({ state: "ACCOUNTED", accountedMicros: accounted, accountedAt: new Date() })
              .where(
                and(eq(writerBudgetReservations.id, id), eq(writerBudgetReservations.state, "ACTIVE")),
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
              .update(writerBudgetReservations)
              .set({ state: "RELEASED", accountedAt: new Date() })
              .where(
                and(eq(writerBudgetReservations.id, id), eq(writerBudgetReservations.state, "ACTIVE")),
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
