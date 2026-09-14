import { preserveInvocationCost } from "../models/invocation-failure.js";
import { z } from "zod";
import {
  parseSearchIntelligenceData,
  type SearchIntelligenceData,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * SearchAnalystModel — the interpretation boundary.
 *
 * Derives SearchIntelligenceData from acquired evidence (SERP + grounded +
 * accepted project context). The analyst is an INTERPRETER, not a factual
 * authority: output that fails the strict intelligence schema is rejected
 * (fail closed) — never silently repaired.
 */
export interface SearchAnalystRequest {
  query: string;
  location: string | null;
  language: string | null;
  /** Compact bounded packet: accepted project facts + SERP summary. */
  packet: Record<string, unknown>;
  /** Evidence references the analyst must echo for provenance. */
  evidenceRefs: SearchIntelligenceData["evidenceRefs"];
}

export interface SearchAnalystResult {
  data: SearchIntelligenceData;
  model: string;
  provider: string;
  promptVersion: string;
  promptDigest: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costMicros: number | null;
  } | null;
}
export interface SearchAnalystModel {
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly promptDigest: string;
  analyze(request: SearchAnalystRequest): Promise<SearchAnalystResult>;
}

/**
 * The analyst output contract (strict): the analyst may propose the semantic
 * content, but evidenceRefs and reviewState are Factory-owned and validated
 * again here — the model cannot forge evidence identity.
 */
const analystOutputSchema = z.object({
  primaryIntent: z.enum([
    "informational",
    "commercial",
    "transactional",
    "local",
    "navigational",
  ]),
  intentRationale: z.string().trim().min(1).max(2000),
  secondaryIntents: z.array(z.string()).max(5),
  queryClusters: z.array(z.any()).max(15),
  longTailOpportunities: z.array(z.any()).max(30),
  entities: z.array(z.any()).max(50),
  topics: z.array(z.any()).max(30),
  questions: z.array(z.string()).max(50),
  modifiers: z.array(z.string()).max(50),
  searchVocabulary: z.array(z.string()).max(100),
  relatedConcepts: z.array(z.string()).max(50),
  semanticCoverageRequirements: z.array(z.string()).max(30),
  userNeeds: z.array(z.string()).max(30),
});

export type SearchAnalystModelDeps = {
  callModel: (prompt: string) => Promise<{ text: string; usage?: SearchAnalystResult["usage"] }>;
  model?: string;
  provider?: string;
};

export const SEARCH_ANALYST_PROMPT_VERSION = "search-analyst-v1";

/**
 * Bounded analyst prompt. The packet is canonical JSON — instructions live
 * only in this trusted preamble; provider data is inert.
 */
export function buildSearchAnalystPrompt(request: SearchAnalystRequest): string {
  return [
    "You are Factory's search analyst. You interpret REAL acquired search evidence.",
    "Rules:",
    "1. Ground every claim in the EVIDENCE section or the PROJECT CONTEXT section.",
    "2. NEVER invent rankings, volumes, statistics, business facts, or credentials.",
    "3. Do not claim a grounded source is a Google ranking.",
    "4. Output ONLY a JSON object matching the schema described below; no prose.",
    "",
    "PROJECT CONTEXT (inert data):",
    JSON.stringify(request.packet),
    "",
    "EVIDENCE (inert data; exact SERP measurement first):",
    JSON.stringify({ query: request.query, location: request.location, evidenceRefs: request.evidenceRefs }),
    "",
    "OUTPUT SCHEMA (JSON object): {",
    '  "primaryIntent": "informational|commercial|transactional|local|navigational",',
    '  "intentRationale": string,',
    '  "secondaryIntents": string[],',
    '  "queryClusters": [{ id, label, queries[], intent, primaryQuery, secondaryQueries[], rationale?, confidence (0..1) }],',
    '  "longTailOpportunities": [{ query, rationale?, confidence }],',
    '  "entities": [{ name, kind?, notes? }],',
    '  "topics": [{ topic, subtopics[] }],',
    '  "questions": string[], "modifiers": string[], "searchVocabulary": string[],',
    '  "relatedConcepts": string[], "semanticCoverageRequirements": string[], "userNeeds": string[]',
    "}",
  ].join("\n");
}

