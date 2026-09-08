import { existsSync } from "node:fs";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";
import { getModelPricing } from "./pricing.js";

/**
 * Factory Model Gateway v0 — OpenRouter adapter.
 *
 * Trust and policy rules enforced here:
 * - The exact model id is ALWAYS explicit per call. Model-identity auto
 *   selection is never used: OpenRouter Auto Router, `models` fallback
 *   arrays, and `route: "fallback"` are forbidden — Factory's
 *   ModelRolePolicy decides champion/challenger selection, never the gateway.
 *   (OpenRouter may still route the pinned model among upstream providers;
 *   the actual provider is captured below as provenance.)
 * - Credentials fail closed: without OPENROUTER_API_KEY no call is made.
 * - The key never enters prompts, artifacts, logs, or error messages.
 * - Exact provenance (responded model, provider, token usage, cost, duration)
 *   is captured from the gateway response whenever available.
 * - No tools, no agentic loop: input JSON/prompt → single completion → out.
 */

export const OPENROUTER_GATEWAY_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

export interface ModelCallRequest {
  /** Factory role this call serves (provenance only — never sent to the gateway). */
  roleId: string;
  /** Exact model id, e.g. "anthropic/claude-sonnet-4.5". Always explicit. */
  model: string;
  /** Trusted instructions (emitted as the system message). */
  systemPrompt: string;
  /** The task + inert DATA payload (emitted as the user message). */
  prompt: string;
  /** Maximum completion tokens; generous default, bounded by policy. */
  maxTokens?: number;
  timeoutMs: number;
}

export interface ModelCallResult {
  requestedModel: string;
  /** Model identity reported by the gateway, or null when truthfully unavailable. */
  respondedModel: string | null;
  /** Provider attribution reported by the gateway, or null when unavailable. */
  provider: string | null;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** The completion content (expected to be a single strict JSON document). */
  content: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ModelGatewayDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Credential loader override (tests); defaults to process environment. */
  loadApiKey?: () => string | null;
}

/**
 * Model-call failure classifications used by drivers to decide fallback and
 * repair behavior. Credentials/policy failures are NEVER retryable against
 * another model (they are configuration errors, not model failures).
 */
export type ModelCallFailureCode =
  | "credentials_unavailable"
  | "policy_violation"
  | "model_timeout"
  | "model_failed";

export class ModelCallError extends FactoryError {
  readonly httpStatus: number | null;

  constructor(code: ModelCallFailureCode, message: string, httpStatus: number | null = null) {
    super(code, message);
    this.httpStatus = httpStatus;
  }
}

/** Load the gateway credential without ever exposing its value. */
export function loadOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env[OPENROUTER_API_KEY_ENV];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  // Operator convenience: load the gitignored root .env when the shell env
  // does not carry the key. Existing environment values always win because
  // we only reach this path when the env value is absent.
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file (or unreadable) — fall through to the final env check.
  }
  const fromFile = process.env[OPENROUTER_API_KEY_ENV];
  if (typeof fromFile === "string" && fromFile.trim().length > 0) {
    return fromFile.trim();
  }
  return null;
}

/**
 * Defensive scrubbing of anything credential-shaped from error text before
 * it can reach artifacts, stderr, or structured results.
 */
export function scrubCredentials(text: string, apiKey?: string | null): string {
  let sanitized = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+@\S+/g, "[redacted-url]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[redacted-key]");
  if (apiKey && apiKey.length >= 8) {
    sanitized = sanitized.split(apiKey).join("[redacted-key]");
  }
  return sanitized.slice(0, 500);
}

function boundedNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value) === value ? value : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

interface OpenRouterChatResponse {
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

/**
 * Provider-side price ceiling for a request, derived from Factory's trusted
 * pricing policy (USD per MILLION tokens, the unit OpenRouter expects).
 *
 * The ceiling is exactly the trusted conservative per-token rate for the
 * requested model, so a route is only eligible when its price stays within
 * what Factory budget authorization assumed possible. If no upstream route
 * satisfies the ceiling, OpenRouter refuses the request (fail closed at the
 * provider, before spend). Models without trusted pricing get no ceiling
 * here; paid production paths fail closed earlier at reservation time, which
 * requires trusted pricing for the exact model.
 */
function trustedProviderMaxPrice(
  model: string,
): { prompt: number; completion: number } | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return {
    prompt: Number((pricing.promptUsdPerToken * 1_000_000).toFixed(6)),
    completion: Number((pricing.completionUsdPerToken * 1_000_000).toFixed(6)),
  };
}

/**
 * Invoke one model through OpenRouter with an explicit exact model id.
 * Throws ModelCallError on failure; never returns partial content.
 */
