import assert from "node:assert/strict";
import test from "node:test";
import { CompetitorStore } from "../src/competitors/competitor-store.js";
import { buildCompetitorAnalysts, settleReservationAfterInvocation } from "../src/competitors/service.js";
import { invokeModel, ModelCallError } from "../src/models/gateway.js";
import { InvocationFailure } from "../src/models/invocation-failure.js";
import { FactoryError } from "../src/executor/errors.js";
import { buildEvidencePacket } from "../src/competitors/packet.js";
import { extractCompetitorPage } from "../src/competitors/extract.js";

const gapRequest = { analyses: [], searchIntelligence: {}, acceptedEvidence: [], projectContext: {}, coverageMatrixSummary: [] };
const competitorRequest = {
  packet: buildEvidencePacket({
    pageSnapshotId: "qa-page", pageSnapshotDigest: "a".repeat(64),
    url: "https://example.com/guide", domain: "example.com", observedAt: new Date("2026-09-08T00:00:00Z"),
    extracted: extractCompetitorPage("<h1>Guide</h1><p>Evidence about the subject.</p>"),
  }),
  projectContext: {}, searchContext: {},
};

function fixture(content: string, cost: number | null, status = 200) {
  let calls = 0;
  const analysts = buildCompetitorAnalysts({ OPENROUTER_API_KEY: "qa-stub-key" }, (request, deps) =>
    invokeModel(request, { ...deps, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { cost, prompt_tokens: 10, completion_tokens: 20 },
        ...(status !== 200 ? { error: { message: "rejected" } } : {}),
      }), { status });
    } }),
  );
  const store = new CompetitorStore({} as never);
  store.sumTodayCompetitorCostMicros = async () => 0;
  return { analysts, store, calls: () => calls };
}

for (const kind of ["gap", "competitor"] as const) {
  for (const content of ["invalid JSON", "{}", ""]) {
    test(`${kind}: trusted overrun survives invalid output ${JSON.stringify(content)} and blocks subsequent execution`, async () => {
      const f = fixture(content, 0.08);
      const handle = await f.store.reserveBudget(70_000, 5);
      let failure: unknown;
      try {
        if (kind === "gap") await f.analysts.gapAnalyst.propose(gapRequest);
        else await f.analysts.competitorAnalyst.analyze(competitorRequest);
      } catch (error) { failure = error; }
      assert.ok(failure instanceof InvocationFailure);
      assert.equal(failure.trustedCostMicros, 80_000);
      await assert.rejects(settleReservationAfterInvocation(handle, { kind: "failed", error: failure }),
        (error: unknown) => error instanceof FactoryError && error.code === "budget_invariant_violation");
      assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, 80_000);
      await assert.rejects(f.store.reserveBudget(1, 5),
        (error: unknown) => error instanceof FactoryError && error.code === "budget_invariant_violation");
      assert.equal(f.calls(), 1);
    });
  }
}

for (const status of [401, 403, 404, 408, 500]) {
  test(`submitted HTTP ${status} with unknown cost retains authorization`, async () => {
    const f = fixture("", null, status);
    const handle = await f.store.reserveBudget(70_000, 5);
    let failure: unknown;
    try { await f.analysts.gapAnalyst.propose(gapRequest); } catch (error) { failure = error; }
    assert.ok(failure instanceof ModelCallError);
    assert.equal(failure.requestSubmitted, true);
    await settleReservationAfterInvocation(handle, { kind: "failed", error: failure });
    assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, 70_000);
    assert.equal(f.calls(), 1);
  });
}

test("known overrun survives an HTTP failure", async () => {
  const f = fixture("", 0.08, 403);
  const h = await f.store.reserveBudget(70_000, 5);
  let failure: unknown;
  try { await f.analysts.gapAnalyst.propose(gapRequest); } catch (error) { failure = error; }
  await assert.rejects(settleReservationAfterInvocation(h, { kind: "failed", error: failure }),
    (error: unknown) => error instanceof FactoryError && error.code === "budget_invariant_violation");
  assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, 80_000);
});

for (const cost of [null, 0, 0.012345]) {
  test(`valid output cost ${cost}: token counts cannot substitute for unknown actual cost`, async () => {
    const f = fixture('{"gaps":[]}', cost);
    const h = await f.store.reserveBudget(70_000, 5);
    const result = await f.analysts.gapAnalyst.propose(gapRequest);
    await settleReservationAfterInvocation(h, { kind: "completed", trustedCostMicros: result.usage!.costMicros });
    assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, cost === null ? 70_000 : Math.round(cost * 1_000_000));
  });
}

test("unknown cost on invalid content retains authorization even when token counts exist", async () => {
  const f = fixture("invalid", null);
  const h = await f.store.reserveBudget(70_000, 5);
  let failure: unknown;
  try { await f.analysts.gapAnalyst.propose(gapRequest); } catch (error) { failure = error; }
  await settleReservationAfterInvocation(h, { kind: "failed", error: failure });
  assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, 70_000);
});

for (const code of ["credentials_unavailable", "policy_violation"]) {
  test(`bare ${code} code is not proof of no submission`, async () => {
    const f = fixture("", null);
    const h = await f.store.reserveBudget(70_000, 5);
    await settleReservationAfterInvocation(h, { kind: "failed", error: new FactoryError(code, "unknown stage") });
    assert.equal((await f.store.getBudgetSummary()).accountedTodayMicros, 70_000);
  });
}

test("gateway-local credential/policy failures release with zero requests", async () => {
  const f = fixture("", null);
  let calls = 0;
  for (const missingKey of [true, false]) {
    const h = await f.store.reserveBudget(70_000, 5);
    let failure: unknown;
    try {
      await invokeModel({ roleId: "search_analyst", model: missingKey ? "google/gemini-3.7-flash" : "openrouter/auto",
        systemPrompt: "system", prompt: "user", maxTokens: 8192, timeoutMs: 1000 },
      { loadApiKey: () => missingKey ? null : "qa-stub-key", fetchImpl: async () => { calls++; throw new Error("unexpected request"); } });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof InvocationFailure);
    assert.equal(failure.requestSubmitted, false);
    await settleReservationAfterInvocation(h, { kind: "failed", error: failure });
  }
  assert.deepEqual(await f.store.getBudgetSummary(), { accountedTodayMicros: 0, activeReservationMicros: 0 });
  assert.equal(calls, 0);
});
