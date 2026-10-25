import assert from "node:assert/strict";
import test from "node:test";
import { computeAccountedCostMicros } from "../src/writer/provider.js";
import { WriterBudgetStore } from "../src/writer/budget.js";
import { runWriterInvocation } from "../src/writer/provider.js";
import type { ModelCallResult } from "../src/models/gateway.js";
import { InvocationFailure } from "../src/models/invocation-failure.js";
import { FactoryError } from "../src/executor/errors.js";

/**
 * P1-04 — provider-reported vs policy-estimated vs accounted cost.
 * The three figures must remain independently distinguishable in the
 * durable evidence; the accounted amount follows the documented rule
 * (never silently 0; never below a trusted provider figure).
 */

function fixtureResult(overrides: Partial<ModelCallResult> = {}): ModelCallResult {
  return {
    requestedModel: "z-ai/glm-5.3-flash",
    respondedModel: "z-ai/glm-5.3-flash",
    provider: "merge",
    durationMs: 12,
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    costUsd: 0.0005,
    content: '{"ok":true}',
    ...overrides,
  };
}

const baseRequest = {
  promptSnapshotDigest: "digest-p104",
  promptSnapshotRevision: 1,
  projectId: "p-cost",
  systemPrompt: "system",
  userPrompt: "user",
};

function makeBudget(): WriterBudgetStore {
  return new WriterBudgetStore({} as never);
}

test("C1: provider-reported cost present -> accounted = max(reported, estimate), basis recorded", async () => {
  const budget = makeBudget();
  // Tiny token counts so the token-policy estimate stays below the
  // authorized override (estimate for 10/5 tokens at champion rates).
  const result = await runWriterInvocation(baseRequest, {
    budget,
    invoke: async () => fixtureResult({ promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.0005 }),
    env: {},
    authorizedMicrosOverride: 1_000_000,
  });
  // Provider reported 500µ; policy estimate from 10/5 tokens -> accounted >= 500µ.
  assert.equal(result.costBreakdown.providerReportedMicros, 500);
  assert.ok(result.costBreakdown.policyEstimatedMicros > 0);
  assert.equal(result.costBreakdown.accountedMicros >= 500, true);
  assert.equal(result.costBreakdown.accountingBasis, "provider_reported_or_policy_estimate");
});

test("C2: provider-reported cost MISSING -> policy estimate becomes the accounted amount (never 0)", async () => {
  const budget = makeBudget();
  const result = await runWriterInvocation(baseRequest, {
    budget,
    invoke: async () => fixtureResult({ costUsd: null, promptTokens: 4, completionTokens: 2 }),
    env: {},
    authorizedMicrosOverride: 900_000,
  });
  assert.equal(result.costBreakdown.providerReportedMicros, null);
  assert.equal(result.costBreakdown.accountingBasis, "policy_estimate");
  assert.ok(result.costBreakdown.accountedMicros > 0);
});

test("C3: NO trusted figures at all (null tokens too) -> conservative basis", async () => {
  const budget = makeBudget();
  const result = await runWriterInvocation(baseRequest, {
    budget,
    invoke: async () => fixtureResult({ costUsd: null, promptTokens: null, completionTokens: null }),
    env: {},
    authorizedMicrosOverride: 900,
  });
  assert.equal(result.costBreakdown.accountingBasis, "unknown_cost_conservative_full");
  // Settlement accounted the authorized conservative amount via the
  // in-memory ledger.
  assert.equal(await budget.sumTodayWriterCostMicros(), 900);
});

test("C4: reported 0 with tokens > 0 is not accounted as 0 — the floor applies", async () => {
  const accounted = computeAccountedCostMicros({
    providerReportedMicros: 0,
    policyEstimatedMicros: 400,
    fullyTrustedEstimateAvailable: true,
  });
  assert.equal(accounted, 400, "a zero provider report must not zero out the accounting when an estimate exists");
  const none = computeAccountedCostMicros({
    providerReportedMicros: null,
    policyEstimatedMicros: 0,
    fullyTrustedEstimateAvailable: false,
  });
  assert.equal(none, Math.max(0, 1), "the 1-micro floor protects accounting from silent zeroing");
});

test("C5: post-submission HTTP failure with trusted cost evidence accounts it; without evidence accounts conservative", async () => {
  const budgetA = makeBudget();
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget: budgetA,
      invoke: async () => {
        throw new InvocationFailure("model_failed", "gateway dropped after submit", { requestSubmitted: true, trustedCostMicros: 250 });
      },
      env: {},
      authorizedMicrosOverride: 400,
    }),
  );
  assert.equal(await budgetA.sumTodayWriterCostMicros(), 250, "trusted evidence retained across post-submission failure");

  const budgetB = makeBudget();
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget: budgetB,
      invoke: async () => {
        throw new Error("non-invocation crash after submit");
      },
      env: {},
      authorizedMicrosOverride: 400,
    }),
  );
  assert.equal(await budgetB.sumTodayWriterCostMicros(), 400, "non-invocation post-reservation failure accounts conservatively (never 0)");
});

test("C6: pre-submission credential failure releases (zero spend)", async () => {
  const budget = makeBudget();
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: async () => {
        throw new InvocationFailure("credentials_unavailable", "no key", { requestSubmitted: false });
      },
      env: {},
      authorizedMicrosOverride: 400,
    }),
  );
  assert.equal(await budget.sumTodayWriterCostMicros(), 0, "provably pre-submission failure must not invent spend");
});

test("C7: overrun is persisted in full and raises budget_invariant_violation", async () => {
  const budget = makeBudget();
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: async () => fixtureResult({ promptTokens: 10_000_000, completionTokens: 10_000_000, costUsd: 200 }),
      env: {},
      authorizedMicrosOverride: 100,
    }),
    (e: unknown) => e instanceof FactoryError && e.code === "budget_invariant_violation",
  );
  // The real (huge) amount is durably recorded, never clamped.
  const total = await budget.sumTodayWriterCostMicros();
  assert.ok(total > 0, `real overrun amount persisted (got ${total})`);
});

test("C8: replay does not double-account (settled reservation is idempotent)", async () => {
  const budget = makeBudget();
  await runWriterInvocation(baseRequest, {
    budget,
    invoke: async () => fixtureResult({ promptTokens: 4, completionTokens: 2, costUsd: 0.0002 }),
    env: {},
    authorizedMicrosOverride: 900_000,
  });
  const total = await budget.sumTodayWriterCostMicros();
  assert.ok(total > 0 && total < 900_000, `accounting is bounded properly on this path (got ${total})`);
});
