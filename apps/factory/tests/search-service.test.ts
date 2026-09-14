import { WriterBudgetStore } from "../src/writer/budget.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  SearchIntelligenceService,
  compilePacket,
  type SearchServiceConfig,
} from "../src/search/service.js";
import type {
  StructuredSerpProvider,
  SerpAcquisitionRequest,
  SerpAcquisitionResult,
  SerpProviderReadiness,
} from "../src/search/provider-types.js";
import type { GroundedSearchProvider, GroundedResearchRequest } from "../src/search/grounded-types.js";
import type { SearchAnalystModel } from "../src/search/analyst.js";
import { buildIntakePayload } from "./fixtures/intake-payloads.js";
import { FactoryError } from "../src/executor/errors.js";

// ---------------------------------------------------------------------------
// Deterministic in-memory fakes (service-level behavior tests, no DB)
// ---------------------------------------------------------------------------

function fakeSerp(overrides: {
  readiness?: SerpProviderReadiness;
  acquire?: (r: SerpAcquisitionRequest) => Promise<SerpAcquisitionResult>;
} = {}): StructuredSerpProvider & { calls: number } {
  const state = { calls: 0 };
  const provider = {
    id: "fake-serp",
    readiness: async () => overrides.readiness ?? { configured: true },
    acquire: async (r: SerpAcquisitionRequest) => {
      state.calls++;
      if (overrides.acquire) return await overrides.acquire(r);
      return {
        data: {
          organic: [
            {
              position: 1,
              url: "https://x.example.com/",
              domain: "x.example.com",
              title: "X",
              snippet: "s",
            },
          ],
        },
        rawPayload: { fake: true },
        providerRequestId: "fake-1",
        observedAt: new Date("2026-09-06T00:00:00.000Z"),
        usage: { costMicros: 1000, currency: "USD" },
      };
    },
  };
  Object.defineProperty(provider, "calls", {
    get: () => state.calls,
    enumerable: true,
  });
  return provider as StructuredSerpProvider & { calls: number };
}

function fakeGrounded(overrides: { ready?: boolean } = {}): GroundedSearchProvider {
  return {
    id: "fake-grounded",
    model: "fake-gemini",
    readiness: () =>
      overrides.ready === false
        ? ({ configured: false, reason: "grounded unavailable" } as const)
        : ({ configured: true } as const),
    research: async (_r: GroundedResearchRequest) => ({
      data: {
        webSearchQueries: ["q"],
        sources: [{ title: "S", uri: "https://src.example.com/" }],
        structuredOutput: { summary: "ok" },
      },
      model: "fake-gemini",
      provider: "fake-grounded",
      promptVersion: "search-analyst-v1",
      promptDigest: "p".repeat(64),
      observedAt: new Date("2026-09-06T00:00:00.000Z"),
      usage: null,
    }),
  };
}

function fakeAnalyst(overrides: { analyze?: never } = {}): SearchAnalystModel {
  return {
    model: "fake-analyst",
    provider: "fake",
    promptVersion: "search-analyst-v1",
    promptDigest: "a".repeat(64),
    analyze: async (request) => ({
      data: {
        primaryIntent: "informational",
        intentRationale: "fixture",
        secondaryIntents: [],
        queryClusters: [
          {
            id: "c1",
            label: "L",
            queries: [request.query],
            intent: "informational",
            primaryQuery: request.query,
            secondaryQueries: [],
            confidence: 0.5,
          },
        ],
        longTailOpportunities: [],
        entities: [],
        topics: [],
        questions: [],
        modifiers: [],
        searchVocabulary: [],
        relatedConcepts: [],
        semanticCoverageRequirements: [],
        userNeeds: [],
        evidenceRefs: request.evidenceRefs,
        reviewState: "model_proposed" as const,
      },
      model: "fake-analyst",
      provider: "fake",
      promptVersion: "search-analyst-v1",
      promptDigest: "a".repeat(64),
      usage: null,
    }),
  };
}