export async function invokeModel(
  request: ModelCallRequest,
  deps: ModelGatewayDeps = {},
): Promise<ModelCallResult> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(request.model)) {
    throw new ModelCallError(
      "policy_violation",
      `model id is not a valid explicit model identifier: "${request.model.slice(0, 50)}"`,
    );
  }
  // OpenRouter Auto Router is never acceptable for Factory calls: role
  // selection belongs to the Factory ModelRolePolicy, never the gateway.
  if (request.model === "openrouter/auto" || request.model.startsWith("openrouter/auto:")) {
    throw new ModelCallError(
      "policy_violation",
      "OpenRouter Auto Router is forbidden for Factory model calls; policy must name an exact model",
    );
  }
  if (!request.systemPrompt.trim() || !request.prompt.trim()) {
    throw new ModelCallError("policy_violation", "model call requires non-empty system and user prompts");
  }

  const apiKey = (deps.loadApiKey ?? loadOpenRouterApiKey)();
  if (apiKey === null) {
    throw new ModelCallError(
      "credentials_unavailable",
      `${OPENROUTER_API_KEY_ENV} is not configured; the gateway fails closed without credentials`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const maxPrice = trustedProviderMaxPrice(request.model);

  let response: Response;
  try {
    response = await fetchImpl(`${OPENROUTER_GATEWAY_BASE_URL}/chat/completions`, {
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
        // Deterministic-friendly default applied uniformly to every family.
        temperature: 0,
        // Provider-side price ceiling: only routes at or below Factory's
        // trusted conservative rate for this exact model are eligible. When
        // no route satisfies the ceiling OpenRouter refuses the request, so
        // spend can never exceed the trusted pricing ceiling provider-side.
        ...(maxPrice ? { provider: { max_price: maxPrice } } : {}),
        // Deliberately absent: `models` fallback arrays, `route`, and any
        // model-identity auto-selection (Auto Router). Factory's role policy
        // owns champion/challenger choice. OpenRouter may route the pinned
        // model among upstream providers; the actual provider is recorded
        // from the response as provenance.
      }),
      // Hard per-call timeout: the gateway never hangs a planning run.
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

  if (!response.ok) {
    let detail = rawBody.slice(0, 300);
    try {
      const parsedError = JSON.parse(rawBody) as OpenRouterChatResponse;
      if (parsedError.error && typeof parsedError.error.message === "string") {
        detail = parsedError.error.message.slice(0, 300);
      }
    } catch {
      // Keep raw slice.
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelCallError(
        "credentials_unavailable",
        `gateway rejected credentials (HTTP ${response.status}): ${scrubCredentials(detail, apiKey)}`,
        response.status,
      );
    }
    if (response.status === 408) {
      throw new ModelCallError("model_timeout", `gateway timeout (HTTP 408): ${scrubCredentials(detail, apiKey)}`, 408);
    }
    throw new ModelCallError(
      "model_failed",
      `gateway call failed (HTTP ${response.status}): ${scrubCredentials(detail, apiKey)}`,
      response.status,
    );
  }

  let parsed: OpenRouterChatResponse;
  try {
    parsed = JSON.parse(rawBody) as OpenRouterChatResponse;
  } catch {
    throw new ModelCallError("model_failed", "gateway returned a non-JSON response body");
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ModelCallError("model_failed", "gateway response contained no completion content");
  }

  return {
    requestedModel: request.model,
    respondedModel: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model.slice(0, 200) : null,
    provider: typeof parsed.provider === "string" && parsed.provider.length > 0 ? parsed.provider.slice(0, 100) : null,
    durationMs,
    promptTokens: boundedNumber(parsed.usage?.prompt_tokens),
    completionTokens: boundedNumber(parsed.usage?.completion_tokens),
    totalTokens: boundedNumber(parsed.usage?.total_tokens),
    costUsd: boundedNumber(parsed.usage?.cost),
    content,
  };
}

export interface OpenRouterModelSummary {
  id: string;
  name: string | null;
  contextLength: number | null;
  created: number | null;
  supportsStructuredOutputs: boolean;
  promptPriceUsdPerToken: number | null;
}

/**
 * Current model discovery (evaluation-time only; authoritative calls always
 * pin an exact id from policy). Fails closed without credentials.
 */
export async function listOpenRouterModels(deps: ModelGatewayDeps = {}): Promise<OpenRouterModelSummary[]> {
  const apiKey = (deps.loadApiKey ?? loadOpenRouterApiKey)();
  if (apiKey === null) {
    throw new ModelCallError(
      "credentials_unavailable",
      `${OPENROUTER_API_KEY_ENV} is not configured; the gateway fails closed without credentials`,
    );
  }
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(`${OPENROUTER_GATEWAY_BASE_URL}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new ModelCallError(
      "model_failed",
      scrubCredentials(error instanceof Error ? error.message : String(error), apiKey),
    );
  }
  if (!response.ok) {
    throw new ModelCallError(
      "model_failed",
      `gateway model listing failed (HTTP ${response.status})`,
      response.status,
    );
  }
  let parsed: { data?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(await response.text()) as { data?: Array<Record<string, unknown>> };
  } catch {
    throw new ModelCallError("model_failed", "gateway returned a non-JSON model listing");
  }
  const models = Array.isArray(parsed.data) ? parsed.data : [];
  return models.map((entry) => {
    const features = Array.isArray(entry.supported_features) ? entry.supported_features : [];
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const promptPrice = boundedNumber(pricing.prompt);
    return {
      id: typeof entry.id === "string" ? entry.id : "",
      name: typeof entry.name === "string" ? entry.name : null,
      contextLength: boundedNumber(entry.context_length),
      created: boundedNumber(entry.created),
      supportsStructuredOutputs: features.includes("structured_outputs"),
      promptPriceUsdPerToken: promptPrice,
    };
  });
}
