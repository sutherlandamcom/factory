import { InvocationFailure } from "./invocation-failure.js";
import { getModelPricing } from "./pricing.js";
import {
  ModelCallError,
  scrubCredentials,
  type FetchLike,
  type ModelCallRequest,
  type ModelCallResult,
  type ModelGatewayDeps,
} from "./gateway.js";

/**
 * FACTORY MERGE GATEWAY ADAPTER — bounded real-inference pilot (TEST ONLY).
 *
 * Routes one explicit-viewer chat completion through Merge Gateway
 * (https://api-gateway.merge.dev/v1/chat/completions, OpenAI-compatible
 * shape, bearer key) for the operator-approved pilot profile in
 * merge-policy.ts. This is NOT the OpenRouter path and NOT a direct Z.ai
 * call: the wire provider is `merge`.
 *
 * Policy rules enforced here (mirror of models/gateway.ts):
 * - The exact model id is ALWAYS explicit per call. No aliases, no
 *   `priority_order` failover lists, no vendor fallbacks, no model-identity
 *   auto-selection: Factory's pilot profile pins `zai/glm-5.3-flash`.
 * - Credentials fail closed: without MERGE_GATEWAY_API_KEY no call is made.
 * - The key never enters prompts, artifacts, logs, or error messages
 *   (scrubCredentials from gateway.ts is reused).
 * - Exact provenance (responded model, provider identity, token usage, cost,
 *   duration) is captured from the gateway response whenever available; the
 *   gateway's `usage.cost` field is USD.
 * - No tools, no agentic loop: system+user messages -> single completion.
 */

export const MERGE_GATEWAY_BASE_URL = "https://api-gateway.merge.dev/v1";

export const MERGE_GATEWAY_API_KEY_ENV = "MERGE_GATEWAY_API_KEY";

/** Gitignored repository-root .env (checked only if the cwd .env is absent). */
const REPO_ROOT_DOTENV = new URL("../../../../.env", import.meta.url).pathname;

/** Load the Merge credential without ever exposing its value. */
export function loadMergeApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env[MERGE_GATEWAY_API_KEY_ENV];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  // Operator convenience: load the gitignored .env (cwd first, then the
  // repository root) when the shell env does not carry the key. Same pattern
  // as loadOpenRouterApiKey, made predictable for package-subdir runtimes.
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file (or unreadable) — fall through to the explicit root load.
  }
  try {
    process.loadEnvFile?.(REPO_ROOT_DOTENV);
  } catch {
    // Repo-root .env also absent.
  }
  const fromFile = process.env[MERGE_GATEWAY_API_KEY_ENV];
  if (typeof fromFile === "string" && fromFile.trim().length > 0) {
    return fromFile.trim();
  }
  return null;
}

/**
 * Provider-side price ceiling (USD per MILLION tokens for the wire request,
 * derived from Factory's trusted conservative per-token rates). Reuses the
 * exact semantics of trustedProviderMaxPrice in gateway.ts: when no trusted
 * pricing exists for the requested model, no ceiling is sent — pilot paths
 * fail closed earlier at conservative-reservation time, so an unpriced merge
 * model can never reach a paid call through governed wiring.
 */
function trustedProviderMaxPrice(model: string): { prompt: number; completion: number } | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return {
    prompt: Number((pricing.promptUsdPerToken * 1_000_000).toFixed(6)),
    completion: Number((pricing.completionUsdPerToken * 1_000_000).toFixed(6)),
  };
}

interface MergeChatResponse {
  model?: unknown;
  provider?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
  };
  error?: { message?: unknown; code?: unknown };
}

function boundedNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * Invoke exactly ONE chat completion through Merge Gateway. Throws
 * ModelCallError on failure; never returns partial content.
 */
