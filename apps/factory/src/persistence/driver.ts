import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSiteTask, type TaskResult } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { preflight } from "../executor/preflight.js";
import { runSiteTask, type RunSiteTaskOptions } from "../executor/run.js";
import { resolveDatabaseConfig } from "./config.js";
import { createDatabaseInstance, type FactoryDatabaseInstance } from "./db.js";
import { acquireControlPlaneLock } from "./lock.js";
import { recoverStaleExecutionState } from "./recovery.js";
import { FactoryStore, computeIdempotencyKey } from "./store.js";
import { DatabaseLifecycleObserver } from "./lifecycle.js";
import { resolveDurableTaskResult } from "./reconstruct.js";

export interface PersistedRunOptions extends RunSiteTaskOptions {
  idempotencyKey?: string;
  databaseUrl?: string;
  isTest?: boolean;
}

/**
 * Executes a SiteTask through the persistent control-plane lifecycle:
 * - Validates PostgreSQL configuration (fails closed if missing/invalid)
 * - Acquires single-writer session advisory lock
 * - Recovers any stale 'running' state from previous crashes
 * - Validates that the target Site and Project are registered in PostgreSQL
 * - Evaluates idempotency (returns existing terminal run if already executed)
 * - Persists durable Run and Task records
 * - Attaches DatabaseLifecycleObserver to execution core
 * - Records attempt outcomes, quality gates, and model invocations
 * - Persists final terminal status and releases advisory lock
 */
export async function runPersistedSiteTask(
  taskInput: unknown,
  opts: PersistedRunOptions,
): Promise<TaskResult> {
  const dbConfig = resolveDatabaseConfig({
    url: opts.databaseUrl,
    test: opts.isTest,
    requireConfigured: true,
  });

  const dbInstance: FactoryDatabaseInstance = createDatabaseInstance(dbConfig);

  let lockHandle: { release: () => Promise<void> } | null = null;
  try {
    // 1. Acquire single-writer control-plane advisory lock on a dedicated connection
    lockHandle = await acquireControlPlaneLock(dbInstance.pool);

    // 2. Recover any stale running state from previous crashes
    await recoverStaleExecutionState(dbInstance.db);

    const store = new FactoryStore(dbInstance.db);

    // 3. Validate task input to identify target site
    let siteId: string;
    let taskType: string;
    try {
      const parsedTask = parseSiteTask(taskInput);
      siteId = parsedTask.siteId;
      taskType = parsedTask.type;
    } catch (err) {
      // If task cannot be parsed, runSiteTask handles producing a structured failed TaskResult
      return await runSiteTask(taskInput, opts);
    }

    // 4. Resolve registered Site and Project in the database
    const siteResolution = await store.findSiteByGlobalKey(siteId);
    if (!siteResolution) {
      throw new FactoryError(
        "unknown_site",
        `Site '${siteId}' is not registered in the control plane database. Register the site before executing tasks.`,
      );
    }

    const { site, project } = siteResolution;

    // 5. Preflight check to obtain baseCommit and repoRoot
    const pre = await preflight(opts.repoRoot);
    const baseCommit = pre.baseCommit;
    const repoRoot = pre.repoRoot;

    // 6. Check idempotency
    const idempotencyKey = computeIdempotencyKey(
      site.key,
      taskInput,
      baseCommit,
      opts.idempotencyKey,
    );

    const existingRun = await store.findRunByIdempotencyKey(idempotencyKey);
    if (existingRun) {
      if (existingRun.siteId !== site.id) {
        throw new FactoryError(
          "idempotency_scope_conflict",
          `Persisted run '${existingRun.id}' matching idempotency key '${idempotencyKey}' belongs to a different site ('${existingRun.siteId}' != '${site.id}').`,
        );
      }
      if (existingRun.status !== "running") {
        const details = await store.getRunDetails(existingRun.id);
        if (!details) {
          throw new FactoryError(
            "persistence_state_invalid",
            `Run '${existingRun.id}' exists but detailed records could not be loaded.`,
          );
        }

        const existingRunDir = path.join(repoRoot, ".factory", "runs", existingRun.id);
        let rawResult: string | null = null;
        try {
          rawResult = await readFile(path.join(existingRunDir, "task-result.json"), "utf8");
        } catch {
          rawResult = null;
        }

        return resolveDurableTaskResult(details, repoRoot, rawResult);
      } else {
        throw new FactoryError(
          "run_already_in_progress",
          `An execution with idempotency key '${idempotencyKey}' is already active in run '${existingRun.id}'.`,
        );
      }
    }

    // 7. Create Run and Task in DB
    const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
    const relRunDir = path.join(".factory", "runs", runId);

    const { run, task } = await store.createRunAndTask({
      runId,
      projectId: project.id,
      siteId: site.id,
      kind: "site_task",
      idempotencyKey,
      baseCommit,
      startedAt: new Date(),
      taskType,
      payload: taskInput,
      artifactDirectory: relRunDir,
    });

    // 8. Attach DatabaseLifecycleObserver and execute runSiteTask
    const lifecycle = new DatabaseLifecycleObserver(
      store,
      run.id,
      task.id,
      taskType,
      repoRoot,
    );

    const result = await runSiteTask(taskInput, {
      ...opts,
      runId: run.id,
      lifecycle,
    });

    // 9. Persist final Run and Task outcome
    await store.completeRun({
      runId: run.id,
      taskId: task.id,
      status: result.status,
      durationMs: result.durationMs,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      artifactDirectory: result.artifacts.runDirectory,
      finishedAt: new Date(result.finishedAt),
    });

    return result;
  } finally {
    if (lockHandle) {
      await lockHandle.release();
    }
    await dbInstance.close();
  }
}