/** Minimal in-memory stores mirroring the SearchStore/IntakeStore surface. */
function makeStores() {
  const accepted = {
    id: "snap-1",
    projectId: "p1",
    version: 1,
    sourceRevision: 1,
    payload: buildIntakePayload(),
    digest: "d".repeat(64),
    acceptedBy: "operator",
    acceptanceState: "human_accepted",
    provenance: {},
    acceptedAt: new Date("2026-09-05T00:00:00.000Z"),
    alreadyAccepted: true,
  };
  const intake = {
    listSnapshots: async (_projectId: string) => [accepted],
  };
  let runSeq = 0;
  const runs: Array<Record<string, unknown>> = [];
  const serps: Array<Record<string, unknown>> = [];
  const grounded: Array<Record<string, unknown>> = [];
  const intel: Array<Record<string, unknown>> = [];
  const searchStore = {
    budget: new WriterBudgetStore({} as never),
    sumTodaySearchCostMicros: async () => spentToday,
    findFreshSerp: async (_digest: string, _hours: number) => {
      if (!freshSerp) return null;
      // Fabricate the historical succeeded run + SERP the cache would return.
      const cachedRun = runs[0] ?? {
        id: "run-cached",
        status: "succeeded",
        query: RUN.query,
        provider: "fake-serp",
        startedAt: new Date("2026-09-06T00:00:00.000Z"),
        finishedAt: new Date("2026-09-06T00:00:01.000Z"),
        durationMs: 1000,
        errorCode: null,
        errorMessage: null,
        refreshRequested: false,
        acceptedInputSnapshotId: "snap-1",
        acceptedInputVersion: 1,
        acceptedInputDigest: "d".repeat(64),
        location: null,
        language: null,
        device: "desktop",
      };
      const cachedSerp = serps[0] ?? {
        id: "serp-cached",
        snapshotDigest: "a".repeat(64),
        runId: "run-cached",
        provider: "fake-serp",
        observedAt: new Date("2026-09-06T00:00:00.000Z"),
        providerRequestId: "fake-1",
        organic: [],
        features: null,
        peopleAlsoAsk: null,
        relatedSearches: null,
        usage: null,
      };
      return { run: cachedRun, serp: cachedSerp };
    },
    createRun: async (input: Record<string, unknown>) => {
      const run = {
        id: `run-${++runSeq}`,
        status: "running",
        startedAt: new Date("2026-09-06T00:00:00.000Z"),
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        refreshRequested: false,
        ...input,
      };
      runs.push(run);
      return run;
    },
    finishRun: async (runId: string, status: string, errorCode: string | null, errorMessage: string | null) => {
      const run = runs.find((r) => r.id === runId)!;
      run.status = status;
      run.errorCode = errorCode;
      run.errorMessage = errorMessage;
      run.finishedAt = new Date("2026-09-06T00:00:01.000Z");
      run.durationMs = 1000;
    },
    insertSerpSnapshot: async (input: { data: { organic: unknown[]; features: unknown; peopleAlsoAsk: unknown; relatedSearches: unknown }; usage: unknown; runId: string; provider: string | null }) => {
      const snap = {
        id: `serp-${serps.length + 1}`,
        snapshotDigest: "a".repeat(64),
        rawDigest: "r".repeat(64),
        observedAt: new Date("2026-09-06T00:00:00.000Z"),
        providerRequestId: "fake-1",
        runId: input.runId,
        provider: input.provider,
        organic: input.data.organic,
        features: input.data.features,
        peopleAlsoAsk: input.data.peopleAlsoAsk,
        relatedSearches: input.data.relatedSearches,
        usage: input.usage,
      };
      serps.push(snap);
      return snap;
    },
    insertGroundedSnapshot: async (input: { data: { webSearchQueries: unknown; sources: unknown }; runId: string; model: string; promptVersion: string }) => {
      const snap = {
        id: `g-${grounded.length + 1}`,
        snapshotDigest: "b".repeat(64),
        runId: input.runId,
        model: input.model,
        promptVersion: input.promptVersion,
        observedAt: new Date("2026-09-06T00:00:00.000Z"),
        webSearchQueries: input.data.webSearchQueries,
        sources: input.data.sources,
      };
      grounded.push(snap);
      return snap;
    },
    insertIntelligenceSnapshot: async (input: { data: unknown; runId: string; model: string; promptVersion: string }) => {
      const snap = {
        id: `i-${intel.length + 1}`,
        snapshotDigest: "i".repeat(64),
        runId: input.runId,
        model: input.model,
        promptVersion: input.promptVersion,
        data: input.data,
      };
      intel.push(snap);
      return snap;
    },
    getRun: async (_projectId: string, runId: string) =>
      runs.find((r) => r.id === runId) ??
      (runId === "run-cached"
        ? {
            id: "run-cached",
            status: "succeeded",
            query: RUN.query,
            provider: "fake-serp",
            startedAt: new Date("2026-09-06T00:00:00.000Z"),
            finishedAt: new Date("2026-09-06T00:00:01.000Z"),
            durationMs: 1000,
            errorCode: null,
            errorMessage: null,
            refreshRequested: false,
            acceptedInputSnapshotId: "snap-1",
            acceptedInputVersion: 1,
            acceptedInputDigest: "d".repeat(64),
            location: null,
            language: null,
            device: "desktop",
            projectId: "p1",
          }
        : null),
    listRuns: async () => runs,
    getSerpSnapshot: async (_projectId: string, runId: string) =>
      serps.find((s) => s.runId === runId) ?? null,
    getGroundedSnapshot: async (_projectId: string, runId: string) =>
      grounded.find((s) => s.runId === runId) ?? null,
    getIntelligenceSnapshot: async (_projectId: string, runId: string) =>
      intel.find((s) => s.runId === runId) ?? null,
  };
  let spentToday = 0;
  let freshSerp = false;
  return {
    intake,
    searchStore,
    state: {
      get spentToday() {
        return spentToday;
      },
      set spentToday(v: number) {
        spentToday = v;
      },
      get freshSerp() {
        return freshSerp;
      },
      set freshSerp(v: boolean) {
        freshSerp = v;
      },
      runs,
      serps,
      grounded,
      intel,
      accepted,
    },
  };
}

