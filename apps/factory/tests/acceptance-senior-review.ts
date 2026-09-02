import { readFile } from "node:fs/promises";
import path from "node:path";
import { gitIn } from "./helpers.js";
import { runSiteTask } from "../src/executor/run.js";
import { createKimiCodeRunner } from "../src/executor/kimi.js";
import { runSeniorReview } from "../src/executor/review.js";
import { deriveTaskWritePolicy } from "../src/executor/module-policy.js";
import { resolveRepositoryRoot } from "../src/repo-root.js";
import {
  ACCEPTANCE_TASK,
  assertAcceptancePrerequisites,
  assertGate,
} from "./acceptance-code-worker-common.js";

/**
 * Senior READ-ONLY review acceptance (Section 46).
 *
 * 1. Kimi implements the neutral synthetic task (real runtime).
 * 2. The resulting candidate patch is FROZEN (bytes content-addressed).
 * 3. Claude Opus 5 reviews the frozen patch read-only: structured P0/P1/P2.
 * 4. Proves the reviewer could not mutate repository state.
 *
 * Run: pnpm --filter @factory/factory exec tsx tests/acceptance-senior-review.ts
 */
async function main() {
  console.log("== SENIOR READ-ONLY REVIEW ACCEPTANCE ==");
  await assertAcceptancePrerequisites();
  const repoRoot = await resolveRepositoryRoot(process.cwd());
  const runId = `accept-review-${Date.now()}`;

  console.log("step 1: Kimi implements the candidate");
  const result = await runSiteTask(ACCEPTANCE_TASK, {
    repoRoot,
    runId,
    workerRuntimes: { "kimi-code-cli": createKimiCodeRunner({ repoRoot }) },
  });
  assertGate(result, "implementation succeeded", result.status === "succeeded", `status=${result.status}`);
  const patchPath = result.changes?.patchPath;
  assertGate(result, "patch artifact exists", patchPath !== null);
  const patch = await readFile(path.join(repoRoot, patchPath!), "utf8");

  console.log("step 2: freeze + review the patch");
  const beforeTree = gitIn(repoRoot, ["status", "--porcelain"]);
  const review = await runSeniorReview({
    repoRoot,
    runId,
    task: ACCEPTANCE_TASK,
    patch,
    writePolicy: deriveTaskWritePolicy(ACCEPTANCE_TASK),
    qaEvidence: [
      `scope: PASS (${result.changes?.changedFiles.join(", ")})`,
      `integrity: PASS`,
      `foundation_qa: ${result.qa?.foundationPassed ?? "n/a"}`,
      `dynamic_qa: ${result.qa?.dynamicPassed ?? "n/a"}`,
      `semantic_verification: ${result.taskVerification?.passed ? "PASS" : "FAIL"}`,
      `patch_replay: ${result.replay?.passed ? "PASS" : "FAIL"}`,
    ].join("\n"),
  });

  console.log(`reviewId: ${review.reviewId}`);
  console.log(`reviewedPatchSha256: ${review.reviewedPatchSha256}`);
  console.log(`verdict: ${review.verdict}`);
  for (const finding of review.findings) {
    console.log(`  [${finding.severity}] ${finding.summary}`);
  }
  assertGate(review, "review verdict parsed", review.verdict !== "unparseable");
  assertGate(review, "patch binding recorded", /^[0-9a-f]{64}$/.test(review.reviewedPatchSha256));

  console.log("step 3: reviewer could not mutate repository state");
  const afterTree = gitIn(repoRoot, ["status", "--porcelain"]);
  assertGate(review, "git tree unchanged by reviewer", beforeTree === afterTree, `before=${JSON.stringify(beforeTree)} after=${JSON.stringify(afterTree)}`);

  console.log("== SENIOR READ-ONLY REVIEW ACCEPTANCE: PASS ==");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
