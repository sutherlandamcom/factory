import type { ModelGateway } from "@factory/contracts";

/**
 * FACTORY MODEL POLICY V0 — operator-selected, version-controlled, fixed.
 *
 * This mapping is AUTHORITATIVE for Factory v0 / first-production-site MVP.
 * It is explicitly selected by the operator; model benchmarking, challenger
 * testing, and policy optimization are DEFERRED to a later optimization
 * phase and DO NOT gate production use. Nothing in this policy is
 * provisional, benchmark-selected, judge-selected, "newest in family",
 * cost-selected, latency-selected, or OpenRouter-auto-selected.
 *
 * Future changes require an explicit reviewed Factory change to this file.
 * Evaluation tooling (apps/factory/src/evals/) is OPTIONAL diagnostic /
 * optimization instrumentation: it may compare models and report quality,
 * cost, and latency, but it can never modify this policy, promote a
 * challenger, or block MVP acceptance.
 *
 * Distinction enforced here: MODEL ≠ GATEWAY/RUNTIME. OpenRouter-backed
 * planning roles resolve role → fixed model id → OpenRouter → actual
 * upstream provider (recorded as provenance). The coding worker is a
 * MODEL + CODING RUNTIME pair, not an OpenRouter model string.
 */

/** The authoritative version of this frozen policy. */
export const FACTORY_MODEL_POLICY_VERSION = "factory-model-policy-v0.1";

/**
 * The full intended Factory role set (machine-readable identifiers). All 11
 * assignments exist in policy; implementation status per role is recorded on
 * the policy entries — a fixed model assignment does NOT imply an
 * implemented pipeline.
 */
export const FACTORY_ROLE_IDS = [
  "bulk_research_extraction",
  "competitor_site_analysis",
  "site_intelligence",
  "blueprint_architect",
  "content_writer",
  "content_critic",
  "design_director",
  "visual_critic",
  "code_worker",
  "cheap_repair",
  "image_generator",
] as const;

export type FactoryRoleId = (typeof FACTORY_ROLE_IDS)[number];

/**
 * Roles whose authoritative execution path is the OpenRouter gateway. The
 * coding worker is intentionally NOT here: it is a model + coding-runtime
 * pair (see CODE_WORKER_POLICY), not an OpenRouter chat-completion role.
 */
export const MODEL_ROLE_IDS = [
  "bulk_research_extraction",
  "competitor_site_analysis",
  "site_intelligence",
  "blueprint_architect",
  "content_writer",
  "content_critic",
  "design_director",
  "visual_critic",
  "cheap_repair",
  "image_generator",
] as const;

export type ModelRoleId = (typeof MODEL_ROLE_IDS)[number];

export type ModelCapability = "structuredOutput" | "vision" | "longContext" | "toolUse";

/**
 * Sensitive-data classes a role may be asked to process. Sutherland operator
 * facts and research are proprietary and unpublished; only roles explicitly
 * permitted for `proprietary_unpublished` may receive them, and every actual
 * provider that received them is recorded in invocation provenance. This
 * gate is part of the accepted trust boundary and is not weakened by the
 * policy freeze.
 */
export type SensitiveDataPolicy = "public_only" | "proprietary_unpublished";

/** Whether the role has a production runner today. A model assignment does not imply an implemented pipeline. */
export type RoleImplementationStatus = "active" | "future";

