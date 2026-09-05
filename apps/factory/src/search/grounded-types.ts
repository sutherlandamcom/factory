import type { GroundedSearchData, SearchUsage } from "@factory/contracts";

/**
 * GroundedSearchProvider — WHAT CURRENT WEB EVIDENCE TELLS US.
 *
 * Model-mediated research with citations (preferred v0 shape: Gemini Flash +
 * native Google Search grounding). Output is NEVER exact SERP evidence and
 * must never be presented as rankings. Sources are the pages the model
 * actually consulted; derived claims remain model_proposed, not authority.
 */
export interface GroundedResearchRequest {
  query: string;
  location: string | null;
  language: string | null;
  /** Bounded operator-approved project context (already compiled packet). */
  packetDigest: string;
}

export interface GroundedResearchResult {
  data: GroundedSearchData;
  model: string;
  provider: string;
  promptVersion: string;
  promptDigest: string;
  observedAt: Date;
  usage: SearchUsage | null;
}

export interface GroundedSearchProvider {
  readonly id: string;
  readonly model: string;
  readiness():
    | { configured: true }
    | { configured: false; reason: string };
  research(request: GroundedResearchRequest): Promise<GroundedResearchResult>;
}

/**
 * Deterministic fixture grounded-research provider (tests/CI/E2E only).
 * Emits a stable, contract-valid grounded output; never reachable from
 * production configuration.
 */
export class FixtureGroundedSearchProvider implements GroundedSearchProvider {
  readonly id = "fixture-grounded";
  readonly model = "fixture-gemini-flash";

  readiness() {
    return { configured: true as const };
  }

  async research(request: GroundedResearchRequest): Promise<GroundedResearchResult> {
    const promptVersion = "search-analyst-v1";
    const promptDigest = "f".repeat(64);
    return {
      data: {
        webSearchQueries: [`${request.query} ${request.location ?? ""}`.trim()],
        sources: [
          {
            title: "Fixture: local market overview",
            uri: "https://fixture-source.example.com/market-overview",
          },
          {
            title: "Fixture: consumer guidance",
            uri: "https://fixture-source.example.com/guidance",
          },
        ],
        structuredOutput: {
          summary: `Fixture grounded findings for ${request.query}.`,
          notes: "Deterministic test evidence; not real web research.",
        },
      },
      model: this.model,
      provider: this.id,
      promptVersion,
      promptDigest,
      observedAt: new Date("2026-09-06T00:00:00.000Z"),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, searchQueriesCount: 1 },
    };
  }
}
