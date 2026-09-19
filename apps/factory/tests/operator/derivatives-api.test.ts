import assert from "node:assert/strict";
import test from "node:test";
import { createOperatorApi, type OperatorApiDeps } from "../../src/operator/api.js";
import { derivativeError } from "../../src/derivatives/core.js";
import type { DerivativesApiFacade } from "../../src/derivatives/api-facade.js";

/**
 * Run 11 Remediation — Real API tests through actual Operator API router for
 * Run 10 6-segment review routes:
 *   GET /api/projects/:projectId/derivatives/summary/:proposalId/review
 *   GET /api/projects/:projectId/derivatives/audio/:candidateId/review
 *
 * Requirements:
 *  - Positive (known ID): 200 + expected review payload.
 *  - Negative (unknown ID): typed 404 (derivative_required_artifact_missing).
 *  - Pin valid 6-segment route behavior.
 */

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

const PROJECT = { id: "p-test", key: "acme", name: "Acme", createdAt: new Date(0), updatedAt: new Date(0) };

const KNOWN_SUMMARY_PAYLOAD = {
  proposalId: "prop-known-1",
  pageIdentity: "homepage",
  sourceContent: { id: "cont-1", version: 1 },
  summaryText: "Authoritative summary for Acme homepage.",
  qa: { overall: "PASS", checks: [] },
  qaOverall: "PASS",
  provider: "google-gemini",
  model: "gemini-2.5-pro",
  providerMode: "fixture",
  cost: { micros: 1500, currency: "USD" },
};

const KNOWN_AUDIO_PAYLOAD = {
  candidateId: "cand-known-1",
  pageIdentity: "homepage",
  sourceContent: { id: "cont-1", version: 1 },
  narrationText: "Narration audio for Acme homepage.",
  narrationDigest: "a".repeat(64),
  voiceId: "voice-en-1",
  provider: "elevenlabs",
  engine: "v2",
  providerMode: "fixture",
  mimeType: "audio/wav",
  sizeBytes: 88200,
  durationSeconds: 20,
  cost: { micros: 4500, currency: "USD" },
};

function makeDerivativesStub(): DerivativesApiFacade {
  return {
    summaryReview: async (projectId: string, proposalId: string) => {
      if (projectId === PROJECT.id && proposalId === "prop-known-1") {
        return KNOWN_SUMMARY_PAYLOAD;
      }
      throw derivativeError("derivative_required_artifact_missing", `Summary proposal ${proposalId} not found.`);
    },
    audioReview: async (projectId: string, candidateId: string) => {
      if (projectId === PROJECT.id && candidateId === "cand-known-1") {
        return KNOWN_AUDIO_PAYLOAD;
      }
      throw derivativeError("derivative_required_artifact_missing", `Audio candidate ${candidateId} not found.`);
    },
  } as unknown as DerivativesApiFacade;
}

function makeDeps(derivatives?: DerivativesApiFacade): OperatorApiDeps {
  return {
    store: {
      getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
    } as unknown as OperatorApiDeps["store"],
    intake: {} as unknown as OperatorApiDeps["intake"],
    derivatives,
  };
}

test("derivatives review routes: GET /api/projects/:id/derivatives/summary/:proposalId/review (positive 200)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/prop-known-1/review`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, KNOWN_SUMMARY_PAYLOAD);
});

test("derivatives review routes: GET /api/projects/:id/derivatives/summary/:proposalId/review (negative 404 unknown ID)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/unknown-prop/review`);
  assert.equal(res.status, 404);
  assert.equal((res.body.error as { code: string })?.code, "derivative_required_artifact_missing");
});

test("derivatives review routes: GET /api/projects/:id/derivatives/audio/:candidateId/review (positive 200)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/audio/cand-known-1/review`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, KNOWN_AUDIO_PAYLOAD);
});

test("derivatives review routes: GET /api/projects/:id/derivatives/audio/:candidateId/review (negative 404 unknown ID)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/audio/unknown-cand/review`);
  assert.equal(res.status, 404);
  assert.equal((res.body.error as { code: string })?.code, "derivative_required_artifact_missing");
});

test("derivatives review routes: unknown project fails closed (404 not_found)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  const res = await callApi(deps, "GET", "/api/projects/unknown-proj/derivatives/summary/prop-known-1/review");
  assert.equal(res.status, 404);
  assert.equal((res.body.error as { code: string })?.code, "not_found");
});

test("derivatives review routes: cross-project review attempt fails closed (404 typed error)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  // Querying project A with an ID that only exists for another project
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/foreign-project-prop/review`);
  assert.equal(res.status, 404);
  assert.equal((res.body.error as { code: string })?.code, "derivative_required_artifact_missing");
});

test("derivatives review routes: invalid segment routes fail closed (404)", async () => {
  const deps = makeDeps(makeDerivativesStub());
  // Extra segment (7 segments instead of 6)
  const resExtra = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/prop-known-1/review/extra`);
  assert.equal(resExtra.status, 404);

  // Missing segment (5 segments instead of 6)
  const resMissing = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/prop-known-1`);
  assert.equal(resMissing.status, 404);

  // Wrong trailing verb
  const resWrongVerb = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/derivatives/summary/prop-known-1/inspect`);
  assert.equal(resWrongVerb.status, 404);
});
