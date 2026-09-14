import { InvocationFailure, preserveInvocationCost } from "../models/invocation-failure.js";
import {
  normalizeSearchQuery,
  parseSerpSnapshotData,
  type SerpSnapshotData,
  type SerpOrganicResult,
  type SerpFeature,
  type PeopleAlsoAskItem,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { scrubCredentials } from "../models/gateway.js";
import type {
  SerpAcquisitionRequest,
  SerpAcquisitionResult,
  SerpProviderReadiness,
  StructuredSerpProvider,
} from "./provider-types.js";

/**
 * DataForSEO adapter (v0 StructuredSerpProvider).
 *
 * Uses the Live Google Organic SERPAdvanced endpoint with HTTP basic auth
 * from trusted backend config (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).
 * Credentials never leave this module; errors are sanitized before throwing.
 *
 * Cost: DataForSEO prices this endpoint per request (post-paid). The response
 * includes a truthful per-request cost (`money.cost`) which is surfaced as
 * usage telemetry; when absent, cost is UNKNOWN (null), never estimated.
 */
export const DATAFORSEO_LIVE_ORGANIC_URL =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";

export const DATAFORSEO_LOGIN_ENV = "DATAFORSEO_LOGIN";
export const DATAFORSEO_PASSWORD_ENV = "DATAFORSEO_PASSWORD";

const TIMEOUT_MS = 60_000;
const MAX_RAW_BYTES = 256 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DataForSeoSerpProviderDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Test seam: stable timestamp injection. */
  now?: () => Date;
}

/** DataForSEO task-post wrapper shapes we rely on (subset). */
interface DfsOrganicItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  url?: string;
  domain?: string;
  title?: string;
  description?: string;
  feature?: string;
  items?: DfsOrganicItem[];
}

interface DfsResponse {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    id?: string;
    cost?: number;
    result?: Array<{
      items?: DfsOrganicItem[];
    }>;
  }> | null;
}

