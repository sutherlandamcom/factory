import assert from "node:assert/strict";
import test from "node:test";
import { createOperatorApi, type OperatorApiDeps } from "../../src/operator/api.js";
import type { WriterService } from "../../src/writer/service.js";
import { FactoryError } from "../../src/executor/errors.js";

/**
 * Direct-API adversarial tests for the writer endpoints: typed error codes,
 * digest/revision binding enforced via the API exactly as via the Dashboard,
 * and fail-closed behavior when preflight would block. The WriterService is a
 * deterministic stub so no database or provider call can happen.
 */

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function makeWriterStub(handlers: Map<string, (body: unknown) => unknown>, calls: Call[]): WriterService {
  return {
    writerPolicyWorkspace: async () => ({ latest: null, versions: [] }),
    briefWorkspace: async () => ({ latest: null, versions: [] }),
    snapshotWorkspace: async () => ({ latest: null, versions: [] }),
    proposalWorkspace: async () => ({ latest: null, versions: [] }),
    acceptedContentWorkspace: async () => ({ latest: null }),
    deriveWriterPolicyDraft: async (projectId: string) => {
      calls.push({ path: "policy-draft", method: "POST", body: { projectId } });
      return handlers.get("policy-draft")!(projectId);
    },
    approveWriterPolicy: async (input: unknown) => {
      calls.push({ path: "policy-approve", method: "POST", body: input });
      return handlers.get("policy-approve")!(input);
    },
    saveBriefDraft: async (input: unknown) => {
      calls.push({ path: "brief-draft", method: "PUT", body: input });
      return handlers.get("brief-draft")!(input);
    },
    approveBrief: async (input: unknown) => {
      calls.push({ path: "brief-approve", method: "POST", body: input });
      return handlers.get("brief-approve")!(input);
    },
    compileSnapshot: async (input: unknown) => {
      calls.push({ path: "snapshot-compile", method: "POST", body: input });
      return handlers.get("snapshot-compile")!(input);
    },
    approveSnapshot: async (input: unknown) => {
      calls.push({ path: "snapshot-approve", method: "POST", body: input });
      return handlers.get("snapshot-approve")!(input);
    },
    generateProposal: async (input: unknown) => {
      calls.push({ path: "generate", method: "POST", body: input });
      return handlers.get("generate")!(input);
    },
    runQa: async (input: unknown) => {
      calls.push({ path: "qa", method: "POST", body: input });
      return handlers.get("qa")!(input);
    },
    acceptContent: async (input: unknown) => {
      calls.push({ path: "accept", method: "POST", body: input });
      return handlers.get("accept")!(input);
    },
  } as unknown as WriterService;
}

async function callApi(
  deps: OperatorApiDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handle = createOperatorApi(deps);
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    end(chunk?: string) {
      (this as { body?: string }).body = chunk ?? "";
    },
    writeHead(status: number, headers: Record<string, string>) {
      (this as { statusCode?: number }).statusCode = status;
      (this as { headers?: Record<string, string> }).headers = headers;
    },
    body: "" as string,
  } as unknown as import("node:http").ServerResponse & { body: string; statusCode: number; headers: Record<string, string> };
  await handle(
    { method, url: path, headers: {} } as unknown as import("node:http").IncomingMessage,
    res,
    path,
    body === undefined ? "" : JSON.stringify(body),
  );
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

const PROJECT = { id: "p-1", key: "acme", name: "Acme", createdAt: new Date(0), updatedAt: new Date(0) };

function makeDeps(writer: WriterService): OperatorApiDeps {
  return {
    store: {
      getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
    } as unknown as OperatorApiDeps["store"],
    intake: {} as unknown as OperatorApiDeps["intake"],
    writer,
  };
}

test("writer API: full semantic surface routes to the service with typed payloads", async () => {
  const calls: Call[] = [];
  const handlers = new Map<string, (body: unknown) => unknown>([
    ["policy-draft", () => ({ id: "wpol-1", version: 1, state: "draft", digest: "d".repeat(64) })],
    ["policy-approve", (b) => ({ ok: true, echo: b })],
    ["brief-draft", (b) => ({ ok: true, echo: b })],
    ["brief-approve", (b) => ({ ok: true, echo: b })],
    ["snapshot-compile", () => ({ id: "wsnp-1", version: 1, digest: "s".repeat(64) })],
    ["snapshot-approve", (b) => ({ ok: true, echo: b })],
    ["generate", () => ({ id: "wprp-1", version: 1 })],
    ["qa", () => ({ overall: "PASS" })],
    ["accept", (b) => ({ ok: true, echo: b })],
  ]);
  const deps = makeDeps(makeWriterStub(handlers, calls));

  const ws = await callApi(deps, "GET", "/api/projects/p-1/writer/workspace");
  assert.equal(ws.status, 200);
  assert.ok("policy" in ws.body && "brief" in ws.body && "snapshot" in ws.body && "proposal" in ws.body && "accepted" in ws.body);

  const draft = await callApi(deps, "POST", "/api/projects/p-1/writer/policy-draft");
  assert.equal(draft.status, 201);
  assert.equal((draft.body as { state: string }).state, "draft");

  const approve = await callApi(deps, "POST", "/api/projects/p-1/writer/policy-approve", {
    policyId: "wpol-1",
    expectedVersion: 1,
    expectedDigest: "d".repeat(64),
  });
  assert.equal(approve.status, 200);

  const brief = await callApi(deps, "PUT", "/api/projects/p-1/writer/brief-draft", {
    pageTarget: { slug: "x", title: "T", objective: "O", audience: "A", structureGuidance: [], internalLinkIntent: [], ctaIntent: "C" },
    contentBriefKeyPoints: [],
  });
  assert.equal(brief.status, 200);

  const briefApprove = await callApi(deps, "POST", "/api/projects/p-1/writer/brief-approve", {
    briefId: "wbrf-1",
    expectedVersion: 1,
    expectedDigest: "b".repeat(64),
    noGapLineageAcknowledged: true,
  });
  assert.equal(briefApprove.status, 200);

  const compile = await callApi(deps, "POST", "/api/projects/p-1/writer/snapshot-compile");
  assert.equal(compile.status, 201);

  const snapApprove = await callApi(deps, "POST", "/api/projects/p-1/writer/snapshot-approve", {
    snapshotId: "wsnp-1",
    expectedVersion: 1,
    expectedDigest: "s".repeat(64),
  });
  assert.equal(snapApprove.status, 200);

  const generate = await callApi(deps, "POST", "/api/projects/p-1/writer/generate", { snapshotId: "wsnp-1" });
  assert.equal(generate.status, 201);

  const qa = await callApi(deps, "POST", "/api/projects/p-1/writer/qa");
  assert.equal(qa.status, 200);
  assert.equal((qa.body as { overall: string }).overall, "PASS");

  const accept = await callApi(deps, "POST", "/api/projects/p-1/writer/accept", {
    proposalId: "wprp-1",
    expectedProposalDigest: "p".repeat(64),
  });
  assert.equal(accept.status, 201);

  // Every endpoint reached the service.
  assert.deepEqual(
    calls.map((c) => c.path),
    ["policy-draft", "policy-approve", "brief-draft", "brief-approve", "snapshot-compile", "snapshot-approve", "generate", "qa", "accept"],
  );
});

