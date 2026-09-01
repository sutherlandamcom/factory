import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_WORKER_POLICY,
  FACTORY_MODEL_POLICY_VERSION,
  FACTORY_ROLE_IDS,
  MODEL_ROLE_IDS,
  MODEL_ROLE_POLICY,
  mayReceiveProprietaryData,
  resolveModelSequence,
  type FactoryRoleId,
} from "../src/models/policy.js";

const EXPECTED_MATRIX: Record<string, { model: string; status: string }> = {
  bulk_research_extraction: { model: "google/gemini-3.7-flash", status: "future" },
  competitor_site_analysis: { model: "openai/gpt-5.6-sol", status: "future" },
  site_intelligence: { model: "anthropic/claude-opus-5", status: "active" },
  blueprint_architect: { model: "anthropic/claude-opus-5", status: "active" },
  content_writer: { model: "anthropic/claude-opus-5", status: "active" },
  content_critic: { model: "openai/gpt-5.6-sol", status: "active" },
  design_director: { model: "anthropic/claude-opus-5", status: "active" },
  visual_critic: { model: "openai/gpt-5.6-sol", status: "future" },
  cheap_repair: { model: "z-ai/glm-5.3-flash", status: "future" },
  image_generator: { model: "openai/gpt-image-2", status: "future" },
};

test("policy version is the frozen v0 identifier", () => {
  assert.equal(FACTORY_MODEL_POLICY_VERSION, "factory-model-policy-v0");
});

test("the full intended role set is machine-readable with 11 unique ids", () => {
  assert.equal(FACTORY_ROLE_IDS.length, 11);
  assert.equal(new Set<string>(FACTORY_ROLE_IDS).size, 11);
  for (const expected of [
    "bulk_research_extraction",
    "competitor_site_analysis",
    "site_intelligence",
    "blueprint_architect",
    "content_writer",
    "content_critic",
    "design_director",
    "visual_critic",
    "code_worker",
    "cheap_repair",
    "image_generator",
  ] as const satisfies readonly FactoryRoleId[]) {
    assert.ok(FACTORY_ROLE_IDS.includes(expected), `missing role ${expected}`);
  }
});

test("every operator-fixed assignment matches the authoritative matrix exactly", () => {
  assert.equal(MODEL_ROLE_IDS.length, 10, "code_worker is a model+runtime pair, not an OpenRouter role");
  for (const [roleId, expected] of Object.entries(EXPECTED_MATRIX)) {
    const policy = MODEL_ROLE_POLICY[roleId as keyof typeof MODEL_ROLE_POLICY];
    assert.ok(policy, `missing policy for ${roleId}`);
    assert.equal(policy.championModel, expected.model, `${roleId} champion model`);
    assert.equal(policy.implementationStatus, expected.status, `${roleId} implementation status`);
    assert.equal(policy.roleId, roleId);
    assert.equal(policy.gateway, "openrouter");
    assert.equal(mayReceiveProprietaryData(policy), true, `${roleId} must keep the proprietary gate`);
  }
});

test("content and design role separation is intentional", () => {
  // The writer is never its own factuality authority; design generation and
  // visual criticism use different models on purpose.
  assert.notEqual(MODEL_ROLE_POLICY.content_writer.championModel, MODEL_ROLE_POLICY.content_critic.championModel);
  assert.notEqual(MODEL_ROLE_POLICY.design_director.championModel, MODEL_ROLE_POLICY.visual_critic.championModel);
  // Bulk extraction and competitor analysis are different workloads.
  assert.notEqual(
    MODEL_ROLE_POLICY.bulk_research_extraction.championModel,
    MODEL_ROLE_POLICY.competitor_site_analysis.championModel,
  );
});

test("code worker: model + runtime split with migration NOT activated", () => {
  assert.equal(CODE_WORKER_POLICY.roleId, "code_worker");
  assert.equal(CODE_WORKER_POLICY.model, "anthropic/claude-opus-5");
  assert.equal(CODE_WORKER_POLICY.runtimeTarget, "claude-code");
  assert.equal(CODE_WORKER_POLICY.currentlyActiveRuntime, "codex-cli");
  assert.equal(CODE_WORKER_POLICY.migrationActivated, false);
  assert.ok(!MODEL_ROLE_POLICY["code_worker" as keyof typeof MODEL_ROLE_POLICY]);
});

test("no role resolves to openrouter/auto and no duplicates exist in fallback sequences", () => {
  for (const roleId of MODEL_ROLE_IDS) {
    const sequence = resolveModelSequence(MODEL_ROLE_POLICY[roleId]);
    assert.ok(sequence.length >= 1);
    for (const model of sequence) {
      assert.notEqual(model, "openrouter/auto");
      assert.ok(!model.startsWith("openrouter/auto"));
      assert.match(model, /^[A-Za-z0-9._/-]{1,200}$/);
    }
    assert.equal(new Set(sequence).size, sequence.length, `${roleId} duplicate fallback models`);
  }
});

test("production role resolution returns the configured primary model (no hidden substitution)", () => {
  const sequence = resolveModelSequence(MODEL_ROLE_POLICY.blueprint_architect);
  assert.equal(sequence[0], "anthropic/claude-opus-5");
  assert.equal(resolveModelSequence(MODEL_ROLE_POLICY.site_intelligence)[0], "anthropic/claude-opus-5");
  assert.equal(resolveModelSequence(MODEL_ROLE_POLICY.content_critic)[0], "openai/gpt-5.6-sol");
});

test("policy is deeply immutable: eval tooling cannot mutate it", () => {
  assert.equal(Object.isFrozen(MODEL_ROLE_POLICY), true);
  assert.equal(Object.isFrozen(MODEL_ROLE_POLICY.blueprint_architect), true);
  assert.equal(Object.isFrozen(Object.getOwnPropertyDescriptor(MODEL_ROLE_POLICY.blueprint_architect, "challengerModels")!.value), true);
  assert.throws(() => {
    "use strict";
    (MODEL_ROLE_POLICY as Record<string, unknown>).blueprint_architect = {} as never;
  });
  assert.throws(() => {
    "use strict";
    (MODEL_ROLE_POLICY.blueprint_architect as unknown as Record<string, unknown>).championModel = "openrouter/auto";
  });
});
