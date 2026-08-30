import { createHash, randomUUID } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import type { FactoryDb } from "./db.js";
import {
  projects,
  sites,
  runs,
  tasks,
  attempts,
  qualityResults,
  modelInvocations,
  type ProjectRecord,
  type SiteRecord,
  type RunRecord,
  type TaskRecord,
  type AttemptRecord,
  type QualityResultRecord,
  type ModelInvocationRecord,
  type InsertQualityResult,
} from "./schema.js";
import { FactoryError } from "../executor/errors.js";

const MAX_ERROR_MESSAGE_LENGTH = 4096;
const MAX_SUMMARY_LENGTH = 1024;

export function truncateBounded(str: string | undefined | null, maxLen: number): string | null {
  if (!str) return null;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "... [truncated]";
}

/**
 * Computes a deterministic idempotency key from siteKey, task payload, and base commit.
 */
export function computeIdempotencyKey(
  siteKey: string,
  taskInput: unknown,
  baseCommit: string,
  callerKey?: string,
): string {
  if (callerKey && callerKey.trim().length > 0) {
    return callerKey.trim();
  }
  const payloadStr =
    typeof taskInput === "string" ? taskInput : JSON.stringify(taskInput);
  const hash = createHash("sha256")
    .update(`${siteKey}::${payloadStr}::${baseCommit}`)
    .digest("hex");
  return `idem-${siteKey}-${hash.slice(0, 32)}`;
}

export interface StoreContext {
  db: FactoryDb;
}

