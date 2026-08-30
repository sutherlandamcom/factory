import type { FailureClassification, TaskStage } from "@factory/contracts";

export const MAX_FAILURE_EXCERPT_CHARS = 8192; // 8 KB

export interface FailureReport {
  runId?: string;
  attemptNumber: number;
  failingStage: TaskStage;
  failureCode: string;
  summary: string;
  excerpt: string;
  failingAssertions?: string[];
  targetSlug: string;
  changedFiles?: string[];
  authorizedScope?: string;
}

/** Strip ANSI color codes from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "");
}

/** Redact sensitive database passwords and credentials from log excerpts. */
export function scrubSecrets(text: string): string {
  return text.replace(
    /((?:postgres|postgresql):\/\/[^:]+:)([^@]+)(@)/gi,
    "$1***$3",
  );
}

/** Sanitize and truncate raw log text into a compact excerpt (max 8KB). */
export function sanitizeExcerpt(raw: string, maxChars: number = MAX_FAILURE_EXCERPT_CHARS): string {
  const clean = scrubSecrets(stripAnsi(raw)).trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  // Take the most relevant tail portion where errors and test summaries usually appear
  const tail = clean.slice(clean.length - maxChars);
  return `... [truncated — full logs preserved in attempt artifacts] ...\n${tail}`;
}

/** Extract key Playwright / Astro test failure lines. */
export function extractFailingAssertions(stdout: string, stderr: string): string[] {
  const combined = stripAnsi(`${stdout}\n${stderr}`);
  const lines = combined.split("\n");
  const failures: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Error:") ||
      trimmed.startsWith("expect(") ||
      (trimmed.includes("›") && trimmed.includes("failed")) ||
      trimmed.includes("error:") ||
      (trimmed.includes("[check]") && trimmed.includes("error")) ||
      (trimmed.includes("[build]") && trimmed.includes("error"))
    ) {
      if (!failures.includes(trimmed) && failures.length < 10) {
        failures.push(trimmed);
      }
    }
  }

  return failures;
}

/**
 * Deterministically classify a failure as repairable or non-repairable.
 *
 * REPAIRABLE:
 * - Stage `qa` (exit code != 0, e.g. Astro typecheck/build error, Playwright assertion failure)
 * - Stage `verify` (route missing, title missing, canonical incorrect)
 *
 * NON-REPAIRABLE (stop immediately, never retry):
 * - Stage `validation` (`invalid_task`)
 * - Stage `preflight` (`dirty_working_tree`, `repo_not_found`, `head_unresolvable`)
 * - Stage `worktree` (`worktree_failed`)
 * - Stage `dependencies` (`dependency_prepare_failed`, `dependency_prepare_timeout`)
 * - Stage `scope` (`scope_violation`, `git_command_failed`)
 * - Any timeout (`codex_timeout`, `qa_timeout`)
 * - Codex exit != 0 or environment failure (`codex_failed`, `codex_environment_failed`)
 * - Cleanup failure (`cleanup_failed`)
 */
export function classifyFailure(
  stage: TaskStage,
  errorCode: string,
): FailureClassification {
  if (errorCode === "scope_violation") {
    return "non_repairable";
  }

  if (
    errorCode === "invalid_task" ||
    errorCode === "invalid_configuration" ||
    errorCode === "dirty_working_tree" ||
    errorCode === "repo_not_found" ||
    errorCode === "head_unresolvable" ||
    errorCode === "worktree_failed" ||
    errorCode === "dependency_prepare_failed" ||
    errorCode === "dependency_prepare_timeout" ||
    errorCode === "strong_execution_isolation_unavailable" ||
    errorCode === "codex_environment_failed" ||
    errorCode === "codex_failed" ||
    errorCode === "codex_timeout" ||
    errorCode === "qa_timeout" ||
    errorCode === "cleanup_failed" ||
    errorCode === "integrity_violation" ||
    errorCode === "git_evidence_invalid" ||
    errorCode === "internal_error"
  ) {
    return "non_repairable";
  }

  if (stage === "qa" && errorCode === "qa_failed") {
    return "repairable";
  }

  if (stage === "verify" && errorCode === "verification_failed") {
    return "repairable";
  }

  if (stage === "replay" && errorCode === "replay_failed") {
    return "repairable";
  }

  return "non_repairable";
}

/** Build a structured, bounded failure report to feed into the repair prompt. */
export function buildFailureReport(params: {
  runId?: string;
  attemptNumber: number;
  failingStage: TaskStage;
  failureCode: string;
  message: string;
  stdout?: string;
  stderr?: string;
  targetSlug: string;
  changedFiles?: string[];
  authorizedScope?: string;
}): FailureReport {
  const combinedLog = `${params.stdout ?? ""}\n${params.stderr ?? ""}`.trim();
  const excerpt = combinedLog.length > 0 ? sanitizeExcerpt(combinedLog) : scrubSecrets(params.message);
  const failingAssertions = extractFailingAssertions(params.stdout ?? "", params.stderr ?? "");

  return {
    runId: params.runId,
    attemptNumber: params.attemptNumber,
    failingStage: params.failingStage,
    failureCode: params.failureCode,
    summary: scrubSecrets(params.message),
    excerpt,
    failingAssertions: failingAssertions.length > 0 ? failingAssertions : undefined,
    targetSlug: params.targetSlug,
    changedFiles: params.changedFiles,
    authorizedScope: params.authorizedScope,
  };
}
