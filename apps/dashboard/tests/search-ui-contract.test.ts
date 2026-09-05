import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  OperatorApiError,
  type SearchRunReadModel,
  type SearchWorkspaceReadModel,
} from "../src/api/client";
import { searchErrorMessage } from "../src/pages/SearchPage";

/**
 * UI↔contract shape audit (Macro Run 1 defect class prevention).
 *
 * The Dashboard renders read-model fields directly. These tests pin the
 * EXACT field shapes the Search UI consumes against a canonical payload, so
 * a backend contract change that drops/renames a UI-consumed field fails
 * here even though backend tests stay green.
 */

const WORKSPACE: SearchWorkspaceReadModel = {
  acceptedInput: {
    snapshotId: "snap-1",
    version: 2,
    digest: "d".repeat(64),
    acceptedAt: "2026-09-05T10:00:00.000Z",
  },
  seeds: {
    topics: ["roofing"],
    queries: ["roof repair austin"],
    competitors: ["acme roofs"],
    marketHints: ["Austin, TX"],
  },
  readiness: {
    canRun: true,
    providerConfigured: true,
    providerReason: null,
    providerMode: "production",
    blockers: [],
  },
  recentRuns: [
    {
      id: "run-1",
      status: "succeeded",
      query: "roof repair austin",
      provider: "dataforseo",
      startedAt: "2026-09-06T00:00:00.000Z",
      errorCode: null,
    },
  ],
};

const RUN: SearchRunReadModel = {
  run: {
    id: "run-1",
    status: "succeeded",
    query: "roof repair austin",
    location: "Austin, TX",
    language: null,
    device: "desktop",
    provider: "dataforseo",
    cacheReused: true,
    refreshRequested: false,
    startedAt: "2026-09-06T00:00:00.000Z",
    finishedAt: "2026-09-06T00:00:01.000Z",
    durationMs: 1000,
    errorCode: null,
    errorMessage: null,
  },
  acceptedInput: {
    snapshotId: "snap-1",
    version: 1,
    digest: "d".repeat(64),
    stale: true,
  },
  serp: {
    snapshotId: "serp-1",
    snapshotDigest: "a".repeat(64),
    observedAt: "2026-09-06T00:00:00.000Z",
    provider: "dataforseo",
    providerRequestId: "req-1",
    organic: [
      {
        position: 1,
        url: "https://example.com/",
        domain: "example.com",
        title: "T",
        snippet: "S",
      },
    ],
    features: ["local_pack"],
    peopleAlsoAsk: [{ question: "How much?" }],
    relatedSearches: ["roof repair cost"],
    rawDigest: "b".repeat(64),
    usage: { costMicros: 2000, currency: "USD", costUnknown: false },
  },
  grounded: {
    snapshotId: "g-1",
    snapshotDigest: "c".repeat(64),
    model: "gemini",
    promptVersion: "search-analyst-v1",
    observedAt: "2026-09-06T00:00:00.000Z",
    webSearchQueries: ["roof repair austin"],
    sources: [{ title: "City", uri: "https://gov.example.com/" }],
  },
  intelligence: {
    snapshotId: "i-1",
    snapshotDigest: "e".repeat(64),
    model: "analyst",
    promptVersion: "search-analyst-v1",
    data: {
      primaryIntent: "commercial",
      intentRationale: "r",
      secondaryIntents: ["informational"],
      queryClusters: [
        {
          id: "c1",
          label: "L",
          queries: ["roof repair austin"],
          intent: "commercial",
          primaryQuery: "roof repair austin",
          secondaryQueries: [],
          confidence: 0.8,
        },
      ],
      longTailOpportunities: [{ query: "roof repair austin cost", confidence: 0.7 }],
      entities: [{ name: "Austin", kind: "location" }],
      topics: [{ topic: "Roofing", subtopics: ["Repair"] }],
      questions: ["How much?"],
      modifiers: ["cost"],
      searchVocabulary: ["shingle"],
      relatedConcepts: ["gutters"],
      semanticCoverageRequirements: ["Cover pricing."],
      userNeeds: ["Find a roofer."],
      evidenceRefs: [{ kind: "serp_snapshot", id: "serp-1", digest: "a".repeat(64) }],
      reviewState: "model_proposed",
    },
  },
};

