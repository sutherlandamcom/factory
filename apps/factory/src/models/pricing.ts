import { FactoryError } from "../executor/errors.js";

/**
 * FACTORY MODEL PRICING POLICY V0 — trusted, version-controlled price ceilings.
 *
 * Used for conservative pre-invocation budget authorization (fail closed before spend).
 * Prices in USD per token, calibrated conservatively above standard catalog rates
 * to guarantee that actual invocation cost is strictly <= authorized reservation.
 */

export const FACTORY_MODEL_PRICING_POLICY_VERSION = "model-pricing-v0.1";

export interface ModelTokenPricing {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

/**
 * Authoritative conservative pricing rates per model.
 * Gemini 3.7 Flash public rates are ~$0.15/1M input and ~$0.60/1M output.
 * We calibrate conservative upper bounds: $0.25/1M input ($0.00000025) and $1.00/1M output ($0.00000100).
 */
export const TRUSTED_MODEL_PRICING: Readonly<Record<string, ModelTokenPricing>> = {
  "google/gemini-3.7-flash": {
    promptUsdPerToken: 0.00000025, // $0.25 per million tokens (catalog: $0.15/1M)
    completionUsdPerToken: 0.00000100, // $1.00 per million tokens (catalog: $0.60/1M)
  },
  "google/gemini-2.5-flash": {
    promptUsdPerToken: 0.00000025,
    completionUsdPerToken: 0.00000100,
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

/**
 * Compute conservative upper bound cost in micros (millionths of USD) for an invocation.
 * Fails closed before provider execution if model is unknown, provider is paid and unpriceable,
 * or maxOutputTokens is unbounded.
 */
export function calculateConservativeInvocationCostMicros(params: {
  model: string;
  provider: string;
  inputChars: number;
  maxOutputTokens?: number | null;
}): number {
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

  // Conservative input token estimate: 1 char = 1 token (real text is 3-4 chars per token).
  // This mathematically guarantees inputTokens <= estimatedInputTokens.
  const estimatedInputTokens = Math.max(1, params.inputChars);
  const maxOutputTokens = params.maxOutputTokens;

  const maxCostUsd =
    estimatedInputTokens * pricing.promptUsdPerToken +
    maxOutputTokens * pricing.completionUsdPerToken;

  // Convert to micros, rounding up.
  return Math.max(1, Math.ceil(maxCostUsd * 1_000_000));
}
