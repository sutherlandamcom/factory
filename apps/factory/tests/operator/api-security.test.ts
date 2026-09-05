import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createOperatorServer } from "../../src/operator/server.js";
import { createOperatorApi, type OperatorApiDeps } from "../../src/operator/api.js";
import { getProjectOperatorWorkspace } from "../../src/operator/workspace.js";
import type { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import type { ProjectRecord } from "../../src/persistence/schema.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";

/**
 * Operator API security + error-contract acceptance (local trusted topology).
 *
 * These tests exercise the REAL HTTP server (security middleware, static
 * serving, body limits, host/origin policy) with stubbed store/intake
 * dependencies, so no database is required and no provider call can happen.
 * Database-backed stale/blocked acceptance semantics are covered by
 * tests/persistence/intake-persistence.test.ts.
 */

const PROJECT: ProjectRecord = {
  id: "p-1",
  key: "acme",
  name: "Acme",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeDeps(overrides: Partial<OperatorApiDeps> = {}): OperatorApiDeps {
  const store = {
    createProject: async () => ({ ...PROJECT, id: "new-1" }),
    listProjects: async () => [PROJECT],
    getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
  };
  const intake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
    getSnapshot: async () => null,
  } as unknown as ProjectIntakeStore;
  return { store: store as unknown as OperatorApiDeps["store"], intake, ...overrides };
}

interface ListenHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function listen(deps: OperatorApiDeps, distDir?: string): Promise<ListenHandle> {
  const server = createOperatorServer(deps, distDir ? { distDir } : undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function rawRequest(
  port: number,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function apiRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return rawRequest(port, {
    ...opts,
    headers: {
      Host: `127.0.0.1:${port}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
}

test("server binds 127.0.0.1 by default (startOperatorServer default host)", async () => {
  // The trusted operator default is a loopback bind; assert the source-level
  // contract directly so no external interface is ever bound implicitly.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/operator/server.ts", import.meta.url), "utf8");
  assert.match(src, /FACTORY_OPERATOR_HOST \?\? "127\.0\.0\.1"/);
});

test("Host allowlist: non-local Host header is rejected with invalid_host", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await rawRequest(h.port, {
      path: "/api/projects",
      headers: { Host: "evil.example.com" },
    });
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, "invalid_host");
  } finally {
    await h.close();
  }
});

test("cross-origin mutation is rejected; GET with foreign Origin stays allowed", async () => {
  const h = await listen(makeDeps());
  try {
    const origin = "http://evil.example.com";
    const post = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Origin: origin },
      body: JSON.stringify({ key: "x", name: "X" }),
    });
    assert.equal(post.status, 403);
    assert.equal(JSON.parse(post.body).error.code, "cross_origin_forbidden");

    const put = await apiRequest(h.port, {
      method: "PUT",
      path: `/api/projects/p-1/intake-draft`,
      headers: { Origin: origin },
      body: JSON.stringify({ baseRevision: 0, payload: {} }),
    });
    assert.equal(put.status, 403);
    assert.equal(JSON.parse(put.body).error.code, "cross_origin_forbidden");

    // Reads are not state-changing; Origin policy does not gate them.
    const get = await apiRequest(h.port, {
      path: "/api/projects",
      headers: { Origin: origin },
    });
    assert.equal(get.status, 200);
  } finally {
    await h.close();
  }
});

test("missing Origin on mutation is deliberately allowed (non-browser clients)", async () => {
  // Documented policy: the operator API is loopback-only with a Host
  // allowlist; curl/service clients send no Origin and must keep working.
  // Browser cross-site requests always carry Origin and are rejected above.
  const h = await listen(makeDeps());
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify({ key: "newop", name: "New Operator Project" }),
    });
    assert.equal(res.status, 201);
    assert.equal(JSON.parse(res.body).id, "new-1");
  } finally {
    await h.close();
  }
});

test("same-origin mutation is allowed", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Origin: `http://127.0.0.1:${h.port}` },
      body: JSON.stringify({ key: "newop2", name: "Same Origin" }),
    });
    assert.equal(res.status, 201);
  } finally {
    await h.close();
  }
});

test("no CORS wildcard is ever emitted", async () => {
  const h = await listen(makeDeps());
  try {
    const preflight = await rawRequest(h.port, {
      method: "OPTIONS",
      path: "/api/projects",
      headers: { Host: `127.0.0.1:${h.port}`, Origin: "http://evil.example.com" },
    });
    assert.notEqual(preflight.headers["access-control-allow-origin"], "*");
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);

    const get = await apiRequest(h.port, { path: "/api/projects" });
    assert.equal(get.headers["access-control-allow-origin"], undefined);
  } finally {
    await h.close();
  }
});

test("mutation without JSON Content-Type is rejected (415)", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await rawRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Host: `127.0.0.1:${h.port}`, "Content-Type": "text/plain" },
      body: JSON.stringify({ key: "x", name: "X" }),
    });
    assert.equal(res.status, 415);
    assert.equal(JSON.parse(res.body).error.code, "unsupported_media_type");
  } finally {
    await h.close();
  }
});

