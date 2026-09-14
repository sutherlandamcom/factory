import { InvocationFailure } from "../models/invocation-failure.js";
import {
  normalizeSearchQuery,
  MAX_SERP_RAW_BYTES,
  type SearchDevice,
  type SearchUsage,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { ProjectIntakeStore } from "../operator/intake-store.js";
import type { SearchStore } from "./search-store.js";
import type { StructuredSerpProvider } from "./provider-types.js";
import type { GroundedSearchProvider } from "./grounded-types.js";
import type { SearchAnalystModel } from "./analyst.js";

/**
 * SearchIntelligenceService — the governed application service.
 *
 * Pipeline: preflight → resolve accepted inputs → normalize request →
 * cache check → acquire structured SERP → persist SerpSnapshot →
 * optional grounded research → derive intelligence (analyst) →
 * persist SearchIntelligenceSnapshot → bounded operator read-model.
 *
 * Trusted policy (provider mode, budgets, freshness) comes from backend
 * configuration; the browser never controls provider plumbing.
 */

export const SEARCH_REQUEST_VERSION = "search-request-v2";

export interface SearchServiceConfig {
  /** Freshness window for cache reuse (hours). */
  freshnessHours: number;
  /** Trusted upper bounds per invocation; absent means no paid execution. */
  authorizedMicros?: Partial<Record<"serp" | "grounded" | "analyst", number>>;
  /** Daily spend ceiling in USD (reserved plus accounted cost). */
  dailyLimitUsd: number;
  /** Trusted provider selection: production adapter id or 'fixture'. */
  providerMode: "production" | "fixture";
}

export const DEFAULT_SEARCH_CONFIG: SearchServiceConfig = {
  freshnessHours: 24,
  dailyLimitUsd: 5,
  providerMode: "production",
};

export interface SearchServiceDeps {
  intake: ProjectIntakeStore;
  searchStore: SearchStore;
  productionSerpProvider: StructuredSerpProvider;
  fixtureSerpProvider?: StructuredSerpProvider;
  groundedProvider?: GroundedSearchProvider | null;
  analyst: SearchAnalystModel;
  config?: Partial<SearchServiceConfig>;
  now?: () => Date;
}

export interface RunSearchInput {
  projectId: string;
  query: string;
  location?: string;
  language?: string;
  device: SearchDevice;
  refresh?: boolean;
}

export interface SearchRunReadModel {
  run: {
    id: string;
    status: "succeeded" | "failed";
    query: string;
    location: string | null;
    language: string | null;
    device: SearchDevice;
    provider: string;
    cacheReused: boolean;
    refreshRequested: boolean;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  acceptedInput: {
    snapshotId: string;
    version: number;
    digest: string;
    /** True when a newer accepted snapshot exists than the one this run used. */
    stale: boolean;
  };
  serp: {
    snapshotId: string;
    snapshotDigest: string;
    observedAt: string;
    provider: string;
    providerRequestId: string | null;
    organic: Array<{ position: number; url: string; domain: string; title: string; snippet: string }>;
    features: string[] | null;
    peopleAlsoAsk: Array<{ question: string; answer?: string }> | null;
    relatedSearches: string[] | null;
    rawDigest: string;
    usage: SearchUsage | null;
  } | null;
  grounded: {
    snapshotId: string;
    snapshotDigest: string;
    model: string;
    promptVersion: string;
    observedAt: string;
    webSearchQueries: string[];
    sources: Array<{ title?: string; uri: string }>;
  } | null;
  intelligence: {
    snapshotId: string;
    snapshotDigest: string;
    model: string;
    promptVersion: string;
    data: Record<string, unknown>;
  } | null;
}

export interface SearchWorkspaceReadModel {
  acceptedInput: {
    snapshotId: string;
    version: number;
    digest: string;
    acceptedAt: string;
  } | null;
  seeds: {
    topics: string[];
    queries: string[];
    competitors: string[];
    marketHints: string[];
  };
  readiness: {
    canRun: boolean;
    providerConfigured: boolean;
    providerReason: string | null;
    providerMode: "production" | "fixture";
    blockers: string[];
  };
  recentRuns: Array<{
    id: string;
    status: string;
    query: string;
    provider: string;
    startedAt: string;
    errorCode: string | null;
  }>;
}

export class SearchIntelligenceService {
  private readonly config: SearchServiceConfig;
  private readonly now: () => Date;

  constructor(private readonly deps: SearchServiceDeps) {
    this.config = { ...DEFAULT_SEARCH_CONFIG, ...deps.config };
    this.now = deps.now ?? (() => new Date());
  }

  private serpProvider(): StructuredSerpProvider {
    if (this.config.providerMode === "fixture") {
      if (!this.deps.fixtureSerpProvider) {
        throw new FactoryError(
          "search_provider_not_configured",
          "Fixture provider selected but not wired.",
        );
      }
      return this.deps.fixtureSerpProvider;
    }
    return this.deps.productionSerpProvider;
  }

  /** Operator-facing readiness (human terms; no secrets, no provider plumbing). */
  async workspace(projectId: string): Promise<SearchWorkspaceReadModel> {
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latest = snapshots.at(-1) ?? null;
    let seeds: SearchWorkspaceReadModel["seeds"] = {
      topics: [],
      queries: [],
      competitors: [],
      marketHints: [],
    };
    if (latest) {
      const payload = latest.payload as { searchSeeds?: SearchWorkspaceReadModel["seeds"] };
      seeds = {
        topics: payload.searchSeeds?.topics ?? [],
        queries: payload.searchSeeds?.queries ?? [],
        competitors: payload.searchSeeds?.competitors ?? [],
        marketHints: payload.searchSeeds?.marketHints ?? [],
      };
    }

    const readiness = await this.serpProvider().readiness();
    const groundedReady = this.deps.groundedProvider
      ? this.deps.groundedProvider.readiness().configured
      : false;

    const blockers: string[] = [];
    if (!latest) blockers.push("No accepted project inputs. Complete Intake first.");
    if (!readiness.configured) blockers.push(readiness.reason);
    if (this.deps.analyst.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
      blockers.push("OpenRouter API key is required for search intelligence in production mode.");
    }
    // Grounded research is optional in v0; absence is surfaced honestly in
    // run details, never treated as a blocker.

    const recentRuns = await this.deps.searchStore.listRuns(projectId, 20);

    return {
      acceptedInput: latest
        ? {
            snapshotId: latest.id,
            version: latest.version,
            digest: latest.digest,
            acceptedAt: latest.acceptedAt.toISOString(),
          }
        : null,
      seeds,
      readiness: {
        canRun:
          Boolean(latest) &&
          readiness.configured &&
          (this.deps.analyst.provider !== "openrouter" || Boolean(process.env.OPENROUTER_API_KEY?.trim())),
        providerConfigured: readiness.configured,
        providerReason: readiness.configured ? null : readiness.reason,
        providerMode: this.config.providerMode,
        blockers,
      },
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        query: r.query,
        provider: r.provider,
        startedAt: r.startedAt.toISOString(),
        errorCode: r.errorCode,
      })),
    };
  }

  private async invoke<T extends { usage: { costMicros?: number | null } | null }>(
    stage: "serp" | "grounded" | "analyst", provider: string, runId: string, call: () => Promise<T>,
  ): Promise<T> {
    // Fixture adapters are selected by trusted backend configuration, never by a request.
    if (this.config.providerMode === "fixture" && (provider === "fixture" || provider.startsWith("fixture-"))) return call();
    const authorizedMicros = this.config.authorizedMicros?.[stage];
    if (!Number.isSafeInteger(authorizedMicros) || authorizedMicros! <= 0 || !this.deps.searchStore.budget) {
      throw new FactoryError("search_provider_budget_blocked", `No trusted conservative reservation bound for ${stage}.`);
    }
    const reservation = await this.deps.searchStore.budget.reserveWriterBudget({
      provider, model: stage, authorizedMicros: authorizedMicros!,
      invocationDigest: deterministicDigest({ runId, stage, provider }), lineage: { runId, stage },
    }, this.config.dailyLimitUsd);
    let result: T;
    try { result = await call(); }
    catch (error) {
      if (error instanceof InvocationFailure && error.requestSubmitted === false) await reservation.releaseUnexecuted();
      else await reservation.account(error instanceof InvocationFailure ? error.trustedCostMicros : null);
      throw error;
    }
    await reservation.account(result.usage?.costMicros ?? null);
    return result;
  }

  async runSearch(input: RunSearchInput): Promise<SearchRunReadModel> {
    // ---- Preflight (fail before spend) -----------------------------------
    const query = normalizeSearchQuery(input.query);
    if (!query) {
      throw new FactoryError("search_query_invalid", "Query is required.");
    }
    if (query.length > 200) {
      throw new FactoryError("search_query_invalid", "Query exceeds 200 characters.");
    }

    const snapshots = await this.deps.intake.listSnapshots(input.projectId);
    const accepted = snapshots.at(-1);
    if (!accepted) {
      throw new FactoryError(
        "search_input_not_accepted",
        "No accepted ProjectInputSnapshot for this project. Complete Intake acceptance first.",
      );
    }

    const budgetMicros = this.config.dailyLimitUsd * 1_000_000;
    const spentToday = await this.deps.searchStore.sumTodaySearchCostMicros();
    if (spentToday >= budgetMicros) {
      throw new FactoryError(
        "search_provider_budget_blocked",
        `Daily search budget reached (${this.config.dailyLimitUsd} USD).`,
      );
    }

    if (this.deps.analyst.provider === "openrouter" && !process.env.OPENROUTER_API_KEY?.trim()) {
      throw new FactoryError(
        "search_analyst_not_configured",
        "OpenRouter API key is required for search intelligence in production mode (fail closed).",
      );
    }

    const provider = this.serpProvider();
    const providerReadiness = await provider.readiness();
    if (!providerReadiness.configured) {
      throw new FactoryError("search_provider_not_configured", providerReadiness.reason);
    }

    const location = input.location?.trim() || null;
    const language = input.language?.trim() || null;

    // Normalize request + cache key.
    const requestDigest = deterministicDigest({
      projectId: input.projectId,
      provider: provider.id,
      query,
      location,
      language,
      device: input.device,
      acceptedInputDigest: accepted.digest,
      requestVersion: SEARCH_REQUEST_VERSION,
    });

    // ---- Cache check (no accidental duplicate spend) ---------------------
    if (!input.refresh) {
      const fresh = await this.deps.searchStore.findFreshSerp(
        input.projectId,
        requestDigest,
        this.config.freshnessHours,
      );
      if (fresh) {
        const reusedRunId = await this.recordReusedRun({
          sourceRunId: fresh.run.id,
          projectId: input.projectId,
          acceptedInputSnapshotId: accepted.id,
          acceptedInputVersion: accepted.version,
          acceptedInputDigest: accepted.digest,
          query,
          location,
          language,
          device: input.device,
          provider: provider.id,
          requestDigest,
          refreshRequested: false,
        });
        const read = await this.buildReadModel(
          input.projectId,
          reusedRunId,
          accepted,
          true,
          false,
        );
        return read;
      }
    }

    // ---- Execute run -----------------------------------------------------
    const run = await this.deps.searchStore.createRun({
      projectId: input.projectId,
      acceptedInputSnapshotId: accepted.id,
      acceptedInputVersion: accepted.version,
      acceptedInputDigest: accepted.digest,
      query,
      location,
      language,
      device: input.device,
      provider: provider.id,
      requestDigest,
      refreshRequested: Boolean(input.refresh),
    });

    try {
      const acquisition = await this.invoke("serp", provider.id, run.id, () => provider.acquire({ query, location, language, device: input.device }));

      if (JSON.stringify(acquisition.rawPayload ?? null).length > MAX_SERP_RAW_BYTES) {
        throw new FactoryError(
          "search_response_invalid",
          "Provider raw payload exceeded the persistence ceiling.",
        );
      }

      const serpSnapshot = await this.deps.searchStore.insertSerpSnapshot({
        runId: run.id,
        projectId: input.projectId,
        acceptedInputSnapshotId: accepted.id,
        acceptedInputVersion: accepted.version,
        acceptedInputDigest: accepted.digest,
        query,
        location,
        language,
        device: input.device,
        provider: provider.id,
        providerRequestId: acquisition.providerRequestId,
        observedAt: acquisition.observedAt,
        requestDigest,
        data: {
          organic: acquisition.data.organic,
          features: acquisition.data.features ?? null,
          peopleAlsoAsk: acquisition.data.peopleAlsoAsk ?? null,
          relatedSearches: acquisition.data.relatedSearches ?? null,
        },
        rawPayload: acquisition.rawPayload,
        usage: acquisition.usage,
      });

      // ---- Grounded research (optional) ----------------------------------
      let groundedSnapshotId: string | null = null;
      let groundedSnapshot: Awaited<ReturnType<SearchStore["insertGroundedSnapshot"]>> | null = null;
      const grounded = this.deps.groundedProvider;
      if (grounded && grounded.readiness().configured) {
        const packet = compilePacket(accepted.payload as Record<string, unknown>, query, location, language);
        const groundedResult = await this.invoke("grounded", grounded.id, run.id, () => grounded.research({
          query,
          location,
          language,
          packetDigest: deterministicDigest(packet),
        }));
        groundedSnapshot = await this.deps.searchStore.insertGroundedSnapshot({
          runId: run.id,
          projectId: input.projectId,
          acceptedInputSnapshotId: accepted.id,
          acceptedInputVersion: accepted.version,
          acceptedInputDigest: accepted.digest,
          query,
          model: groundedResult.model,
          provider: groundedResult.provider,
          promptVersion: groundedResult.promptVersion,
          promptDigest: groundedResult.promptDigest,
          data: {
            webSearchQueries: groundedResult.data.webSearchQueries,
            sources: groundedResult.data.sources,
            citations: groundedResult.data.citations ?? null,
            structuredOutput: groundedResult.data.structuredOutput,
          },
          usage: groundedResult.usage,
          observedAt: groundedResult.observedAt,
        });
        groundedSnapshotId = groundedSnapshot.id;
      }

      // ---- Intelligence derivation ----------------------------------------
      const analyst = this.deps.analyst;
      const packet = {
        project: compilePacket(accepted.payload as Record<string, unknown>, query, location, language),
        evidence: compileAnalystEvidence(serpSnapshot, groundedSnapshot),
      };
      const analystResult = await this.invoke("analyst", analyst.provider, run.id, () => analyst.analyze({
        query,
        location,
        language,
        packet,
        evidenceRefs: [
          { kind: "serp_snapshot", id: serpSnapshot.id, digest: serpSnapshot.snapshotDigest },
          ...(groundedSnapshotId
            ? [
                {
                  kind: "grounded_snapshot" as const,
                  id: groundedSnapshotId,
                  digest: groundedSnapshot!.snapshotDigest,
                },
              ]
            : []),
        ],
      }));

      await this.deps.searchStore.insertIntelligenceSnapshot({
        runId: run.id,
        projectId: input.projectId,
        acceptedInputSnapshotId: accepted.id,
        acceptedInputVersion: accepted.version,
        acceptedInputDigest: accepted.digest,
        query,
        model: analystResult.model,
        provider: analystResult.provider,
        promptVersion: analystResult.promptVersion,
        promptDigest: analystResult.promptDigest,
        serpSnapshotId: serpSnapshot.id,
        groundedSnapshotId,
        evidenceDigests: { serp: serpSnapshot.snapshotDigest, ...(groundedSnapshot ? { grounded: groundedSnapshot.snapshotDigest } : {}) },
        data: analystResult.data,
      });

      await this.deps.searchStore.finishRun(run.id, "succeeded", null, null);
      return await this.buildReadModel(input.projectId, run.id, accepted, false, Boolean(input.refresh));
    } catch (error) {
      const code =
        error instanceof FactoryError && error.code.startsWith("search_")
          ? error.code
          : "search_run_failed";
      const message =
        error instanceof FactoryError ? error.message : "Search run failed unexpectedly.";
      await this.deps.searchStore.finishRun(run.id, "failed", code, message);
      throw error;
    }
  }

  async runDetail(projectId: string, runId: string): Promise<SearchRunReadModel | null> {
    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const accepted = snapshots.at(-1) ?? null;
    const run = await this.deps.searchStore.getRun(projectId, runId);
    if (!run || !accepted) return null;
    return await this.buildReadModel(projectId, runId, accepted, false, run.refreshRequested);
  }

  /**
   * Cache reuse is recorded as its own run row (audit trail) without spend,
   * referencing the existing immutable SERP snapshot via requestDigest.
   */
  private async recordReusedRun(runInput: Parameters<SearchStore["createRun"]>[0]): Promise<string> {
    const run = await this.deps.searchStore.createRun(runInput);
    await this.deps.searchStore.finishRun(run.id, "succeeded", null, null);
    return run.id;
  }

  private async buildReadModel(
    projectId: string,
    runId: string,
    accepted: { id: string; version: number; digest: string },
    cacheReused: boolean,
    refreshRequested: boolean,
  ): Promise<SearchRunReadModel> {
    const run = (await this.deps.searchStore.getRun(projectId, runId))!;
    const evidenceRunId = run.sourceRunId ?? runId;
    const serp = await this.deps.searchStore.getSerpSnapshot(projectId, evidenceRunId);
    const grounded = await this.deps.searchStore.getGroundedSnapshot(projectId, evidenceRunId);
    const intelligence = await this.deps.searchStore.getIntelligenceSnapshot(projectId, evidenceRunId);
    cacheReused = Boolean(run.sourceRunId);

    const snapshots = await this.deps.intake.listSnapshots(projectId);
    const latestVersion = snapshots.at(-1)?.version ?? accepted.version;

    return {
      run: {
        id: run.id,
        status: run.status === "succeeded" ? "succeeded" : "failed",
        query: run.query,
        location: run.location,
        language: run.language,
        device: run.device as SearchDevice,
        provider: run.provider,
        cacheReused,
        refreshRequested,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        durationMs: run.durationMs,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
      },
      acceptedInput: {
        snapshotId: run.acceptedInputSnapshotId,
        version: run.acceptedInputVersion,
        digest: run.acceptedInputDigest,
        stale: run.acceptedInputVersion < latestVersion,
      },
      serp:
        serp && serp.runId === evidenceRunId
          ? {
              snapshotId: serp.id,
              snapshotDigest: serp.snapshotDigest,
              observedAt: serp.observedAt.toISOString(),
              provider: serp.provider,
              providerRequestId: serp.providerRequestId,
              organic: serp.organic as SearchRunReadModel["serp"] extends { organic: infer T }
                ? T
                : never,
              features: (serp.features as string[] | null) ?? null,
              peopleAlsoAsk:
                (serp.peopleAlsoAsk as SearchRunReadModel["serp"] extends {
                  peopleAlsoAsk: infer T;
                }
                  ? T
                  : never) ?? null,
              relatedSearches: (serp.relatedSearches as string[] | null) ?? null,
              rawDigest: serp.rawDigest,
              usage: (serp.usage as SearchUsage | null) ?? null,
            }
          : null,
      grounded: grounded
        ? {
            snapshotId: grounded.id,
            snapshotDigest: grounded.snapshotDigest,
            model: grounded.model,
            promptVersion: grounded.promptVersion,
            observedAt: grounded.observedAt.toISOString(),
            webSearchQueries: grounded.webSearchQueries as string[],
            sources: grounded.sources as Array<{ title?: string; uri: string }>,
          }
        : null,
      intelligence: intelligence
        ? {
            snapshotId: intelligence.id,
            snapshotDigest: intelligence.snapshotDigest,
            model: intelligence.model,
            promptVersion: intelligence.promptVersion,
            data: intelligence.data as Record<string, unknown>,
          }
        : null,
    };
  }
}

