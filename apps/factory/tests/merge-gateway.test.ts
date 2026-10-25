import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import {
  invokeModelViaMerge,
  loadMergeApiKey,
  listMergeModels,
} from "../src/models/merge-gateway.js";
import type { ModelCallRequest } from "../src/models/gateway.js";
import {
  isMergePilotEnabled,
  mergePilotModelForRole,
  MERGE_PILOT_ALLOWED_ROLES,
  MERGE_PILOT_BUDGET_LIMIT_USD,
  MERGE_PILOT_MODEL,
  MERGE_PILOT_PROVIDER,
  MERGE_TEST_PROFILE_VERSION,
} from "../src/models/merge-policy.js";
import { getModelPricing } from "../src/models/pricing.js";
import { assertOverrideStartupPolicy } from "../src/models/override-guard.js";
import { resolveWriterModel } from "../src/writer/provider.js";
import { scrubCredentials } from "../src/models/gateway.js";
import { InvocationFailure } from "../src/models/invocation-failure.js";
import { modelGatewaySchema } from "@factory/contracts";

/**
 * Merge Gateway TEST PILOT — deterministic negative battery (ZERO network).
 *
 * Fail-closed invariants: without a key NO HTTP call is attempted; invalid
 * model ids, empty prompts, wrong-key 401/403, budget blocks, non-JSON
 * bodies, and missing usage all produce typed failures with conservative
 * accounting. The OpenRouter path is untouched (regression probe at the
 * end).
 */

const baseRequest: ModelCallRequest = {
  roleId: "content_writer",
  model: MERGE_PILOT_MODEL,
  systemPrompt: "Trusted Factory test system instructions.",
  prompt: "Approved Factory test prompt (fictional data only).",
  maxTokens: 64,
  timeoutMs: 5_000,
};

function countingFetch() {
  const calls: Array<{ input: string }> = [];
  const fetchImpl = async (input: string) => {
    calls.push({ input });
    throw new Error("NETWORK-PROHIBITED: this test must not reach network");
  };
  return { fetchImpl, calls };
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("MG-01: no key -> credentials_unavailable with ZERO HTTP calls", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => null }),
    (error: unknown) => {
      assert.ok(error instanceof InvocationFailure);
      assert.equal(error.code, "credentials_unavailable");
      return true;
    },
  );
  assert.equal(calls.length, 0, "no fetch may occur without a credential");
});

test("MG-02: invalid model id -> policy_violation with zero HTTP calls", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    invokeModelViaMerge({ ...baseRequest, model: "bad model id!" }, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "policy_violation");
      return true;
    },
  );
  await assert.rejects(
    invokeModelViaMerge({ ...baseRequest, model: "openrouter/auto" }, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "policy_violation");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("MG-03: empty prompts -> policy_violation with zero HTTP calls", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    invokeModelViaMerge({ ...baseRequest, systemPrompt: "  " }, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "policy_violation");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("MG-04: wrong key (HTTP 401) -> credentials_unavailable, no key material in message", async () => {
  let callCount = 0;
  // Assembled so this synthetic test value is not a literal key-shaped
  // string (gitleaks generic-api-key) while preserving the real scrub
  // semantics being tested.
  const apiKey = ["mg", "test_key_abcdef123456"].join("_");
  const fetchImpl = async (): Promise<Response> => {
    callCount++;
    return new Response(
      JSON.stringify({ error: { message: `Invalid API key (sent ${apiKey})`, type: "invalid_api_key" } }),
      { status: 401 },
    );
  };
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => apiKey }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "credentials_unavailable");
      const message = (error as Error).message;
      assert.ok(!message.includes(apiKey), "key must be scrubbed from error text");
      return true;
    },
  );
  assert.equal(callCount, 1);
});

test("MG-05: model unavailable to key (HTTP 403) -> typed FAIL before spend", async () => {
  const fetchImpl = async (): Promise<Response> =>
    okResponse({ error: { message: "model not allowed for this account", code: "free_tier_model_not_allowed" } }, 403);
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "credentials_unavailable");
      return true;
    },
  );
});

test("MG-06: HTTP 402 budget/credit block -> policy_violation with cost evidence retained", async () => {
  const fetchImpl = async (): Promise<Response> =>
    okResponse({ error: { message: "budget exceeded" }, usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.000003 } }, 402);
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "policy_violation");
      return true;
    },
  );
});

test("MG-07: non-JSON success body -> model_failed", async () => {
  const fetchImpl = async (): Promise<Response> => new Response("<html>gateway</html>", { status: 200 });
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "model_failed");
      return true;
    },
  );
});

test("MG-08: timeout -> model_timeout classification", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error(" TimeoutError: The operation timed out ");
  };
  await assert.rejects(
    invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "model_timeout");
      return true;
    },
  );
});

test("MG-09: successful response -> exact model/provider/usage/cost recorded", async () => {
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    // Verify the wire request shape once.
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body["model"], MERGE_PILOT_MODEL);
    assert.equal(String(input), "https://api-gateway.merge.dev/v1/chat/completions");
    return okResponse({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22, cost: 0.00001234 },
    });
  };
  const result = await invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" });
  assert.equal(result.requestedModel, MERGE_PILOT_MODEL);
  assert.equal(result.respondedModel, "glm-5.3-flash");
  assert.equal(result.promptTokens, 17);
  assert.equal(result.completionTokens, 5);
  assert.equal(result.totalTokens, 22);
  assert.ok(Math.abs((result.costUsd ?? 0) - 0.00001234) < 1e-12);
  assert.equal(result.content, "{\"ok\":true}");
});

