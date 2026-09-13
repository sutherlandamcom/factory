import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import { visualBudgetReservations } from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { FACTORY_BUDGET_RESERVATION_LOCK_KEY } from "../persistence/lock.js";

/**
 * VISUAL BUDGET — durable reservation ledger for paid visual provider
 * invocations. Reuses the EXACT lifecycle mechanism of the writer budget
 * ledger (migrations 0009/0010): ceiling-check + INSERT in one transaction
 * under the shared budget advisory xact lock, ACTIVE -> ACCOUNTED |
 * RELEASED transitions, trusted-usage retention across failures, unknown
 * cost accounted at the authorized conservative amount, and overrun
 * persisted in full with a typed budget_invariant_violation. The visual
 * role has its own scoped table (migration 0017) and its own daily limit
 * env: FACTORY_VISUAL_DAILY_LIMIT_USD.
 */

/** Default daily limit when no explicit limit is configured. */
export const DEFAULT_VISUAL_DAILY_LIMIT_USD = 5;

export interface VisualBudgetReservationHandle {
  readonly id: string;
  readonly invocationDigest: string;
  account(actualTrustedMicros: number | null): Promise<void>;
  releaseUnexecuted(): Promise<void>;
}

export interface VisualBudgetReservationInput {
  provider: string;
  model: string;
  authorizedMicros: number;
  invocationDigest: string;
  lineage?: Record<string, unknown>;
}

export class VisualBudgetStore {
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

  /** Accounted visual spend today (UTC), from the durable ledger. */
  async sumTodayVisualCostMicros(): Promise<number> {
    if (!this.hasDb) {
      let accounted = 0;
      for (const row of this.inMemoryLedger.values()) {
        if (row.state === "ACCOUNTED") accounted += row.accountedMicros ?? row.authorizedMicros;
      }
      return accounted;
    }
    const rows = await this.db
      .select({
        authorizedMicros: visualBudgetReservations.authorizedMicros,
        accountedMicros: visualBudgetReservations.accountedMicros,
      })
      .from(visualBudgetReservations)
      .where(
        sql`(${visualBudgetReservations.state} = 'ACCOUNTED'
             AND ${visualBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc'))`,
      );
    let total = 0;
    for (const row of rows) total += row.accountedMicros ?? row.authorizedMicros;
    return total;
  }

  async getVisualBudgetSummary(): Promise<{ accountedTodayMicros: number; activeReservationMicros: number }> {
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
        state: visualBudgetReservations.state,
        authorizedMicros: visualBudgetReservations.authorizedMicros,
        accountedMicros: visualBudgetReservations.accountedMicros,
      })
      .from(visualBudgetReservations)
      .where(
        sql`(${visualBudgetReservations.state} = 'ACTIVE'
             OR (${visualBudgetReservations.state} = 'ACCOUNTED'
                 AND ${visualBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc')))`,
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
      UPDATE visual_budget_reservations
      SET state = 'ACCOUNTED',
          accounted_micros = authorized_micros,
          accounted_at = now()
      WHERE state = 'ACTIVE'
        AND created_at < now() - (${VisualBudgetStore.STALE_RESERVATION_MS} || ' milliseconds')::interval
    `);
  }

  /** Fail-closed invariant scan (identical semantics to the writer ledger). */
  private static assertNoBudgetInvariantViolation(
    rows: ReadonlyArray<{ state: string; authorizedMicros: number; accountedMicros: number | null }>,
  ): void {
    for (const row of rows) {
      if (row.state === "ACCOUNTED" && row.accountedMicros != null && row.accountedMicros > row.authorizedMicros) {
        throw new FactoryError(
          "budget_invariant_violation",
          `Visual budget ledger records accounted spend (${row.accountedMicros} micros) exceeding its authorized reservation (${row.authorizedMicros} micros). ` +
            "Trusted pricing no longer covers reality; paid execution fails closed until pricing is corrected.",
        );
      }
    }
  }

  /**
   * Concurrency-safe, DURABLE visual budget reservation. Hard ceiling:
   * accountedToday + activeReservations + authorizedMicros <= dailyBudget,
   * checked + inserted in ONE transaction under the shared budget advisory
   * xact lock.
   */
  async reserveVisualBudget(
    input: VisualBudgetReservationInput,
    dailyLimitUsd?: number,
  ): Promise<VisualBudgetReservationHandle> {
    const limitUsd = dailyLimitUsd ?? DEFAULT_VISUAL_DAILY_LIMIT_USD;
    return await this.withReservationLock(async () => {
      const budgetMicros = Math.round(limitUsd * 1_000_000);
      if (!this.hasDb) {
        VisualBudgetStore.assertNoBudgetInvariantViolation([...this.inMemoryLedger.values()]);
        const summary = await this.getVisualBudgetSummary();
        const persistedSpend = await this.sumTodayVisualCostMicros();
        if (
          Math.max(summary.accountedTodayMicros, persistedSpend) +
            summary.activeReservationMicros +
            input.authorizedMicros >
          budgetMicros
        ) {
          throw new FactoryError(
            "visual_budget_blocked",
            `Daily visual budget reached (${(budgetMicros / 1_000_000).toFixed(2)} USD).`,
          );
        }
        return this.makeHandle(`res-${randomUUID()}`, input);
      }
      const id = `vres-${randomUUID()}`;
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(FACTORY_BUDGET_RESERVATION_LOCK_KEY)})`);
        await this.reconcileStaleReservations(tx as unknown as FactoryDb);
        const rows = await tx
          .select({
            state: visualBudgetReservations.state,
            authorizedMicros: visualBudgetReservations.authorizedMicros,
            accountedMicros: visualBudgetReservations.accountedMicros,
          })
          .from(visualBudgetReservations)
          .where(
            sql`(${visualBudgetReservations.state} = 'ACTIVE'
                 OR (${visualBudgetReservations.state} = 'ACCOUNTED'
                     AND (${visualBudgetReservations.accountedAt} >= date_trunc('day', now() at time zone 'utc')
                          OR ${visualBudgetReservations.accountedMicros} > ${visualBudgetReservations.authorizedMicros})))`,
          );
        VisualBudgetStore.assertNoBudgetInvariantViolation(rows);
        let total = 0;
        for (const row of rows) {
          total += row.state === "ACTIVE" ? row.authorizedMicros : (row.accountedMicros ?? row.authorizedMicros);
        }
        if (total + input.authorizedMicros > budgetMicros) {
          throw new FactoryError(
            "visual_budget_blocked",
            `Daily visual budget reached (${(budgetMicros / 1_000_000).toFixed(2)} USD).`,
          );
        }
        await tx.insert(visualBudgetReservations).values({
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

  private makeHandle(id: string, input: VisualBudgetReservationInput): VisualBudgetReservationHandle {
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
              .update(visualBudgetReservations)
              .set({ state: "ACCOUNTED", accountedMicros: accounted, accountedAt: new Date() })
              .where(and(eq(visualBudgetReservations.id, id), eq(visualBudgetReservations.state, "ACTIVE")));
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
            `Trusted actual cost (${accounted} micros) exceeded the authorized reservation (${input.authorizedMicros} micros) for visual reservation ${id}. ` +
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
              .update(visualBudgetReservations)
              .set({ state: "RELEASED", accountedAt: new Date() })
              .where(and(eq(visualBudgetReservations.id, id), eq(visualBudgetReservations.state, "ACTIVE")));
          });
        } else if (inMemoryRows) {
          const row = inMemoryRows.get(id);
          if (row && row.state === "ACTIVE") row.state = "RELEASED";
        }
      },
    };
  }
}
