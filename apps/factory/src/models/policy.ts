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
 * CHAMPION PROVENANCE (2026-09-01, FINAL):
 *
 * site_intelligence and blueprint_architect are FACTORY-EVAL-CONFIRMED by
 * real multi-model bake-offs on the real Sutherland inputs (Intelligence run
 * 20260831T224728Z-32ddb4c4; pinned candidates openai/gpt-5.6-sol,
 * anthropic/claude-opus-5, google/gemini-3.7-flash; identical prompts,
 * schema, and deterministic gates; blind two-judge rubric):
 *
 * - site_intelligence eval-20260901T104549Z-12c450c6 + final
 *   eval-20260901T110515Z-b8d52c71: gpt-5.6-sol passed the deterministic
 *   gates in BOTH runs, ranked first by every functioning judge
 *   (5.00 avg vs 4.80/4.40 claude-opus-5, 2.40/3.20 gemini-3.7-flash;
 *   2/2 judge preference votes in the final run), at the lowest cost and
 *   latency. claude-opus-5 failed the production parse in the final run
 *   (markdown-fenced output — zero-salvage contract).
 * - blueprint_architect eval-20260901T105050Z-f4e79061 + final
 *   eval-20260901T111010Z-c12b0864: gpt-5.6-sol was the ONLY candidate
 *   producing a deterministic-valid SiteBlueprint in BOTH runs (IA
 *   preserved, provenance, readiness, chart policy, links all enforced).
 *   claude-opus-5 failed transport/limits both runs (300s harness artifact
 *   in run 1 — harness fixed to role-policy timeout; 32k-token completion
 *   truncation in run 2 — the production envelope). gemini-3.7-flash was
 *   schema-invalid in run 1 and valid in run 2.
 *
 * The remaining roles (content_writer, content_critic, design_director)
 * are OPERATOR-DESIGNATED from the operator's own multi-model test results
 * (2026-09-01: "content writer — Claude Opus 5; claim / factuality critic —
 * GPT-5.6 Sol; design director — Claude Opus 5"); no Factory bake-off has
 * run for them yet. Future designations recorded for later phases (NOT
 * implemented roles in v0): bulk research extraction →
 * google/gemini-3.7-flash; competitor/site analysis → openai/gpt-5.6-sol;
 * visual screenshot critic → openai/gpt-5.6-sol; cheap classification/
 * repair → z-ai/glm-5.3-flash; image generation → openai/gpt-image-2.
 * The accepted code-worker boundary remains the isolated Codex CLI worker.
 *
 * MODEL ID CAVEAT: all champion/challenger ids below were verified against
 * the authenticated OpenRouter model listing on 2026-09-01 (all AVAILABLE).
 * Exact ids — never aliases, never "auto".
 */
export const MODEL_ROLE_POLICY: Readonly<Record<ModelRoleId, ModelRolePolicy>> = Object.freeze({
  site_intelligence: {
    roleId: "site_intelligence",
    // FACTORY-EVAL-CONFIRMED champion (see header provenance): only
    // candidate passing the accepted production gates in both bake-off
    // runs; unanimous judge preference; lowest cost and latency.
    // Evaluation-only role in Autonomy v0; the accepted production
    // Intelligence implementation remains Codex-based until a migration is
    // separately accepted.
    championModel: "openai/gpt-5.6-sol",
    challengerModels: ["anthropic/claude-opus-5", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  blueprint_architect: {
    roleId: "blueprint_architect",
    // FACTORY-EVAL-CONFIRMED champion (see header provenance): the only
    // candidate producing a deterministic-valid SiteBlueprint in both
    // bake-off runs under identical inputs, schema, and gates. Also the
    // most token-efficient: fits the production completion envelope with
    // wide margin.
    championModel: "openai/gpt-5.6-sol",
    challengerModels: ["anthropic/claude-opus-5", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  content_writer: {
    roleId: "content_writer",
    // OPERATOR-DESIGNATED champion (content writer) — no Factory bake-off
    // yet. Evaluation-only role in Autonomy v0.
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
    // OPERATOR-DESIGNATED champion (claim / factuality critic).
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
    // OPERATOR-DESIGNATED champion (design director) — no Factory bake-off
    // yet. Evaluation-only role in Autonomy v0.
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