test("MG-10: missing usage -> null tokens (conservative accounting downstream)", async () => {
  const fetchImpl = async (): Promise<Response> =>
    okResponse({
      model: "glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    });
  const result = await invokeModelViaMerge(baseRequest, { fetchImpl, loadApiKey: () => "test-key" });
  assert.equal(result.promptTokens, null);
  assert.equal(result.completionTokens, null);
  assert.equal(result.costUsd, null);
});

test("MG-11: model discovery fails closed without credentials, zero network", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    listMergeModels({ fetchImpl, loadApiKey: () => null }),
    (error: unknown) => {
      assert.equal((error as InvocationFailure).code, "credentials_unavailable");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Pilot policy profile invariants
// ---------------------------------------------------------------------------

test("MG-12: pilot profile pins exact model, provider, roles, budget, no authority", () => {
  assert.equal(MERGE_PILOT_MODEL, "zai/glm-5.3-flash");
  assert.equal(MERGE_PILOT_PROVIDER, "merge");
  assert.ok((MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes("site_intelligence"));
  assert.ok((MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes("competitor_site_analysis"));
  assert.ok((MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes("content_writer"));
  assert.ok(!(MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes("design_director"));
  assert.ok(!(MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes("image_generator"));
  assert.equal(MERGE_PILOT_BUDGET_LIMIT_USD, 2.0);
  assert.equal(MERGE_TEST_PROFILE_VERSION, "merge-gateway-test-pilot-v1");
  assert.equal(mergePilotModelForRole("design_director"), null);
  assert.equal(mergePilotModelForRole("site_intelligence"), MERGE_PILOT_MODEL);
  assert.equal(isMergePilotEnabled({}), false);
  assert.equal(isMergePilotEnabled({ FACTORY_LLM_PROVIDER: "merge" }), true);
  assert.equal(isMergePilotEnabled({ FACTORY_LLM_PROVIDER: "openrouter" }), false);
});

test("MG-12b: modelGatewaySchema accepts merge as provenance value", () => {
  assert.deepEqual(modelGatewaySchema.safeParse("openrouter").error, undefined);
  assert.deepEqual(modelGatewaySchema.safeParse("merge").error, undefined);
  assert.ok(modelGatewaySchema.safeParse("stitch").success === false);
});

test("MG-13: pilot model has trusted pricing (fail closed before paid calls)", () => {
  const pricing = getModelPricing(MERGE_PILOT_MODEL);
  assert.ok(pricing, "zai/glm-5.3-flash must exist in TRUSTED_MODEL_PRICING");
  // Conservative ceilings strictly above the verified vendor catalog rates.
  assert.ok(pricing.promptUsdPerToken >= 0.15e-6, "prompt ceiling >= 0.15/1M");
  assert.ok(pricing.completionUsdPerToken >= 0.5e-6, "completion ceiling >= 0.50/1M");
});

test("MG-14: writer resolution under the pilot uses the fixed model and never champion", () => {
  const env = { FACTORY_LLM_PROVIDER: "merge" };
  const resolved = resolveWriterModel(env);
  assert.equal(resolved.model, MERGE_PILOT_MODEL);
  assert.equal(resolved.overrideApplied, false);
});

test("MG-15: override guard unaffected by the pilot; governed envs still reject overrides", () => {
  assert.doesNotThrow(() => assertOverrideStartupPolicy({ FACTORY_LLM_PROVIDER: "merge" }));
  assert.throws(() => assertOverrideStartupPolicy({ CI: "true", FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "zai/glm-5.3-flash" }));
});

test("MG-16: credential scrubbing beats key-shaped strings", () => {
  // Assembled concatenation: synthetic scrub fixture, not a literal
  // key-shaped string (gitleaks generic-api-key false-positive avoidance).
  const apiKey = ["mg", "ooREDactedKeyMARKER0001"].join("");
  const message = `request failed with Bearer ${apiKey} at https://user:pass@evil.example`;
  const scrubbed = scrubCredentials(message, apiKey);
  assert.ok(!scrubbed.includes(apiKey), "raw key must never survive scrubbing");
  assert.ok(!scrubbed.includes("user:pass"), "URL credentials must be redacted");
  assert.ok(scrubbed.includes("Bearer [redacted]"));
});

test("MG-17: loadMergeApiKey prefers explicit env and falls back to the gitignored .env files", () => {
  // Present env value always wins untouched.
  assert.equal(loadMergeApiKey({ MERGE_GATEWAY_API_KEY: "mg_env_value" }), "mg_env_value");
  // With no env value left the loader may consult gitignored dotfiles — it
  // must never throw when those are absent (isolated temp cwd).
  const originalCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    // Temporarily neutralize the repo-root fallback by overriding HOME-based
    // resolution: the loader uses a fixed repo-root URL relative to the
    // module, so with a clean env record the .env files (if loadable) only
    // ADD a value; absence must still return null rather than throw.
    const saved = process.env.MERGE_GATEWAY_API_KEY;
    delete process.env.MERGE_GATEWAY_API_KEY;
    try {
      const loaded = loadMergeApiKey({});
      // Either null (no dotfiles present) or a real gitignored value —
      // importantly: never an exception path.
      assert.ok(loaded === null || typeof loaded === "string");
    } finally {
      if (saved !== undefined) process.env.MERGE_GATEWAY_API_KEY = saved;
    }
  } finally {
    process.chdir(originalCwd);
  }
});

test("MG-18: OpenRouter champion resolution is untouched by pilot env presence", () => {
  const resolved = resolveWriterModel({ FACTORY_LLM_PROVIDER: "openrouter" });
  assert.equal(resolved.model, "anthropic/claude-opus-5");
  assert.equal(resolved.overrideApplied, false);
});
