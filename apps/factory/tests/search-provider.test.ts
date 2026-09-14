import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  DataForSeoSerpProvider,
  DATAFORSEO_LIVE_ORGANIC_URL,
  normalizeDfsItems,
} from "../src/search/serp-dataforseo.js";
import { FixtureSerpProvider } from "../src/search/serp-fixture.js";
import { FixtureGroundedSearchProvider } from "../src/search/grounded-types.js";
import {
  FixtureSearchAnalyst,
  extractJsonObject,
  finalizeAnalystOutput,
} from "../src/search/analyst.js";
import type { SerpAcquisitionRequest } from "../src/search/provider-types.js";

const okDfsBody = {
  status_code: 20000,
  tasks: [
    {
      id: "task-1",
      status_code: 20000,
      cost: 0.002,
      result: [
        {
          items: [
            {
              type: "organic",
              rank_absolute: 1,
              url: "https://www.example.com/page",
              domain: "example.com",
              title: "Example",
              description: "Snip",
            },
            {
              type: "organic",
              rank_absolute: 2,
              url: "https://other.example.org/",
              domain: "other.example.org",
              title: "Other",
              description: "Two",
            },
            { type: "local_pack" },
            {
              type: "people_also_ask",
              items: [{ type: "people_also_ask_element", title: "How much does it cost?" }],
            },
            {
              type: "related_searches",
              items: [{ type: "related_searches_element", title: "  example   pricing  " }],
            },
          ],
        },
      ],
    },
  ],
};

function makeProvider(
  respond: () => { status: number; body: string },
  env: Record<string, string> = { DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "pass" },
) {
  return new DataForSeoSerpProvider({
    env,
    fetchImpl: async () => new Response(respond().body, { status: respond().status }),
  });
}

const acquisition: SerpAcquisitionRequest = {
  query: "roof repair austin",
  location: "Austin, TX",
  language: "en",
  device: "desktop",
};

describe("DataForSEO adapter", () => {
  test("readiness reflects configured credentials without leaking them", async () => {
    const ready = new DataForSeoSerpProvider({
      env: { DATAFORSEO_LOGIN: "x", DATAFORSEO_PASSWORD: "y" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const unready = new DataForSeoSerpProvider({
      env: {},
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    assert.deepEqual(ready.readiness(), { configured: true });
    const r = unready.readiness();
    assert.equal(r.configured, false);
    if (!r.configured) assert.ok(!r.reason.includes("y"));
  });

  test("normalizes organic results, features, PAA, related searches", async () => {
    const provider = makeProvider(() => ({ status: 200, body: JSON.stringify(okDfsBody) }));
    const result = await provider.acquire(acquisition);
    assert.equal(result.data.organic.length, 2);
    assert.equal(result.data.organic[0]!.domain, "example.com");
    assert.equal(result.data.organic[0]!.position, 1);
    assert.deepEqual(result.data.features, ["local_pack"]);
    assert.deepEqual(result.data.peopleAlsoAsk, [{ question: "How much does it cost?" }]);
    assert.deepEqual(result.data.relatedSearches, ["example pricing"]);
    assert.equal(result.providerRequestId, "task-1");
    assert.equal(result.usage?.costMicros, 2000);
    assert.equal(result.usage?.costUnknown, false);
  });

  test("maps HTTP 401 to search_provider_auth_failed without leaking credentials", async () => {
    const provider = makeProvider(() => ({ status: 401, body: "unauthorized" }));
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string }) => e.code === "search_provider_auth_failed",
    );
  });

  test("maps HTTP 429 to search_provider_rate_limited", async () => {
    const provider = makeProvider(() => ({ status: 429, body: "rate" }));
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string }) => e.code === "search_provider_rate_limited",
    );
  });

  test("maps network failure to search_provider_unavailable", async () => {
    const provider = new DataForSeoSerpProvider({
      env: { DATAFORSEO_LOGIN: "x", DATAFORSEO_PASSWORD: "y" },
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED with secret sk-abcdefghijklmnop1234");
      },
    });
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string; message: string }) => {
        assert.equal(e.code, "search_provider_unavailable");
        assert.ok(!e.message.includes("sk-"));
        return true;
      },
    );
  });

  test("maps DataForSEO auth task status under HTTP 200 to auth failure", async () => {
    const provider = makeProvider(() => ({
      status: 200,
      body: JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40100 }] }),
    }));
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string }) => e.code === "search_provider_auth_failed",
    );
  });

  test("malformed JSON maps to search_response_invalid", async () => {
    const provider = makeProvider(() => ({ status: 200, body: "<html>not json</html>" }));
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string }) => e.code === "search_response_invalid",
    );
  });

  test("not-configured provider fails closed before any network call", async () => {
    const provider = new DataForSeoSerpProvider({
      env: {},
      fetchImpl: async () => {
        throw new Error("should not be called");
      },
    });
    await assert.rejects(
      () => provider.acquire(acquisition),
      (e: { code: string }) => e.code === "search_provider_not_configured",
    );
  });

  test("hits the live organic advanced endpoint", async () => {
    let calledUrl = "";
    const provider = new DataForSeoSerpProvider({
      env: { DATAFORSEO_LOGIN: "x", DATAFORSEO_PASSWORD: "y" },
      fetchImpl: async (input) => {
        calledUrl = String(input);
        return new Response(JSON.stringify(okDfsBody), { status: 200 });
      },
    });
    await provider.acquire(acquisition);
    assert.equal(calledUrl, DATAFORSEO_LIVE_ORGANIC_URL);
  });
});