test("invalid JSON body yields 400 invalid_json", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, "invalid_json");
  } finally {
    await h.close();
  }
});

test("oversized body is rejected with 413 payload_too_large", async () => {
  const h = await listen(makeDeps());
  try {
    const big = "x".repeat(256 * 1024 + 1);
    const res = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      body: `{"key":"x","name":"${big}"}`,
    });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).error.code, "payload_too_large");
  } finally {
    await h.close();
  }
});

test("strict validation: unknown fields and bad key shapes are rejected", async () => {
  const h = await listen(makeDeps());
  try {
    const unknown = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify({ key: "x1", name: "X", extra: true }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(JSON.parse(unknown.body).error.code, "validation_error");

    const badKey = await apiRequest(h.port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify({ key: "Not A Key!", name: "X" }),
    });
    assert.equal(badKey.status, 400);
    assert.equal(JSON.parse(badKey.body).error.code, "validation_error");
  } finally {
    await h.close();
  }
});

test("unexpected handler faults return sanitized 500 with fixed message", async () => {
  const boom = async (): Promise<never> => {
    throw new Error(
      "connect ECONNREFUSED postgresql://factory:hunter2@db.internal:5432/factory_secret_db",
    );
  };
  const deps = makeDeps({
    store: {
      listProjects: boom,
      createProject: boom,
      getProjectById: boom,
    } as never,
  });
  const h = await listen(deps);
  try {
    const res = await apiRequest(h.port, { path: "/api/projects" });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.message, "Internal server error.");
    assert.ok(!res.body.includes("ECONNREFUSED"));
    assert.ok(!res.body.includes("hunter2"));
    assert.ok(!res.body.includes("db.internal"));
    assert.ok(!res.body.includes("factory_secret_db"));
  } finally {
    await h.close();
  }
});

test("responses never leak secrets/stack markers", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await apiRequest(h.port, { path: "/api/projects/nope/workspace" });
    const flat = res.body.toLowerCase();
    assert.ok(!flat.includes("stack"));
    assert.ok(!flat.includes("at async"));
    assert.ok(!flat.includes("postgres"));
    assert.ok(!flat.includes("database_url"));
  } finally {
    await h.close();
  }
});

test("unknown API endpoint returns contract not_found", async () => {
  const h = await listen(makeDeps());
  try {
    const res = await apiRequest(h.port, { path: "/api/definitely-not-here" });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, "not_found");
  } finally {
    await h.close();
  }
});

