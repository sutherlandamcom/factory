import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  generateRelayToken,
  validateRelayAuth,
  validateRelayPath,
  validateRelayModel,
  startModelRelay,
} from "../src/executor/relay.js";
import { CODE_WORKER_POLICY } from "../src/models/policy.js";

test("generateRelayToken generates a unique cryptographically random token per run", () => {
  const t1 = generateRelayToken();
  const t2 = generateRelayToken();
  assert.ok(t1.startsWith("factory-relay-"));
  assert.ok(t2.startsWith("factory-relay-"));
  assert.notEqual(t1, t2);
});

test("validateRelayAuth rejects missing and invalid tokens; accepts matching token", () => {
  const expected = "factory-relay-secret-token-123";
  assert.deepEqual(validateRelayAuth(undefined, expected), {
    valid: false,
    code: 401,
    error: "Missing Authorization header",
  });
  assert.deepEqual(validateRelayAuth("", expected), {
    valid: false,
    code: 401,
    error: "Missing Authorization header",
  });
  assert.deepEqual(validateRelayAuth("Bearer wrong-token", expected), {
    valid: false,
    code: 403,
    error: "Invalid relay authorization token",
  });
  assert.deepEqual(validateRelayAuth(`Bearer ${expected}`, expected), {
    valid: true,
  });
});

test("validateRelayPath explicitly maps only required endpoints per tier; rejects unmapped paths", () => {
  // Primary tier (Kimi / OpenAI)
  assert.equal(validateRelayPath("GET", "/health", "primary").valid, true);
  assert.equal(validateRelayPath("GET", "/", "primary").valid, true);
  assert.equal(validateRelayPath("POST", "/chat/completions", "primary").valid, true);
  assert.equal(validateRelayPath("POST", "/v1/chat/completions", "primary").valid, true);
  assert.equal(validateRelayPath("POST", "/api/v1/chat/completions", "primary").valid, true);

  // Primary rejects Claude endpoints and unmapped paths
  assert.equal(validateRelayPath("POST", "/v1/messages", "primary").valid, false);
  assert.equal(validateRelayPath("GET", "/models", "primary").valid, false);
  assert.equal(validateRelayPath("POST", "/v1/completions", "primary").valid, false);

  // Senior tier (Claude / Anthropic)
  assert.equal(validateRelayPath("GET", "/health", "senior").valid, true);
  assert.equal(validateRelayPath("POST", "/messages", "senior").valid, true);
  assert.equal(validateRelayPath("POST", "/v1/messages", "senior").valid, true);
  assert.equal(validateRelayPath("POST", "/api/v1/messages", "senior").valid, true);

  // Senior rejects Kimi endpoints and unmapped paths
  assert.equal(validateRelayPath("POST", "/chat/completions", "senior").valid, false);
  assert.equal(validateRelayPath("POST", "/v1/chat/completions", "senior").valid, false);
  assert.equal(validateRelayPath("GET", "/v1/models", "senior").valid, false);
});

test("validateRelayModel strictly enforces exact model per tier", () => {
  const primaryAllowed = CODE_WORKER_POLICY.primary.model;
  const seniorAllowed = CODE_WORKER_POLICY.senior.model;

  assert.equal(validateRelayModel({ model: primaryAllowed }, primaryAllowed).valid, true);
  assert.equal(validateRelayModel({ model: seniorAllowed }, seniorAllowed).valid, true);

  // Mismatched models
  const invalidPrimary = validateRelayModel({ model: "openai/gpt-5.6-sol" }, primaryAllowed);
  assert.equal(invalidPrimary.valid, false);
  assert.match(invalidPrimary.error!, /Unauthorized model/);

  const invalidSenior = validateRelayModel({ model: "anthropic/claude-3-haiku" }, seniorAllowed);
  assert.equal(invalidSenior.valid, false);
  assert.match(invalidSenior.error!, /Unauthorized model/);

  // Missing model
  assert.equal(validateRelayModel({}, primaryAllowed).valid, false);
  assert.equal(validateRelayModel(null, primaryAllowed).valid, false);
});

test("startModelRelay: Zero-LLM synthetic tests against fake upstream server", async () => {
  let upstreamCalls: Array<{ path: string; method: string; auth: string; body: string }> = [];

  const fakeUpstream = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamCalls.push({
        path: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "mock-response", choices: [] }));
    });
  });

  await new Promise<void>((resolve) => fakeUpstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (fakeUpstream.address() as { port: number }).port;
  const fakeUpstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  const relayToken = "local-relay-random-token-xyz123";
  const realApiKey = "sk-or-v1-secret-openrouter-key-999";

  const primaryRelay = await startModelRelay({
    tier: "primary",
    apiKey: realApiKey,
    relayToken,
    upstreamBaseUrl: fakeUpstreamUrl,
    inProcess: true,
  });

  try {
    // 1. Health check
    const healthRes = await fetch(`${primaryRelay.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string; tier: string; allowedModel: string };
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.tier, "primary");
    assert.equal(healthJson.allowedModel, "moonshotai/kimi-k3");

    // 2. Reject unmapped endpoint
    const unmappedRes = await fetch(`${primaryRelay.baseUrl}/unmapped/path`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k3" }),
    });
    assert.equal(unmappedRes.status, 404);
    assert.equal(upstreamCalls.length, 0, "0 upstream calls on unmapped path");

    // 3. Reject missing auth
    const noAuthRes = await fetch(`${primaryRelay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k3" }),
    });
    assert.equal(noAuthRes.status, 401);
    assert.equal(upstreamCalls.length, 0, "0 upstream calls on missing auth");

    // 4. Reject invalid auth
    const badAuthRes = await fetch(`${primaryRelay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k3" }),
    });
    assert.equal(badAuthRes.status, 403);
    assert.equal(upstreamCalls.length, 0, "0 upstream calls on bad auth");

    // 5. Reject unauthorized model (openai/gpt-5.6-sol)
    const badModelRes = await fetch(`${primaryRelay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.6-sol", messages: [] }),
    });
    assert.equal(badModelRes.status, 403);
    assert.equal(upstreamCalls.length, 0, "0 upstream calls on unauthorized model");

    // 6. Authorized model (moonshotai/kimi-k3) -> forwarded to upstream with real API key
    const successRes = await fetch(`${primaryRelay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k3", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(successRes.status, 200);
    assert.equal(upstreamCalls.length, 1, "exactly 1 upstream call made");
    assert.equal(upstreamCalls[0]?.auth, `Bearer ${realApiKey}`, "real API key injected upstream");
    assert.match(upstreamCalls[0]?.path ?? "", /chat\/completions/);
  } finally {
    await primaryRelay.close();
  }

  // Test senior tier relay
  upstreamCalls = [];
  const seniorRelay = await startModelRelay({
    tier: "senior",
    apiKey: realApiKey,
    relayToken,
    upstreamBaseUrl: fakeUpstreamUrl,
    inProcess: true,
  });

  try {
    // Reject unauthorized model (anthropic/claude-3-5-sonnet)
    const badModelRes = await fetch(`${seniorRelay.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", messages: [] }),
    });
    assert.equal(badModelRes.status, 403);
    assert.equal(upstreamCalls.length, 0, "0 upstream calls on wrong senior model");

    // Authorized model (anthropic/claude-opus-5) -> forwarded
    const successRes = await fetch(`${seniorRelay.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(successRes.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0]?.auth, `Bearer ${realApiKey}`);
    assert.match(upstreamCalls[0]?.path ?? "", /messages/);
  } finally {
    await seniorRelay.close();
    await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
  }
});
