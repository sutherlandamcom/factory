import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelCallError,
  invokeModel,
  listOpenRouterModels,
  loadOpenRouterApiKey,
  scrubCredentials,
} from "../src/models/gateway.js";

const VALID_KEY = "sk-or-test-abcdef1234567890";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SUCCESS_BODY = {
  model: "anthropic/claude-test-model",
  provider: "Anthropic",
  choices: [{ message: { content: "{\"ok\":true}" } }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 340,
    total_tokens: 460,
    cost: 0.0123,
  },
};

function depsWith(overrides: {
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  loadApiKey?: () => string | null;
}) {
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => jsonResponse(200, SUCCESS_BODY)),
    loadApiKey: overrides.loadApiKey ?? (() => VALID_KEY),
    now: (() => {
      let current = 1_000;
      return () => (current += 5);
    })(),
  };
}

const BASE_REQUEST = {
  roleId: "blueprint_architect",
  model: "anthropic/claude-test-model",
  systemPrompt: "You are the Factory blueprint architect.",
  prompt: "produce one JSON document",
  timeoutMs: 5_000,
};

test("invokeModel captures exact provenance: model, provider, tokens, cost, duration", async () => {
  const result = await invokeModel(BASE_REQUEST, depsWith({}));
  assert.equal(result.requestedModel, "anthropic/claude-test-model");
  assert.equal(result.respondedModel, "anthropic/claude-test-model");
  assert.equal(result.provider, "Anthropic");
  assert.equal(result.promptTokens, 120);
  assert.equal(result.completionTokens, 340);
  assert.equal(result.totalTokens, 460);
  assert.equal(result.costUsd, 0.0123);
  assert.equal(result.durationMs, 5);
  assert.equal(result.content, "{\"ok\":true}");
});

test("missing credentials fail closed without any network call", async () => {
  await assert.rejects(
    invokeModel(BASE_REQUEST, depsWith({ loadApiKey: () => null })),
    (error: unknown) => error instanceof ModelCallError && error.code === "credentials_unavailable",
  );
});

test("authorization failures are terminal credentials_unavailable", async () => {
  await assert.rejects(
    invokeModel(BASE_REQUEST, depsWith({ fetchImpl: async () => jsonResponse(401, { error: { message: "bad key" } }) })),
    (error: unknown) => error instanceof ModelCallError && error.code === "credentials_unavailable",
  );
});

test("HTTP 408 maps to model_timeout; 5xx maps to model_failed", async () => {
  await assert.rejects(
    invokeModel(BASE_REQUEST, depsWith({ fetchImpl: async () => jsonResponse(408, {}) })),
    (error: unknown) => error instanceof ModelCallError && error.code === "model_timeout",
  );
  await assert.rejects(
    invokeModel(BASE_REQUEST, depsWith({ fetchImpl: async () => jsonResponse(503, {}) })),
    (error: unknown) => error instanceof ModelCallError && error.code === "model_failed",
  );
});

test("request never uses auto-routing: single explicit model, no fallback arrays", async () => {
  let capturedBody = "";
  await invokeModel(
    BASE_REQUEST,
    depsWith({
      fetchImpl: async (_input, init) => {
        capturedBody = String(init.body);
        return jsonResponse(200, SUCCESS_BODY);
      },
    }),
  );
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(body.model, "anthropic/claude-test-model");
  assert.ok(!("models" in body), "models fallback arrays are forbidden");
  assert.ok(!("route" in body), "route fallback is forbidden");
  assert.ok(!JSON.stringify(body).includes("auto"), "no auto router usage");
});

test("the api key never appears in request artifacts or error messages", async () => {
  let capturedAuth = "";
  try {
    await invokeModel(
      BASE_REQUEST,
      depsWith({
        fetchImpl: async (_input, init) => {
          capturedAuth = String((init.headers as Record<string, string>).Authorization);
          return jsonResponse(500, { error: { message: `internal error for key ${VALID_KEY}` } });
        },
      }),
    );
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof ModelCallError);
    assert.ok(!error.message.includes(VALID_KEY), "key must not leak into error messages");
  }
  assert.equal(capturedAuth, `Bearer ${VALID_KEY}`);
});

test("scrubCredentials removes bearer tokens, key shapes, and URL credentials", () => {
  const dirty = "failed: Bearer sk-or-v1-abcdef1234567890 http://user:pass@host/path sk-abc123def456";
  const clean = scrubCredentials(dirty, VALID_KEY);
  assert.ok(!clean.includes("sk-or-v1-abcdef1234567890"));
  assert.ok(!clean.includes("sk-abc123def456"));
  assert.ok(!clean.includes("user:pass"));
  assert.ok(clean.includes("Bearer [redacted]"));
});

test("malformed ids and empty prompts are policy violations", async () => {
  await assert.rejects(
    invokeModel({ ...BASE_REQUEST, model: "openrouter/auto" }, depsWith({})),
    (error: unknown) => error instanceof ModelCallError && error.code === "policy_violation",
  );
  await assert.rejects(
    invokeModel({ ...BASE_REQUEST, model: "not a valid id!" }, depsWith({})),
    (error: unknown) => error instanceof ModelCallError && error.code === "policy_violation",
  );
  await assert.rejects(
    invokeModel({ ...BASE_REQUEST, prompt: "  " }, depsWith({})),
    (error: unknown) => error instanceof ModelCallError && error.code === "policy_violation",
  );
});

test("listOpenRouterModels parses summaries and fails closed without credentials", async () => {
  const models = await listOpenRouterModels(
    depsWith({
      fetchImpl: async (input) => {
        assert.ok(String(input).endsWith("/models"));
        return jsonResponse(200, {
          data: [
            {
              id: "openai/gpt-test",
              name: "OpenAI: Test",
              context_length: 400_000,
              created: 1_800_000_000,
              supported_features: ["structured_outputs", "tools"],
              pricing: { prompt: "0.0000025" },
            },
            { id: "openai/gpt-mini:free", context_length: 128_000, created: 1_700_000_000 },
          ],
        });
      },
    }),
  );
  assert.equal(models.length, 2);
  const flagship = models.find((model) => model.id === "openai/gpt-test");
  assert.ok(flagship);
  assert.equal(flagship.supportsStructuredOutputs, true);
  assert.equal(flagship.promptPriceUsdPerToken, 0.0000025);
  assert.equal(flagship.contextLength, 400_000);

  await assert.rejects(
    listOpenRouterModels(depsWith({ loadApiKey: () => null })),
    (error: unknown) => error instanceof ModelCallError && error.code === "credentials_unavailable",
  );
});

test("loadOpenRouterApiKey reads process env without exposing the value", () => {
  const fakeEnv = { OPENROUTER_API_KEY: "sk-or-env-value-123456" };
  assert.equal(loadOpenRouterApiKey(fakeEnv as unknown as NodeJS.ProcessEnv), "sk-or-env-value-123456");
  const emptyEnv = {};
  assert.equal(loadOpenRouterApiKey(emptyEnv as unknown as NodeJS.ProcessEnv), null);
});