/**
 * Compile the bounded provider packet: only accepted project facts relevant
 * to search analysis — never the whole repository or provider plumbing.
 */
export function compilePacket(
  payload: Record<string, unknown>,
  query: string,
  location: string | null,
  language: string | null,
): Record<string, unknown> {
  const business = (payload.business ?? {}) as Record<string, unknown>;
  const audience = (payload.audience ?? {}) as Record<string, unknown>;
  const markets = (payload.markets ?? {}) as Record<string, unknown>;
  const evidence = (payload.evidence ?? {}) as Record<string, unknown>;
  const searchSeeds = (payload.searchSeeds ?? {}) as Record<string, unknown>;
  return {
    business: {
      name: business.name ?? "",
      description: business.description ?? "",
      businessModel: business.businessModel ?? "",
      offerings: business.offerings ?? [],
    },
    audience: { segments: audience.segments ?? [], needs: audience.needs ?? [] },
    markets: {
      geographies: markets.geographies ?? [],
      priorityLocations: markets.priorityLocations ?? [],
    },
    evidence: {
      operatorFacts: ((evidence.operatorFacts ?? []) as string[]).slice(0, 10),
      allowedClaims: ((evidence.allowedClaims ?? []) as string[]).slice(0, 10),
    },
    searchSeeds: {
      topics: searchSeeds.topics ?? [],
      queries: searchSeeds.queries ?? [],
    },
    searchTask: { query, location, language },
  };
}

