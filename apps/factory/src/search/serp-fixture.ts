import type { SerpSnapshotData, SearchUsage } from "@factory/contracts";
import type {
  SerpAcquisitionRequest,
  SerpAcquisitionResult,
  SerpProviderReadiness,
  StructuredSerpProvider,
} from "./provider-types.js";

/**
 * Deterministic fixture SERP provider (tests/CI/E2E only).
 *
 * Produces stable, contract-valid SERP data derived purely from the request
 * (query/location/device) so journeys are reproducible without network or
 * spend. It is NOT reachable through production configuration: the trusted
 * backend selects it only when FACTORY_SEARCH_MODE=fixture.
 */
export class FixtureSerpProvider implements StructuredSerpProvider {
  readonly id = "fixture";
  private readonly now: () => Date;

  constructor(deps: { now?: () => Date } = {}) {
    this.now = deps.now ?? (() => new Date("2026-09-06T00:00:00.000Z"));
  }

  readiness(): SerpProviderReadiness {
    return { configured: true };
  }

  async acquire(request: SerpAcquisitionRequest): Promise<SerpAcquisitionResult> {
    const q = request.query;
    const loc = request.location ?? "United States";
    const data: SerpSnapshotData = {
      organic: [
        {
          position: 1,
          url: `https://market-leader.example.com/${slug(q)}`,
          domain: "market-leader.example.com",
          title: `${titleCase(q)} — Complete Guide`,
          snippet: `The top-ranked guide covering ${q} for customers in ${loc}.`,
        },
        {
          position: 2,
          url: `https://local-directory.example.net/${slug(q)}`,
          domain: "local-directory.example.net",
          title: `Best ${titleCase(q)} near you`,
          snippet: `Directory listings comparing providers for ${q}.`,
        },
        {
          position: 3,
          url: `https://independent-blog.example.org/posts/${slug(q)}`,
          domain: "independent-blog.example.org",
          title: `What nobody tells you about ${q}`,
          snippet: `An independent analysis of ${q}, including costs and pitfalls.`,
        },
      ],
      features: ["local_pack", "ads_top"],
      peopleAlsoAsk: [
        { question: `How much does ${q} cost in ${loc}?` },
        { question: `How do I choose a provider for ${q}?` },
      ],
      relatedSearches: [`${q} cost`, `best ${q} ${loc.toLowerCase()}`, `${q} near me`],
    };
    return {
      data,
      rawPayload: { fixture: true, request: { query: q, location: loc, device: request.device } },
      providerRequestId: `fixture-${simpleHash(q + loc + request.device)}`,
      observedAt: this.now(),
      usage: { costMicros: 0, currency: "USD" },
    } satisfies SerpAcquisitionResult & { usage: SearchUsage };
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function simpleHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
