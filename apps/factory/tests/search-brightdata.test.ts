import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BRIGHTDATA_REQUEST_URL,
  BrightDataSerpProvider,
  DEFAULT_BRIGHTDATA_ZONE,
  buildBrightDataGoogleUrl,
  normalizeBrightDataResponse,
} from "../src/search/serp-brightdata.js";
import type { SerpAcquisitionRequest } from "../src/search/provider-types.js";

const request: SerpAcquisitionRequest = {
  query: "investment property chamonix",
  location: "Chamonix-Mont-Blanc,Auvergne-Rhone-Alpes,France",
  language: "fr-FR",
  device: "desktop",
};

const brightBody = {
  general: {
    timestamp: "2026-09-06T08:00:00.000Z",
  },
  input: {
    request_id: "hl_test_request",
  },
  organic: [
    {
      rank: 2,
      global_rank: 6,
      link: "https://www.example.org/chamonix",
      title: "Second result",
      description: "Second snippet",
    },
    {
      rank: 1,
      global_rank: 3,
      link: "https://example.com/investment",
      title: "First result",
      description: "First snippet",
      sitelinks: [{ title: "Guide" }],
    },
  ],
  people_also_ask: [
    { question: "Is Chamonix property a good investment?", answer: "It depends on price and use." },
  ],
  related: [
    { text: "chamonix property investment" },
    { text: "  chamonix   rental yield " },
  ],
  local: [{ title: "Local result" }],
  knowledge: { title: "Chamonix" },
  images: [{ title: "Images" }],
  videos: [{ title: "Videos" }],
  shopping: [{ title: "Shopping" }],
  top_stories: [{ title: "News" }],
  ads_top: [{ title: "Ad" }],
};

function providerWith(
  response: () => Response,
  env: NodeJS.ProcessEnv = { BRIGHTDATA_API_KEY: "test-bright-key" },
) {
  return new BrightDataSerpProvider({
    env,
    now: () => new Date("2026-09-06T09:00:00.000Z"),
    fetchImpl: async () => response(),
  });
}