test("writer API: typed stale/digest errors propagate with the contract status mapping", async () => {
  const calls: Call[] = [];
  const handlers = new Map<string, (body: unknown) => unknown>([
    ["policy-approve", () => {
      throw new FactoryError("writer_artifact_stale", "Writer policy is stale: the accepted ProjectInputSnapshot changed.");
    }],
    ["brief-approve", () => {
      throw new FactoryError("content_gap_lineage_missing", "Brief has no accepted gap lineage.");
    }],
    ["generate", () => {
      throw new FactoryError("writer_budget_blocked", "Daily writer budget reached.");
    }],
    ["accept", () => {
      throw new FactoryError("content_accept_failed", "QA overall verdict is FAIL.");
    }],
  ]);
  const deps = makeDeps(makeWriterStub(handlers, calls));

  const stale = await callApi(deps, "POST", "/api/projects/p-1/writer/policy-approve", {
    policyId: "wpol-1",
    expectedVersion: 1,
    expectedDigest: "d".repeat(64),
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: { code: string } }).error.code, "writer_artifact_stale");

  const noGap = await callApi(deps, "POST", "/api/projects/p-1/writer/brief-approve", {
    briefId: "wbrf-1",
    expectedVersion: 1,
    expectedDigest: "b".repeat(64),
  });
  assert.equal(noGap.status, 409);
  assert.equal((noGap.body as { error: { code: string } }).error.code, "content_gap_lineage_missing");

  const budget = await callApi(deps, "POST", "/api/projects/p-1/writer/generate", { snapshotId: "wsnp-1" });
  assert.equal(budget.status, 402);
  assert.equal((budget.body as { error: { code: string } }).error.code, "writer_budget_blocked");

  const acceptFail = await callApi(deps, "POST", "/api/projects/p-1/writer/accept", {
    proposalId: "wprp-1",
    expectedProposalDigest: "p".repeat(64),
  });
  assert.equal(acceptFail.status, 409);
  assert.equal((acceptFail.body as { error: { code: string } }).error.code, "content_accept_failed");
});

test("writer API: malformed request bodies fail closed with validation_error (never reach the service)", async () => {
  const calls: Call[] = [];
  const handlers = new Map<string, (body: unknown) => unknown>([
    ["policy-approve", () => ({ ok: true })],
    ["generate", () => ({ ok: true })],
    ["accept", () => ({ ok: true })],
  ]);
  const deps = makeDeps(makeWriterStub(handlers, calls));

  // Missing expectedDigest.
  const missingDigest = await callApi(deps, "POST", "/api/projects/p-1/writer/policy-approve", {
    policyId: "wpol-1",
    expectedVersion: 1,
  });
  assert.equal(missingDigest.status, 400);
  assert.equal((missingDigest.body as { error: { code: string } }).error.code, "validation_error");

  // Missing snapshotId.
  const noSnapshot = await callApi(deps, "POST", "/api/projects/p-1/writer/generate", {});
  assert.equal(noSnapshot.status, 400);

  // Missing proposal digest.
  const noDigest = await callApi(deps, "POST", "/api/projects/p-1/writer/accept", { proposalId: "x" });
  assert.equal(noDigest.status, 400);

  assert.equal(calls.length, 0, "no malformed request may reach the service");
});

test("writer API: unknown project and missing writer dep fail closed", async () => {
  const calls: Call[] = [];
  const handlers = new Map<string, (body: unknown) => unknown>();
  const deps = makeDeps(makeWriterStub(handlers, calls));
  const missing = await callApi(deps, "GET", "/api/projects/other/writer/workspace");
  assert.equal(missing.status, 404);

  const noWriter = await callApi({ ...deps, writer: undefined }, "GET", "/api/projects/p-1/writer/workspace");
  assert.equal(noWriter.status, 404);
});
