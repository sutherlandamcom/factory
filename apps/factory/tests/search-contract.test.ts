import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  SEARCH_ERROR_CODES,
  SEARCH_SCHEMA_VERSION,
  MAX_SERP_RAW_BYTES,
  normalizeSearchQuery,
  parseSearchRequest,
  parseSerpSnapshotData,
  parseGroundedSearchData,
  parseSearchIntelligenceData,
  searchRequestSchema,
  serpSnapshotDataSchema,
  groundedSearchDataSchema,
  searchIntelligenceDataSchema,
  type SearchIntelligenceData,
  type SerpSnapshotData,
} from "@factory/contracts";

const baseRequest = {
  projectId: "p1",
  acceptedProjectInputSnapshotId: "snap-1",
  acceptedProjectInputSnapshotVersion: 1,
  acceptedProjectInputDigest: "a".repeat(64),
  query: "roof repair austin",
  device: "desktop",
  provider: "dataforseo",
  requestedAt: "2026-09-06T00:00:00.000Z",
};

const organic = [
  { position: 1, url: "https://a.example.com/x", domain: "a.example.com", title: "A", snippet: "s1" },
  { position: 2, url: "http://b.example.com", domain: "b.example.com", title: "B", snippet: "s2" },
];

const serpData: SerpSnapshotData = { organic };

const intelligenceData: SearchIntelligenceData = {
  primaryIntent: "commercial",
  intentRationale: "SERP shows service pages and pricing comparisons.",
  secondaryIntents: ["informational"],
  queryClusters: [
    {
      id: "cluster-1",
      label: "Repair",
      queries: ["roof repair austin", "roof leak repair austin"],
      intent: "commercial",
      primaryQuery: "roof repair austin",
      secondaryQueries: ["roof leak repair austin"],
      confidence: 0.8,
    },
  ],
  longTailOpportunities: [
    { query: "roof leak repair austin tx cost", confidence: 0.7, rationale: "low competition phrasing" },
  ],
  entities: [{ name: "Austin", kind: "location" }],
  topics: [{ topic: "Roofing", subtopics: ["Repair", "Replacement"] }],
  questions: ["How much does roof repair cost in Austin?"],
  modifiers: ["cost", "near me"],
  searchVocabulary: ["shingle", "flashing"],
  relatedConcepts: ["gutter maintenance"],
  semanticCoverageRequirements: ["Explain repair vs replacement decision factors."],
  userNeeds: ["Find a trustworthy local roofer."],
  evidenceRefs: [{ kind: "serp_snapshot", id: "serp-1", digest: "d".repeat(64) }],
  reviewState: "model_proposed",
};

describe("search query normalization", () => {
  test("normalizes whitespace and control characters", () => {
    assert.equal(normalizeSearchQuery("  roof\trepair\n  austin "), "roof repair austin");
    assert.equal(normalizeSearchQuery("roof\u0000repair"), "roof repair");
  });

  test("request schema rejects non-normalized queries and normalizes on write paths", () => {
    const bad = searchRequestSchema.safeParse({ ...baseRequest, query: "  double  space  " });
    assert.equal(bad.success, false);
  });

  test("query length bound", () => {
    const tooLong = searchRequestSchema.safeParse({
      ...baseRequest,
      query: normalizeSearchQuery("x".repeat(201)),
    });
    assert.equal(tooLong.success, false);
  });
});

describe("search request strictness", () => {
  test("parses a valid request", () => {
    const parsed = parseSearchRequest(baseRequest);
    assert.equal(parsed.device, "desktop");
  });

  test("rejects unknown fields (fail closed)", () => {
    const bad = searchRequestSchema.safeParse({ ...baseRequest, apiKey: "x" });
    assert.equal(bad.success, false);
  });

  test("rejects invalid device", () => {
    const bad = searchRequestSchema.safeParse({ ...baseRequest, device: "watch" });
    assert.equal(bad.success, false);
  });

  test("rejects unknown provider", () => {
    const bad = searchRequestSchema.safeParse({ ...baseRequest, provider: "some-seo-plugin" });
    assert.equal(bad.success, false);
  });
});

