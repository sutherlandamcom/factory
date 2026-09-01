import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalResult } from "../src/evals/contracts.js";
import { MODEL_ROLE_POLICY } from "../src/models/policy.js";
import { runRoleEval } from "../src/evals/runner.js";
import { loadBlueprintFixtureInputs, loadBlueprintFixtureInputsRaw } from "./blueprint-fixtures.js";

const VALID_KEY = "sk-or-test-abcdef1234567890";

const { request, research, plan } = loadBlueprintFixtureInputs();

const MODEL_LIST = {
  data: [
    { id: "openai/gpt-test-a", context_length: 400_000, created: 1_800_000_001, supported_features: [] },
    { id: "anthropic/claude-test-b", context_length: 300_000, created: 1_800_000_002, supported_features: [] },
    { id: "google/gemini-test-c", context_length: 200_000, created: 1_800_000_003, supported_features: [] },
  ],
};

const DRAFT_A = {
  heading: "What happens after you call",
  body: "When you request an inspection, a documented walk-through follows within the promised forty-eight hour window. The inspector records shingle condition, flashing, and gutter state, then explains the repair scope before any work is scheduled. You keep the documentation for your own records.",
  ctaJob: "Request the free inspection",
};
const DRAFT_B = {
  heading: "Our secret 24/7 guarantee",
  body: "We guarantee the lowest price in Denver and we promise insurance approval for every claim. Our crews are available day and night, every day, and we have completed over ten thousand roofs this year alone. Call now for a same-hour response anywhere in Colorado.",
  ctaJob: "Call now",
};
const DRAFT_C = {
  heading: "Roof care without the pressure",
  body: "A roof decision is easier with documentation. The inspection covers shingles, flashing, and gutters, and the findings arrive in writing before any commitment. If a repair is the right size, the scope says so plainly; replacement is only proposed when the evidence supports it.",
  ctaJob: "Book the free inspection",
};

const JUDGE_VERDICT = (preferred: "A" | "B" | "C") => ({
  scores: {
    A: { grounding: 5, usefulness: 4, restraint: 5, accuracy: 5, quality: 4 },
    B: { grounding: 1, usefulness: 2, restraint: 1, accuracy: 1, quality: 2 },
    C: { grounding: 5, usefulness: 5, restraint: 4, accuracy: 5, quality: 5 },
  },
  preferred,
  rationale: "Grounded, restrained drafts score higher; invented guarantees and volumes are heavily penalized.",
});

