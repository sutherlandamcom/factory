import { FactoryError } from "../executor/errors.js";
import { WriterBudgetStore } from "../writer/budget.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  parseSerpSnapshotData,
  parseGroundedSearchData,
  parseSearchIntelligenceData,
  type SearchUsage,
} from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  searchRuns,
  searchBudgetReservations,
  serpSnapshots,
  groundedSearchSnapshots,
  searchIntelligenceSnapshots,
  type SearchRunRecord,
  type SerpSnapshotRecord,
  type GroundedSearchSnapshotRecord,
  type SearchIntelligenceSnapshotRecord,
} from "../persistence/schema.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * SearchStore — owns persistence for Search Intelligence v0.
 *
 * Semantics:
 * - completed SERP/grounded/intelligence snapshots are immutable;
 * - a failed run persists status='failed' and never masquerades as evidence;
 * - cache reuse is an explicit run record referencing an existing snapshot
 *   (no snapshot mutation);
 * - project isolation is enforced by projectId predicates on every read.
 */
export class SearchStore {
  readonly budget: WriterBudgetStore;
  constructor(private readonly db: FactoryDb) { this.budget = new WriterBudgetStore(db, searchBudgetReservations); }

  async createRun(input: {
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    query: string;
    location: string | null;
    language: string | null;
    device: string;
    provider: string;
    requestDigest: string;
    refreshRequested: boolean;
    sourceRunId?: string;
  }): Promise<SearchRunRecord> {
    const [row] = await this.db
      .insert(searchRuns)
      .values({ id: randomUUID(), status: "running", ...input })
      .returning();
    return row!;
  }

  async finishRun(
    runId: string,
    status: "succeeded" | "failed",
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.db
      .update(searchRuns)
      .set({
        status,
        errorCode,
        errorMessage: errorMessage === null ? null : errorMessage.slice(0, 1024),
        finishedAt: new Date(),
        durationMs: sql`GREATEST(0, EXTRACT(EPOCH FROM (now() - ${searchRuns.startedAt})) * 1000)::int`,
      })
      .where(eq(searchRuns.id, runId));
  }

