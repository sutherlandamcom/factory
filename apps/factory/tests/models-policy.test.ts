import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_WORKER_POLICY,
  FACTORY_MODEL_POLICY_VERSION,
  FACTORY_ROLE_IDS,
  MODEL_ROLE_IDS,
  MODEL_ROLE_POLICY,
  activeCodeWorkerRuntime,
  codeWorkerBinding,
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

test("policy version is the explicit v0.1 successor of the accepted v0 policy", () => {
  // Model-policy semantics changed (code-worker routing v0); the version
  // string distinguishes old and new provenance — never a silent swap.
  assert.equal(FACTORY_MODEL_POLICY_VERSION, "factory-model-policy-v0.1");
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

test("code worker: primary is Kimi K3 (effort max) via Kimi Code CLI through OpenRouter", () => {
  assert.equal(CODE_WORKER_POLICY.roleId, "code_worker");
  // Exact OpenRouter slug — never an alias, never openrouter/auto, never a
  // "kimi-k3-max"-style invented id.
  assert.equal(CODE_WORKER_POLICY.primary.model, "moonshotai/kimi-k3");
  assert.equal(CODE_WORKER_POLICY.primary.reasoningEffort, "max");
  assert.equal(CODE_WORKER_POLICY.primary.runtime, "kimi-code-cli");
  assert.equal(CODE_WORKER_POLICY.primary.gateway, "openrouter");
  assert.equal(CODE_WORKER_POLICY.primary.tier, "primary");
});

test("code worker: senior is Claude Opus 5 via Claude Code through OpenRouter", () => {
  assert.equal(CODE_WORKER_POLICY.senior.model, "anthropic/claude-opus-5");
  assert.equal(CODE_WORKER_POLICY.senior.runtime, "claude-code");
  assert.equal(CODE_WORKER_POLICY.senior.gateway, "openrouter");
  assert.equal(CODE_WORKER_POLICY.senior.tier, "senior");
});

test("code worker: model, runtime, and gateway are distinct provenance fields", () => {
  // "Kimi K3 Max" is model id + reasoning effort, never one model string.
  assert.ok(!CODE_WORKER_POLICY.primary.model.includes("max"));
  assert.ok(!CODE_WORKER_POLICY.primary.model.includes("-k3-max"));
  assert.notEqual(CODE_WORKER_POLICY.primary.model, CODE_WORKER_POLICY.primary.runtime);
  assert.notEqual(CODE_WORKER_POLICY.senior.model, CODE_WORKER_POLICY.senior.runtime);
});

test("code worker: exact slug pins reject batch variants and tilde aliases", () => {
  for (const binding of [CODE_WORKER_POLICY.primary, CODE_WORKER_POLICY.senior]) {
    assert.ok(!binding.model.includes(":"), "no :batch-style variants");
    assert.ok(!binding.model.startsWith("~"), "no alias models");
    assert.notEqual(binding.model, "openrouter/auto");
    assert.match(binding.model, /^[a-z0-9][a-z0-9._/-]{2,120}$/);
  }
});

test("code worker: routing policy version and architecture are pinned", () => {
  assert.equal(CODE_WORKER_POLICY.routingPolicyVersion, "code-worker-routing-v0");
  assert.equal(CODE_WORKER_POLICY.currentlyActiveArchitecture, "code-worker-routing-v0");
});

test("code worker: migration NOT activated while legacy codex remains the accepted path", () => {
  assert.equal(CODE_WORKER_POLICY.migrationActivated, false);
  assert.equal(CODE_WORKER_POLICY.legacyRuntime, "codex-cli");
  assert.equal(activeCodeWorkerRuntime(), "codex-cli");
  assert.ok(!MODEL_ROLE_POLICY["code_worker" as keyof typeof MODEL_ROLE_POLICY]);
});

test("code worker: activation flips the active runtime to the primary worker", () => {
  const activated = { ...CODE_WORKER_POLICY, migrationActivated: true };
  assert.equal(activeCodeWorkerRuntime(activated), "kimi-code-cli");
});

test("code worker: bindings expose exact runtime/model/effort per tier", () => {
  const primary = codeWorkerBinding("primary");
  const senior = codeWorkerBinding("senior");
  assert.deepEqual(
    { model: primary.model, runtime: primary.runtime, reasoningEffort: primary.reasoningEffort },
    { model: "moonshotai/kimi-k3", runtime: "kimi-code-cli", reasoningEffort: "max" },
  );
  assert.deepEqual(
    { model: senior.model, runtime: senior.runtime },
    { model: "anthropic/claude-opus-5", runtime: "claude-code" },
  );
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
