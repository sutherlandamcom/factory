import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BlueprintResult, ModelInvocation } from "@factory/contracts";
import { MODEL_ROLE_POLICY } from "../src/models/policy.js";
import { ModelCallError } from "../src/models/gateway.js";
import { runBlueprint, type ModelInvoker, type RunBlueprintDeps } from "../src/blueprint/runner.js";
import { parseBlueprintResult, parseSiteBlueprint } from "@factory/contracts";
import {
  loadBlueprintFixtureInputs,
  loadBlueprintFixtureInputsRaw,
  makeValidBlueprintJson,
} from "./blueprint-fixtures.js";

const { request, research, plan } = loadBlueprintFixtureInputs();
const raw = loadBlueprintFixtureInputsRaw();

async function tempRepo(): Promise<string> {
  return realpathSync(await mkdtemp(path.join(tmpdir(), "factory-blueprint-test-")));
}

function fakeSourceCommit(): RunBlueprintDeps {
  return {
    sourceCommitResolver: async () => ({ ok: true, commit: "a".repeat(40) }),
    now: () => new Date("2026-09-01T10:00:00Z"),
    runIdSuffix: () => "abc12345",
  };
}

function fakeInvoker(outputs: Array<string | Error>): { invoker: ModelInvoker; calls: Array<{ model: string }> } {
  const calls: Array<{ model: string }> = [];
  let index = 0;
  const invoker: ModelInvoker = async (request) => {
    calls.push({ model: request.model });
    const output = outputs[index] ?? outputs[outputs.length - 1]!;
    index++;
    if (output instanceof Error) throw output;
    return {
      requestedModel: request.model,
      respondedModel: request.model,
      provider: "TestProvider",
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      costUsd: 0.002,
      content: output,
    };
  };
  return { invoker, calls };
}

async function readRunDir(repoRoot: string, result: BlueprintResult): Promise<string> {
  assert.ok(result.artifacts);
  return path.join(repoRoot, result.artifacts.runDirectory);
}

test("successful blueprint run publishes verified artifacts and records exact model", async () => {
  const repoRoot = await tempRepo();
  const { invoker } = fakeInvoker([makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.pageCount, 5);
  assert.equal(result.readyCount, 5);
  assert.equal(result.blockedCount, 0);
  assert.ok(result.modelInvocation);
  assert.equal(result.modelInvocation.respondedModel, MODEL_ROLE_POLICY.blueprint_architect.championModel);
  assert.equal(result.modelInvocation.gateway, "openrouter");
  assert.equal(result.modelInvocation.fallback, false);
  assert.ok(result.blueprintDigest);

  const runDir = await readRunDir(repoRoot, result);
  const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.roleId, "blueprint_architect");
  const storedBlueprint = parseSiteBlueprint(await readFile(path.join(runDir, "site-blueprint.json"), "utf8"));
  assert.equal(storedBlueprint.pages.length, 5);
  const storedResult = parseBlueprintResult(JSON.parse(await readFile(path.join(runDir, "blueprint-result.json"), "utf8")));
  assert.equal(storedResult.status, "succeeded");
  const invocations: ModelInvocation[] = manifest.modelInvocations;
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.costUsd, 0.002);
  await rm(repoRoot, { recursive: true, force: true });
});