  async getRun(projectId: string, runId: string): Promise<SearchRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(searchRuns)
      .where(and(eq(searchRuns.projectId, projectId), eq(searchRuns.id, runId)));
    return row ?? null;
  }

  async listRuns(projectId: string, limit = 20): Promise<SearchRunRecord[]> {
    return await this.db
      .select()
      .from(searchRuns)
      .where(eq(searchRuns.projectId, projectId))
      .orderBy(desc(searchRuns.createdAt))
      .limit(limit);
  }

  /**
   * Freshness cache: newest succeeded run with the exact requestDigest whose
   * SERP observation is younger than maxAgeHours. Returns the run + SERP row.
   */
  async findFreshSerp(
    projectId: string,
    requestDigest: string,
    maxAgeHours: number,
  ): Promise<{ run: SearchRunRecord; serp: SerpSnapshotRecord } | null> {
    const rows = await this.db
      .select({ run: searchRuns, serp: serpSnapshots })
      .from(searchRuns)
      .innerJoin(serpSnapshots, eq(serpSnapshots.runId, searchRuns.id))
      .where(
        and(
          eq(searchRuns.projectId, projectId),
          eq(serpSnapshots.projectId, projectId),
          eq(searchRuns.requestDigest, requestDigest),
          eq(searchRuns.status, "succeeded"),
          sql`${serpSnapshots.observedAt} > now() - (${maxAgeHours} * interval '1 hour')`,
        ),
      )
      .orderBy(desc(serpSnapshots.observedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertSerpSnapshot(input: {
    runId: string;
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    query: string;
    location: string | null;
    language: string | null;
    device: string;
    provider: string;
    providerRequestId: string | null;
    observedAt: Date;
    requestDigest: string;
    data: {
      organic: unknown[];
      features: unknown[] | null;
      peopleAlsoAsk: unknown[] | null;
      relatedSearches: string[] | null;
    };
    rawPayload: unknown;
    usage: SearchUsage | null;
  }): Promise<SerpSnapshotRecord> {
    const snapshotDigest = deterministicDigest({
      query: input.query,
      location: input.location,
      language: input.language,
      device: input.device,
      provider: input.provider,
      observedAt: input.observedAt.toISOString(),
      requestDigest: input.requestDigest,
      data: input.data,
    });
    const rawDigest = deterministicDigest(input.rawPayload ?? null);
    const [row] = await this.db
      .insert(serpSnapshots)
      .values({
        id: randomUUID(),
        runId: input.runId,
        projectId: input.projectId,
        acceptedInputSnapshotId: input.acceptedInputSnapshotId,
        acceptedInputVersion: input.acceptedInputVersion,
        acceptedInputDigest: input.acceptedInputDigest,
        query: input.query,
        location: input.location,
        language: input.language,
        device: input.device,
        provider: input.provider,
        providerRequestId: input.providerRequestId,
        observedAt: input.observedAt,
        requestDigest: input.requestDigest,
        organic: input.data.organic,
        features: input.data.features,
        peopleAlsoAsk: input.data.peopleAlsoAsk,
        relatedSearches: input.data.relatedSearches,
        rawPayload: input.rawPayload,
        rawDigest,
        usage: input.usage,
        snapshotDigest,
      })
      .returning();
    return row!;
  }

  async insertGroundedSnapshot(input: {
    runId: string;
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    query: string;
    model: string;
    provider: string;
    promptVersion: string;
    promptDigest: string;
    data: {
      webSearchQueries: string[];
      sources: unknown[];
      citations: unknown[] | null;
      structuredOutput: Record<string, unknown>;
    };
    usage: SearchUsage | null;
    observedAt: Date;
  }): Promise<GroundedSearchSnapshotRecord> {
    const snapshotDigest = deterministicDigest({
      query: input.query,
      model: input.model,
      promptVersion: input.promptVersion,
      promptDigest: input.promptDigest,
      data: input.data,
    });
    const [row] = await this.db
      .insert(groundedSearchSnapshots)
      .values({
        id: randomUUID(),
        runId: input.runId,
        projectId: input.projectId,
        acceptedInputSnapshotId: input.acceptedInputSnapshotId,
        acceptedInputVersion: input.acceptedInputVersion,
        acceptedInputDigest: input.acceptedInputDigest,
        query: input.query,
        model: input.model,
        provider: input.provider,
        promptVersion: input.promptVersion,
        promptDigest: input.promptDigest,
        webSearchQueries: input.data.webSearchQueries,
        sources: input.data.sources,
        citations: input.data.citations,
        structuredOutput: input.data.structuredOutput,
        usage: input.usage,
        observedAt: input.observedAt,
        snapshotDigest,
      })
      .returning();
    return row!;
  }

  async insertIntelligenceSnapshot(input: {
    runId: string;
    projectId: string;
    acceptedInputSnapshotId: string;
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    query: string;
    model: string;
    provider: string;
    promptVersion: string;
    promptDigest: string;
    serpSnapshotId: string;
    groundedSnapshotId: string | null;
    evidenceDigests: Record<string, string>;
    data: unknown;
  }): Promise<SearchIntelligenceSnapshotRecord> {
    // Fail closed: persisted intelligence must satisfy the current contract.
    const data = parseSearchIntelligenceData(input.data);
    const expectedRefs = [
      { kind: "serp_snapshot", id: input.serpSnapshotId, digest: input.evidenceDigests.serp },
      ...(input.groundedSnapshotId ? [{ kind: "grounded_snapshot", id: input.groundedSnapshotId, digest: input.evidenceDigests.grounded }] : []),
    ];
    if (expectedRefs.some(ref => !ref.digest || !/^[0-9a-f]{64}$/.test(ref.digest) || !data.evidenceRefs.some(actual => actual.kind === ref.kind && actual.id === ref.id && actual.digest === ref.digest)) || data.evidenceRefs.length !== expectedRefs.length) {
      throw new FactoryError("search_intelligence_invalid", "Intelligence evidence lineage must bind exact SHA-256 snapshot digests.");
    }
    const snapshotDigest = deterministicDigest({
      query: input.query,
      model: input.model,
      promptVersion: input.promptVersion,
      promptDigest: input.promptDigest,
      evidenceDigests: input.evidenceDigests,
      data,
    });
    const [row] = await this.db
      .insert(searchIntelligenceSnapshots)
      .values({
        id: randomUUID(),
        runId: input.runId,
        projectId: input.projectId,
        acceptedInputSnapshotId: input.acceptedInputSnapshotId,
        acceptedInputVersion: input.acceptedInputVersion,
        acceptedInputDigest: input.acceptedInputDigest,
        query: input.query,
        model: input.model,
        provider: input.provider,
        promptVersion: input.promptVersion,
        promptDigest: input.promptDigest,
        serpSnapshotId: input.serpSnapshotId,
        groundedSnapshotId: input.groundedSnapshotId,
        evidenceDigests: input.evidenceDigests,
        data,
        snapshotDigest,
      })
      .returning();
    return row!;
  }

  async getSerpSnapshot(projectId: string, runId: string): Promise<SerpSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(serpSnapshots)
      .where(and(eq(serpSnapshots.projectId, projectId), eq(serpSnapshots.runId, runId)));
    if (!row) return null;
    // Re-parse through the current contract on read (fail closed on drift).
    parseSerpSnapshotData({
      organic: row.organic,
      ...(row.features != null ? { features: row.features } : {}),
      ...(row.peopleAlsoAsk != null ? { peopleAlsoAsk: row.peopleAlsoAsk } : {}),
      ...(row.relatedSearches != null ? { relatedSearches: row.relatedSearches } : {}),
    });
    return row;
  }

  async getGroundedSnapshot(
    projectId: string,
    runId: string,
  ): Promise<GroundedSearchSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(groundedSearchSnapshots)
      .where(
        and(eq(groundedSearchSnapshots.projectId, projectId), eq(groundedSearchSnapshots.runId, runId)),
      );
    if (!row) return null;
    parseGroundedSearchData({
      webSearchQueries: row.webSearchQueries,
      sources: row.sources,
      ...(row.citations != null ? { citations: row.citations } : {}),
      structuredOutput: row.structuredOutput,
    });
    return row;
  }

  async getIntelligenceSnapshot(
    projectId: string,
    runId: string,
  ): Promise<SearchIntelligenceSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(searchIntelligenceSnapshots)
      .where(
        and(
          eq(searchIntelligenceSnapshots.projectId, projectId),
          eq(searchIntelligenceSnapshots.runId, runId),
        ),
      );
    if (!row) return null;
    parseSearchIntelligenceData(row.data);
    return row;
  }

  /**
   * Budget gate input: sum of recorded costMicros for search artifacts today
   * (UTC). Null costs (UNKNOWN) are skipped — they are documented as
   * uncounted, never fabricated.
   */
  async sumTodaySearchCostMicros(): Promise<number> {
    return (await this.budget.sumTodayWriterCostMicros()) + (await this.budget.unreservedSearchCost());
  }

  async latestIntelligenceForProject(projectId: string) {
    const [row] = await this.db
      .select()
      .from(searchIntelligenceSnapshots)
      .where(eq(searchIntelligenceSnapshots.projectId, projectId))
      .orderBy(asc(searchIntelligenceSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  }
}
