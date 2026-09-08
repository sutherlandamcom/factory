import pg from "pg";
import { FactoryError } from "../executor/errors.js";

/**
 * Stable 64-bit lock key for Factory single-writer control plane.
 */
export const FACTORY_CONTROL_PLANE_LOCK_KEY = "1428570001";

/**
 * Stable 64-bit lock key serializing budget reservation decisions
 * (authorization, accounting, release) across processes. Distinct from the
 * control-plane lock so budget accounting never blocks general execution.
 */
export const FACTORY_BUDGET_RESERVATION_LOCK_KEY = "1428570002";

export interface ControlPlaneLockHandle {
  release: () => Promise<void>;
}

/**
 * Acquires a dedicated PostgreSQL session advisory lock for Factory execution.
 * Fails immediately with 'control_plane_busy' if another process holds the lock.
 */
export async function acquireControlPlaneLock(
  pool: pg.Pool,
  lockKey: string = FACTORY_CONTROL_PLANE_LOCK_KEY,
): Promise<ControlPlaneLockHandle> {
  const client = await pool.connect();
  let clientOwnershipTransferred = false;

  try {
    const res = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired;",
      [lockKey],
    );
    const lockAcquired = Boolean(res.rows[0]?.acquired);

    if (!lockAcquired) {
      throw new FactoryError(
        "control_plane_busy",
        "Another Factory control-plane process is currently active. Persistent control plane enforces a single active writer.",
      );
    }

    clientOwnershipTransferred = true;
    let released = false;

    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1::bigint);", [lockKey]);
        } catch {
          // Ignore unlock errors during teardown if connection is already closed/errored
        } finally {
          client.release();
        }
      },
    };
  } finally {
    if (!clientOwnershipTransferred) {
      client.release();
    }
  }
}

/**
 * Executes a callback within a held control-plane session advisory lock.
 */
export async function withControlPlaneLock<T>(
  pool: pg.Pool,
  fn: () => Promise<T>,
  lockKey: string = FACTORY_CONTROL_PLANE_LOCK_KEY,
): Promise<T> {
  const lock = await acquireControlPlaneLock(pool, lockKey);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
