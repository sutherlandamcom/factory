import assert from "node:assert/strict";
import test from "node:test";
import {
  FACTORY_ROLE_IDS,
  MODEL_ROLE_POLICY,
  activeModelOverrides,
  overrideEnvKeyForRole,
  resolveModelSequence,
  resolveRoleModel,
} from "../src/models/policy.js";
import {
  assertOverrideStartupPolicy,
  isGovernedEnvironment,
} from "../src/models/override-guard.js";
import {
  calculateConservativeInvocationCostMicros,
  getModelPricing,
} from "../src/models/pricing.js";
import { FactoryError } from "../src/executor/errors.js";

// ---- Phase 0: governed dev-time model override -----------------------------

test("override absent -> champion resolution unchanged (byte-identical semantics)", () => {
  for (const roleId of FACTORY_ROLE_IDS) {
    if (roleId === "code_worker") continue;
    const resolved = resolveRoleModel(roleId, {});
    assert.equal(resolved.overrideApplied, false, roleId);
    assert.equal(resolved.model, MODEL_ROLE_POLICY[roleId as keyof typeof MODEL_ROLE_POLICY].championModel, roleId);
    assert.equal(resolved.championModel, resolved.model, roleId);
  }
});

test("override set -> resolved model is the override with provenance markers", () => {
  const env = { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" };
  const resolved = resolveRoleModel("content_writer", env);
  assert.equal(resolved.overrideApplied, true);
  assert.equal(resolved.model, "z-ai/glm-5.3-flash");
  assert.equal(resolved.championModel, "anthropic/claude-opus-5");
  // Other roles are untouched by that override.
  assert.equal(resolveRoleModel("blueprint_architect", env).overrideApplied, false);
  assert.equal(activeModelOverrides(env).length, 1);
  assert.deepEqual(activeModelOverrides(env)[0], {
    roleId: "content_writer",
    model: "z-ai/glm-5.3-flash",
    championModel: "anthropic/claude-opus-5",
  });
});

test("override naming the champion itself is a no-op (overrideApplied false)", () => {
  const env = { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "anthropic/claude-opus-5" };
  const resolved = resolveRoleModel("content_writer", env);
  assert.equal(resolved.overrideApplied, false);
  assert.equal(activeModelOverrides(env).length, 0);
});

test("unknown role id fails closed", () => {
  assert.throws(() => resolveRoleModel("nonexistent_role" as never, {}), /unknown factory role id/);
});

test("resolveModelSequence champion-first behavior is unchanged", () => {
  const seq = resolveModelSequence(MODEL_ROLE_POLICY.content_writer);
  assert.deepEqual([...seq], ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]);
});

test("override env key convention is deterministic", () => {
  assert.equal(overrideEnvKeyForRole("content_writer"), "FACTORY_MODEL_OVERRIDE__CONTENT_WRITER");
});

// ---- Override startup guard -------------------------------------------------

test("override present in CI/acceptance mode -> hard startup failure", () => {
  const env = { CI: "true", FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" };
  assert.throws(() => assertOverrideStartupPolicy(env), (err: unknown) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /DEV MODEL OVERRIDE FORBIDDEN/);
    return true;
  });
  const env2 = { FACTORY_ACCEPTANCE_MODE: "1", FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" };
  assert.throws(() => assertOverrideStartupPolicy(env2), FactoryError);
});

test("override present outside governed environments -> permitted, diagnostics returned", () => {
  const env = { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" };
  const result = assertOverrideStartupPolicy(env);
  assert.equal(result.activeOverrides.length, 1);
  assert.equal(result.fixtureModes.length, 0);
});

test("no overrides anywhere -> guard passes silently", () => {
  const result = assertOverrideStartupPolicy({ CI: "true" });
  assert.equal(result.activeOverrides.length, 0);
});

test("live-proof path forbids fixture provider modes even without overrides", () => {
  const env = { FACTORY_LIVE_PROOF: "true", FACTORY_WRITER_MODE: "fixture" };
  assert.throws(() => assertOverrideStartupPolicy(env), (err: unknown) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /PRODUCTION PROVIDER MODE/);
    return true;
  });
});

test("governed environment detection covers CI and acceptance flags", () => {
  assert.equal(isGovernedEnvironment({}), false);
  assert.equal(isGovernedEnvironment({ CI: "true" }), true);
  assert.equal(isGovernedEnvironment({ CI: "1" }), true);
  assert.equal(isGovernedEnvironment({ FACTORY_ACCEPTANCE_MODE: "true" }), true);
  assert.equal(isGovernedEnvironment({ FACTORY_LIVE_PROOF: "1" }), true);
});

// ---- Phase 0: trusted pricing -----------------------------------------------

test("z-ai/glm-5.3-flash is priced (verified OpenRouter catalog) and conservative", () => {
  const pricing = getModelPricing("z-ai/glm-5.3-flash");
  assert.ok(pricing, "override target must be priced or paid overrides fail closed");
  // Verified catalog: $0.075/1M prompt, $0.25/1M completion; ceilings strictly above.
  assert.equal(pricing.promptUsdPerToken, 0.0000001);
  assert.equal(pricing.completionUsdPerToken, 0.0000003);
});

test("anthropic/claude-opus-5 is priced at verified OpenRouter catalog rates", () => {
  const pricing = getModelPricing("anthropic/claude-opus-5");
  assert.ok(pricing);
  assert.equal(pricing.promptUsdPerToken, 0.000005);
  assert.equal(pricing.completionUsdPerToken, 0.000025);
});

test("unpriced override target -> conservative cost fails closed (zero provider calls)", () => {
  assert.throws(
    () =>
      calculateConservativeInvocationCostMicros({
        model: "some/unpriced-model",
        provider: "openrouter",
        systemPrompt: "s",
        userPrompt: "u",
        maxOutputTokens: 100,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /fails closed/);
      return true;
    },
  );
});

test("priced override target gets a bounded conservative cost ceiling", () => {
  const micros = calculateConservativeInvocationCostMicros({
    model: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    systemPrompt: "a".repeat(1000),
    userPrompt: "b".repeat(1000),
    maxOutputTokens: 1000,
  });
  assert.ok(micros > 0);
  // Mirror the exact conservative bound: UTF-8 bytes + 256 framing, ×1.25
  // safety factor, then priced at the trusted ceilings.
  const utf8Bytes = Buffer.byteLength("a".repeat(1000) + "\n" + "b".repeat(1000), "utf8");
  const inputTokens = Math.max(1, Math.ceil((utf8Bytes + 256) * 1.25));
  const expected = Math.ceil((inputTokens * 0.0000001 + 1000 * 0.0000003) * 1_000_000);
  assert.equal(micros, expected);
});