describe("Bright Data SERP adapter", () => {
  test("readiness requires only the backend API key and never exposes it", () => {
    const ready = new BrightDataSerpProvider({ env: { BRIGHTDATA_API_KEY: "secret-value" } });
    const missing = new BrightDataSerpProvider({ env: {} });
    assert.deepEqual(ready.readiness(), { configured: true });
    const notReady = missing.readiness();
    assert.equal(notReady.configured, false);
    if (!notReady.configured) assert.ok(!notReady.reason.includes("secret-value"));
  });

  test("builds exact Google URL with canonical location, language and device controls", () => {
    const url = new URL(buildBrightDataGoogleUrl(request));
    assert.equal(url.origin, "https://www.google.com");
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("q"), "investment property chamonix");
    assert.equal(url.searchParams.get("uule"), request.location);
    assert.equal(url.searchParams.get("hl"), "fr");
    assert.equal(url.searchParams.get("pws"), "0");
    assert.equal(url.searchParams.get("brd_mobile"), "0");
    assert.equal(url.searchParams.get("brd_browser"), "chrome");

    const mobile = new URL(buildBrightDataGoogleUrl({ ...request, device: "mobile" }));
    const tablet = new URL(buildBrightDataGoogleUrl({ ...request, device: "tablet" }));
    assert.equal(mobile.searchParams.get("brd_mobile"), "1");
    assert.equal(tablet.searchParams.get("brd_mobile"), "ipad");
  });

  test("uses Bright Data request endpoint, bearer auth, configured zone and parsed JSON", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const provider = new BrightDataSerpProvider({
      env: { BRIGHTDATA_API_KEY: "test-bright-key", BRIGHTDATA_ZONE: "factory_google_serp" },
      fetchImpl: async (input, init) => {
        calledUrl = input;
        calledInit = init;
        return new Response(JSON.stringify(brightBody), { status: 200 });
      },
    });

    await provider.acquire(request);
    assert.equal(calledUrl, BRIGHTDATA_REQUEST_URL);
    assert.equal((calledInit?.headers as Record<string, string>).Authorization, "Bearer test-bright-key");
    const body = JSON.parse(String(calledInit?.body));
    assert.equal(body.zone, "factory_google_serp");
    assert.equal(body.format, "json");
    assert.equal(body.data_format, "parsed");
    assert.match(body.url, /^https:\/\/www\.google\.com\/search\?/);
  });

  test("uses the Factory Bright Data zone default when no override is configured", async () => {
    let bodyZone = "";
    const provider = new BrightDataSerpProvider({
      env: { BRIGHTDATA_API_KEY: "test-bright-key" },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init.body)) as { zone?: string };
        bodyZone = body.zone ?? "";
        return new Response(JSON.stringify(brightBody), { status: 200 });
      },
    });
    await provider.acquire(request);
    assert.equal(bodyZone, DEFAULT_BRIGHTDATA_ZONE);
  });

  test("normalizes provider rank, PAA, related searches and known SERP features", () => {
    const data = normalizeBrightDataResponse(brightBody);
    assert.deepEqual(data.organic.map((item) => item.position), [1, 2]);
    assert.equal(data.organic[0]?.domain, "example.com");
    assert.deepEqual(data.peopleAlsoAsk, [
      { question: "Is Chamonix property a good investment?", answer: "It depends on price and use." },
    ]);
    assert.deepEqual(data.relatedSearches, [
      "chamonix property investment",
      "chamonix rental yield",
    ]);
    assert.deepEqual(data.features, [
      "local_pack",
      "knowledge_panel",
      "image_pack",
      "video_results",
      "shopping_results",
      "top_stories",
      "ads_top",
      "sitelinks",
    ]);
  });

  test("acquisition preserves request id, provider timestamp and truthful unknown cost", async () => {
    const result = await providerWith(
      () => new Response(JSON.stringify(brightBody), { status: 200 }),
    ).acquire(request);
    assert.equal(result.providerRequestId, "hl_test_request");
    assert.equal(result.observedAt.toISOString(), "2026-09-06T08:00:00.000Z");
    assert.equal(result.usage?.costMicros, null);
    assert.equal(result.usage?.costUnknown, true);
    assert.equal(result.usage?.searchQueriesCount, 1);
  });

  test("accepts Bright Data JSON wrapper with a serialized body", async () => {
    const wrapped = { body: JSON.stringify(brightBody) };
    const result = await providerWith(
      () => new Response(JSON.stringify(wrapped), { status: 200 }),
    ).acquire(request);
    assert.equal(result.data.organic[0]?.position, 1);
    assert.equal(result.providerRequestId, "hl_test_request");
  });

  test("fails closed before network when the API key is absent", async () => {
    let called = false;
    const provider = new BrightDataSerpProvider({
      env: {},
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    await assert.rejects(
      () => provider.acquire(request),
      (error: { code: string }) => error.code === "search_provider_not_configured",
    );
    assert.equal(called, false);
  });

  test("maps auth, budget, rate-limit and provider failures to typed errors", async () => {
    for (const [status, code] of [
      [401, "search_provider_auth_failed"],
      [402, "search_provider_budget_blocked"],
      [429, "search_provider_rate_limited"],
      [503, "search_provider_unavailable"],
    ] as const) {
      const provider = providerWith(() => new Response("provider secret body", { status }));
      await assert.rejects(
        () => provider.acquire(request),
        (error: { code: string; message: string }) => {
          assert.equal(error.code, code);
          assert.ok(!error.message.includes("provider secret body"));
          assert.ok(!error.message.includes("test-bright-key"));
          return true;
        },
      );
    }
  });

  test("invalid JSON and invalid organic URLs fail closed", async () => {
    await assert.rejects(
      () => providerWith(() => new Response("not-json", { status: 200 })).acquire(request),
      (error: { code: string }) => error.code === "search_response_invalid",
    );

    const bad = {
      ...brightBody,
      organic: [{ rank: 1, link: "javascript:alert(1)", title: "bad", description: "bad" }],
    };
    await assert.rejects(
      () => providerWith(() => new Response(JSON.stringify(bad), { status: 200 })).acquire(request),
      (error: { code: string }) => error.code === "search_normalization_failed",
    );
  });
});