function makeService(
  stores: ReturnType<typeof makeStores>,
  serp: StructuredSerpProvider,
  overrides: {
    grounded?: GroundedSearchProvider | null;
    analyst?: SearchAnalystModel;
    config?: Partial<SearchServiceConfig>;
  } = {},
) {
  return new SearchIntelligenceService({
    intake: stores.intake as never,
    searchStore: stores.searchStore as never,
    productionSerpProvider: serp,
    groundedProvider: overrides.grounded === undefined ? fakeGrounded() : overrides.grounded,
    analyst: overrides.analyst ?? fakeAnalyst(),
    config: { authorizedMicros: { serp: 10000, grounded: 10000, analyst: 10000 }, ...overrides.config },
  });
}

const RUN = {
  projectId: "p1",
  query: "roof repair austin",
  device: "desktop" as const,
};

test("service: full run persists serp + grounded + intelligence and returns read-model", async () => {
  const stores = makeStores();
  const serp = fakeSerp();
  const service = makeService(stores, serp);
  const result = await service.runSearch(RUN);

  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.cacheReused, false);
  assert.equal(result.acceptedInput.version, 1);
  assert.equal(result.acceptedInput.stale, false);
  assert.ok(result.serp);
  assert.equal(result.serp!.organic.length, 1);
  assert.ok(result.grounded);
  assert.equal(result.grounded!.webSearchQueries.length, 1);
  assert.ok(result.intelligence);
  assert.equal(result.intelligence!.model, "fake-analyst");
  assert.equal(stores.state.serps.length, 1);
  assert.equal(stores.state.intel.length, 1);
});

test("service: no accepted inputs fails closed with search_input_not_accepted", async () => {
  const stores = makeStores();
  stores.intake.listSnapshots = async () => [];
  const service = makeService(stores, fakeSerp());
  await assert.rejects(
    () => service.runSearch(RUN),
    (e: { code: string }) => e.code === "search_input_not_accepted",
  );
});

