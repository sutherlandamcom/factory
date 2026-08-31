import type { ModelGateway } from "@factory/contracts";

/**
 * Factory ModelRolePolicy — role selection is Factory IP; the gateway is
 * only transport.
 *
 * Factory owns: role definitions, rubrics, accepted champion/challenger
 * models, quality thresholds, provenance, contracts, validators, invocation
 * records, cost/latency observations, fallback policy, and the sensitive-data
 * policy. OpenRouter provides unified transport ONLY — it must never decide
 * the semantic Factory role through opaque auto-routing (no Auto Router, no
 * `models` fallback arrays, no `route: "fallback"` for authoritative calls).
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
 * `PROVISIONAL (pre-bake-off)` entries name sensible current-family models
 * for development and tests; they are replaced by bake-off evidence in the
 * same change before the real acceptance run. Every entry names exact model
 * ids — never provider aliases, never "auto".
 */
export const MODEL_ROLE_POLICY: Readonly<Record<ModelRoleId, ModelRolePolicy>> = Object.freeze({
  site_intelligence: {
    roleId: "site_intelligence",
    // PROVISIONAL (pre-bake-off) — evaluation-only role in Autonomy v0; the
    // accepted production Intelligence implementation remains Codex-based.
    championModel: "openai/gpt-5.2",
    challengerModels: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  blueprint_architect: {
    roleId: "blueprint_architect",
    // PROVISIONAL (pre-bake-off) — replaced by bake-off evidence before the
    // real Sutherland acceptance run (same PR, evidence cited).
    championModel: "anthropic/claude-sonnet-4.5",
    challengerModels: ["openai/gpt-5.2", "google/gemini-2.5-pro"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  content_writer: {
    roleId: "content_writer",
    // PROVISIONAL (pre-bake-off) — evaluation-only role in Autonomy v0.
    championModel: "anthropic/claude-sonnet-4.5",
    challengerModels: ["openai/gpt-5.2"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  content_critic: {
    roleId: "content_critic",
    championModel: "openai/gpt-5.2",
    challengerModels: ["google/gemini-2.5-pro"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  design_director: {
    roleId: "design_director",
    // PROVISIONAL (pre-bake-off) — evaluation-only role in Autonomy v0.
    championModel: "google/gemini-2.5-pro",
    challengerModels: ["anthropic/claude-sonnet-4.5"],
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
