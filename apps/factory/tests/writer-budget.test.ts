import assert from "node:assert/strict";
import test from "node:test";
import { WriterBudgetStore } from "../src/writer/budget.js";
import {
  assertWriterCredentialAvailable,
  deterministicWriterInvocationDigest,
  resolveWriterModel,
  runWriterInvocation,
} from "../src/writer/provider.js";
import { FactoryError } from "../src/executor/errors.js";
import { InvocationFailure } from "../src/models/invocation-failure.js";
import type { ModelCallResult } from "../src/models/gateway.js";

/** In-memory WriterBudgetStore seam (no DB) — same unit-test pattern as competitors. */
function makeBudget(): WriterBudgetStore {
  return new WriterBudgetStore({} as never);
}

function fixtureResult(overrides: Partial<ModelCallResult> = {}): ModelCallResult {
  return {
    requestedModel: "z-ai/glm-5.3-flash",
    respondedModel: "z-ai/glm-5.3-flash",
    provider: "Z.AI",
    durationMs: 12,
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    costUsd: null,
    content: '{"ok":true}',
    ...overrides,
  };
}

const baseRequest = {
  promptSnapshotDigest: "digest-abc",
  promptSnapshotRevision: 1,
  projectId: "p1",
  systemPrompt: "system",
  userPrompt: "user",
};

// ---- Resolution + preflight --------------------------------------------------

test("writer model resolves through the governed seam; override honored", () => {
  const champion = resolveWriterModel({});
  assert.equal(champion.model, "anthropic/claude-opus-5");
  assert.equal(champion.overrideApplied, false);
  const overridden = resolveWriterModel({ FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" });
  assert.equal(overridden.model, "z-ai/glm-5.3-flash");
  assert.equal(overridden.overrideApplied, true);
  assert.equal(overridden.championModel, "anthropic/claude-opus-5");
});

test("missing credential -> typed failure before any provider call", () => {
  assert.throws(
    () => assertWriterCredentialAvailable({ loadApiKey: () => null }),
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.equal(err.code, "writer_provider_not_configured");
      return true;
    },
  );
  assert.throws(
    () => assertWriterCredentialAvailable({ loadApiKey: () => "  " }),
    FactoryError,
  );
  assert.doesNotThrow(() => assertWriterCredentialAvailable({ loadApiKey: () => "k" }));
});

test("invocation digest binds exact authorized inputs", () => {
  const a = deterministicWriterInvocationDigest({ ...baseRequest, model: "m", maxOutputTokens: 100 });
  const b = deterministicWriterInvocationDigest({ ...baseRequest, model: "m", maxOutputTokens: 100 });
  const c = deterministicWriterInvocationDigest({ ...baseRequest, model: "other", maxOutputTokens: 100 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- Budget-governed invocation flow (fixture gateway, zero paid calls) ------

test("blocked budget -> zero provider calls (fail closed before spend)", async () => {
  const budget = makeBudget();
  let calls = 0;
  const invoke = async (): Promise<ModelCallResult> => {
    calls += 1;
    return fixtureResult();
  };
  // Exhaust the daily budget with a first invocation attempt: any positive
  // authorization exceeds the 1-micro limit.
  await runWriterInvocation(baseRequest, {
    budget,
    invoke,
    dailyLimitUsd: 0.000001,
    authorizedMicrosOverride: 2,
  }).catch(() => undefined);
  assert.equal(calls, 0, "budget-blocked invocation must never reach the provider");
});

test("first invocation authorized; second blocked when ceiling reached", async () => {
  const budget = makeBudget();
  const seen: string[] = [];
  const invoke = async (req: { model: string }): Promise<ModelCallResult> => {
    seen.push(req.model);
    return fixtureResult();
  };
  const r1 = await runWriterInvocation(baseRequest, {
    budget,
    invoke: invoke as never,
    dailyLimitUsd: 10,
    authorizedMicrosOverride: 9_500_000, // $9.50 <= $10 budget
    env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
  });
  assert.equal(seen.length, 1);
  assert.equal(r1.model, "z-ai/glm-5.3-flash");
  assert.equal(r1.overrideApplied, true);
  assert.equal(r1.overriddenChampion, "anthropic/claude-opus-5");
  // Fixture usage accounts 250 micros (trusted actual); the second $9.9998
  // reservation pushes the total over the $10 ceiling.
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: invoke as never,
      dailyLimitUsd: 10,
      authorizedMicrosOverride: 9_999_800,
    }),
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.equal(err.code, "writer_budget_blocked");
      return true;
    },
  );
  assert.equal(seen.length, 1, "blocked reservation must not call the provider");
});

test("unknown cost -> accounts the authorized conservative amount", async () => {
  const budget = makeBudget();
  const invoke = async (): Promise<ModelCallResult> =>
    fixtureResult({ promptTokens: null, completionTokens: null, totalTokens: null });
  await runWriterInvocation(baseRequest, {
    budget,
    invoke: invoke as never,
    dailyLimitUsd: 10,
    authorizedMicrosOverride: 4_000_000,
  });
  assert.equal(await budget.sumTodayWriterCostMicros(), 4_000_000);
});

test("trusted overrun -> full accounting + budget invariant violation", async () => {
  const budget = makeBudget();
  const invoke = async (): Promise<ModelCallResult> =>
    fixtureResult({ promptTokens: 1_000_000, completionTokens: 1_000_000 });
  // authorized computed from pricing for glm override target:
  // (small prompt + 16000 out) — actual far exceeds it.
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: invoke as never,
      dailyLimitUsd: 100,
      env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.equal(err.code, "budget_invariant_violation");
      return true;
    },
  );
  const summary = await budget.getWriterBudgetSummary();
  assert.ok(summary.accountedTodayMicros > 0, "real overrun amount durably accounted");
  // Subsequent reservations fail closed.
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: async () => fixtureResult(),
      dailyLimitUsd: 100,
      env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
    }),
    FactoryError,
  );
});

