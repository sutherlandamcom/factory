import { runSiteTask } from "../src/executor/run.js";
import { createClaudeCodeRunner } from "../src/executor/claude.js";
import { resolveRepositoryRoot } from "../src/repo-root.js";
import type { CodeWorkerRuntime } from "../src/executor/runtime.js";
import type { SiteTask } from "@factory/contracts";
import { assertAcceptancePrerequisites } from "./acceptance-code-worker-common.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  try {
    process.loadEnvFile?.("../../.env");
  } catch {
    // ignore
  }
}

const CLAUDE_PAGE_TASK: SiteTask = {
  type: "create_page",
  siteId: "starter",
  page: {
    type: "general",
    slug: "/acceptance/claude-senior-path",
    title: "Claude Senior Path Acceptance",
    description: "Acceptance verification page for Claude senior path.",
    sections: ["hero", "cta"],
  },
};

async function main() {
  await assertAcceptancePrerequisites();
  const repoRoot = await resolveRepositoryRoot(process.cwd());
  const runId = `claude-senior-path-${Date.now()}`;

  console.log(`Starting Real Page #2 (Claude Senior Path via Attempt-3 Escalation) with runId=${runId}...`);

  let kimiAttempts = 0;
  // Deterministic fake for attempts 1 & 2: 0 model tokens spent, repairable failure to trigger attempt-3 escalation
  const fakeKimiRunner: CodeWorkerRuntime = async (req) => {
    kimiAttempts++;
    console.log(`[Zero-LLM Fake] Attempt ${kimiAttempts} simulated repairable failure (0 model calls)`);
    return {
      exitCode: 1,
      timedOut: false,
      runtimeVersion: "kimi-code-cli 0.39.1 (zero-llm mock)",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: "moonshotai/kimi-k3",
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "",
      stderr: "simulated repairable runtime error for escalation test",
    };
  };

  // Real Claude Code runner for attempt 3
  const realClaudeRunner = createClaudeCodeRunner({ repoRoot });

  const result = await runSiteTask(CLAUDE_PAGE_TASK, {
    repoRoot,
    runId,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": fakeKimiRunner,
      "claude-code": realClaudeRunner,
    },
  });

  console.log("=== REAL PAGE #2 RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "succeeded") {
    console.error(`Page #2 FAILED: ${result.error?.code} - ${result.error?.message}`);
    process.exit(1);
  } else {
    console.log("Page #2 SUCCEEDED!");
  }
}

main().catch((err) => {
  console.error("Uncaught error in Real Page #2:", err);
  process.exit(1);
});