test("service: blank query rejected", async () => {
  const stores = makeStores();
  const service = makeService(stores, fakeSerp());
  await assert.rejects(
    () => service.runSearch({ ...RUN, query: "   " }),
    (e: { code: string }) => e.code === "search_query_invalid",
  );
});

test("service: unconfigured provider fails before spend", async () => {
  const stores = makeStores();
  const serp = fakeSerp({
    readiness: { configured: false, reason: "no creds" },
  });
  const service = makeService(stores, serp);
  await assert.rejects(
    () => service.runSearch(RUN),
    (e: { code: string }) => e.code === "search_provider_not_configured",
  );
  assert.equal(stores.state.runs.length, 0);
});

test("service: budget blocked when today's spend reaches the limit", async () => {
  const stores = makeStores();
  stores.state.spentToday = 5 * 1_000_000;
  const service = makeService(stores, fakeSerp());
  await assert.rejects(
    () => service.runSearch(RUN),
    (e: { code: string }) => e.code === "search_provider_budget_blocked",
  );
});

test("service: cache reuse does not call the provider", async () => {
  const stores = makeStores();
  stores.state.freshSerp = true;
  const serp = fakeSerp();
  const service = makeService(stores, serp);
  const result = await service.runSearch(RUN);
  assert.equal(result.run.cacheReused, true);
  assert.equal((serp as unknown as { calls: number }).calls, 0);
});

test("service: refresh bypasses cache and creates a new observation", async () => {
  const stores = makeStores();
  stores.state.freshSerp = true;
  const serp = fakeSerp();
  const service = makeService(stores, serp);
  const result = await service.runSearch({ ...RUN, refresh: true });
  assert.equal(result.run.cacheReused, false);
  assert.equal(result.run.refreshRequested, true);
  assert.equal((serp as unknown as { calls: number }).calls, 1);
});

test("service: provider failure marks run failed with typed code and no snapshots", async () => {
  const stores = makeStores();
  const serp = fakeSerp({
    acquire: async () => {
      throw new FactoryError("search_provider_unavailable", "provider down");
    },
  });
  const service = makeService(stores, serp);
  await assert.rejects(
    () => service.runSearch(RUN),
    (e: { code: string }) => e.code === "search_provider_unavailable",
  );
  const run = stores.state.runs[0]!
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "search_provider_unavailable");
  assert.equal(stores.state.serps.length, 0);
  assert.equal(stores.state.intel.length, 0);
});

test("service: analyst invalid output fails the run with search_intelligence_invalid", async () => {
  const stores = makeStores();
  const badAnalyst: SearchAnalystModel = {
    ...fakeAnalyst(),
    analyze: async () => {
      throw new FactoryError("search_intelligence_invalid", "bad output");
    },
  };
  const service = makeService(stores, fakeSerp(), { analyst: badAnalyst });
  await assert.rejects(
    () => service.runSearch(RUN),
    (e: { code: string }) => e.code === "search_intelligence_invalid",
  );
  const run = stores.state.runs[0]!
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "search_intelligence_invalid");
});

test("service: grounded provider absent → run succeeds with grounded=null", async () => {
  const stores = makeStores();
  const service = makeService(stores, fakeSerp(), { grounded: null });
  const result = await service.runSearch(RUN);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.grounded, null);
  assert.ok(result.intelligence);
});

test("service: workspace exposes seeds, readiness and accepted input in human terms", async () => {
  const stores = makeStores();
  const service = makeService(stores, fakeSerp());
  const ws = await service.workspace("p1");
  assert.equal(ws.acceptedInput!.version, 1);
  assert.ok(Array.isArray(ws.seeds.queries));
  assert.equal(ws.readiness.canRun, true);
  assert.equal(ws.readiness.providerConfigured, true);
  assert.equal(ws.readiness.providerMode, "production");
});