test("built dashboard dist is served with SPA fallback", async () => {
  // Point the server at a temp dist so the test is hermetic.
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()  }/operator-dist-`);
  await writeFile(
    `${dir}/index.html`,
    "<!doctype html><html><body>dashboard-shell</body></html>",
  );
  await mkdir(`${dir}/assets`, { recursive: true });
  await writeFile(`${dir}/assets/app.js`, "console.log(1)");
  // A marker file OUTSIDE the dist root that traversal must never serve.
  const outside = await mkdtemp(`${tmpdir()  }/operator-outside-`);
  await writeFile(`${outside}/secrets.txt`, "OUTSIDE-DIST");

  const h = await listen(makeDeps(), dir);
  try {
    const index = await apiRequest(h.port, { path: "/" });
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"] ?? "", /text\/html/);
    assert.ok(index.body.includes("dashboard-shell"));

    const asset = await apiRequest(h.port, { path: "/assets/app.js" });
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"] ?? "", /javascript/);

    // SPA fallback for a client-side route.
    const spa = await apiRequest(h.port, { path: "/projects/p-1" });
    assert.equal(spa.status, 200);
    assert.ok(spa.body.includes("dashboard-shell"));

    // Traversal attempts must never escape the dist root: URL parsing
    // normalizes ".." segments and encoded dots stay literal, so the
    // result is either a dist file, the SPA fallback, or a 403/404 —
    // never content from outside dist.
    const trav = await rawRequest(h.port, {
      path: "/../secrets.txt",
      headers: { Host: `127.0.0.1:${h.port}` },
    });
    assert.ok(
      trav.status === 403 || trav.status === 404 || trav.status === 200,
      `unexpected traversal status ${trav.status}`,
    );
    assert.ok(!trav.body.includes("OUTSIDE-DIST"), "traversal must not serve files outside dist");

    const travEncoded = await rawRequest(h.port, {
      path: "/..%2f..%2fsecrets.txt",
      headers: { Host: `127.0.0.1:${h.port}` },
    });
    assert.ok(!travEncoded.body.includes("OUTSIDE-DIST"));
  } finally {
    await h.close();
  }
});

test("API error contract: known codes map to stable statuses via createOperatorApi", async () => {
  // Stale save / blocked accept through the real API dispatch with a stub
  // intake store that mimics the typed store rejections.
  const { FactoryError } = await import("../../src/executor/errors.js");
  const staleIntake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
    saveDraft: async () => {
      throw new FactoryError("intake_stale_revision", "not current");
    },
    accept: async () => {
      throw new FactoryError("intake_blocked", "blocked");
    },
    getSnapshot: async () => null,
  } as unknown as ProjectIntakeStore;

  const handleApiRequest = createOperatorApi(makeDeps({ intake: staleIntake }));

  const respond = async (method: string, pathname: string, body: string) => {
    let status = 0;
    const chunks: string[] = [];
    const res = new http.ServerResponse(new http.IncomingMessage(null as never));
    (res as unknown as { writeHead: (s: number, h?: unknown) => unknown }).writeHead = (
      s: number,
    ) => {
      status = s;
    };
    (res as unknown as { end: (c?: unknown) => unknown }).end = (c?: unknown) => {
      if (typeof c === "string") chunks.push(c);
      return res;
    };
    await handleApiRequest(
      { method, headers: { host: "127.0.0.1" } } as unknown as http.IncomingMessage,
      res,
      pathname,
      body,
    );
    return { status, payload: chunks.join("") };
  };

  const stale = await respond("PUT", "/api/projects/p-1/intake-draft", JSON.stringify({ baseRevision: 1, payload: {} }));
  assert.equal(stale.status, 409);
  assert.equal(JSON.parse(stale.payload).error.code, "intake_stale_revision");

  const blocked = await respond("POST", "/api/projects/p-1/intake/accept", JSON.stringify({ expectedRevision: 1, expectedDigest: "d" }));
  assert.equal(blocked.status, 422);
  assert.equal(JSON.parse(blocked.payload).error.code, "intake_blocked");
});

test("API error contract: intake_digest_mismatch and intake_revision_mismatch map to 409", async () => {
  const { FactoryError } = await import("../../src/executor/errors.js");
  let acceptError: InstanceType<typeof FactoryError> | null = null;
  const intake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
    accept: async () => {
      if (acceptError) throw acceptError;
      throw new Error("unexpected call");
    },
  } as unknown as ProjectIntakeStore;

  const handleApiRequest = createOperatorApi(makeDeps({ intake }));

  const respond = async (method: string, pathname: string, body: string) => {
    let status = 0;
    const chunks: string[] = [];
    const res = new http.ServerResponse(new http.IncomingMessage(null as never));
    (res as unknown as { writeHead: (s: number, h?: unknown) => unknown }).writeHead = (
      s: number,
    ) => {
      status = s;
    };
    (res as unknown as { end: (c?: unknown) => unknown }).end = (c?: unknown) => {
      if (typeof c === "string") chunks.push(c);
      return res;
    };
    await handleApiRequest(
      { method, headers: { host: "127.0.0.1" } } as unknown as http.IncomingMessage,
      res,
      pathname,
      body,
    );
    return { status, payload: chunks.join("") };
  };

  acceptError = new FactoryError("intake_digest_mismatch", "digest mismatch");
  const digestRes = await respond("POST", "/api/projects/p-1/intake/accept", JSON.stringify({ expectedRevision: 1, expectedDigest: "forged" }));
  assert.equal(digestRes.status, 409);
  assert.equal(JSON.parse(digestRes.payload).error.code, "intake_digest_mismatch");

  acceptError = new FactoryError("intake_revision_mismatch", "revision mismatch");
  const revRes = await respond("POST", "/api/projects/p-1/intake/accept", JSON.stringify({ expectedRevision: 0, expectedDigest: "valid" }));
  assert.equal(revRes.status, 409);
  assert.equal(JSON.parse(revRes.payload).error.code, "intake_revision_mismatch");
});

// ---------------------------------------------------------------------------
// Canonical workspace projection (status matrix)
// ---------------------------------------------------------------------------

test("workspace projection: DRAFT for fresh project (blank template, no facts)", async () => {
  const intake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.ok(ws);
  assert.equal(ws!.status, "DRAFT");
  assert.equal(ws!.currentDraft.revision, 0);
  assert.equal(ws!.currentDraft.digest, null);
  // The projection presents the canonical BLANK template so the Dashboard
  // form binds immediately; it carries no business facts.
  assert.equal(ws!.currentDraft.payload!.business.name, "");
  assert.equal(ws!.currentDraft.payload!.schemaVersion, "v1");
  assert.ok(ws!.readiness.blockers.length > 0, "blank template fails readiness (no invented facts)");
  assert.ok(ws!.nextActions.length > 0);
});

test("workspace projection: BLOCKED for saved but incomplete draft", async () => {
  const incomplete = buildIntakePayload({ business: { name: "" } });
  const intake = {
    getDraft: async () => ({
      projectId: "p",
      revision: 1,
      payload: incomplete,
      digest: "d1",
      updatedAt: new Date(0),
    }),
    listSnapshots: async () => [],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.equal(ws!.status, "BLOCKED");
  assert.ok(ws!.readiness.blockers.some((b) => b.code === "INTAKE_BUSINESS_NAME_REQUIRED"));
});

test("workspace projection: READY when complete and unaccepted", async () => {
  const payload = buildIntakePayload();
  const intake = {
    getDraft: async () => ({
      projectId: "p",
      revision: 2,
      payload,
      digest: "digest-2",
      updatedAt: new Date(0),
    }),
    listSnapshots: async () => [],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.equal(ws!.status, "READY");
  assert.equal(ws!.currentAcceptedSnapshot, null);
});

test("workspace projection: APPROVED when draft matches accepted snapshot", async () => {
  const payload = buildIntakePayload();
  const intake = {
    getDraft: async () => ({
      projectId: "p",
      revision: 1,
      payload,
      digest: "digest-2",
      updatedAt: new Date(0),
    }),
    listSnapshots: async () => [
      { version: 1, digest: "digest-2", acceptedAt: new Date(0), sourceRevision: 1 },
    ],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.equal(ws!.status, "APPROVED");
  assert.equal(ws!.currentAcceptedSnapshot!.version, 1);
  assert.equal(ws!.draftDiffersFromAccepted, false);
});

test("workspace projection: CHANGED when accepted snapshot exists and draft differs", async () => {
  const payload = buildIntakePayload({ business: { description: "Edited after acceptance." } });
  const intake = {
    getDraft: async () => ({
      projectId: "p",
      revision: 2,
      payload,
      digest: "digest-3",
      updatedAt: new Date(0),
    }),
    listSnapshots: async () => [
      { version: 1, digest: "digest-1", acceptedAt: new Date(0), sourceRevision: 1 },
    ],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.equal(ws!.status, "CHANGED");
  assert.equal(ws!.draftDiffersFromAccepted, true);
  assert.equal(ws!.currentAcceptedSnapshot!.version, 1);
});

test("workspace projection: history is ascending and last entry is the accepted one", async () => {
  const payload = buildIntakePayload();
  const intake = {
    getDraft: async () => ({
      projectId: "p",
      revision: 3,
      payload,
      digest: "digest-3",
      updatedAt: new Date(0),
    }),
    listSnapshots: async () => [
      { version: 1, digest: "d1", acceptedAt: new Date(0), sourceRevision: 1 },
      { version: 2, digest: "d2", acceptedAt: new Date(1), sourceRevision: 2 },
    ],
  } as unknown as ProjectIntakeStore;
  const ws = await getProjectOperatorWorkspace(intake, { id: "p", key: "k", name: "N" });
  assert.equal(ws!.history.length, 2);
  assert.equal(ws!.history[0]!.version, 1);
  assert.equal(ws!.history[ws!.history.length - 1]!.version, 2);
  assert.equal(ws!.currentAcceptedSnapshot!.version, 2);
});
