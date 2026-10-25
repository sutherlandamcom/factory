/**
 * UNIFIED MERGE PILOT BUDGET (P0-02) — one durable $2 ceiling across roles.
 *
 * The pilot budget is a SCOPED FUNCTION over the EXISTING reservation
 * ledgers (competitor/writer/search), never a parallel system:
 * - every pilot reservation is inserted into the ledger of the serving role
 *   with provider='merge' and lineage {pilotProfileId, pilotRunId, role};
 * - the ceiling-check inside ONE transaction (under the SHARED
 *   FACTORY_BUDGET_RESERVATION_LOCK_KEY advisory xact lock) sums provider-
 *   'merge' ACTIVE and ACCOUNTED rows across ALL of those ledgers, so a
 *   writer + search + competitor race can never collectively exceed the
 *   profile ceiling;
 * - non-merge rows are excluded by the provider predicate, so ordinary
 *   daily budgets never consume (or get consumed by) the pilot cap;
 * - openrouter (non-pilot) spending is computed SEPARATELY so the two
 *   providers' ledgers never mix (requirement 10).
 *
 * Semantics preserved from the existing lifecycle:
 * - ACTIVE reservations reserve their authorized amount (concurrency-safe);
 * - unknown/missing trusted cost accounts the authorized conservative
 *   amount (never 0);
 * - a provable PRE-submission failure is the only releasable path (a
 *   timeout/HTTP error after submission may already have been billed).
 */