export class DataForSeoSerpProvider implements StructuredSerpProvider {
  readonly id = "dataforseo";
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(deps: DataForSeoSerpProviderDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  readiness(): SerpProviderReadiness {
    if (this.env[DATAFORSEO_LOGIN_ENV]?.trim() && this.env[DATAFORSEO_PASSWORD_ENV]?.trim()) {
      return { configured: true };
    }
    return {
      configured: false,
      reason:
        "DataForSEO credentials are not configured (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).",
    };
  }

  async acquire(request: SerpAcquisitionRequest): Promise<SerpAcquisitionResult> {
    const readiness = this.readiness();
    if (!readiness.configured) {
      throw new InvocationFailure("search_provider_not_configured", readiness.reason, { requestSubmitted: false });
    }

    const login = this.env[DATAFORSEO_LOGIN_ENV]!.trim();
    const password = this.env[DATAFORSEO_PASSWORD_ENV]!.trim();
    const auth = Buffer.from(`${login}:${password}`).toString("base64");

    const keywords = [normalizeSearchQuery(request.query)];
    const postBody = [
      {
        keyword: keywords[0],
        location_name: request.location ?? "United States",
        language_code: request.language ?? "en",
        device: request.device,
      },
    ];

    let response: Response;
    try {
      response = await this.fetchImpl(DATAFORSEO_LIVE_ORGANIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify(postBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new FactoryError("search_provider_unavailable", "DataForSEO request timed out.");
      }
      throw new FactoryError(
        "search_provider_unavailable",
        "DataForSEO endpoint could not be reached.",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new FactoryError(
        "search_provider_auth_failed",
        "DataForSEO rejected the configured credentials.",
      );
    }
    if (response.status === 429) {
      throw new FactoryError("search_provider_rate_limited", "DataForSEO rate limit reached.");
    }
    if (!response.ok) {
      throw new FactoryError(
        "search_provider_unavailable",
        `DataForSEO returned HTTP ${response.status}.`,
      );
    }

    const rawText = await response.text();
    if (rawText.length > MAX_RAW_BYTES) {
      throw new FactoryError(
        "search_response_invalid",
        "DataForSEO response exceeded the raw payload ceiling.",
      );
    }

    let parsed: DfsResponse;
    try {
      parsed = JSON.parse(rawText) as DfsResponse;
    } catch {
      throw new FactoryError("search_response_invalid", "DataForSEO response was not valid JSON.");
    }

    // DataForSEO wraps success codes in tasks[]; 40000-series task codes
    // indicate auth/quota problems even under HTTP 200.
    const task = parsed.tasks?.[0];
    const costMicros =
      typeof task?.cost === "number" && Number.isFinite(task.cost) && task.cost >= 0
        ? Math.round(task.cost * 1_000_000)
        : null;
    try {
    const statusCode = task?.status_code ?? parsed.status_code ?? 0;
    if (statusCode === 40100 || statusCode === 40101 || statusCode === 40300) {
      throw new FactoryError(
        "search_provider_auth_failed",
        "DataForSEO rejected the request (authentication/quota task status).",
      );
    }
    if (statusCode >= 40000) {
      if (statusCode === 40600 || /quota|limit/i.test(task?.status_message ?? "")) {
        throw new FactoryError(
          "search_provider_rate_limited",
          "DataForSEO quota/limit status returned.",
        );
      }
      throw new FactoryError(
        "search_response_invalid",
        "DataForSEO task did not complete successfully.",
      );
    }

    const organicItems = task?.result?.[0]?.items ?? [];
    const data = normalizeDfsItems(organicItems);
    const validated = parseSerpSnapshotData(data);



    return {
      data: validated,
      rawPayload: JSON.parse(rawText) as unknown,
      providerRequestId: task?.id ?? null,
      observedAt: this.now(),
      usage: {
        costMicros,
        currency: costMicros != null ? "USD" : undefined,
        costUnknown: costMicros == null,
      },
    };
    } catch (error) { throw preserveInvocationCost(error, costMicros); }
  }
}

/**
 * Deterministic normalization of DataForSEO organic items.
 *
 * Ranking authority: `rank_absolute` is the engine's 1-based position;
 * fallback to rank_group, then array order. Unknown item types are ignored —
 * never invented into organic results.
 */
export function normalizeDfsItems(items: DfsOrganicItem[]): SerpSnapshotData {
  const organic: SerpOrganicResult[] = [];
  const features: SerpFeature[] = [];
  const paa: PeopleAlsoAskItem[] = [];
  const related: string[] = [];
  const visit = (item: DfsOrganicItem, fallbackRank: number): void => {
    const type = item.type ?? "";
    if (type === "organic") {
      const url = item.url ?? "";
      if (!url || !/^https?:\/\//i.test(url)) return;
      const position = item.rank_absolute ?? item.rank_group ?? fallbackRank;
      let domain = item.domain ?? "";
      try {
        const host = new URL(url).hostname;
        domain = host.replace(/^www\./, "");
      } catch {
        return;
      }
      organic.push({
        position,
        url,
        domain,
        title: (item.title ?? "").slice(0, 500),
        snippet: (item.description ?? "").slice(0, 2000),
      });
      return;
    }
    if (type === "featured_snippet") {
      features.push("featured_snippet");
      return;
    }
    if (type === "local_pack") {
      features.push("local_pack");
      return;
    }
    if (type === "knowledge_panel") {
      features.push("knowledge_panel");
      return;
    }
    if (type === "images" || type === "image_results") {
      features.push("image_pack");
      return;
    }
    if (type === "video") {
      features.push("video_results");
      return;
    }
    if (type === "shopping") {
      features.push("shopping_results");
      return;
    }
    if (type === "top_stories") {
      features.push("top_stories");
      return;
    }
    if (type === "paid" || type === "ad") {
      features.push("ads_top");
      return;
    }
    if (type === "people_also_ask" && Array.isArray(item.items)) {
      for (const child of item.items) {
        if (typeof child.title === "string" && child.title.trim()) {
          paa.push({ question: child.title.trim().slice(0, 500) });
        }
      }
      return;
    }
    if (type === "related_searches" && Array.isArray(item.items)) {
      for (const child of item.items) {
        if (typeof child.title === "string" && child.title.trim()) {
          related.push(normalizeSearchQuery(child.title).slice(0, 200));
        }
      }
      return;
    }
    if (Array.isArray(item.items)) {
      for (const child of item.items) visit(child, fallbackRank);
    }
  };

  items.forEach((item, index) => visit(item, index + 1));

  organic.sort((a, b) => a.position - b.position);

  const data: SerpSnapshotData = { organic };
  if (features.length > 0) data.features = dedupe(features) as SerpFeature[];
  if (paa.length > 0) data.peopleAlsoAsk = paa;
  if (related.length > 0) data.relatedSearches = dedupe(related);
  return data;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Keep FactoryError messages credential-free (defense in depth). */
export function sanitizeProviderMessage(message: string): string {
  return scrubCredentials(message);
}