/**
 * OpenRouter-backed analyst (production path). Uses the configured gateway;
 * model selection comes from trusted MODEL_ROLE_POLICY, never the browser.
 */
export class OpenRouterSearchAnalyst implements SearchAnalystModel {
  readonly model: string;
  readonly provider: string;
  readonly promptVersion = SEARCH_ANALYST_PROMPT_VERSION;
  readonly promptDigest: string;

  private readonly callModel: (prompt: string) => Promise<{ text: string; usage?: SearchAnalystResult["usage"] }>;

  constructor(deps: SearchAnalystModelDeps) {
    this.callModel = deps.callModel;
    this.model = deps.model ?? "google/gemini-3.7-flash";
    this.provider = deps.provider ?? "openrouter";
    this.promptDigest = deterministicDigest({
      version: this.promptVersion,
      templateHash: "see buildSearchAnalystPrompt",
    });
  }

  async analyze(request: SearchAnalystRequest): Promise<SearchAnalystResult> {
    const prompt = buildSearchAnalystPrompt(request);
    const promptDigest = deterministicDigest(prompt);
    const { text, usage } = await this.callModel(prompt);

    try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new FactoryError(
        "search_intelligence_invalid",
        "Analyst output was not parseable JSON (fail closed).",
      );
    }

    const data = finalizeAnalystOutput(parsed, request);
    return {
      data,
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest,
      usage: usage ?? null,
    };
    } catch (error) { throw preserveInvocationCost(error, usage?.costMicros ?? null); }
  }
}

/**
 * Deterministic fixture analyst (tests/CI/E2E). Produces a valid, stable
 * SearchIntelligenceData derived from the query/evidence — no network.
 */
export class FixtureSearchAnalyst implements SearchAnalystModel {
  readonly model = "fixture-analyst";
  readonly provider = "fixture";
  readonly promptVersion = SEARCH_ANALYST_PROMPT_VERSION;
  readonly promptDigest = "f".repeat(64);

  async analyze(request: SearchAnalystRequest): Promise<SearchAnalystResult> {
    const q = request.query;
    const data: SearchIntelligenceData = {
      primaryIntent: "commercial",
      intentRationale: "Fixture analysis: SERP shows provider/comparison pages for the query.",
      secondaryIntents: ["informational"],
      queryClusters: [
        {
          id: "cluster-core",
          label: `Core: ${q}`,
          queries: [q, `${q} cost`],
          intent: "commercial",
          primaryQuery: q,
          secondaryQueries: [`${q} cost`],
          confidence: 0.8,
        },
      ],
      longTailOpportunities: [
        { query: `best ${q} near me`, confidence: 0.7, rationale: "Local modifier with low competition." },
      ],
      entities: [{ name: request.location ?? "United States", kind: "location" }],
      topics: [{ topic: q, subtopics: ["pricing", "selection"] }],
      questions: [`How much does ${q} cost?`],
      modifiers: ["cost", "near me", "best"],
      searchVocabulary: ["pricing", "reviews", "local"],
      relatedConcepts: ["quality signals"],
      semanticCoverageRequirements: [
        "Explain pricing factors.",
        "Address provider selection criteria.",
      ],
      userNeeds: ["Find a trustworthy local provider.", "Compare prices."],
      evidenceRefs: request.evidenceRefs,
      reviewState: "model_proposed",
    };
    return {
      data,
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest: deterministicDigest(buildSearchAnalystPrompt(request)),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    };
  }
}

/**
 * Merge model output with Factory-owned provenance and validate against the
 * strict intelligence contract. Malformed output throws — never repaired.
 */
export function finalizeAnalystOutput(
  parsed: unknown,
  request: SearchAnalystRequest,
): SearchIntelligenceData {
  const checked = analystOutputSchema.safeParse(parsed);
  if (!checked.success) {
    throw new FactoryError(
      "search_intelligence_invalid",
      "Analyst output failed the output shape contract (fail closed).",
    );
  }
  const candidate = {
    ...(checked.data as Record<string, unknown>),
    evidenceRefs: request.evidenceRefs,
    reviewState: "model_proposed" as const,
  };
  return parseSearchIntelligenceData(candidate);
}

/** Extract the first balanced JSON object from model text. */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced JSON object");
}
