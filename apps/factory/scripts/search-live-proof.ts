import type { SearchUsage } from "@factory/contracts";

/**
 * LIVE SEARCH ACCEPTANCE — MANUAL/GATED ONLY (never run in CI).
 *
 * What this run performed:
 *
 * 1. Structured SERP (exact measurement): BLOCKED — no Bright Data
 *    credentials exist in the environment (only OPENROUTER_API_KEY is
 *    configured). The Bright Data adapter is implemented, fixture-tested, and
 *    fails closed with `search_provider_not_configured`. No live SERP proof
 *    was possible and none was faked.
 *
 * 2. Grounded research (native Gemini Google Search grounding): BLOCKED —
 *    no GOOGLE_API_KEY; native grounding is not reachable through the
 *    OpenRouter gateway. The GroundedSearchProvider boundary ships with a
 *    deterministic fixture; honest absence is surfaced in the UI.
 *
 * 3. Search analyst (Gemini Flash via OpenRouter, structured output):
 *    PERFORMED below with one bounded real call. This is the interpretation
 *    layer only — it consumed a compiled evidence packet and produced a
 *    SearchIntelligenceData payload that passed the strict contract, with
 *    truthful token usage persisted to the run report.
 *
 * Run with:  FACTORY_SEARCH_MODE=production node --import tsx scripts/search-live-proof.ts
 * Requires:  OPENROUTER_API_KEY in the environment.
 * Actual spend: one bounded completion (recorded in the output below).
 */
import { OpenRouterSearchAnalyst } from "../src/search/analyst.js";
import { invokeModel } from "../src/models/gateway.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { normalizeSearchQuery } from "@factory/contracts";

const QUERY = "roof replacement austin";
const LOCATION = "Austin, TX";

/** Sanitized SERP-shaped summary (fixture provider output — NOT live SERP). */
const evidenceSummary = {
  organic: [
    { position: 1, domain: "market-leader.example.com", title: `${QUERY} — Complete Guide` },
    { position: 2, domain: "local-directory.example.net", title: `Best ${QUERY} near you` },
    { position: 3, domain: "independent-blog.example.org", title: `What nobody tells you about ${QUERY}` },
  ],
  note: "FIXTURE evidence (deterministic test provider), not a live SERP. The analyst is being evaluated for output-shape governance, not factual discovery.",
};

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required. No spend performed.");
    process.exit(1);
  }

  const started = new Date();
  const analyst = new OpenRouterSearchAnalyst({
    model: "google/gemini-3.7-flash",
    callModel: async (prompt) => {
      const result = await invokeModel(
        {
          roleId: "search_analyst",
          model: "google/gemini-3.7-flash",
          systemPrompt:
            "You are Factory's search analyst. Output only strict JSON matching the requested schema. Ground every claim in the provided evidence; never invent rankings, volumes, statistics, or business facts.",
          prompt,
          maxTokens: 4096,
          timeoutMs: 120_000,
        },
        { loadApiKey: () => apiKey },
      );
      return {
        text: result.content,
        usage: {
          inputTokens: result.promptTokens,
          outputTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          costMicros: result.costUsd != null ? Math.round(result.costUsd * 1_000_000) : null,
        },
      };
    },
  });

  const result = await analyst.analyze({
    query: normalizeSearchQuery(QUERY),
    location: LOCATION,
    language: "en",
    packet: evidenceSummary,
    evidenceRefs: [{ kind: "serp_snapshot", id: "fixture-serp-proof", digest: deterministicDigest(evidenceSummary) }],
  });

  const usage: SearchUsage = {
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
    costMicros: result.usage?.costMicros ?? null,
    costUnknown: result.usage?.costMicros == null,
  };

  const report = {
    proof: "search_analyst_live_v0",
    model: result.model,
    provider: result.provider,
    promptVersion: result.promptVersion,
    promptDigest: result.promptDigest,
    query: QUERY,
    location: LOCATION,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    outputDigest: deterministicDigest(result.data),
    evidenceDigest: deterministicDigest(evidenceSummary),
    usage,
    primaryIntent: result.data.primaryIntent,
    clusterCount: result.data.queryClusters.length,
    evidenceRefs: result.data.evidenceRefs,
    structuredOutputValid: true,
    structuredSerpLive: "BLOCKED — no Bright Data credentials configured (BRIGHTDATA_API_KEY)",
    groundedLive: "BLOCKED — no GOOGLE_API_KEY; native grounding unreachable via OpenRouter",
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("Live analyst proof failed (fail closed):", error instanceof Error ? error.message : error);
  process.exit(1);
});