export interface ModelRolePolicy {
  roleId: ModelRoleId;
  /** The operator-fixed authoritative model for this role. */
  championModel: string;
  /**
   * Explicit, ordered fallbacks (operator-configured; NOT bake-off-derived
   * and never a silent authority change — the actual model is always
   * recorded on every invocation).
   */
  challengerModels: readonly string[];
  gateway: ModelGateway;
  requiredCapabilities: readonly ModelCapability[];
  sensitiveDataPolicy: SensitiveDataPolicy;
  implementationStatus: RoleImplementationStatus;
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
 * FACTORY MODEL POLICY V0 — the frozen operator matrix.
 *
 * OpenRouter-backed roles. Every champion model id was verified against the
 * authenticated OpenRouter model listing on 2026-09-01. Production role
 * resolution returns EXACTLY the configured champion — no hidden
 * substitutions, no openrouter/auto, no `models` fallback arrays.
 *
 * Frozen assignments (operator architecture decision, Factory v0 MVP):
 * - bulk_research_extraction  → google/gemini-3.7-flash   (future)
 * - competitor_site_analysis  → openai/gpt-5.6-sol        (future)
 * - site_intelligence         → anthropic/claude-opus-5   (active; evaluation-only runner in v0)
 * - blueprint_architect       → anthropic/claude-opus-5   (active)
 * - content_writer            → anthropic/claude-opus-5   (active; evaluation-only runner in v0)
 * - content_critic            → openai/gpt-5.6-sol        (active; judging role)
 * - design_director           → anthropic/claude-opus-5   (active; evaluation-only runner in v0)
 * - visual_critic             → openai/gpt-5.6-sol        (future)
 * - cheap_repair              → z-ai/glm-5.3-flash        (future)
 * - image_generator           → openai/gpt-image-2        (future; dedicated provider path when implemented — NOT forced through chat completions)
 * - code_worker               → see CODE_WORKER_POLICY (a MODEL + CODING RUNTIME pair, not an
 *                               OpenRouter chat-completion role; both runtime bindings resolve
 *                               their models through the OpenRouter gateway since policy v0.1)
 */
export const MODEL_ROLE_POLICY: Readonly<Record<ModelRoleId, ModelRolePolicy>> = deepFreeze({
  bulk_research_extraction: {
    roleId: "bulk_research_extraction",
    championModel: "google/gemini-3.7-flash",
    challengerModels: [],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    implementationStatus: "future",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  competitor_site_analysis: {
    roleId: "competitor_site_analysis",
    championModel: "openai/gpt-5.6-sol",
    challengerModels: [],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    implementationStatus: "future",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  site_intelligence: {
    roleId: "site_intelligence",
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    // The accepted production Intelligence implementation remains the
    // isolated Codex pipeline; this role's OpenRouter runner is used by the
    // diagnostic eval harness only.
    implementationStatus: "active",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  blueprint_architect: {
    roleId: "blueprint_architect",
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol", "google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext", "structuredOutput"],
    sensitiveDataPolicy: "proprietary_unpublished",
    implementationStatus: "active",
    timeoutMs: PLANNING_TIMEOUT_MS,
    maxAttempts: 3,
  },
  content_writer: {
    roleId: "content_writer",
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    // Full content synthesis pipeline is a later bounded layer; the current
    // runner is the diagnostic eval harness section task.
    implementationStatus: "active",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  content_critic: {
    roleId: "content_critic",
    championModel: "openai/gpt-5.6-sol",
    challengerModels: ["google/gemini-3.7-flash"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    // Claim/factuality criticism — deliberately a different model from the
    // writer; the writer is never its own factuality authority.
    implementationStatus: "active",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  design_director: {
    roleId: "design_director",
    championModel: "anthropic/claude-opus-5",
    challengerModels: ["openai/gpt-5.6-sol"],
    gateway: "openrouter",
    requiredCapabilities: ["longContext"],
    sensitiveDataPolicy: "proprietary_unpublished",
    // Design GENERATION is intentionally a different model from the visual
    // CRITIC below.
    implementationStatus: "active",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  visual_critic: {
    roleId: "visual_critic",
    championModel: "openai/gpt-5.6-sol",
    challengerModels: [],
    gateway: "openrouter",
    requiredCapabilities: ["vision"],
    sensitiveDataPolicy: "proprietary_unpublished",
    implementationStatus: "future",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  cheap_repair: {
    roleId: "cheap_repair",
    championModel: "z-ai/glm-5.3-flash",
    challengerModels: [],
    gateway: "openrouter",
    requiredCapabilities: [],
    sensitiveDataPolicy: "proprietary_unpublished",
    // Bounded low-cost classification/schema-correction support ONLY —
    // never the authority for strategy, IA, high-value content, claim
    // approval, or design direction.
    implementationStatus: "future",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
  image_generator: {
    roleId: "image_generator",
    championModel: "openai/gpt-image-2",
    challengerModels: [],
    gateway: "openrouter",
    requiredCapabilities: ["vision"],
    sensitiveDataPolicy: "proprietary_unpublished",
    // Policy assignment only. Image generation is NOT implemented in v0 and
    // must use a dedicated provider/API path when built — not the chat
    // completion adapter.
    implementationStatus: "future",
    timeoutMs: BOUNDED_GENERATION_TIMEOUT_MS,
    maxAttempts: 2,
  },
});

/**
 * The coding worker is a MODEL + CODING RUNTIME pair — never one fake model
 * string.
 *
 * HISTORY / TRANSITION (factory-model-policy-v0 → v0.1):
 * - v0 targeted anthropic/claude-opus-5 via Claude Code while the ACCEPTED
 *   production runtime remained the isolated Codex CLI worker
 *   (migrationActivated: false).
 * - v0.1 implements the operator's Code Worker Routing v0 decision: the
 *   PRIMARY routine code worker is Kimi K3 (reasoning effort "max") through
 *   the Kimi Code CLI runtime; the SENIOR implementation, escalation, and
 *   review worker is Claude Opus 5 through the Claude Code runtime. Both
 *   resolve their models through the existing OpenRouter gateway, so MODEL,
 *   RUNTIME, and GATEWAY remain distinct provenance fields and one
 *   credential class (OPENROUTER_API_KEY) serves both runtimes.
 * - Routing is deterministic, Factory-owned, and risk-first: routine work
 *   defaults to the primary worker, senior/escalation work goes to the
 *   senior worker immediately, and percentages (expected ~70-85% primary /
 *   ~15-30% senior) are economic guidance only — NEVER a quota, and never
 *   encoded in routing logic. Untrusted SiteTask content cannot select a
 *   runtime, model, or reasoning effort.
 * - The legacy Codex CLI adapter is retained as an explicit rollback /
 *   reference path only; after activation it is NOT a normal routing
 *   fallback.
 * - `migrationActivated` flips to true ONLY after every acceptance gate of
 *   the code-worker migration passes (deterministic routing tests, real
 *   isolated Kimi acceptance, real isolated Claude acceptance, adversarial
 *   security acceptance, escalation-path tests, senior read-only review,
 *   full QA, PostgreSQL acceptance, exact-SHA CI, P0=0/P1=0).
 */
export type CodeWorkerRuntimeId = "codex-cli" | "kimi-code-cli" | "claude-code";
export type CodeWorkerTier = "primary" | "senior";
export type RoutingClass = "routine" | "senior_required" | "senior_review_required";
export type CodeWorkerGateway = "openrouter";

export interface CodeWorkerBinding {
  tier: CodeWorkerTier;
  /** Exact OpenRouter model id (never an alias, a `:batch` variant, or auto routing). */
  model: string;
  /** Configured reasoning effort, when the model supports it. */
  reasoningEffort: string | null;
  /** The coding agent runtime that executes the task. */
  runtime: CodeWorkerRuntimeId;
  /** The model gateway the runtime resolves its model through. */
  gateway: CodeWorkerGateway;
}

export const CODE_WORKER_POLICY = deepFreeze({
  roleId: "code_worker" as const,
  /** Distinguishes old (v0) and new (v0.1) code-worker semantics in provenance. */
  routingPolicyVersion: "code-worker-routing-v0",
  primary: deepFreeze({
    tier: "primary" as const,
    model: "moonshotai/kimi-k3",
    reasoningEffort: "max" as const,
    runtime: "kimi-code-cli" as const,
    gateway: "openrouter" as const,
  }) satisfies CodeWorkerBinding,
  senior: deepFreeze({
    tier: "senior" as const,
    model: "anthropic/claude-opus-5",
    reasoningEffort: null,
    runtime: "claude-code" as const,
    gateway: "openrouter" as const,
  }) satisfies CodeWorkerBinding,
  /** Legacy accepted runtime: rollback/reference only after activation. */
  legacyRuntime: "codex-cli" as const,
  currentlyActiveArchitecture: "code-worker-routing-v0" as const,
  migrationActivated: false,
});

export type CodeWorkerPolicy = typeof CODE_WORKER_POLICY;

/**
 * The currently accepted normal coding execution path. Before activation
 * this remains the legacy Codex worker; after activation the router is
 * authoritative and the primary worker binding is the normal execution
 * path.
 */
export function activeCodeWorkerRuntime(policy: CodeWorkerPolicy = CODE_WORKER_POLICY): CodeWorkerRuntimeId {
  return policy.migrationActivated ? policy.primary.runtime : policy.legacyRuntime;
}

/** Exact runtime binding for a tier (single source of truth for adapters). */
export function codeWorkerBinding(tier: CodeWorkerTier, policy: CodeWorkerPolicy = CODE_WORKER_POLICY): CodeWorkerBinding {
  return tier === "primary" ? policy.primary : policy.senior;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

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
