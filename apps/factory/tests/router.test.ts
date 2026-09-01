import assert from "node:assert/strict";
import test from "node:test";
import type { FailureClassification } from "@factory/contracts";
import { FactoryError } from "../src/executor/errors.js";
import {
  ESCALATABLE_FAILURE_CODES,
  TERMINAL_FAILURE_CODES,
  acceptanceRuntimeOverride,
  classifyTask,
  isEscalationEligible,
  runtimeFailureCodes,
  selectWorkerForAttempt,
} from "../src/executor/router.js";
import { CODE_WORKER_POLICY } from "../src/models/policy.js";

const bindings = {
  primary: {
    runtime: CODE_WORKER_POLICY.primary.runtime,
    model: CODE_WORKER_POLICY.primary.model,
    reasoningEffort: CODE_WORKER_POLICY.primary.reasoningEffort,
  },
  senior: {
    runtime: CODE_WORKER_POLICY.senior.runtime,
    model: CODE_WORKER_POLICY.senior.model,
    reasoningEffort: CODE_WORKER_POLICY.senior.reasoningEffort,
  },
};

test("routine create_page classifies as routine", () => {
  assert.equal(classifyTask({ type: "create_page" }), "routine");
});

test("attempt selection: routine 1 and 2 go to kimi, eligible attempt 3 escalates to claude", () => {
  for (const attemptNumber of [1, 2]) {
    const selection = selectWorkerForAttempt("routine", attemptNumber, undefined, bindings);
    assert.equal(selection.runtime, "kimi-code-cli");
    assert.equal(selection.tier, "primary");
    assert.equal(selection.escalation, false);
    assert.equal(selection.escalationReason, null);
    assert.equal(selection.requestedModel, "moonshotai/kimi-k3");
    assert.equal(selection.reasoningEffort, "max");
  }
  const escalated = selectWorkerForAttempt(
    "routine",
    3,
    { code: "qa_failed", classification: "repairable" },
    bindings,
  );
  assert.equal(escalated.runtime, "claude-code");
  assert.equal(escalated.tier, "senior");
  assert.equal(escalated.escalation, true);
  assert.ok(escalated.escalationReason);
  assert.equal(escalated.requestedModel, "anthropic/claude-opus-5");
});

test("senior_required routes to claude immediately at attempt 1 (no wasted kimi attempts)", () => {
  const selection = selectWorkerForAttempt("senior_required", 1, undefined, bindings);
  assert.equal(selection.runtime, "claude-code");
  assert.equal(selection.tier, "senior");
  assert.equal(selection.escalation, false);
});

test("attempt 3 without an eligible previous failure is a routing violation", () => {
  assert.throws(
    () => selectWorkerForAttempt("routine", 3, undefined, bindings),
    (err: unknown) => err instanceof FactoryError && err.code === "routing_violation",
  );
  assert.throws(
    () => selectWorkerForAttempt("routine", 3, { code: "scope_violation", classification: "non_repairable" }, bindings),
    (err: unknown) => err instanceof FactoryError && err.code === "routing_violation",
  );
});

test("security and infrastructure failures are NEVER escalation-eligible", () => {
  const terminalCodes = [
    "scope_violation",
    "integrity_violation",
    "strong_execution_isolation_unavailable",
    "invalid_task",
    "invalid_configuration",
    "dirty_working_tree",
    "repo_not_found",
    "head_unresolvable",
    "worktree_failed",
    "dependency_prepare_failed",
    "dependency_prepare_timeout",
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
  ];
  for (const code of terminalCodes) {
    assert.ok(TERMINAL_FAILURE_CODES.has(code), `${code} must be terminal`);
    assert.equal(isEscalationEligible(code, "non_repairable"), false, `${code} must never escalate`);
    // Even a repairable classification must not launder a terminal code.
    assert.equal(isEscalationEligible(code, "repairable"), false, `${code} stays terminal under any classification`);
  }
});

test("repairable, no_progress, and runtime failures ARE escalation-eligible", () => {
  assert.equal(isEscalationEligible("qa_failed", "repairable"), true);
  assert.equal(isEscalationEligible("verification_failed", "repairable"), true);
  assert.equal(isEscalationEligible("replay_failed", "repairable"), true);
  assert.equal(isEscalationEligible("no_progress", "no_progress"), true);
  for (const code of ESCALATABLE_FAILURE_CODES) {
    assert.equal(isEscalationEligible(code, "non_repairable"), true, `${code} eligible even when non-repairable`);
  }
  // Explicit runtime failure codes exist for both routed runtimes.
  for (const code of [
    "kimi_execution_failed",
    "kimi_timeout",
    "kimi_runtime_unavailable",
    "claude_execution_failed",
    "claude_timeout",
    "claude_runtime_unavailable",
  ]) {
    assert.ok(ESCALATABLE_FAILURE_CODES.has(code));
  }
});

test("legacy codex keeps its exact terminal codes", () => {
  assert.deepEqual(runtimeFailureCodes("codex-cli"), {
    timeout: "codex_timeout",
    executionFailed: "codex_failed",
  });
  assert.deepEqual(runtimeFailureCodes("kimi-code-cli"), {
    timeout: "kimi_timeout",
    executionFailed: "kimi_execution_failed",
  });
  assert.deepEqual(runtimeFailureCodes("claude-code"), {
    timeout: "claude_timeout",
    executionFailed: "claude_execution_failed",
  });
});

test("acceptance override: requires FACTORY_ACCEPTANCE_MODE=1, strict values, never from task data", () => {
  assert.equal(acceptanceRuntimeOverride({}), null);
  assert.equal(acceptanceRuntimeOverride({ FACTORY_ACCEPTANCE_RUNTIME: "claude-code" }), null, "ignored without mode");
  assert.equal(acceptanceRuntimeOverride({ FACTORY_ACCEPTANCE_MODE: "1", FACTORY_ACCEPTANCE_RUNTIME: "" }), null);
  const senior = acceptanceRuntimeOverride({ FACTORY_ACCEPTANCE_MODE: "1", FACTORY_ACCEPTANCE_RUNTIME: "claude-code" });
  assert.equal(senior?.runtime, "claude-code");
  assert.equal(senior?.tier, "senior");
  const primary = acceptanceRuntimeOverride({ FACTORY_ACCEPTANCE_MODE: "1", FACTORY_ACCEPTANCE_RUNTIME: "kimi-code-cli" });
  assert.equal(primary?.runtime, "kimi-code-cli");
  assert.equal(primary?.tier, "primary");
  assert.throws(
    () => acceptanceRuntimeOverride({ FACTORY_ACCEPTANCE_MODE: "1", FACTORY_ACCEPTANCE_RUNTIME: "openai/gpt-5.6-sol" }),
    (err: unknown) => err instanceof FactoryError && err.code === "invalid_configuration",
  );
});

test("no percentage quota exists in the routing policy surface", () => {
  // Routing decisions must be a pure function of class/attempt/failure —
  // there is no quota counter, distribution target, or budget in the API.
  const selection = selectWorkerForAttempt("routine", 1, undefined, bindings);
  assert.ok(!("quota" in selection));
  assert.ok(!("percentage" in selection));
  assert.ok(!("distribution" in selection));
});
