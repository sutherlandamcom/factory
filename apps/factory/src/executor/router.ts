import type { FailureClassification, SiteTask } from "@factory/contracts";
import { FactoryError } from "./errors.js";
import type { CodeWorkerRuntimeId, CodeWorkerTier, RoutingClass } from "../models/policy.js";

/**
 * FACTORY CODE-WORKER ROUTER (code-worker-routing-v0).
 *
 * Deterministic, trusted, Factory-owned worker selection. Routing NEVER
 * consults an LLM, a percentage quota, or any SiteTask field: the untrusted
 * task payload cannot select a runtime, model, or reasoning effort. The
 * expected ~70–85% primary / ~15–30% senior operational distribution is an
 * economic consequence of these semantics — risk routing always overrides
 * any percentage target.
 *
 * Routing classes:
 * - `routine`                 → primary worker (Kimi K3) attempts 1–2, senior escalation on attempt 3 when eligible.
 * - `senior_required`         → senior worker (Claude Opus 5) from attempt 1 (critical/high-risk work).
 * - `senior_review_required`  → primary implementation with an ADDITIONAL senior read-only review
 *                               (handled outside the attempt loop by executor/review.ts; selection here
 *                               matches routine so implementation still starts on the primary worker).
 */

/**
 * Failure codes eligible for escalation to the senior runtime. Everything
 * else escalates only when its failure classification is `repairable` or
 * `no_progress`. Terminal security and infrastructure failures are NEVER
 * eligible (a violation must be reported, never laundered through another
 * runtime).
 *
 * Runtime/model failures and bounded runtime timeouts ARE eligible
 * (Factory Model Policy: "model/runtime failure; bounded timeout").
 * Credential/configuration errors are NOT: they are Factory configuration
 * defects, not worker failures. `qa_timeout` stays terminal (the QA oracle
 * timing out is a Factory-side condition, not a worker defect). Legacy
 * `codex_failed` / `codex_timeout` stay terminal: the legacy Codex path
 * keeps its accepted semantics and is rollback/reference only.
 */
export const ESCALATABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "kimi_execution_failed",
  "kimi_timeout",
  "kimi_runtime_unavailable",
  "claude_execution_failed",
  "claude_timeout",
  "claude_runtime_unavailable",
]);

/**
 * Explicit failure-code mapping per runtime. The legacy Codex path keeps its
 * accepted codes AND its terminal semantics (`codex_failed`/`codex_timeout`
 * never escalate); the routed runtimes get precise new codes.
 */
export function runtimeFailureCodes(runtime: "codex-cli" | "kimi-code-cli" | "claude-code"): {
  timeout: string;
  executionFailed: string;
} {
  switch (runtime) {
    case "codex-cli":
      return { timeout: "codex_timeout", executionFailed: "codex_failed" };
    case "kimi-code-cli":
      return { timeout: "kimi_timeout", executionFailed: "kimi_execution_failed" };
    case "claude-code":
      return { timeout: "claude_timeout", executionFailed: "claude_execution_failed" };
  }
}

/** Terminal failure codes that must stop the run with zero further worker invocations. */
export const TERMINAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_task",
  "invalid_configuration",
  "dirty_working_tree",
  "repo_not_found",
  "head_unresolvable",
  "worktree_failed",
  "dependency_prepare_failed",
  "dependency_prepare_timeout",
  "strong_execution_isolation_unavailable",
  "scope_violation",
  "integrity_violation",
  "git_evidence_invalid",
  "internal_error",
  "cleanup_failed",
  "qa_timeout",
  "kimi_credentials_unavailable",
  "claude_credentials_unavailable",
  "codex_failed",
  "codex_timeout",
  "codex_environment_failed",
  "routing_violation",
]);

/**
 * Deterministically classify a validated SiteTask into a routing class.
 *
 * SiteTask v0 supports exactly one task type: bounded `create_page`, whose
 * exact-write policy already restricts it to a single page. It is therefore
 * `routine`. Future task types extend this switch explicitly — no generic
 * workflow DSL, no untrusted classification hints.
 */
export function classifyTask(task: Pick<SiteTask, "type">): RoutingClass {
  switch (task.type) {
    case "create_page":
      return "routine";
  }
}

/**
 * Whether a failed attempt may be followed by another attempt (repair on
 * the primary worker, or escalation to the senior worker).
 */
