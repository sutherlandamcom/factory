import { FactoryError } from "../executor/errors.js";

/**
 * FACTORY MODEL PRICING POLICY V0 — trusted, version-controlled price ceilings.
 *
 * Used for conservative pre-invocation budget authorization (fail closed before spend).
 * Prices in USD per token, calibrated conservatively above standard catalog rates
 * to guarantee that actual invocation cost is strictly <= authorized reservation.
 */

export const FACTORY_MODEL_PRICING_POLICY_VERSION = "model-pricing-v0.3";

export interface ModelTokenPricing {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

/**
 * Authoritative conservative pricing rates per model.
 *
 * Current Gemini rates (Google / OpenRouter catalog):
 * - Gemini 3.7 Flash: introductory rate through Dec 31, 2026 is $0.75/1M prompt ($0.00000075/token)
 *   and $3.75/1M completion ($0.00000375/token); standard catalog rate is $1.50/1M prompt and $7.50/1M completion.
 *   Authoritative conservative rates are set to $1.50/1M prompt ($0.00000150) and $7.50/1M completion ($0.00000750),
 *   strictly >= actual possible provider charges under both promotional and standard terms.
 * - Gemini 2.5 Flash: catalog rate $0.30/1M prompt and $2.50/1M completion.
 *   Conservative rates: $0.50/1M prompt ($0.00000050) and $3.00/1M completion ($0.00000300).
 * - Gemini 2.0 Flash: catalog rate $0.10/1M prompt and $0.40/1M completion.
 *   Conservative rates: $0.20/1M prompt ($0.00000020) and $0.80/1M completion ($0.00000080).
 * - Gemini 1.5 Flash: catalog rate $0.075/1M prompt and $0.30/1M completion.
 *   Conservative rates: $0.20/1M prompt ($0.00000020) and $0.80/1M completion ($0.00000080).
 * - Fixtures: 0 USD.
 */
export const TRUSTED_MODEL_PRICING: Readonly<Record<string, ModelTokenPricing>> = {
  // Verified against the authenticated OpenRouter model catalog (2026-09-12):
  // anthropic/claude-opus-5 prompt $5/1M, completion $25/1M. Rates set at the
  // exact verified catalog values (verified, not estimated).
  "anthropic/claude-opus-5": {
    promptUsdPerToken: 0.000005,
    completionUsdPerToken: 0.000025,
  },
  // Verified against the authenticated OpenRouter model catalog (2026-09-12):
  // z-ai/glm-5.3-flash prompt $0.075/1M, completion $0.25/1M. Conservative
  // ceilings strictly above catalog rates.
  "z-ai/glm-5.3-flash": {
    promptUsdPerToken: 0.0000001,
    completionUsdPerToken: 0.0000003,
  },
  "google/gemini-3.7-flash": {
    promptUsdPerToken: 0.00000150, // $1.50 per million tokens (catalog: $0.75/1M intro, $1.50/1M standard)
    completionUsdPerToken: 0.00000750, // $7.50 per million tokens (catalog: $3.75/1M intro, $7.50/1M standard)
  },
  "google/gemini-2.5-flash": {
    promptUsdPerToken: 0.00000050, // $0.50 per million tokens (catalog: $0.30/1M)
    completionUsdPerToken: 0.00000300, // $3.00 per million tokens (catalog: $2.50/1M)
  },
  "google/gemini-2.0-flash-001": {
    promptUsdPerToken: 0.00000020,
    completionUsdPerToken: 0.00000080,
  },
  "google/gemini-1.5-flash": {
    promptUsdPerToken: 0.00000020,
    completionUsdPerToken: 0.00000080,
  },
  "fixture-competitor-analyst": {
    promptUsdPerToken: 0,
    completionUsdPerToken: 0,
  },
  "fixture-gap-analyst": {
    promptUsdPerToken: 0,
    completionUsdPerToken: 0,
  },
};

export function getModelPricing(model: string): ModelTokenPricing | null {
  return TRUSTED_MODEL_PRICING[model] ?? null;
}

/**
 * Compute actual cost in micros given actual prompt and completion tokens.
 * Returns null if model is unpriced (fail closed caller).
 */
export function calculateInvocationActualCostMicros(params: {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
}): number | null {
  if (params.provider === "fixture" || params.model.startsWith("fixture-")) {
    return 0;
  }
  const pricing = getModelPricing(params.model);
  if (!pricing) return null;
  const costUsd =
    params.promptTokens * pricing.promptUsdPerToken +
    params.completionTokens * pricing.completionUsdPerToken;
  return Math.max(1, Math.round(costUsd * 1_000_000));
}

export interface ConservativeInvocationCostParams {
  model: string;
  provider: string;
  systemPrompt?: string;
  userPrompt?: string;
  inputChars?: number;
  inputTokens?: number;
  maxOutputTokens?: number | null;
}

/**
 * Compute conservative upper bound cost in micros (millionths of USD) for an invocation.
 * Fails closed before provider execution if model is unknown, provider is paid and unpriceable,
 * or maxOutputTokens is unbounded.
 *
 * Hard invariant:
 *   authorized worst-case cost >= actual possible provider charge for that exact bounded invocation.
 */
export function calculateConservativeInvocationCostMicros(params: ConservativeInvocationCostParams): number {
  // Fixture provider never incurs external cost.
  if (params.provider === "fixture" || (typeof params.model === "string" && params.model.startsWith("fixture-"))) {
    return 0;
  }

  // Explicit bounded maxOutputTokens is strictly required for a hard ceiling.
  if (
    typeof params.maxOutputTokens !== "number" ||
    !Number.isFinite(params.maxOutputTokens) ||
    params.maxOutputTokens <= 0
  ) {
    throw new FactoryError(
      "competitor_analyst_not_configured",
      `Model call requires an explicit bounded maxOutputTokens to prove budget ceiling (got ${params.maxOutputTokens}).`,
    );
  }

  const pricing = getModelPricing(params.model);
  if (!pricing) {
    throw new FactoryError(
      "competitor_analyst_not_configured",
      `No trusted pricing configuration found for model "${params.model}". Paid execution fails closed.`,
    );
  }

  // Conservative input token estimation:
  // In subword tokenizers (BPE, SentencePiece), every token contains at least 1 byte.
  // When systemPrompt / userPrompt are provided, calculate UTF-8 byte length + framing overhead + 1.25 safety factor.
  let estimatedInputTokens: number;
  if (params.inputTokens != null && Number.isFinite(params.inputTokens) && params.inputTokens > 0) {
    estimatedInputTokens = Math.ceil(params.inputTokens);
  } else if (params.systemPrompt !== undefined || params.userPrompt !== undefined) {
    const fullText = (params.systemPrompt ?? "") + "\n" + (params.userPrompt ?? "");
    const utf8Bytes = Buffer.byteLength(fullText, "utf8");
    // 256 bytes framing overhead for chat roles/delimiters + 1.25 safety factor guarantees >= actual tokens.
    estimatedInputTokens = Math.max(1, Math.ceil((utf8Bytes + 256) * 1.25));
  } else if (typeof params.inputChars === "number" && Number.isFinite(params.inputChars) && params.inputChars > 0) {
    estimatedInputTokens = Math.max(1, Math.ceil(params.inputChars * 1.25));
  } else {
    throw new FactoryError(
      "competitor_analyst_not_configured",
      "Model call requires exact compiled prompt or input size to prove budget ceiling.",
    );
  }

  const maxOutputTokens = params.maxOutputTokens;
  const maxCostUsd =
    estimatedInputTokens * pricing.promptUsdPerToken +
    maxOutputTokens * pricing.completionUsdPerToken;

  // Convert to micros, rounding up.
  return Math.max(1, Math.ceil(maxCostUsd * 1_000_000));
}