test("schema-invalid output triggers bounded repair and then succeeds", async () => {
  const repoRoot = await tempRepo();
  const { invoker, calls } = fakeInvoker([
    `{"version":"v0","methodologyVersion":"site-blueprint-v0","siteId":"summit-roofing","broken":true}`,
    makeValidBlueprintJson(request, plan),
  ]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.attemptCount, 2);
  assert.equal(calls.length, 2);
  const runDir = await readRunDir(repoRoot, result);
  const repairPrompt = await readFile(path.join(runDir, "attempts/2/prompt.txt"), "utf8");
  assert.match(repairPrompt, /bounded REPAIR attempt/);
  assert.match(repairPrompt, /Unrecognized|unrecognized_keys|invalid/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("deterministic validation failure (IA mutation) feeds repair, not acceptance", async () => {
  const repoRoot = await tempRepo();
  // First attempt drops an unreferenced plan page (IA mutation that still
  // parses); second attempt is valid.
  const mutated = JSON.parse(makeValidBlueprintJson(request, plan));
  mutated.pages = mutated.pages.filter((page: { slug: string }) => page.slug !== "/blog/roof-replacement-cost-guide");
  const { invoker } = fakeInvoker([JSON.stringify(mutated), makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.attemptCount, 2);
  const runDir = await readRunDir(repoRoot, result);
  const repairPrompt = await readFile(path.join(runDir, "attempts/2/prompt.txt"), "utf8");
  assert.match(repairPrompt, /missing from the blueprint|page count/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("exhausted attempts end needs_review with no accepted artifact", async () => {
  const repoRoot = await tempRepo();
  // Three DISTINCT invalid outputs: schema failure, unknown-field failure,
  // and a structurally valid but IA-mutating blueprint on the final attempt.
  const mutated = JSON.parse(makeValidBlueprintJson(request, plan));
  mutated.pages = mutated.pages.filter((page: { slug: string }) => page.slug !== "/");
  const { invoker } = fakeInvoker([
    `{"broken":1}`,
    `{"version":"v0","methodologyVersion":"site-blueprint-v0","siteId":"summit-roofing","unexpectedField":true}`,
    JSON.stringify(mutated),
  ]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.error?.code, "blueprint_attempts_exhausted");
  assert.equal(result.modelInvocation, null);
  await rm(repoRoot, { recursive: true, force: true });
});

test("no-progress detection stops repeated invalid output", async () => {
  const repoRoot = await tempRepo();
  const invalid = `{"version":"v0","methodologyVersion":"site-blueprint-v0","siteId":"summit-roofing","broken":true}`;
  const { invoker } = fakeInvoker([invalid, invalid, invalid, invalid]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.error?.code, "blueprint_no_progress");
  await rm(repoRoot, { recursive: true, force: true });
});

test("champion failure falls back to the explicit challenger and records it", async () => {
  const repoRoot = await tempRepo();
  const calls: Array<{ model: string }> = [];
  let first = true;
  const invoker: ModelInvoker = async (call) => {
    calls.push({ model: call.model });
    if (first) {
      first = false;
      throw new ModelCallError("model_failed", "simulated champion outage");
    }
    return {
      requestedModel: call.model,
      respondedModel: call.model,
      provider: "TestProvider",
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      costUsd: 0.002,
      content: makeValidBlueprintJson(request, plan),
    };
  };
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.model, MODEL_ROLE_POLICY.blueprint_architect.championModel);
  assert.equal(calls[1]!.model, MODEL_ROLE_POLICY.blueprint_architect.challengerModels[0]);
  assert.equal(result.modelInvocation?.respondedModel, MODEL_ROLE_POLICY.blueprint_architect.challengerModels[0]);
  assert.equal(result.modelInvocation?.fallback, true);
  assert.equal(result.modelInvocations.length, 2);
  const runDir = await readRunDir(repoRoot, result);
  const invocationArtifact = JSON.parse(await readFile(path.join(runDir, "attempts/invocations/1.json"), "utf8"));
  assert.equal(invocationArtifact.fallback, false);
  await rm(repoRoot, { recursive: true, force: true });
});

test("credential failures are terminal: no silent model fallback", async () => {
  const repoRoot = await tempRepo();
  const { invoker, calls } = fakeInvoker([
    new ModelCallError("credentials_unavailable", "gateway rejected credentials (HTTP 401): [redacted]"),
    makeValidBlueprintJson(request, plan),
  ]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_credentials_unavailable");
  assert.equal(calls.length, 1, "must not retry against another model");
  await rm(repoRoot, { recursive: true, force: true });
});

test("missing credentials fail closed before any model work", async () => {
  const repoRoot = await tempRepo();
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit() },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_credentials_unavailable");
  await rm(repoRoot, { recursive: true, force: true });
});

test("incoming plan that fails the accepted Intelligence gates is rejected", async () => {
  const repoRoot = await tempRepo();
  const mutatedPlan = JSON.parse(JSON.stringify(plan));
  // Push the plan over the request page budget (5): a gate the accepted
  // Intelligence validation enforces before any blueprint model work.
  const extraPage = JSON.parse(JSON.stringify(mutatedPlan.pages[mutatedPlan.pages.length - 1]));
  extraPage.slug = "/blog/extra-budget-violating-guide";
  extraPage.evidenceIds = mutatedPlan.pages[mutatedPlan.pages.length - 1].evidenceIds;
  mutatedPlan.pages.push(extraPage);
  const { invoker, calls } = fakeInvoker([makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: mutatedPlan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_plan_invalid");
  assert.equal(calls.length, 0, "no model may run on an invalid base plan");
  await rm(repoRoot, { recursive: true, force: true });
});

test("unverified source provenance fails closed", async () => {
  const repoRoot = await tempRepo();
  const { invoker, calls } = fakeInvoker([makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    {
      sourceCommitResolver: async () => ({ ok: false, reason: "dirty tree" }),
      invoker,
      now: () => new Date("2026-09-01T10:00:00Z"),
      runIdSuffix: () => "abc12345",
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_source_unverified");
  assert.equal(calls.length, 0);
  await rm(repoRoot, { recursive: true, force: true });
});

test("model timeouts are terminal for the sequence and recorded", async () => {
  const repoRoot = await tempRepo();
  const calls: Array<{ model: string }> = [];
  const invoker: ModelInvoker = async (request) => {
    calls.push({ model: request.model });
    throw new ModelCallError("model_timeout", "operation timed out");
  };
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_model_timeout");
  assert.equal(calls.length, 3, "champion + two challengers attempted, then stop");
  await rm(repoRoot, { recursive: true, force: true });
});

test("P1-2: public_only role policy fails closed with zero invocations", async () => {
  const repoRoot = await tempRepo();
  const publicOnlyPolicy = {
    ...MODEL_ROLE_POLICY.blueprint_architect,
    sensitiveDataPolicy: "public_only" as const,
  };
  const { invoker, calls } = fakeInvoker([makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker, policy: publicOnlyPolicy },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_policy_violation");
  assert.match(result.error?.message ?? "", /public_only/);
  assert.equal(calls.length, 0, "zero model invocations must be performed");
  assert.equal(result.modelInvocations.length, 0);
  assert.equal(result.modelInvocation, null);
  await rm(repoRoot, { recursive: true, force: true });
});

test("P2: oversized raw model output is rejected before JSON acceptance and repaired", async () => {
  const repoRoot = await tempRepo();
  // > 256 KB of JSON-shaped garbage: must be rejected on the byte cap (not
  // on schema/parse grounds), feed bounded repair, and truncate its artifact.
  const oversized = `{"padding":"${"x".repeat(300 * 1024)}"}`;
  const { invoker, calls } = fakeInvoker([oversized, makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.attemptCount, 2);
  assert.equal(calls.length, 2);
  const runDir = await readRunDir(repoRoot, result);
  const rawArtifact = await readFile(path.join(runDir, "attempts/1/raw-output.txt"), "utf8");
  assert.ok(rawArtifact.length <= 256 * 1024 + 200, "artifact must be truncated at the cap");
  assert.match(rawArtifact, /truncated/);
  const repairPrompt = await readFile(path.join(runDir, "attempts/2/prompt.txt"), "utf8");
  assert.match(repairPrompt, /output cap/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("secrets never enter prompts or artifacts", async () => {
  const repoRoot = await tempRepo();
  let promptSeen = "";
  const invoker: ModelInvoker = async (call) => {
    promptSeen = call.prompt;
    return {
      requestedModel: call.model,
      respondedModel: call.model,
      provider: null,
      durationMs: 5,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
      content: makeValidBlueprintJson(request, plan),
    };
  };
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "succeeded");
  assert.ok(!promptSeen.toLowerCase().includes("openrouter_api_key=sk"));
  assert.ok(!promptSeen.includes("sk-or-"));
  const runDir = await readRunDir(repoRoot, result);
  const files = await readdir(runDir, { recursive: true });
  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".json")) continue;
    const content = await readFile(path.join(runDir, file), "utf8");
    assert.ok(!content.includes("sk-or-"), `secret leaked into ${file}`);
  }
  await rm(repoRoot, { recursive: true, force: true });
});

test("existing run directory refuses reuse (unique runIds)", async () => {
  const repoRoot = await tempRootWithExistingRun();
  const { invoker } = fakeInvoker([makeValidBlueprintJson(request, plan)]);
  const result = await runBlueprint(
    { repoRoot, planInput: plan, requestInput: request, researchInput: research },
    { ...fakeSourceCommit(), invoker },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blueprint_artifact_failed");
  await rm(repoRoot, { recursive: true, force: true });
});

async function tempRootWithExistingRun(): Promise<string> {
  const repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "factory-blueprint-collide-")));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(repoRoot, ".factory", "blueprint", "20260901T100000Z-abc12345"), { recursive: true });
  return repoRoot;
}