test("service: workspace names the missing provider without leaking secrets", async () => {
  const stores = makeStores();
  const service = makeService(
    stores,
    fakeSerp({ readiness: { configured: false, reason: "credentials missing" } }),
  );
  const ws = await service.workspace("p1");
  assert.equal(ws.readiness.canRun, false);
  assert.equal(ws.readiness.providerReason, "credentials missing");
  assert.ok(!JSON.stringify(ws).includes("password"));
});

test("compilePacket: bounded packet contains project facts, not plumbing", () => {
  const payload = buildIntakePayload() as unknown as Record<string, unknown>;
  const packet = compilePacket(payload, "roof repair", "Austin", "en");
  const json = JSON.stringify(packet);
  assert.ok(json.includes("roof repair"));
  assert.ok(!json.includes("customWriterInstructions"));
  assert.ok(!json.includes("designReferences"));
});

test("P1-A/B: persisted evidence reaches analyst and grounded lineage is exact", async () => {
  const stores = makeStores();
  let captured: Parameters<SearchAnalystModel["analyze"]>[0] | undefined;
  const analyst = fakeAnalyst();
  const analyze = analyst.analyze;
  analyst.analyze = async request => { captured = request; return analyze(request); };
  await makeService(stores, fakeSerp(), { analyst }).runSearch(RUN);
  assert.ok(JSON.stringify(captured?.packet).includes("https://x.example.com/"));
  assert.equal(captured?.evidenceRefs.find(r => r.kind === "grounded_snapshot")?.digest,
    stores.state.grounded[0]!.snapshotDigest);
});

test("P1-C: cache response identifies the new audit run", async () => {
  const stores = makeStores();
  const service = makeService(stores, fakeSerp());
  const original = await service.runSearch(RUN);
  stores.state.freshSerp = true;
  const reused = await service.runSearch(RUN);
  assert.notEqual(reused.run.id, original.run.id);
  assert.equal(reused.run.id, stores.state.runs.at(-1)!.id);
  assert.equal(reused.serp?.snapshotId, original.serp?.snapshotId);
  assert.deepEqual(await service.runDetail("p1", reused.run.id), reused);
});

test("P1-A: same IDs/query with altered persisted SERP changes actual analyst prompt digest", async () => {
  const { FixtureSearchAnalyst } = await import("../src/search/analyst.js");
  const digests: string[] = [];
  for (const snippet of ["Original measured snippet", "Changed measured snippet"]) {
    const stores = makeStores();
    const provider = fakeSerp();
    const acquire = provider.acquire;
    provider.acquire = async request => { const result = await acquire(request); result.data.organic[0]!.snippet = snippet; return result; };
    const analyst = new FixtureSearchAnalyst();
    const analyze = analyst.analyze.bind(analyst);
    analyst.analyze = async request => { const result = await analyze(request); digests.push(result.promptDigest); return result; };
    await makeService(stores, provider, { analyst }).runSearch(RUN);
  }
  assert.notEqual(digests[0], digests[1]);
});

test("P1-D: unknown cost and submitted failures consume reservations; pre-submission releases", async () => {
  const { InvocationFailure } = await import("../src/models/invocation-failure.js");
  for (const submitted of [true, false]) {
    const stores = makeStores();
    const provider = fakeSerp({ acquire: async () => { throw new InvocationFailure("search_run_failed", "test failure", { requestSubmitted: submitted }); } });
    await assert.rejects(makeService(stores, provider).runSearch(RUN));
    assert.equal((await stores.searchStore.budget.getWriterBudgetSummary()).accountedTodayMicros, submitted ? 10000 : 0);
    assert.equal((await stores.searchStore.budget.getWriterBudgetSummary()).activeReservationMicros, 0);
  }
  const stores = makeStores(), provider = fakeSerp();
  const acquire = provider.acquire;
  provider.acquire = async request => ({ ...await acquire(request), usage: null });
  await makeService(stores, provider).runSearch(RUN);
  assert.equal((await stores.searchStore.budget.getWriterBudgetSummary()).accountedTodayMicros, 30000);
});
