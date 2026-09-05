import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createOperatorServer } from "../../src/operator/server.js";
import type { OperatorApiDeps } from "../../src/operator/api.js";
import type { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import type { ProjectRecord } from "../../src/persistence/schema.js";
import type { SearchIntelligenceService } from "../../src/search/service.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * Search Operator API security + contract tests (no DB, no provider calls).
 *
 * The real HTTP server is exercised with a stubbed SearchIntelligenceService
 * so the API surface (routes, error contract, sanitization, provider-plumbing
 * rejection) is verified in isolation.
 */

const PROJECT: ProjectRecord = {
  id: "p-1",
  key: "acme",
  name: "Acme",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeSearchStub(overrides: Partial<SearchIntelligenceService> = {}): SearchIntelligenceService {
  return {
    workspace: async () => ({
      acceptedInput: {
        snapshotId: "snap-1",
        version: 1,
        digest: "d".repeat(64),
        acceptedAt: "2026-09-05T00:00:00.000Z",
      },
      seeds: { topics: ["roofing"], queries: ["roof repair"], competitors: [], marketHints: [] },
      readiness: {
        canRun: true,
        providerConfigured: true,
        providerReason: null,
        providerMode: "production",
        blockers: [],
      },
      recentRuns: [],
    }),
    runSearch: async () => ({
      run: {
        id: "run-1",
        status: "succeeded",
        query: "roof repair",
        location: null,
        language: null,
        device: "desktop",
        provider: "dataforseo",
        cacheReused: false,
        refreshRequested: false,
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:00:01.000Z",
        durationMs: 1000,
        errorCode: null,
        errorMessage: null,
      },
      acceptedInput: { snapshotId: "snap-1", version: 1, digest: "d".repeat(64), stale: false },
      serp: null,
      grounded: null,
      intelligence: null,
    }),
    runDetail: async () => null,
  } as unknown as SearchIntelligenceService;
}

function makeDeps(search: SearchIntelligenceService | null): OperatorApiDeps {
  const store = {
    getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
    getProjectByKey: async () => null,
    createProject: async () => ({ ...PROJECT, id: "new-1" }),
    listProjects: async () => [PROJECT],
  };
  const intake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
    getSnapshot: async () => null,
  } as unknown as ProjectIntakeStore;
  return {
    store: store as unknown as OperatorApiDeps["store"],
    intake,
    ...(search ? { search } : {}),
  };
}

async function listen(deps: OperatorApiDeps): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createOperatorServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function apiRequest(
  port: number,
  opts: { method?: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test("search workspace returns accepted input, seeds, readiness", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const res = await apiRequest(h.port, { path: "/api/projects/p-1/search/workspace" });
    assert.equal(res.status, 200);
    const ws = JSON.parse(res.body);
    assert.equal(ws.acceptedInput.version, 1);
    assert.deepEqual(ws.seeds.queries, ["roof repair"]);
    assert.equal(ws.readiness.canRun, true);
  } finally {
    await h.close();
  }
});

test("search run executes and returns bounded read-model", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "roof repair", device: "desktop" }),
    });
    assert.equal(res.status, 200);
    const run = JSON.parse(res.body);
    assert.equal(run.run.status, "succeeded");
    assert.equal(run.run.query, "roof repair");
  } finally {
    await h.close();
  }
});

test("search run on unknown project returns 404", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/unknown/search/runs",
      body: JSON.stringify({ query: "x", device: "desktop" }),
    });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, "not_found");
  } finally {
    await h.close();
  }
});

test("search unavailable (no service wired) returns 404 not_found", async () => {
  const h = await listen(makeDeps(null));
  try {
    const res = await apiRequest(h.port, { path: "/api/projects/p-1/search/workspace" });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test("search run rejects invalid body (validation_error)", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const bad = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "", device: "desktop" }),
    });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, "validation_error");

    const plumbing = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "x", device: "desktop", provider: "dataforseo", apiKey: "sk-evil" }),
    });
    assert.equal(plumbing.status, 400);
    assert.equal(JSON.parse(plumbing.body).error.code, "validation_error");

    const wrongDevice = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "x", device: "satellite" }),
    });
    assert.equal(wrongDevice.status, 400);
  } finally {
    await h.close();
  }
});

test("typed search errors pass through with contract statuses", async () => {
  const failing: SearchIntelligenceService = {
    runSearch: async () => {
      // Mirror the real service: typed failures are FactoryErrors with
      // search-domain codes, which the API maps onto contract statuses.
      throw new FactoryError("search_input_not_accepted", "no accepted inputs");
    },
  } as unknown as SearchIntelligenceService;
  const h = await listen(makeDeps(failing));
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "x", device: "desktop" }),
    });
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).error.code, "search_input_not_accepted");
  } finally {
    await h.close();
  }
});

test("unexpected search failure is sanitized to internal_error", async () => {
  const failing: SearchIntelligenceService = {
    runSearch: async () => {
      throw new Error("DATAFORSEO_PASSWORD=supersecret leaked");
    },
  } as unknown as SearchIntelligenceService;
  const h = await listen(makeDeps(failing));
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      body: JSON.stringify({ query: "x", device: "desktop" }),
    });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, "internal_error");
    assert.ok(!res.body.includes("supersecret"));
  } finally {
    await h.close();
  }
});

test("unknown run detail returns search_run_not_found (404)", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const res = await apiRequest(h.port, { path: "/api/projects/p-1/search/runs/nope" });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, "search_run_not_found");
  } finally {
    await h.close();
  }
});

test("search mutations respect same-origin policy", async () => {
  const h = await listen(makeDeps(makeSearchStub()));
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects/p-1/search/runs",
      headers: { Origin: "https://evil.example.com" },
      body: JSON.stringify({ query: "x", device: "desktop" }),
    });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, "cross_origin_forbidden");
  } finally {
    await h.close();
  }
});