export async function invokeModelViaMerge(
  request: ModelCallRequest,
  deps: ModelGatewayDeps = {},
): Promise<ModelCallResult> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(request.model)) {
    throw new ModelCallError(
      "policy_violation",
      `model id is not a valid explicit model identifier: "${request.model.slice(0, 50)}"`,
      null, { requestSubmitted: false },
    );
  }
  if (request.model === "openrouter/auto" || request.model.startsWith("openrouter/auto:")) {
    throw new ModelCallError(
      "policy_violation",
      "Auto-routing is forbidden for Factory Merge Gateway calls; the pilot profile names an exact model",
      null, { requestSubmitted: false },
    );
  }
  if (!request.systemPrompt.trim() || !request.prompt.trim()) {
    throw new ModelCallError(
      "policy_violation",
      "model call requires non-empty system and user prompts",
      null, { requestSubmitted: false },
    );
  }

  const apiKey = (deps.loadApiKey ?? loadMergeApiKey)();
  if (apiKey === null) {
    throw new ModelCallError(
      "credentials_unavailable",
      `${MERGE_GATEWAY_API_KEY_ENV} is not configured; the Merge Gateway adapter fails closed without credentials`,
      null, { requestSubmitted: false },
    );
  }

  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const maxPrice = trustedProviderMaxPrice(request.model);

  let response: Response;
  try {
    response = await fetchImpl(`${MERGE_GATEWAY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.prompt },
        ],
        max_tokens: request.maxTokens ?? 16_000,
        // Deterministic-friendly default applied uniformly with the
        // OpenRouter adapter.
        temperature: 0,
        // Providers are not restricted to a vendor; this sends ONE exact
        // model id. Deliberately absent: priority_order, vendor(s), aliases,
        // stream, tools.
        ...(maxPrice ? { provider_options: { max_price: maxPrice } } : {}),
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/abort|timeout|timed?\s?out/i.test(raw)) {
      throw new ModelCallError("model_timeout", scrubCredentials(raw, apiKey));
    }
    throw new ModelCallError("model_failed", scrubCredentials(raw, apiKey));
  }

  const durationMs = Math.max(0, now() - startedAt);
  const rawBody = await response.text().catch(() => "");

  // Usage belongs to the invocation even if content or the HTTP outcome
  // fails. Merge reports cost in USD inside usage.cost.
  let trustedCostMicros: number | null = null;
  try {
    const cost = boundedNumber((JSON.parse(rawBody) as MergeChatResponse).usage?.cost);
    if (cost != null) trustedCostMicros = Math.round(cost * 1_000_000);
  } catch {
    // No trustworthy usage: preserve conservative accounting.
  }
  const evidence = { trustedCostMicros };

  if (!response.ok) {
    let detail = rawBody.slice(0, 300);
    try {
      const parsedError = JSON.parse(rawBody) as MergeChatResponse;
      if (parsedError.error && typeof parsedError.error.message === "string") {
        detail = parsedError.error.message.slice(0, 300);
      }
    } catch {
      // Keep raw slice.
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelCallError(
        "credentials_unavailable",
        `Merge Gateway rejected credentials (HTTP ${response.status}): ${scrubCredentials(detail, apiKey)}`,
        response.status,
        evidence,
      );
    }
    if (response.status === 402) {
      throw new ModelCallError(
        "policy_violation",
        `Merge Gateway budget/credit block (HTTP 402): ${scrubCredentials(detail, apiKey)}`,
        402,
        evidence,
      );
    }
    if (response.status === 408) {
      throw new ModelCallError("model_timeout", `Merge Gateway timeout (HTTP 408): ${scrubCredentials(detail, apiKey)}`, 408, evidence);
    }
    throw new ModelCallError(
      "model_failed",
      `Merge Gateway call failed (HTTP ${response.status}): ${scrubCredentials(detail, apiKey)}`,
      response.status,
      evidence,
    );
  }

  let parsed: MergeChatResponse;
  try {
    parsed = JSON.parse(rawBody) as MergeChatResponse;
  } catch {
    throw new ModelCallError("model_failed", "Merge Gateway returned a non-JSON response body");
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ModelCallError("model_failed", "Merge Gateway response contained no completion content", null, evidence);
  }

  return {
    requestedModel: request.model,
    respondedModel: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model.slice(0, 200) : null,
    provider: typeof parsed.provider === "string" && parsed.provider.length > 0 ? parsed.provider.slice(0, 100) : "merge",
    durationMs,
    promptTokens: boundedNumber(parsed.usage?.prompt_tokens),
    completionTokens: boundedNumber(parsed.usage?.completion_tokens),
    totalTokens: boundedNumber(parsed.usage?.total_tokens),
    costUsd: boundedNumber(parsed.usage?.cost),
    content,
  };
}

export interface MergeModelSummary {
  id: string;
  name: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  supportsStructuredOutputs: boolean;
  /** Pricing straight from the authenticated listing (USD per token), or null. */
  promptPriceUsdPerToken: number | null;
  completionPriceUsdPerToken: number | null;
}

/**
 * Authenticated model discovery (preflight only — paid calls always pin the
 * exact pilot id from the merge profile). This listing reflects the models
 * the KEY's account can access, not the public catalog. The listing is
 * cursor-paginated (`has_more`/`next_cursor`); we bound the walk at 15
 * pages (~330 ids, the full current catalog). Fails closed without
 * credentials.
 */
export async function listMergeModels(deps: ModelGatewayDeps = {}): Promise<MergeModelSummary[]> {
  const apiKey = (deps.loadApiKey ?? loadMergeApiKey)();
  if (apiKey === null) {
    throw new ModelCallError(
      "credentials_unavailable",
      `${MERGE_GATEWAY_API_KEY_ENV} is not configured; the Merge Gateway adapter fails closed without credentials`,
      null, { requestSubmitted: false },
    );
  }
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const models: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 15; page++) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${MERGE_GATEWAY_BASE_URL}/models${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      );
    } catch (error) {
      throw new ModelCallError(
        "model_failed",
        scrubCredentials(error instanceof Error ? error.message : String(error), apiKey),
      );
    }
    if (!response.ok) {
      throw new ModelCallError(
        "model_failed",
        `Merge Gateway model listing failed (HTTP ${response.status})`,
        response.status,
      );
    }
    let parsed: { data?: Array<Record<string, unknown>>; has_more?: unknown; next_cursor?: unknown };
    try {
      parsed = JSON.parse(await response.text()) as typeof parsed;
    } catch {
      throw new ModelCallError("model_failed", "Merge Gateway returned a non-JSON model listing");
    }
    if (Array.isArray(parsed.data)) models.push(...parsed.data);
    const hasMore = parsed.has_more === true && typeof parsed.next_cursor === "string" && parsed.next_cursor.length > 0;
    if (!hasMore) break;
    cursor = parsed.next_cursor as string;
  }
  return models
    .map((entry) => {
      const supportedFeatures = entry.supported_features;
      const features = Array.isArray(supportedFeatures) ? (supportedFeatures as unknown[]) : [];
      // Merge per-vendor shape: entry.vendors[vendor].capabilities/discounted…
      // Entry-level `supports_structured_outputs` is the true gate; the
      // listing entry also carries availability_status and per-vendor pricing.
      const structured =
        entry.supports_structured_outputs === true || features.includes("structured_outputs");
      const entryPricing = (entry.pricing ?? {}) as Record<string, unknown>;
      const promptPrice = boundedNumber(entryPricing.prompt) ?? boundedNumber(entryPricing.input_per_million !== undefined ? Number(entryPricing.input_per_million) * 1e-6 : undefined);
      const completionPrice = boundedNumber(entryPricing.completion) ?? boundedNumber(entryPricing.output_per_million !== undefined ? Number(entryPricing.output_per_million) * 1e-6 : undefined);
      const vendors = (entry.vendors ?? {}) as Record<string, Record<string, unknown>>;
      const cheapestPrompt = Object.values(vendors)
        .map((v) => ((v.pricing ?? {}) as Record<string, unknown>).input_per_million)
        .filter((v): v is number => typeof v === "number" && v >= 0);
      const cheapestCompletion = Object.values(vendors)
        .map((v) => ((v.pricing ?? {}) as Record<string, unknown>).output_per_million)
        .filter((v): v is number => typeof v === "number" && v >= 0);
      const contextLength =
        boundedNumber(entry.context_length) ??
        (() => {
          // Merge catalogs context per vendor: minimum of accessible windows.
          const windows = Object.values(vendors)
            .map((v) => boundedNumber(v.context_window))
            .filter((v): v is number => v != null);
          return windows.length > 0 ? Math.min(...windows) : null;
        })();
      const maxOutputTokens =
        boundedNumber(entry.max_output_tokens) ??
        (() => {
          const caps = Object.values(vendors)
            .map((v) => boundedNumber(v.max_output_tokens))
            .filter((v): v is number => v != null);
          return caps.length > 0 ? Math.max(...caps) : null;
        })();
      return {
        id: typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : "",
        name: typeof entry.display_name === "string" ? entry.display_name : null,
        contextLength,
        maxOutputTokens,
        supportsStructuredOutputs: structured === true || (() => {
          const vendorStructured = Object.values(vendors).map((v) => ((v.capabilities ?? {}) as Record<string, unknown>).supports_structured_outputs);
          return vendorStructured.some((s) => s === true);
        })(),
        promptPriceUsdPerToken: promptPrice ?? (cheapestPrompt.length > 0 ? Math.min(...cheapestPrompt) * 1e-6 : null),
        completionPriceUsdPerToken: completionPrice ?? (cheapestCompletion.length > 0 ? Math.min(...cheapestCompletion) * 1e-6 : null),
      };
    })
    .filter((entry: MergeModelSummary) => entry.id.length > 0);
}

/** Re-exported so pilot wiring reuses the exact failure taxonomy. */
export { ModelCallError };
export { InvocationFailure };