function evalDeps(handler: (model: string) => { content: string } | Error) {
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(MODEL_LIST) } as unknown as Response;
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init.body)) as { model?: string };
      const model = body.model ?? "";
      const outcome = handler(model);
      if (outcome instanceof Error) throw outcome;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model,
            provider: `Provider-${model}`,
            choices: [{ message: { content: outcome.content } }],
            usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, cost: 0.001 },
          }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch url ${url}`);
  };
  return { fetchImpl, loadApiKey: () => VALID_KEY };
}

test("content_writer bake-off: gates, blind judging, winner, artifacts", async () => {
  const repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "factory-eval-test-")));
  // Candidates answer with drafts; judge calls (same models, later calls)
  // answer with verdicts. The gpt candidate fabricates claims; judges then
  // penalize it heavily.
  const callCounts = new Map<string, number>();
  const result: EvalResult = await runRoleEval(repoRoot, {
    roleId: "content_writer",
    requestInput: request,
    researchInput: research,
    planInput: plan,
    gatewayDeps: evalDeps((model) => {
      const callIndex = callCounts.get(model) ?? 0;
      callCounts.set(model, callIndex + 1);
      if (callIndex > 0) {
        // Judge pass: openai judge and google judge both rank the grounded
        // drafts above the fabricating one.
        return { content: JSON.stringify(JUDGE_VERDICT("C")) };
      }
      return {
        content: JSON.stringify(
          model.includes("gpt") ? DRAFT_B : model.includes("claude") ? DRAFT_A : DRAFT_C,
        ),
      };
    }),
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.label),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.family),
    ["openai", "anthropic", "google"],
  );
  const gpt = result.candidates.find((candidate) => candidate.family === "openai")!;
  const claude = result.candidates.find((candidate) => candidate.family === "anthropic")!;
  assert.ok(gpt.deterministicValid === false || gpt.deterministicValid === true); // measured either way
  assert.ok(claude.costUsd !== null, "gateway cost must be captured when available");
  assert.equal(result.judges.length, 2, "two blind judge passes");
  assert.ok(result.judges.every((judge) => judge.verdict !== null));
  assert.ok(result.winner, "a winner must be selected");
  assert.ok(result.winner.label === "C" || result.winner.label === "A");
  assert.notEqual(result.winner.label, "B", "the fabricating candidate must not win");
  assert.ok(result.totalCostUsd > 0);
  assert.ok(result.totalCostUsd <= result.budgetUsdCap);

  const runDir = path.join(repoRoot, ".factory", "evals", "autonomy-v0", result.runId);
  const stored = JSON.parse(await readFile(path.join(runDir, "eval-result.json"), "utf8")) as EvalResult;
  assert.equal(stored.roleId, "content_writer");
  await rm(repoRoot, { recursive: true, force: true });
});

test("bake-off stops when the budget cap is exceeded", async () => {
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "factory-eval-budget-")));
  const previous = process.env.FACTORY_EVAL_BUDGET_USD;
  process.env.FACTORY_EVAL_BUDGET_USD = "0.0005";
  try {
    const result: EvalResult = await runRoleEval(repoRoot, {
      roleId: "content_writer",
      requestInput: request,
      researchInput: research,
      planInput: plan,
      gatewayDeps: evalDeps(() => ({ content: JSON.stringify(DRAFT_A) })),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "eval_budget_exceeded");
    assert.ok(result.candidates.length >= 1, "at least one candidate ran before the cap hit");
  } finally {
    if (previous === undefined) delete process.env.FACTORY_EVAL_BUDGET_USD;
    else process.env.FACTORY_EVAL_BUDGET_USD = previous;
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("P1-2: public_only role policy blocks proprietary eval inputs with zero invocations", async () => {
  const repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "factory-eval-policy-")));
  let networkCalls = 0;
  const result: EvalResult = await runRoleEval(repoRoot, {
    roleId: "content_writer",
    requestInput: request,
    researchInput: research,
    planInput: plan,
    policyOverride: {
      ...MODEL_ROLE_POLICY.content_writer,
      sensitiveDataPolicy: "public_only",
    },
    gatewayDeps: evalDeps(() => {
      networkCalls++;
      return { content: JSON.stringify(DRAFT_A) };
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "eval_policy_violation");
  assert.match(result.error?.message ?? "", /public_only/);
  assert.equal(result.candidates.length, 0, "no candidates may be invoked");
  assert.equal(networkCalls, 0, "zero model invocations must reach the gateway");
  await rm(repoRoot, { recursive: true, force: true });
});

test("blueprint_architect bake-off requires a plan input", async () => {
  const repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "factory-eval-plan-")));
  const result = await runRoleEval(repoRoot, {
    roleId: "blueprint_architect",
    requestInput: request,
    researchInput: research,
    gatewayDeps: evalDeps(() => ({ content: "{}" })),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "eval_input_invalid");
  await rm(repoRoot, { recursive: true, force: true });
});

test("site_intelligence bake-off reuses the accepted production gates", async () => {
  const repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "factory-eval-intel-")));
  const raw = loadBlueprintFixtureInputsRaw();
  // Feed a deliberately invalid plan text: the gate must mark it invalid.
  let calls = 0;
  const result: EvalResult = await runRoleEval(repoRoot, {
    roleId: "site_intelligence",
    requestInput: raw.request,
    researchInput: raw.research,
    gatewayDeps: evalDeps(() => {
      calls++;
      return { content: `{"broken":"not a plan"}` };
    }),
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.ok(calls >= 3, "all three families invoked");
  assert.ok(result.candidates.every((candidate) => candidate.deterministicValid === false));
  assert.equal(result.winner, null, "no winner when nothing passes the gates");
  await rm(repoRoot, { recursive: true, force: true });
});
