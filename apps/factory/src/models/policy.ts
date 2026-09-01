import type { ModelGateway } from "@factory/contracts";

/**
 * Factory ModelRolePolicy — role selection is Factory IP; the gateway is
 * only transport.
 *
 * Factory owns: role definitions, rubrics, accepted champion/challenger
 * models, quality thresholds, provenance, contracts, validators, invocation
 * records, cost/latency observations, fallback policy, and the sensitive-data
 * policy. OpenRouter provides unified transport ONLY — it must never decide
 * the semantic Factory role through opaque model-identity auto-selection
 * (no Auto Router, no `models` fallback arrays, no `route: "fallback"` for
 * authoritative calls). Factory pins exact MODEL identity; OpenRouter may
 * route that model among upstream providers, and the actual provider remains
 * recorded provenance on every invocation.
 *
 * Champion selection evidence lives in gitignored eval artifacts
 * (.factory/evals/autonomy-v0/<runId>/) and is summarized in
 * docs/handoffs/autonomy-v0-build-report.md. Champion entries below cite the
 * eval run that selected them.
 */

export const MODEL_ROLE_IDS = [
  "site_intelligence",
  "blueprint_architect",
  "content_writer",
  "content_critic",
  "design_director",
] as const;

export type ModelRoleId = (typeof MODEL_ROLE_IDS)[number];

export type ModelCapability = "structuredOutput" | "vision" | "longContext" | "toolUse";

/**
 * Sensitive-data classes a role may be asked to process. Sutherland operator
 * facts and research are proprietary and unpublished; only roles explicitly
 * permitted for `proprietary_unpublished` may receive them, and every actual
 * provider that received them is recorded in invocation provenance.
 */
export type SensitiveDataPolicy =
  | "public_only"
  | "proprietary_unpublished";

export interface ModelRolePolicy {
  roleId: ModelRoleId;
  championModel: string;
  /** Explicit, ordered fallbacks. Champion failure may ONLY use these. */
  challengerModels: readonly string[];
  gateway: ModelGateway;
  requiredCapabilities: readonly ModelCapability[];
  sensitiveDataPolicy: SensitiveDataPolicy;
  timeoutMs: number;
  /** Bounded attempt ceiling (never more than 3 for planning roles). */
  maxAttempts: 1 | 2 | 3;
}

/**
 * Per-call timeout for planning roles. Long structured synthesis gets a
 * generous but bounded ceiling (mirrors the bounded-repair philosophy).
 */
const PLANNING_TIMEOUT_MS = 600_000;
/** Shorter ceiling for small bounded generation (sections, design direction, judging). */
const BOUNDED_GENERATION_TIMEOUT_MS = 300_000;

/**
 * Authoritative role policy for Autonomy v0.
 *
 * CHAMPION PROVENANCE (2026-09-01): champions below are OPERATOR-DESIGNATED
 * from the operator's own multi-model test results for Sutherland-class work
 * ("bulk research extraction — Gemini 3.7 Flash; competitor/site analysis —
 * GPT-5.6 Sol; site intelligence / SEO strategy — Claude Opus 5; site
 * blueprint / IA — Claude Opus 5; content writer — Claude Opus 5; claim /
 * factuality critic — GPT-5.6 Sol; design director — Claude Opus 5; visual
 * screenshot critic — GPT-5.6 Sol; coding worker — Claude Opus 5 + Claude
 * Code; cheap classification/repair — GLM-5.3-Flash; image generation —
 * GPT-Image-2"). The Factory bake-off harness (`pnpm factory eval run`) is
 * the mechanism that must CONFIRM or CHALLENGE these designations once real
 * gateway credentials are configured; this policy is then updated with
 * recorded eval-run evidence.
 *
 * MODEL ID CAVEAT: the operator designation names model FAMILIES ("Claude
 * Opus 5", "GPT-5.6 Sol", "Gemini 3.7 Flash"). The ids below are the
 * corresponding explicit OpenRouter-style ids; they MUST be verified against
 * `GET /api/v1/models` (current availability) before any authoritative call,
 * and corrected there if the gateway resolves them differently. Exact ids —
 * never aliases, never "auto".
 *
 * Future operator designations recorded for later phases (NOT implemented
 * roles in v0): bulk research extraction → google/gemini-3.7-flash;
 * competitor/site analysis → openai/gpt-5.6-sol; visual screenshot critic →
 * openai/gpt-5.6-sol; cheap classification/repair → z-ai/glm-5.3-flash;
 * image generation → openai/gpt-image-2. The accepted code-worker boundary
 * remains the isolated Codex CLI worker; a future "Claude Opus 5 + Claude
 * Code" code worker is a separate acceptance decision, not a policy flip.
 */
export const MODEL_ROLE_POLICY: Readonly<Record<ModelRoleId, ModelRolePolicy>> = Object.freeze({
  site_intelligence: {
    roleId: "site_intelligence",
    // Operator-designated champion (site intelligence / SEO strategy).
    // Evaluation-only role in Autonomy v0; the accepted production
    // Intelligence implementation remains Codex-based until a migration is
    // separately accepted.
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  blueprint_architect: {
    roleId: "blueprint_architect",
    // Operator-designated champion (site blueprint / IA).
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  content_writer: {
    roleId: "content_writer",
    // Operator-designated champion (content writer). Evaluation-only role
    // in Autonomy v0.
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  content_critic: {
    roleId: "content_critic",
    // Operator-designated champion (claim / factuality critic).
    championModel: "openai/gpt-5.6-sol",
    challengerModels: ["google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  design_director: {
    roleId: "design_director",
    // Operator-designated champion (design director). Evaluation-only role
    // in Autonomy v0.
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
});

/** Fallback resolution: champion first, then explicit challengers in order. */
export function resolveModelSequence(policy: ModelRolePolicy): readonly string[] {
  if (!policy.championModel || policy.challengerModels.includes(policy.championModel)) {
    throw new Error(`role ${policy.roleId}: challenger list must not contain the champion model`);
  }
  const seen = new Set<string>([policy.championModel]);
  for (const challenger of policy.challengerModels) {
    if (seen.has(challenger)) {
      throw new Error(`role ${policy.roleId}: duplicate model in fallback sequence: ${challenger}`);
    }
    seen.add(challenger);
  }
  return [policy.championModel, ...policy.challengerModels];
}

/** Whether a role may receive proprietary, unpublished operator material. */
export function mayReceiveProprietaryData(policy: ModelRolePolicy): boolean {
  return policy.sensitiveDataPolicy === "proprietary_unpublished";
}
