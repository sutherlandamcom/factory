import { eq, and } from "drizzle-orm";
import type { FactoryDb } from "./db.js";
import { runs, tasks, attempts } from "./schema.js";

export interface RecoveryReport {
  recoveredRuns: number;
  recoveredTasks: number;
  recoveredAttempts: number;
}

/**
 * Recovers stale executions left in 'running' state after a process crash or restart.
 * Runs atomically inside a single transaction.
 */
export async function recoverStaleExecutionState(db: FactoryDb): Promise<RecoveryReport> {
  return await db.transaction(async (tx) => {
    const runningRuns = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"));

    if (runningRuns.length === 0) {
      return { recoveredRuns: 0, recoveredTasks: 0, recoveredAttempts: 0 };
    }

    const now = new Date();
    const runIds = runningRuns.map((r) => r.id);

    let recoveredAttempts = 0;
    let recoveredTasks = 0;

    for (const runId of runIds) {
      // 1. Mark running attempts for this run as interrupted
      const updatedAttempts = await tx
        .update(attempts)
        .set({
          status: "interrupted",
          errorMessage: "control_plane_restart",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(attempts.runId, runId), eq(attempts.status, "running")))
        .returning({ id: attempts.id });

      recoveredAttempts += updatedAttempts.length;

      // 2. Mark running tasks for this run as interrupted
      const updatedTasks = await tx
        .update(tasks)
        .set({
          status: "interrupted",
          updatedAt: now,
        })
        .where(and(eq(tasks.runId, runId), eq(tasks.status, "running")))
        .returning({ id: tasks.id });

      recoveredTasks += updatedTasks.length;

      // 3. Mark the run as interrupted
      await tx
        .update(runs)
        .set({
          status: "interrupted",
          errorMessage: "control_plane_restart",
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(runs.id, runId));
    }

    return {
      recoveredRuns: runIds.length,
      recoveredTasks,
      recoveredAttempts,
    };
  });
}