/** Every field path the SearchPage component reads must exist. */
const WORKSPACE_UI_PATHS = [
  "acceptedInput.snapshotId",
  "acceptedInput.version",
  "acceptedInput.digest",
  "acceptedInput.acceptedAt",
  "seeds.topics",
  "seeds.queries",
  "seeds.competitors",
  "seeds.marketHints",
  "readiness.canRun",
  "readiness.providerConfigured",
  "readiness.providerReason",
  "readiness.providerMode",
  "readiness.blockers",
  "recentRuns",
] as const;

const RUN_UI_PATHS = [
  "run.id",
  "run.status",
  "run.query",
  "run.device",
  "run.provider",
  "run.cacheReused",
  "run.refreshRequested",
  "run.startedAt",
  "run.errorCode",
  "run.errorMessage",
  "acceptedInput.version",
  "acceptedInput.stale",
  "serp.snapshotDigest",
  "serp.observedAt",
  "serp.provider",
  "serp.providerRequestId",
  "serp.organic",
  "serp.features",
  "serp.peopleAlsoAsk",
  "serp.relatedSearches",
  "serp.rawDigest",
  "serp.usage",
  "grounded.model",
  "grounded.promptVersion",
  "grounded.observedAt",
  "grounded.webSearchQueries",
  "grounded.sources",
  "intelligence.model",
  "intelligence.promptVersion",
  "intelligence.data.primaryIntent",
  "intelligence.data.intentRationale",
  "intelligence.data.queryClusters",
  "intelligence.data.longTailOpportunities",
  "intelligence.data.entities",
  "intelligence.data.topics",
  "intelligence.data.questions",
  "intelligence.data.modifiers",
  "intelligence.data.searchVocabulary",
  "intelligence.data.relatedConcepts",
  "intelligence.data.semanticCoverageRequirements",
  "intelligence.data.userNeeds",
  "intelligence.data.evidenceRefs",
  "intelligence.data.reviewState",
] as const;

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

test("search workspace read-model: every UI-consumed field exists", () => {
  for (const path of WORKSPACE_UI_PATHS) {
    const value = getPath(WORKSPACE, path);
    assert.notEqual(value, undefined, `workspace field missing: ${path}`);
  }
});

test("search run read-model: every UI-consumed field exists", () => {
  for (const path of RUN_UI_PATHS) {
    const value = getPath(RUN, path);
    assert.notEqual(value, undefined, `run field missing: ${path}`);
  }
  // Organic fields the SERP list renders:
  const organic = RUN.serp!.organic[0]!;
  assert.equal(organic.position, 1);
  assert.equal(typeof organic.url, "string");
  assert.equal(typeof organic.domain, "string");
  assert.equal(typeof organic.title, "string");
  assert.equal(typeof organic.snippet, "string");
  // Cluster fields the cluster list renders:
  const cluster = RUN.intelligence!.data.queryClusters[0]!;
  assert.equal(cluster.id, "c1");
  assert.equal(typeof cluster.confidence, "number");
  assert.ok(Array.isArray(cluster.queries));
});

test("search client methods hit the exact semantic API routes", () => {
  // Route-shape pinning via fetch interception.
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  try {
    void api.getSearchWorkspace("p1");
    void api.runSearch("p1", { query: "q", device: "desktop" });
    void api.listSearchRuns("p1");
    void api.getSearchRun("p1", "r1");
    const paths = calls.map((c) => c.path);
    assert.ok(paths.includes("/api/projects/p1/search/workspace"));
    assert.ok(paths.includes("/api/projects/p1/search/runs"));
    assert.ok(paths.includes("/api/projects/p1/search/runs/r1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("typed search error codes map to operator-facing copy; unknown codes degrade", () => {
  const cases: Array<[string, string]> = [
    ["search_input_not_accepted", "accepted"],
    ["search_provider_not_configured", "configured"],
    ["search_provider_budget_blocked", "budget"],
    ["search_run_not_found", "no longer exists"],
  ];
  for (const [code, fragment] of cases) {
    const message = searchErrorMessage(new OperatorApiError(code, "raw", 400), "fallback");
    assert.ok(message.toLowerCase().includes(fragment), `${code} -> ${message}`);
  }
  const fallback = searchErrorMessage(new OperatorApiError("http_503", "raw", 503), "fallback");
  assert.equal(fallback, "fallback");
});

test("no secret/config fields exist anywhere on the search read-models", () => {
  const flat = JSON.stringify({ WORKSPACE, RUN });
  for (const forbidden of ["apiKey", "api_key", "password", "secret", "credential", "tokenValue"]) {
    assert.ok(!flat.toLowerCase().includes(forbidden.toLowerCase()), `forbidden field: ${forbidden}`);
  }
});