test("HTTP 401/403 after fetch -> NOT released, conservative accounting", async () => {
  const budget = makeBudget();
  const invoke = async (): Promise<ModelCallResult> => {
    throw new InvocationFailure("model_failed", "401 unauthorized", {
      requestSubmitted: true,
      trustedCostMicros: null,
    });
  };
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: invoke as never,
      dailyLimitUsd: 10,
      authorizedMicrosOverride: 3_000_000,
    }),
    FactoryError,
  );
  assert.equal(await budget.sumTodayWriterCostMicros(), 3_000_000, "conservative accounting retained");
});

test("pre-submission local failure -> release permitted (zero accounted spend)", async () => {
  const budget = makeBudget();
  const invoke = async (): Promise<ModelCallResult> => {
    throw new InvocationFailure("model_timeout", "timed out before submission", {
      requestSubmitted: false,
      trustedCostMicros: null,
    });
  };
  await assert.rejects(
    runWriterInvocation(baseRequest, {
      budget,
      invoke: invoke as never,
      dailyLimitUsd: 10,
      authorizedMicrosOverride: 3_000_000,
    }),
    FactoryError,
  );
  assert.equal(await budget.sumTodayWriterCostMicros(), 0, "released reservation accounts nothing");
  const summary = await budget.getWriterBudgetSummary();
  assert.equal(summary.activeReservationMicros, 0, "no active reservation leaks");
});

test("exact invocation digest binding: authorized == executed (lineage recorded)", async () => {
  const budget = makeBudget();
  let capturedLineage: Record<string, unknown> | undefined;
  const originalReserve = budget.reserveWriterBudget.bind(budget);
  budget.reserveWriterBudget = async (input, limit) => {
    capturedLineage = input.lineage;
    return originalReserve(input, limit);
  };
  const invoke = async (): Promise<ModelCallResult> => fixtureResult();
  await runWriterInvocation(baseRequest, {
    budget,
    invoke: invoke as never,
    dailyLimitUsd: 10,
    authorizedMicrosOverride: 1_000_000,
    env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
  });
  assert.ok(capturedLineage);
  assert.equal(capturedLineage["kind"], "writer_proposal");
  assert.equal(capturedLineage["promptSnapshotDigest"], "digest-abc");
  assert.equal(capturedLineage["promptSnapshotRevision"], 1);
  assert.equal(capturedLineage["overrideApplied"], true);
  assert.equal(capturedLineage["overriddenChampion"], "anthropic/claude-opus-5");
});