export class FactoryStore {
  constructor(public readonly db: FactoryDb) {}

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async createProject(input: { key: string; name: string }): Promise<ProjectRecord> {
    const id = randomUUID();
    const [created] = await this.db
      .insert(projects)
      .values({
        id,
        key: input.key,
        name: input.name,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to create project");
    return created;
  }

  async ensureProject(input: { key: string; name?: string }): Promise<ProjectRecord> {
    const existing = await this.getProjectByKey(input.key);
    if (existing) return existing;
    return await this.createProject({
      key: input.key,
      name: input.name ?? `Project ${input.key}`,
    });
  }

  async getProjectByKey(key: string): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.key, key));
    return row ?? null;
  }

  async getProjectById(id: string): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id));
    return row ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sites
  // ---------------------------------------------------------------------------

  async registerSite(input: {
    projectKey: string;
    key: string;
    name: string;
  }): Promise<SiteRecord> {
    const existing = await this.findSiteByGlobalKey(input.key);
    if (existing) {
      throw new FactoryError(
        "site_already_exists",
        `Site with key '${input.key}' is already registered under project '${existing.project.key}'.`,
      );
    }
    const project = await this.getProjectByKey(input.projectKey);
    if (!project) {
      throw new FactoryError(
        "unknown_project",
        `Cannot register site: project with key '${input.projectKey}' does not exist.`,
      );
    }
    const id = randomUUID();
    const [created] = await this.db
      .insert(sites)
      .values({
        id,
        projectId: project.id,
        key: input.key,
        name: input.name,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to register site");
    return created;
  }

  async ensureSite(input: {
    projectKey: string;
    key: string;
    name?: string;
  }): Promise<{ site: SiteRecord; project: ProjectRecord }> {
    const existing = await this.findSiteByGlobalKey(input.key);
    if (existing) {
      if (existing.project.key !== input.projectKey) {
        throw new FactoryError(
          "site_ownership_conflict",
          `Site key '${input.key}' is already registered under project '${existing.project.key}'. Cannot register under '${input.projectKey}'.`,
        );
      }
      return existing;
    }

    const project = await this.ensureProject({ key: input.projectKey });
    const id = randomUUID();
    const [created] = await this.db
      .insert(sites)
      .values({
        id,
        projectId: project.id,
        key: input.key,
        name: input.name ?? `Site ${input.key}`,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to create site");
    return { site: created, project };
  }

  async getSiteByKey(projectKey: string, siteKey: string): Promise<SiteRecord | null> {
    const resolved = await this.findSiteByGlobalKey(siteKey);
    if (!resolved || resolved.project.key !== projectKey) return null;
    return resolved.site;
  }

  async findSiteByGlobalKey(siteKey: string): Promise<{ site: SiteRecord; project: ProjectRecord } | null> {
    const rows = await this.db
      .select({
        site: sites,
        project: projects,
      })
      .from(sites)
      .innerJoin(projects, eq(sites.projectId, projects.id))
      .where(eq(sites.key, siteKey));

    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new FactoryError(
        "persistence_state_invalid",
        `Ambiguous site key '${siteKey}': multiple sites found with the same key.`,
      );
    }
    return rows[0]!;
  }

  // ---------------------------------------------------------------------------
  // Runs & Tasks
  // ---------------------------------------------------------------------------

  async findRunById(runId: string): Promise<RunRecord | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, runId));
    return row ?? null;
  }

  async findRunByIdempotencyKey(idempotencyKey: string): Promise<RunRecord | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.idempotencyKey, idempotencyKey));
    return row ?? null;
  }

  async createRunAndTask(input: {
    runId: string;
    projectId: string;
    siteId: string;
    kind?: string;
    idempotencyKey: string;
    baseCommit: string;
    startedAt: Date;
    taskType: string;
    payload: unknown;
    artifactDirectory?: string;
  }): Promise<{ run: RunRecord; task: TaskRecord; isExisting: boolean }> {
    // 1. Check existing before transaction
    const existing = await this.findRunByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const [existingTask] = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.runId, existing.id));
      return {
        run: existing,
        task: existingTask!,
        isExisting: true,
      };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const [createdRun] = await tx
          .insert(runs)
          .values({
            id: input.runId,
            projectId: input.projectId,
            siteId: input.siteId,
            kind: input.kind ?? "site_task",
            idempotencyKey: input.idempotencyKey,
            status: "running",
            baseCommit: input.baseCommit,
            startedAt: input.startedAt,
            artifactDirectory: input.artifactDirectory,
          })
          .returning();

        const taskId = randomUUID();
        const [createdTask] = await tx
          .insert(tasks)
          .values({
            id: taskId,
            runId: input.runId,
            siteId: input.siteId,
            type: input.taskType,
            payload: input.payload as Record<string, unknown>,
            status: "running",
          })
          .returning();

        return {
          run: createdRun!,
          task: createdTask!,
          isExisting: false,
        };
      });
    } catch (err: unknown) {
      const pgCode = (err as any)?.code ?? (err as any)?.cause?.code;
      if (
        pgCode === "23505" ||
        (err instanceof Error && err.message.includes("runs_idempotency_key_unique"))
      ) {
        // Race condition: another concurrent caller inserted the run
        const conflicted = await this.findRunByIdempotencyKey(input.idempotencyKey);
        if (conflicted) {
          const [conflictedTask] = await this.db
            .select()
            .from(tasks)
            .where(eq(tasks.runId, conflicted.id));
          return {
            run: conflicted,
            task: conflictedTask!,
            isExisting: true,
          };
        }
      }
      throw err;
    }
  }

  async completeRun(input: {
    runId: string;
    taskId?: string;
    status: "succeeded" | "failed" | "needs_review" | "interrupted";
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    artifactDirectory?: string;
    finishedAt: Date;
  }): Promise<{ run: RunRecord; task?: TaskRecord }> {
    return await this.db.transaction(async (tx) => {
      const now = new Date();
      const [updatedRun] = await tx
        .update(runs)
        .set({
          status: input.status,
          finishedAt: input.finishedAt,
          durationMs: input.durationMs,
          errorCode: input.errorCode,
          errorMessage: truncateBounded(input.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
          artifactDirectory: input.artifactDirectory,
          updatedAt: now,
        })
        .where(eq(runs.id, input.runId))
        .returning();

      let updatedTask: TaskRecord | undefined;
      if (input.taskId) {
        const [t] = await tx
          .update(tasks)
          .set({
            status: input.status,
            updatedAt: now,
          })
          .where(eq(tasks.id, input.taskId))
          .returning();
        updatedTask = t;
      } else {
        const [t] = await tx
          .update(tasks)
          .set({
            status: input.status,
            updatedAt: now,
          })
          .where(eq(tasks.runId, input.runId))
          .returning();
        updatedTask = t;
      }

      return { run: updatedRun!, task: updatedTask };
    });
  }

  // ---------------------------------------------------------------------------
  // Attempts
  // ---------------------------------------------------------------------------

  async beginAttempt(input: {
    id?: string;
    runId: string;
    taskId: string;
    attemptNumber: number;
    kind: "initial" | "repair";
    stage: string;
    startedAt: Date;
    artifactDirectory?: string;
  }): Promise<AttemptRecord> {
    const id = input.id ?? randomUUID();
    const [created] = await this.db
      .insert(attempts)
      .values({
        id,
        runId: input.runId,
        taskId: input.taskId,
        attemptNumber: input.attemptNumber,
        kind: input.kind,
        stage: input.stage,
        status: "running",
        startedAt: input.startedAt,
        artifactDirectory: input.artifactDirectory,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to begin attempt");
    return created;
  }

  async completeAttempt(input: {
    attemptId: string;
    stage: string;
    status: "succeeded" | "failed" | "needs_review" | "interrupted";
    classification?: string | null;
    finishedAt: Date;
    durationMs?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    artifactDirectory?: string | null;
  }): Promise<AttemptRecord> {
    const now = new Date();
    const [updated] = await this.db
      .update(attempts)
      .set({
        stage: input.stage,
        status: input.status,
        classification: input.classification,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        errorMessage: truncateBounded(input.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
        artifactDirectory: input.artifactDirectory,
        updatedAt: now,
      })
      .where(eq(attempts.id, input.attemptId))
      .returning();

    if (!updated) throw new FactoryError("persistence_write_failed", "Failed to complete attempt");
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Quality Results
  // ---------------------------------------------------------------------------

  async recordQualityResult(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    gate: string;
    passed: boolean;
    summary?: string | null;
    artifactRef?: string | null;
  }): Promise<QualityResultRecord> {
    const id = randomUUID();
    const [created] = await this.db
      .insert(qualityResults)
      .values({
        id,
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        gate: input.gate,
        passed: input.passed,
        summary: truncateBounded(input.summary, MAX_SUMMARY_LENGTH),
        artifactRef: input.artifactRef,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to record quality result");
    return created;
  }

  async recordQualityResults(resultsList: InsertQualityResult[]): Promise<QualityResultRecord[]> {
    if (resultsList.length === 0) return [];
    const valuesWithIds = resultsList.map((r) => ({
      ...r,
      id: r.id ?? randomUUID(),
      summary: truncateBounded(r.summary, MAX_SUMMARY_LENGTH),
    }));
    return await this.db.insert(qualityResults).values(valuesWithIds).returning();
  }

  // ---------------------------------------------------------------------------
  // Model Invocations
  // ---------------------------------------------------------------------------

  async recordModelInvocation(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    taskKind: string;
    provider: string;
    model?: string | null;
    runtime: string;
    runtimeVersion?: string | null;
    methodologyVersion?: string | null;
    status: "running" | "succeeded" | "failed" | "interrupted";
    startedAt: Date;
    finishedAt?: Date | null;
    durationMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    costMicros?: number | null;
    errorCode?: string | null;
    artifactRef?: string | null;
  }): Promise<ModelInvocationRecord> {
    const id = randomUUID();
    const [created] = await this.db
      .insert(modelInvocations)
      .values({
        id,
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        taskKind: input.taskKind,
        provider: input.provider,
        model: input.model,
        runtime: input.runtime,
        runtimeVersion: input.runtimeVersion,
        methodologyVersion: input.methodologyVersion,
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        costMicros: input.costMicros,
        errorCode: input.errorCode,
        artifactRef: input.artifactRef,
      })
      .returning();
    if (!created) throw new FactoryError("persistence_write_failed", "Failed to record model invocation");
    return created;
  }

  // ---------------------------------------------------------------------------
  // Inspection Details
  // ---------------------------------------------------------------------------

  async getRunDetails(runId: string): Promise<{
    run: RunRecord;
    site: SiteRecord;
    project: ProjectRecord;
    tasks: TaskRecord[];
    attempts: (AttemptRecord & {
      qualityResults: QualityResultRecord[];
      modelInvocations: ModelInvocationRecord[];
    })[];
  } | null> {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return null;

    const [site] = await this.db.select().from(sites).where(eq(sites.id, run.siteId));
    const [project] = await this.db.select().from(projects).where(eq(projects.id, run.projectId));
    const runTasks = await this.db.select().from(tasks).where(eq(tasks.runId, runId));
    const runAttempts = await this.db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, runId))
      .orderBy(asc(attempts.attemptNumber));

    const runQualityResults = await this.db
      .select()
      .from(qualityResults)
      .where(eq(qualityResults.runId, runId));

    const runModelInvocations = await this.db
      .select()
      .from(modelInvocations)
      .where(eq(modelInvocations.runId, runId));

    const attemptsWithDetails = runAttempts.map((attempt) => ({
      ...attempt,
      qualityResults: runQualityResults.filter((qr) => qr.attemptId === attempt.id),
      modelInvocations: runModelInvocations.filter((mi) => mi.attemptId === attempt.id),
    }));

    return {
      run,
      site: site!,
      project: project!,
      tasks: runTasks,
      attempts: attemptsWithDetails,
    };
  }
}
