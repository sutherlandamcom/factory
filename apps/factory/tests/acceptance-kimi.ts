import { existsSync } from "node:fs";
import path from "node:path";
import { taskResultSchema } from "@factory/contracts";
import { runSiteTask } from "../src/executor/run.js";
import { createKimiCodeRunner } from "../src/executor/kimi.js";
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
 * REAL isolated Kimi Code acceptance (Factory Code Worker Routing v0).
 *
 * Runs one neutral synthetic SiteTask through the production attempt loop
 * with the REAL kimi-code-cli runtime inside the factory-sandbox boundary:
 * pinned Kimi Code version, exact OpenRouter model moonshotai/kimi-k3,
 * reasoning effort max, exact write scope, deterministic QA oracle, replay,
 * secret scan, and cleanup proof. No Sutherland commercial content.
 *
 * Run: pnpm --filter @factory/factory exec tsx tests/acceptance-kimi.ts
 */
async function main() {
  console.log("== REAL KIMI CODE ACCEPTANCE ==");
  await assertAcceptancePrerequisites();
  const repoRoot = await resolveRepositoryRoot(process.cwd());
  const runId = `accept-kimi-${Date.now()}`;

  const result = await runSiteTask(ACCEPTANCE_TASK, {
    repoRoot,
    runId,
    workerRuntimes: { "kimi-code-cli": createKimiCodeRunner({ repoRoot }) },
  });

  console.log(`runId: ${result.runId}`);
  assertGate(result, "TaskResult schema-valid", taskResultSchema.safeParse(result).success);
  assertGate(result, "status succeeded", result.status === "succeeded", `status=${result.status}`);
  assertGate(result, "1–3 attempts", (result.totalAttempts ?? 0) >= 1 && result.totalAttempts <= 3);
  assertGate(result, "primary runtime is kimi-code-cli", result.worker?.runtime === "kimi-code-cli");
  assertGate(result, "worker tier primary", result.worker?.workerTier === "primary");
  assertGate(result, "no escalation on clean run", result.worker?.escalation === false);
  assertGate(result, "requested model pinned", result.worker?.requestedModel === CODE_WORKER_POLICY.primary.model, `got ${result.worker?.requestedModel}`);
  assertGate(result, "reasoning effort max", result.worker?.reasoningEffort === "max");
  assertGate(result, "exact write scope respected", (result.changes?.changedFiles ?? []).every((f) => f === "sites/starter/src/pages/private-office/approach.astro"), JSON.stringify(result.changes?.changedFiles));
  assertGate(result, "QA evidence present", result.qa?.passed === true);
  assertGate(result, "semantic verification present", result.taskVerification?.passed === true);
  assertGate(result, "replay present", result.replay?.passed === true);
  assertGate(result, "worktree removed", !existsSync(path.join(repoRoot, ".factory", "worktrees", result.runId)));
  await scanArtifactsForSecrets(repoRoot, result.artifacts.runDirectory);
  await assertCleanup(repoRoot, result.runId);
  console.log("== REAL KIMI ACCEPTANCE: PASS ==");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