describe("normalizeDfsItems determinism", () => {
  test("preserves ranking order and ignores unknown item types", () => {
    const data = normalizeDfsItems([
      { type: "organic", rank_absolute: 2, url: "https://b.example.com/", title: "B", description: "" },
      { type: "mystery_widget" },
      { type: "organic", rank_absolute: 1, url: "https://a.example.com/", title: "A", description: "" },
    ]);
    assert.deepEqual(
      data.organic.map((r) => r.position),
      [1, 2],
    );
    assert.equal(data.features, undefined);
  });

  test("drops organic items with non-http URLs", () => {
    const data = normalizeDfsItems([
      { type: "organic", rank_absolute: 1, url: "javascript:alert(1)", title: "X", description: "" },
    ]);
    assert.equal(data.organic.length, 0);
  });
});

describe("fixture providers", () => {
  test("fixture SERP is deterministic and contract-valid", async () => {
    const p = new FixtureSerpProvider();
    const a = await p.acquire(acquisition);
    const b = await p.acquire(acquisition);
    assert.deepEqual(a.data, b.data);
    assert.equal(a.providerRequestId, b.providerRequestId);
    assert.equal(a.data.organic.length, 3);
    assert.ok(a.data.features);
  });

  test("fixture grounded + analyst produce valid outputs", async () => {
    const grounded = await new FixtureGroundedSearchProvider().research({
      query: "roof repair austin",
      location: "Austin, TX",
      language: "en",
      packetDigest: "d".repeat(64),
    });
    assert.equal(grounded.data.webSearchQueries.length, 1);
    assert.ok(grounded.data.sources.length >= 1);

    const analyst = new FixtureSearchAnalyst();
    const result = await analyst.analyze({
      query: "roof repair austin",
      location: "Austin, TX",
      language: "en",
      packet: {},
      evidenceRefs: [{ kind: "serp_snapshot", id: "s1", digest: "d".repeat(64) }],
    });
    assert.equal(result.data.primaryIntent, "commercial");
    assert.equal(result.data.evidenceRefs[0]!.id, "s1");
    assert.equal(result.data.reviewState, "model_proposed");
  });
});

describe("analyst output governance", () => {
  const req = {
    query: "q",
    location: null,
    language: null,
    packet: {},
    evidenceRefs: [{ kind: "serp_snapshot" as const, id: "s1", digest: "d".repeat(64) }],
  };

  test("extractJsonObject finds balanced JSON in prose", () => {
    const text = 'Sure! Here it is: {"a": {"b": 1}} hope that helps';
    assert.equal(JSON.parse(extractJsonObject(text)).a.b, 1);
  });

  test("evidenceRefs are Factory-owned (model cannot forge them)", () => {
    const data = finalizeAnalystOutput(
      {
        primaryIntent: "informational",
        intentRationale: "r",
        secondaryIntents: [],
        queryClusters: [],
        longTailOpportunities: [],
        entities: [],
        topics: [],
        questions: [],
        modifiers: [],
        searchVocabulary: [],
        relatedConcepts: [],
        semanticCoverageRequirements: [],
        userNeeds: [],
      },
      req,
    );
    assert.deepEqual(data.evidenceRefs, req.evidenceRefs);
    assert.equal(data.reviewState, "model_proposed");
  });

  test("output missing required fields fails closed", () => {
    assert.throws(() => finalizeAnalystOutput({ primaryIntent: "commercial" }, req), /fail/i);
  });

  test("output with wrong enum fails closed", () => {
    assert.throws(
      () =>
        finalizeAnalystOutput(
          {
            primaryIntent: "seo_score_92",
            intentRationale: "r",
            secondaryIntents: [],
            queryClusters: [],
            longTailOpportunities: [],
            entities: [],
            topics: [],
            questions: [],
            modifiers: [],
            searchVocabulary: [],
            relatedConcepts: [],
            semanticCoverageRequirements: [],
            userNeeds: [],
          },
          req,
        ),
      /fail/i,
    );
  });
});


test("P1-D: DataForSEO task failure retains trusted actual cost", async () => {
  const body = { status_code: 20000, tasks: [{ status_code: 50000, cost: 0.02 }] };
  const provider = makeProvider(() => ({ status: 200, body: JSON.stringify(body) }));
  await assert.rejects(provider.acquire(acquisition), (error: any) => {
    assert.equal(error.requestSubmitted, true);
    assert.equal(error.trustedCostMicros, 20000);
    return true;
  });
});