export function isEscalationEligible(errorCode: string, classification: FailureClassification): boolean {
  if (TERMINAL_FAILURE_CODES.has(errorCode)) return false;
  if (ESCALATABLE_FAILURE_CODES.has(errorCode)) return true;
  return classification === "repairable" || classification === "no_progress";
}

export interface WorkerSelection {
  runtime: CodeWorkerRuntimeId;
  tier: CodeWorkerTier;
  requestedModel: string | null;
  reasoningEffort: string | null;
  escalation: boolean;
  escalationReason: string | null;
}

export interface PreviousFailure {
  code: string;
  classification: FailureClassification;
}

/**
 * Select the worker for one attempt of a routed task.
 *
 * Routine semantics (Factory Model Policy v0.1, operator decision):
 * - Attempt 1: primary worker, initial implementation.
 * - Attempt 2: primary worker, repair.
 * - Attempt 3: senior worker escalation — ONLY when the attempt-2 failure
 *   is escalation-eligible (the attempt loop breaks earlier otherwise).
 *
 * `senior_required` starts on the senior worker at attempt 1 — critical
 * work never wastes primary attempts to satisfy a distribution target.
 */
export function selectWorkerForAttempt(
  routingClass: RoutingClass,
  attemptNumber: number,
  previousFailure: PreviousFailure | undefined,
  bindings: {
    primary: { runtime: CodeWorkerRuntimeId; model: string; reasoningEffort: string | null };
    senior: { runtime: CodeWorkerRuntimeId; model: string; reasoningEffort: string | null };
  },
): WorkerSelection {
  if (routingClass === "senior_required") {
    return {
      runtime: bindings.senior.runtime,
      tier: "senior",
      requestedModel: bindings.senior.model,
      reasoningEffort: bindings.senior.reasoningEffort,
      escalation: false,
      escalationReason: null,
    };
  }

  if (attemptNumber <= 2) {
    return {
      runtime: bindings.primary.runtime,
      tier: "primary",
      requestedModel: bindings.primary.model,
      reasoningEffort: bindings.primary.reasoningEffort,
      escalation: false,
      escalationReason: null,
    };
  }

  if (!previousFailure) {
    throw new FactoryError(
      "routing_violation",
      `attempt 3 cannot be selected without a recorded previous failure (routing class ${routingClass})`,
    );
  }
  if (!isEscalationEligible(previousFailure.code, previousFailure.classification)) {
    throw new FactoryError(
      "routing_violation",
      `attempt 3 escalation is not eligible after terminal failure ${previousFailure.code}`,
    );
  }
  return {
    runtime: bindings.senior.runtime,
    tier: "senior",
    requestedModel: bindings.senior.model,
    reasoningEffort: bindings.senior.reasoningEffort,
    escalation: true,
    escalationReason: `primary worker (${bindings.primary.runtime}) failed ${previousFailure.code} after ${previousFailure.classification} attempt 2; escalating to senior runtime`,
  };
}

/**
 * Acceptance-only runtime override (trusted Factory process configuration —
 * the same trust class as FACTORY_MAX_ATTEMPTS). This is how the REAL
 * isolated senior-runtime acceptance selects Claude Code without waiting
 * for a natural Kimi failure. It is read exclusively from the executor's
 * own process environment; SiteTask content can never set it.
 *
 * Ordinary production execution must NOT accidentally honor a leftover
 * acceptance variable: requires BOTH FACTORY_ACCEPTANCE_MODE=1 and
 * FACTORY_ACCEPTANCE_RUNTIME to be configured.
 *
 * Returns null when no override is configured.
 */
export function acceptanceRuntimeOverride(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSelection | null {
  if (env.FACTORY_ACCEPTANCE_MODE !== "1") return null;
  const raw = env.FACTORY_ACCEPTANCE_RUNTIME;
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  if (value !== "kimi-code-cli" && value !== "claude-code") {
    throw new FactoryError(
      "invalid_configuration",
      `FACTORY_ACCEPTANCE_RUNTIME must be "kimi-code-cli" or "claude-code" (got "${value.slice(0, 40)}")`,
    );
  }
  return {
    runtime: value,
    tier: value === "claude-code" ? "senior" : "primary",
    requestedModel: null, // resolved by the acceptance caller from policy bindings
    reasoningEffort: null,
    escalation: false,
    escalationReason: "acceptance_override",
  };
}