/** Persisted evidence only; ranking measurements and grounded research stay separate.
 * Full evidence digests remain bound even when the prompt packet is truncated.
 */
export function compileAnalystEvidence(
  serp: { id: string; snapshotDigest: string; organic: unknown; features: unknown; peopleAlsoAsk: unknown; relatedSearches: unknown },
  grounded: { id: string; snapshotDigest: string; sources: unknown; structuredOutput?: unknown; webSearchQueries: unknown } | null,
): Record<string, unknown> {
  let truncated = false;
  let remainingChars = 24000;
  let remainingNodes = 500;
  const bounded = (value: unknown, depth = 0): unknown => {
    if (--remainingNodes < 0 || remainingChars <= 0) { truncated = true; return null; }
    if (typeof value === "string") { const size = Math.min(2000, remainingChars); if (value.length > size) truncated = true; const text = value.slice(0, size); remainingChars -= text.length; return text; }
    if (value == null || typeof value !== "object") return value ?? null;
    if (depth >= 6) { truncated = true; return null; }
    if (Array.isArray(value)) { if (value.length > 30) truncated = true; return value.slice(0, 30).map(v => bounded(v, depth + 1)); }
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.length > 30) truncated = true;
    return Object.fromEntries(entries.slice(0, 30).map(([k,v]) => [k, bounded(v, depth + 1)]));
  };
  const measurement = bounded({ organic: serp.organic, features: serp.features, peopleAlsoAsk: serp.peopleAlsoAsk, relatedSearches: serp.relatedSearches });
  const research = grounded ? bounded({ sources: grounded.sources, structuredOutput: grounded.structuredOutput, webSearchQueries: grounded.webSearchQueries }) : null;
  return { packetVersion: "search-evidence-v1", truncated,
    serp: { id: serp.id, digest: serp.snapshotDigest, measurement },
    grounded: grounded ? { id: grounded.id, digest: grounded.snapshotDigest, research } : null };
}