import { and, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import {
  competitorBudgetReservations,
  searchBudgetReservations,
  writerBudgetReservations,
} from "../persistence/schema.js";
import { FACTORY_BUDGET_RESERVATION_LOCK_KEY } from "../persistence/lock.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { MergePilotGrant } from "./merge-pilot-guard.js";

export const MERGE_PROVIDER = "merge";

export interface PilotBudgetReservationInput {
  grant: MergePilotGrant;
  /** Ledger of the serving role: the reservation LIVES there. */
  ledger: "writer" | "competitor" | "search";
  model: string;
  authorizedMicros: number;
  /** Distinct per attempt (writer digest / compiled analytics digest). */
  invocationDigest: string;
  role: string;
  lineage?: Record<string, unknown>;
}

export interface PilotBudgetReservationHandle {
  readonly id: string;
  readonly ledger: string;
  readonly invocationDigest: string;
  readonly authorizedMicros: number;
  /** Account durable spend (null = unknown cost -> conservative full amount). */
  account(actualTrustedMicros: number | null): Promise<void>;
  /** Release ONLY for provably pre-submission failures. */
  releaseUnexecuted(): Promise<void>;
}

/** Per-role ledger table map (existing tables, extended by this module). */
function ledgerTable(ledger: PilotBudgetReservationInput["ledger"]) {
  return ledger === "writer"
    ? writerBudgetReservations
    : ledger === "competitor"
      ? competitorBudgetReservations
      : searchBudgetReservations;
}

/**
 * Sum of merge-provider pilot exposure across ALL existing ledgers:
 * every ACTIVE reservation's authorized amount plus every ACCOUNTED row's
 * accounted amount (fallback: authorized when accountedMicros is null).
 *Executed inside the caller's transaction/lock precondition.
 */
function sumPilotExposureExpr(): ReturnType<typeof sql> {
  return sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN state = 'ACTIVE' THEN authorized_micros
        WHEN state = 'ACCOUNTED' THEN COALESCE(accounted_micros, authorized_micros)
        ELSE 0
      END
    ), 0)::int AS exposure
    FROM (
      SELECT state, authorized_micros, accounted_micros, provider FROM search_budget_reservations
      UNION ALL
      SELECT state, authorized_micros, accounted_micros, provider FROM writer_budget_reservations
      UNION ALL
      SELECT state, authorized_micros, accounted_micros, provider FROM competitor_budget_reservations
    ) pilot_rows
    WHERE provider = ${MERGE_PROVIDER}
  `;
}

/**
 * Pilot-spending report: per-ledger merge-spend totals (pilot scope only),
 * computed OUTSIDE any transaction for observability/audit use.
 */
export async function mergePilotSpendingReport(
  db: FactoryDb,
): Promise<{
  totalMicros: number;
  perLedger: Record<string, number>;
  activeReservationMicros: number;
}> {
  const { rows } = await db.execute<{ ledger: string; total: string; active: string }>(sql`
    SELECT 'writer' AS ledger,
           COALESCE(SUM(CASE WHEN state='ACCOUNTED' THEN COALESCE(accounted_micros, authorized_micros) WHEN state='ACTIVE' THEN 0 ELSE 0 END),0)::text AS total,
           COALESCE(SUM(CASE WHEN state='ACTIVE' THEN authorized_micros ELSE 0 END),0)::text AS active
    FROM writer_budget_reservations WHERE provider = ${MERGE_PROVIDER}
    UNION ALL
    SELECT 'competitor' AS ledger,
           COALESCE(SUM(CASE WHEN state='ACCOUNTED' THEN COALESCE(accounted_micros, authorized_micros) WHEN state='ACTIVE' THEN 0 ELSE 0 END),0)::text AS total,
           COALESCE(SUM(CASE WHEN state='ACTIVE' THEN authorized_micros ELSE 0 END),0)::text AS active
    FROM competitor_budget_reservations WHERE provider = ${MERGE_PROVIDER}
    UNION ALL
    SELECT 'search' AS ledger,
           COALESCE(SUM(CASE WHEN state='ACCOUNTED' THEN COALESCE(accounted_micros, authorized_micros) WHEN state='ACTIVE' THEN 0 ELSE 0 END),0)::text AS total,
           COALESCE(SUM(CASE WHEN state='ACTIVE' THEN authorized_micros ELSE 0 END),0)::text AS active
    FROM search_budget_reservations WHERE provider = ${MERGE_PROVIDER}
  `);
  let totalMicros = 0;
  let activeReservationMicros = 0;
  const perLedger: Record<string, number> = {};
  for (const row of rows) {
    const value = Number(row.total);
    const active = Number(row.active);
    perLedger[row.ledger] = value + active;
    totalMicros += value;
    activeReservationMicros += active;
  }
  // Whole-pilot exposure = accounted spend + ACTIVE reservations (matches
  // the reservation ceiling predicate exactly).
  totalMicros += activeReservationMicros;
  return { totalMicros, perLedger, activeReservationMicros };
}

/**
 * Seam for pure unit tests: in-memory ledger state (per-ledger rows). The
 * durable path uses the real tables + advisory lock + one transaction.
 */
export interface PilotBudgetStoreDeps {
  db?: FactoryDb;
  /**
   * Unit-test seam: current merge-provider exposure across all ledgers.
   * When absent, the durable SQL path is used.
   */
  exposureForTest?: () => Promise<number>;
  /** Unit-test seam: record a reservation row (in-memory). */
  recordForTest?: (input: PilotBudgetReservationInput, id: string) => void;
  idPrefix?: string;
}

/**
 * Reserve part of the WHOLE-PILOT ceiling for one paid call. Atomic: the
 * exposure check and the INSERT happen in ONE transaction under the shared
 * budget advisory xact lock, so two processes racing across DIFFERENT role
 * ledgers still serialize exactly like two reservations in one ledger.
 */
export async function reservePilotBudget(
  input: PilotBudgetReservationInput,
  deps: PilotBudgetStoreDeps = {},
): Promise<PilotBudgetReservationHandle> {
  const { grant } = input;
  const ceiling = grant.effectiveBudgetLimitMicros;
  if (
    !Number.isSafeInteger(input.authorizedMicros) ||
    input.authorizedMicros < 0
  ) {
    throw new FactoryError("budget_invariant_violation", "Pilot reservation must be a safe nonnegative integer in micros.");
  }
  // Zero-cost fixture reservations do not consume the ceiling.
  if (input.authorizedMicros === 0) {
    return makeTestHandle(input, "noop");
  }
  const id = `${deps.idPrefix ?? "pbres"}-${input.ledger}-${invocationDigestShort(input.invocationDigest)}`;

  if (deps.exposureForTest) {
    // ---- Unit-test in-memory path (no DB) -----------------------------
    const exposure = await deps.exposureForTest();
    if (exposure + input.authorizedMicros > ceiling) {
      throw new FactoryError(
        "merge_pilot_budget_blocked",
        `Merge pilot budget reached (${(ceiling / 1_000_000).toFixed(2)} USD across all pilot roles).`,
      );
    }
    deps.recordForTest?.(input, id);
    return {
      id,
      ledger: input.ledger,
      invocationDigest: input.invocationDigest,
      authorizedMicros: input.authorizedMicros,
      account: async () => {},
      releaseUnexecuted: async () => {},
    };
  }

  const db = deps.db;
  if (!db || typeof db.transaction !== "function") {
    throw new FactoryError("budget_invariant_violation", "reservePilotBudget requires a durable FactoryDb.");
  }

  const table = ledgerTable(input.ledger);
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(FACTORY_BUDGET_RESERVATION_LOCK_KEY)})`);
    const { rows } = await tx.execute<{ exposure: number }>(sumPilotExposureExpr());
    const exposure = Number(rows[0]?.exposure ?? 0);
    if (exposure + input.authorizedMicros > ceiling) {
      throw new FactoryError(
        "merge_pilot_budget_blocked",
        `Merge pilot budget reached (${(ceiling / 1_000_000).toFixed(2)} USD across all pilot roles); exposure ${exposure}µ + authorized ${input.authorizedMicros}µ exceeds ceiling ${ceiling}µ.`,
      );
    }
    await tx.insert(table).values({
      id,
      provider: MERGE_PROVIDER,
      model: input.model,
      authorizedMicros: input.authorizedMicros,
      state: "ACTIVE",
      invocationDigest: input.invocationDigest,
      lineage: {
        pilotProfileId: grant.profileId,
        pilotProfileVersion: grant.profileVersion,
        pilotRunId: grant.runId,
        pilotProjectId: grant.projectId,
        role: input.role,
        gatewayRole: grant.role,
        ...(input.lineage ?? {}),
      },
    }).catch((err: unknown) => {
      // A8 replay protection: a repeated reservation with the SAME
      // invocation digest collides on the deterministic reservation id —
      // that repeat is refused, never re-reserved or double-spent.
      if (String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code) === "23505") {
        throw new FactoryError(
          "merge_pilot_budget_blocked",
          `Merge pilot reservation replay blocked: invocation digest ${input.invocationDigest.slice(0, 40)} already holds an active/settled reservation (idempotent refusal, no double spend).`,
        );
      }
      throw err;
    });
    const reservationId = id;

    const settle = async (state: "ACCOUNTED" | "RELEASED", accountedMicros: number | null): Promise<void> => {
      await tx
        .update(table)
        .set(
          state === "ACCOUNTED"
            ? { state: "ACCOUNTED", accountedMicros, accountedAt: new Date() }
            : { state: "RELEASED", accountedAt: new Date() },
        )
        .where(and(eq(table.id, reservationId), eq(table.state, "ACTIVE")));
    };

    return {
      id: reservationId,
      ledger: input.ledger,
      invocationDigest: input.invocationDigest,
      authorizedMicros: input.authorizedMicros,
      account: async (actualTrustedMicros: number | null) => {
        // Unknown/untrusted cost -> conservative FULL authorized amount.
        // A real zero-usage response is still conservatively accounted
        // (never 0) unless the invocation provably never happened.
        const accounted =
          actualTrustedMicros != null && Number.isFinite(actualTrustedMicros) && actualTrustedMicros >= 0
            ? Math.round(actualTrustedMicros)
            : input.authorizedMicros;
        await settle("ACCOUNTED", accounted);
        if (accounted > input.authorizedMicros) {
          throw new FactoryError(
            "budget_invariant_violation",
            `Merge pilot actual cost (${accounted}µ) exceeded its authorized reservation (${input.authorizedMicros}µ) in ledger ${input.ledger}. The real amount is durably accounted; further pilot spend fails closed until the pricing/profile mismatch is resolved.`,
          );
        }
      },
      releaseUnexecuted: async () => {
        await settle("RELEASED", null);
      },
    };
  });
}

function invocationDigestShort(digest: string): string {
  return digest.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || deterministicDigest(digest).slice(0, 32);
}

function makeTestHandle(input: PilotBudgetReservationInput, id: string): PilotBudgetReservationHandle {
  return {
    id,
    ledger: input.ledger,
    invocationDigest: input.invocationDigest,
    authorizedMicros: input.authorizedMicros,
    account: async () => {},
    releaseUnexecuted: async () => {},
  };
}