describe("serp snapshot data", () => {
  test("round-trips valid data and preserves organic order", () => {
    const parsed = parseSerpSnapshotData(serpData);
    assert.deepEqual(
      parsed.organic.map((r) => r.position),
      [1, 2],
    );
  });

  test("rejects out-of-order positions", () => {
    const bad = serpSnapshotDataSchema.safeParse({
      organic: [organic[1], organic[0]],
    });
    assert.equal(bad.success, false);
  });

  test("rejects fabricated features vocabulary", () => {
    const bad = serpSnapshotDataSchema.safeParse({
      organic,
      features: ["seo_score_92"],
    });
    assert.equal(bad.success, false);
  });

  test("absent optional groups stay absent (UNKNOWN not invented)", () => {
    const parsed = parseSerpSnapshotData(serpData);
    assert.equal(parsed.features, undefined);
    assert.equal(parsed.peopleAlsoAsk, undefined);
    assert.equal(parsed.relatedSearches, undefined);
  });

  test("rejects credential-shaped URLs", () => {
    const bad = serpSnapshotDataSchema.safeParse({
      organic: [
        { position: 1, url: "https://user:pass@example.com/", domain: "example.com", title: "T", snippet: "s" },
      ],
    });
    assert.equal(bad.success, false);
  });

  test("raw payload ceiling constant is bounded", () => {
    assert.ok(MAX_SERP_RAW_BYTES <= 256 * 1024);
  });
});

describe("grounded search data", () => {
  test("round-trips valid grounded output", () => {
    const parsed = parseGroundedSearchData({
      webSearchQueries: ["roof repair austin"],
      sources: [{ title: "City of Austin permits", uri: "https://austin.example.gov/permits" }],
      structuredOutput: { summary: "Permits may be required." },
    });
    assert.equal(parsed.sources.length, 1);
  });

  test("rejects unknown fields on grounded output (fail closed)", () => {
    const bad = groundedSearchDataSchema.safeParse({
      webSearchQueries: ["q"],
      sources: [],
      structuredOutput: {},
      ranking: 1,
    });
    assert.equal(bad.success, false);
  });

  test("rejects non-http URI sources", () => {
    let threw = false;
    try {
      parseGroundedSearchData({
        webSearchQueries: ["q"],
        sources: [{ uri: "javascript:alert(1)" }],
        structuredOutput: {},
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  });
});

describe("search intelligence data", () => {
  test("round-trips valid intelligence", () => {
    const parsed = parseSearchIntelligenceData(intelligenceData);
    assert.equal(parsed.primaryIntent, "commercial");
    assert.equal(parsed.queryClusters[0]!.queries.length, 2);
  });

  test("rejects cluster whose primaryQuery is not in queries", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      queryClusters: [
        {
          ...intelligenceData.queryClusters[0]!,
          primaryQuery: "not-in-list",
        },
      ],
    });
    assert.equal(bad.success, false);
  });

  test("rejects duplicate cluster ids", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      queryClusters: [intelligenceData.queryClusters[0]!, intelligenceData.queryClusters[0]!],
    });
    assert.equal(bad.success, false);
  });

  test("rejects intelligence without evidence refs", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      evidenceRefs: [],
    });
    assert.equal(bad.success, false);
  });

  test("rejects unknown fields (no LSI/density/score fields possible)", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      lsiScore: 92,
    });
    assert.equal(bad.success, false);
  });

  test("rejects fabricated exact-rank claims in evidence refs", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      evidenceRefs: [{ kind: "grounded_snapshot", id: "g1", digest: "d".repeat(64) }],
    });
    // grounded evidence is valid provenance; ensure schema accepts it, then
    // assert the closed kind union rejects a fake kind:
    assert.equal(bad.success, true);
    const fake = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      evidenceRefs: [{ kind: "organic_rank_1", id: "x", digest: "d".repeat(64) }],
    });
    assert.equal(fake.success, false);
  });

  test("confidence bounds", () => {
    const bad = searchIntelligenceDataSchema.safeParse({
      ...intelligenceData,
      longTailOpportunities: [{ query: "q austin", confidence: 1.5 }],
    });
    assert.equal(bad.success, false);
  });
});

describe("schema version and error codes", () => {
  test("schema version is v1", () => {
    assert.equal(SEARCH_SCHEMA_VERSION, "v1");
  });

  test("error codes are unique and snake_case", () => {
    const codes = new Set(SEARCH_ERROR_CODES);
    assert.equal(codes.size, SEARCH_ERROR_CODES.length);
    for (const code of SEARCH_ERROR_CODES) {
      assert.match(code, /^[a-z0-9_]+$/);
    }
  });
});
