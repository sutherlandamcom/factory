import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelCallError,
  invokeModel,
  type FetchLike,
} from "../src/models/gateway.js";
import { TRUSTED_MODEL_PRICING } from "../src/models/pricing.js";
import { CompetitorStore } from "../src/competitors/competitor-store.js";
import { FactoryError } from "../src/executor/errors.js";

/**
 * P1-1 closure: provider-side price ceiling + overrun accounting.
 *
 * Proves, with ZERO real network calls (fetch is always a recording stub):
 * - the outgoing OpenRouter request carries the real supported
 *   `provider.max_price` restriction derived from Factory's trusted pricing;
 * - a route that cannot satisfy the ceiling fails closed;
 * - trusted actual cost above the authorized reservation is NOT hidden
 *   (accounted in full) and surfaces a typed invariant violation that blocks
 *   subsequent paid execution;
 * - unknown actual cost still accounts the authorized conservative amount.
 */

const VALID_KEY = "sk-or-test-abcdef1234567890";
const PRICED_MODEL = "google/gemini-3.7-flash";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SUCCESS_BODY = {
  model: PRICED_MODEL,
  provider: "Google",
  choices: [{ message: { content: "{\"ok\":true}" } }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0001 },
};

/** Recording fetch stub; `calls` proves exactly what would hit the network. */
function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, payload: JSON.parse(String(init.body)) as Record<string, unknown> });
    return jsonResponse(status, body);
  };
  return { calls, fetchImpl };
}

const BASE_REQUEST = {
  roleId: "search_analyst",
  model: PRICED_MODEL,
  systemPrompt: "system",
  prompt: "user",
  maxTokens: 8192,
  timeoutMs: 5_000,
};

test("gateway sends provider.max_price equal to the trusted Factory pricing ceiling for the model", async () => {
  const { calls, fetchImpl } = recordingFetch(200, SUCCESS_BODY);
  await invokeModel(BASE_REQUEST, { fetchImpl, loadApiKey: () => VALID_KEY });

  assert.equal(calls.length, 1, "exactly one (stubbed) provider request");
  const provider = calls[0]!.payload.provider as { max_price?: { prompt: number; completion: number } } | undefined;
  assert.ok(provider?.max_price, "request must carry a provider.max_price restriction");
  const trusted = TRUSTED_MODEL_PRICING[PRICED_MODEL]!;
  assert.equal(provider.max_price.prompt, trusted.promptUsdPerToken * 1_000_000);
  assert.equal(provider.max_price.completion, trusted.completionUsdPerToken * 1_000_000);
  assert.equal(provider.max_price.prompt, 1.5);
  assert.equal(provider.max_price.completion, 7.5);
});

test("route that cannot satisfy the price ceiling fails closed (provider refusal surfaces as model_failed)", async () => {
  // OpenRouter rejects with an error when no endpoint satisfies max_price.
  const { calls, fetchImpl } = recordingFetch(404, {
    error: { message: "No endpoints found that satisfy the requested max_price", code: 404 },
  });
  await assert.rejects(
    invokeModel(BASE_REQUEST, { fetchImpl, loadApiKey: () => VALID_KEY }),
    (err: unknown) =>
      err instanceof ModelCallError && err.code === "model_failed" && err.httpStatus === 404,
  );
  assert.equal(calls.length, 1);
});

test("model without trusted pricing sends no provider price ceiling (evaluation-only paths unchanged)", async () => {
  const { calls, fetchImpl } = recordingFetch(200, SUCCESS_BODY);
  await invokeModel(
    { ...BASE_REQUEST, model: "anthropic/claude-test-model" },
    { fetchImpl, loadApiKey: () => VALID_KEY },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.payload.provider, undefined);
});

function makeBudgetStore(): CompetitorStore {
  const store = new CompetitorStore({} as never);
  store.sumTodayCompetitorCostMicros = async () => 0;
  return store;
}

test("actual > authorized is NOT hidden: full amount accounted and typed invariant violation raised", async () => {
  const store = makeBudgetStore();
  const handle = await store.reserveBudget(70_000, 5);
  await assert.rejects(
    handle.account(80_000),
    (err: unknown) =>
      err instanceof FactoryError &&
      err.code === "budget_invariant_violation" &&
      /80,000|80000/.test(err.message),
  );
  // The overrun is durably accounted in full — never capped down to 70,000.
  const accounted = (await store.getBudgetSummary()).accountedTodayMicros;
  assert.equal(accounted, 80_000, "real trusted amount must be fully accounted, not capped");
});

test("budget invariant violation blocks subsequent paid execution (fail closed)", async () => {
  const store = makeBudgetStore();
  const handle = await store.reserveBudget(70_000, 5);
  await assert.rejects(
    handle.account(80_000),
    (err: unknown) => err instanceof FactoryError && err.code === "budget_invariant_violation",
  );
  // Even with ample budget headroom, a new reservation must fail closed.
  await assert.rejects(
    store.reserveBudget(1, 5),
    (err: unknown) => err instanceof FactoryError && err.code === "budget_invariant_violation",
  );
});

test("actual <= authorized accounts the exact trusted amount without violation", async () => {
  const store = makeBudgetStore();
  const handle = await store.reserveBudget(70_000, 5);
  await handle.account(12_345);
  const accounted = (await store.getBudgetSummary()).accountedTodayMicros;
  assert.equal(accounted, 12_345);
});

test("unknown actual cost still accounts the authorized conservative amount", async () => {
  const store = makeBudgetStore();
  const handle = await store.reserveBudget(70_000, 5);
  await handle.account(null);
  const accounted = (await store.getBudgetSummary()).accountedTodayMicros;
  assert.equal(accounted, 70_000, "unknown cost must account the authorized amount, never less");
});
