import { existsSync } from "node:fs";
import path from "node:path";
import { taskResultSchema } from "@factory/contracts";
import { runSiteTask } from "../src/executor/run.js";
import { createClaudeCodeRunner } from "../src/executor/claude.js";
import { resolveRepositoryRoot } from "../src/repo-root.js";
import { CODE_WORKER_POLICY } from "../src/models/policy.js";
import {
  ACCEPTANCE_TASK,
  assertAcceptancePrerequisites,
  assertCleanup,
  assertGate,
  scanArtifactsForSecrets,
} from "./acceptance-code-worker-common.js";

/**
 * REAL isolated Claude Code senior-runtime acceptance (Section 43).
 *
 * Uses the trusted acceptance-only override (FACTORY_ACCEPTANCE_RUNTIME,
 * Factory process env — never SiteTask content) to route the WHOLE run to
 * the senior runtime without waiting for a natural Kimi failure. Proves the
 * escalation runtime works end to end under the same boundary and oracle.
 *
 * Run: pnpm --filter @factory/factory exec tsx tests/acceptance-claude.ts
 */
async function main() {
  console.log("== REAL CLAUDE CODE SENIOR ACCEPTANCE ==");
  await assertAcceptancePrerequisites();
  const repoRoot = await resolveRepositoryRoot(process.cwd());
  const runId = `accept-claude-${Date.now()}`;

  process.env.FACTORY_ACCEPTANCE_RUNTIME = "claude-code";
  let result;
  try {
    result = await runSiteTask(ACCEPTANCE_TASK, {
      repoRoot,
      runId,
      workerRuntimes: { "claude-code": createClaudeCodeRunner({ repoRoot }) },
    });
  } finally {
    delete process.env.FACTORY_ACCEPTANCE_RUNTIME;
  }

  console.log(`runId: ${result.runId}`);
  assertGate(result, "TaskResult schema-valid", taskResultSchema.safeParse(result).success);
  assertGate(result, "status succeeded", result.status === "succeeded", `status=${result.status}`);
  assertGate(result, "senior runtime claude-code for ALL attempts", result.attempts!.every((a) => a.worker?.runtime === "claude-code"));
  assertGate(result, "worker tier senior", result.worker?.workerTier === "senior");
  assertGate(result, "requested model pinned", result.worker?.requestedModel === CODE_WORKER_POLICY.senior.model, `got ${result.worker?.requestedModel}`);
  assertGate(result, "exact write scope respected", (result.changes?.changedFiles ?? []).every((f) => f === "sites/starter/src/pages/private-office/approach.astro"), JSON.stringify(result.changes?.changedFiles));
  assertGate(result, "QA evidence present", result.qa?.passed === true);
  assertGate(result, "semantic verification present", result.taskVerification?.passed === true);
  assertGate(result, "replay present", result.replay?.passed === true);
  assertGate(result, "worktree removed", !existsSync(path.join(repoRoot, ".factory", "worktrees", result.runId)));
  await scanArtifactsForSecrets(repoRoot, result.artifacts.runDirectory);
  await assertCleanup(repoRoot, result.runId);
  console.log("== REAL CLAUDE SENIOR ACCEPTANCE: PASS ==");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
