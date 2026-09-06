import {
  MAX_SERP_RAW_BYTES,
  normalizeSearchQuery,
  parseSerpSnapshotData,
  type PeopleAlsoAskItem,
  type SerpFeature,
  type SerpOrganicResult,
  type SerpSnapshotData,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import type {
  SerpAcquisitionRequest,
  SerpAcquisitionResult,
  SerpProviderReadiness,
  StructuredSerpProvider,
} from "./provider-types.js";

/**
 * Bright Data SERP API adapter.
 *
 * This is Factory's default v0 structured-SERP measurement provider. It calls
 * the trusted Bright Data SERP API zone and normalizes provider-native Google
 * results into the existing SerpSnapshotData contract. Credentials never
 * leave this module and provider error bodies are never surfaced to callers.
 *
 * Bright Data does not expose authoritative per-request billing in the SERP
 * response used here, so cost remains UNKNOWN rather than being estimated.
 */
export const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
export const BRIGHTDATA_API_KEY_ENV = "BRIGHTDATA_API_KEY";
export const BRIGHTDATA_ZONE_ENV = "BRIGHTDATA_ZONE";
export const DEFAULT_BRIGHTDATA_ZONE = "factory_google_serp";

const TIMEOUT_MS = 60_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BrightDataSerpProviderDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

interface BrightDataOrganicItem {
  rank?: number;
  global_rank?: number;
  link?: string;
  url?: string;
  title?: string;
  description?: string;
  snippet?: string;
  sitelinks?: unknown;
}

interface BrightDataPaaItem {
  question?: string;
  answer?: string;
}

interface BrightDataRelatedItem {
  text?: string;
  title?: string;
  query?: string;
}

interface BrightDataParsedResponse {
  general?: {
    timestamp?: string;
  };
  input?: {
    request_id?: string;
  };
  organic?: BrightDataOrganicItem[];
  people_also_ask?: BrightDataPaaItem[];
  related?: BrightDataRelatedItem[];
  related_searches?: BrightDataRelatedItem[];
  featured_snippet?: unknown;
  local?: unknown;
  local_results?: unknown;
  local_pack?: unknown;
  knowledge?: unknown;
  knowledge_panel?: unknown;
  images?: unknown;
  image_pack?: unknown;
  videos?: unknown;
  video_results?: unknown;
  shopping?: unknown;
  shopping_results?: unknown;
  top_stories?: unknown;
  ads_top?: unknown;
  top_ads?: unknown;
  ads_bottom?: unknown;
  bottom_ads?: unknown;
}

export class BrightDataSerpProvider implements StructuredSerpProvider {
  readonly id = "brightdata";
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(deps: BrightDataSerpProviderDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  readiness(): SerpProviderReadiness {
    if (this.env[BRIGHTDATA_API_KEY_ENV]?.trim()) return { configured: true };
    return {
      configured: false,
      reason: "Bright Data credentials are not configured (BRIGHTDATA_API_KEY).",
    };
  }

  async acquire(request: SerpAcquisitionRequest): Promise<SerpAcquisitionResult> {
    const readiness = this.readiness();
    if (!readiness.configured) {
      throw new FactoryError("search_provider_not_configured", readiness.reason);
    }

    const apiKey = this.env[BRIGHTDATA_API_KEY_ENV]!.trim();
    const zone = this.env[BRIGHTDATA_ZONE_ENV]?.trim() || DEFAULT_BRIGHTDATA_ZONE;
    const targetUrl = buildBrightDataGoogleUrl(request);

    let response: Response;
    try {
      response = await this.fetchImpl(BRIGHTDATA_REQUEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          zone,
          url: targetUrl,
          format: "json",
          data_format: "parsed",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new FactoryError("search_provider_unavailable", "Bright Data request timed out.");
      }
      throw new FactoryError(
        "search_provider_unavailable",
        "Bright Data endpoint could not be reached.",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new FactoryError(
        "search_provider_auth_failed",
        "Bright Data rejected the configured credentials.",
      );
    }
    if (response.status === 402) {
      throw new FactoryError(
        "search_provider_budget_blocked",
        "Bright Data reported insufficient account credit or quota.",
      );
    }
    if (response.status === 429) {
      throw new FactoryError("search_provider_rate_limited", "Bright Data rate limit reached.");
    }
    if (!response.ok) {
      throw new FactoryError(
        response.status >= 500 ? "search_provider_unavailable" : "search_response_invalid",
        `Bright Data returned HTTP ${response.status}.`,
      );
    }

    const rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_SERP_RAW_BYTES) {
      throw new FactoryError(
        "search_response_invalid",
        "Bright Data response exceeded the raw payload ceiling.",
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawText) as unknown;
    } catch {
      throw new FactoryError("search_response_invalid", "Bright Data response was not valid JSON.");
    }

    const parsed = unwrapBrightDataPayload(rawPayload);
    const validated = parseSerpSnapshotData(normalizeBrightDataResponse(parsed));
    const observedAt = parseObservedAt(parsed.general?.timestamp) ?? this.now();

    return {
      data: validated,
      rawPayload,
      providerRequestId: parsed.input?.request_id ?? null,
      observedAt,
      usage: {
        costMicros: null,
        costUnknown: true,
        searchQueriesCount: 1,
      },
    };
  }
}

const KNOWN_COUNTRY_CODES: Record<string, string> = {
  france: "fr",
  "united states": "us",
  usa: "us",
  "united kingdom": "gb",
  uk: "gb",
  germany: "de",
  spain: "es",
  italy: "it",
  switzerland: "ch",
  canada: "ca",
  australia: "au",
  japan: "jp",
};

const US_STATE_EXPANSIONS: Record<string, string> = {
  tx: "Texas",
  ca: "California",
  ny: "New York",
  fl: "Florida",
  il: "Illinois",
  wa: "Washington",
  co: "Colorado",
  az: "Arizona",
  ma: "Massachusetts",
  pa: "Pennsylvania",
  oh: "Ohio",
  ga: "Georgia",
  nc: "North Carolina",
  mi: "Michigan",
  va: "Virginia",
  nj: "New Jersey",
};

/** Build an exact Google request without semantically rewriting the query. */
export function buildBrightDataGoogleUrl(request: SerpAcquisitionRequest): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", normalizeSearchQuery(request.query));
  url.searchParams.set("pws", "0");
  url.searchParams.set("brd_browser", "chrome");

  if (request.location?.trim()) {
    const rawLoc = request.location.trim();
    if (/^[a-z]{2}$/i.test(rawLoc)) {
      // 2-letter ISO country code: set gl only, never pollute uule with a non-canonical code
      url.searchParams.set("gl", rawLoc.toLowerCase());
    } else {
      const lower = rawLoc.toLowerCase();
      if (KNOWN_COUNTRY_CODES[lower]) {
        url.searchParams.set("gl", KNOWN_COUNTRY_CODES[lower]!);
        url.searchParams.set("uule", rawLoc);
      } else {
        // Expand common City, ST format (e.g. "Austin, TX" -> "Austin,Texas,United States")
        const usStateMatch = /^([^,]+),\s*([a-zA-Z]{2})$/.exec(rawLoc);
        let normalizedLoc = rawLoc;
        if (usStateMatch) {
          const stateAbbr = usStateMatch[2]!.toLowerCase();
          const expandedState = US_STATE_EXPANSIONS[stateAbbr];
          if (expandedState) {
            normalizedLoc = `${usStateMatch[1]!.trim()},${expandedState},United States`;
          }
        }
        url.searchParams.set("uule", normalizedLoc);

        // Pair with gl country code from location tail per Bright Data best practice
        const countryMatch = /,\s*([a-zA-Z\s]+)$/.exec(normalizedLoc);
        if (countryMatch) {
          const countryName = countryMatch[1]!.trim().toLowerCase();
          const code = KNOWN_COUNTRY_CODES[countryName];
          if (code) url.searchParams.set("gl", code);
        }
      }
    }
  }
  if (request.language?.trim()) {
    const language = request.language.trim().split(/[-_]/, 1)[0]?.toLowerCase();
    if (language) url.searchParams.set("hl", language);
  }

  if (request.device === "mobile") url.searchParams.set("brd_mobile", "1");
  else if (request.device === "tablet") url.searchParams.set("brd_mobile", "ipad");
  else url.searchParams.set("brd_mobile", "0");

  return url.toString();
}

/**
 * Normalize Bright Data's documented full Google JSON schema. Unknown provider
 * fields remain in rawPayload only; they are never fabricated into Factory's
 * closed SERP vocabulary.
 */
export function normalizeBrightDataResponse(parsed: BrightDataParsedResponse): SerpSnapshotData {
  if (!Array.isArray(parsed.organic)) {
    throw new FactoryError("search_response_invalid", "Bright Data response omitted organic results.");
  }

  const organic: SerpOrganicResult[] = parsed.organic.map((item, index) => {
    const rawUrl = item.link ?? item.url ?? "";
    let domain: string;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("unsupported protocol");
      domain = u.hostname.replace(/^www\./, "");
    } catch {
      throw new FactoryError("search_normalization_failed", "Bright Data organic result contained an invalid URL.");
    }

    return {
      position: validRank(item.rank) ?? validRank(item.global_rank) ?? index + 1,
      url: rawUrl,
      domain,
      title: (item.title ?? "").trim(),
      snippet: (item.description ?? item.snippet ?? "").trim(),
    };
  });

  organic.sort((a, b) => a.position - b.position);

  const peopleAlsoAsk: PeopleAlsoAskItem[] = [];
  for (const item of parsed.people_also_ask ?? []) {
    const question = item.question?.trim();
    if (!question) continue;
    peopleAlsoAsk.push({
      question,
      ...(item.answer?.trim() ? { answer: item.answer.trim() } : {}),
    });
  }

  const relatedSearches = [...(parsed.related ?? []), ...(parsed.related_searches ?? [])]
    .map((item) => normalizeSearchQuery(item.text ?? item.title ?? item.query ?? ""))
    .filter(Boolean);

  const features: SerpFeature[] = [];
  if (present(parsed.featured_snippet)) features.push("featured_snippet");
  if (present(parsed.local) || present(parsed.local_results) || present(parsed.local_pack)) features.push("local_pack");
  if (present(parsed.knowledge) || present(parsed.knowledge_panel)) features.push("knowledge_panel");
  if (present(parsed.images) || present(parsed.image_pack)) features.push("image_pack");
  if (present(parsed.videos) || present(parsed.video_results)) features.push("video_results");
  if (present(parsed.shopping) || present(parsed.shopping_results)) features.push("shopping_results");
  if (present(parsed.top_stories)) features.push("top_stories");
  if (present(parsed.ads_top) || present(parsed.top_ads)) features.push("ads_top");
  if (present(parsed.ads_bottom) || present(parsed.bottom_ads)) features.push("ads_bottom");
  if (parsed.organic.some((item) => present(item.sitelinks))) features.push("sitelinks");

  const data: SerpSnapshotData = { organic };
  if (features.length > 0) data.features = dedupe(features);
  if (peopleAlsoAsk.length > 0) data.peopleAlsoAsk = peopleAlsoAsk;
  if (relatedSearches.length > 0) data.relatedSearches = dedupe(relatedSearches);
  return data;
}

function unwrapBrightDataPayload(input: unknown): BrightDataParsedResponse {
  if (!input || typeof input !== "object") {
    throw new FactoryError("search_response_invalid", "Bright Data response had an invalid shape.");
  }

  const outer = input as Record<string, unknown>;
  if (Array.isArray(outer.organic)) return outer as BrightDataParsedResponse;

  if (typeof outer.body === "string") {
    try {
      const body = JSON.parse(outer.body) as unknown;
      if (body && typeof body === "object") return body as BrightDataParsedResponse;
    } catch {
      throw new FactoryError("search_response_invalid", "Bright Data response body was not valid JSON.");
    }
  }
  if (outer.body && typeof outer.body === "object") {
    return outer.body as BrightDataParsedResponse;
  }

  return outer as BrightDataParsedResponse;
}

function parseObservedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validRank(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
