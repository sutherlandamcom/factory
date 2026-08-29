import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { taskResultSchema, type SiteTask } from "@factory/contracts";
import { createCodexRunner, type CodexRunRequest, type CodexRunResult } from "../src/executor/codex.js";
import { runSiteTask } from "../src/executor/run.js";

const ACCEPTANCE_TASK: SiteTask = {
  type: "create_page",
  siteId: "starter",
  page: {
    type: "service",
    slug: "/services/gutter-cleaning",
    title: "Gutter Cleaning & Inspection Services",
    description: "Expert gutter cleaning and downspout inspection for residential properties.",
    sections: ["hero", "benefits", "feature_cards", "faq", "cta"],
  },
};

async function runRealRepairAcceptance(repoRoot: string) {
  console.log("\n=======================================================");
  console.log("1. REAL REPAIR ACCEPTANCE (Attempt 1: defect, Attempt 2: real Codex)");
  console.log("=======================================================");

  const realCodex = createCodexRunner({
    codexPath: path.join(repoRoot, "node_modules", ".bin", "codex"),
  });

  let codexInvocations = 0;

  const hybridCodexRunner = async (req: CodexRunRequest): Promise<CodexRunResult> => {
    codexInvocations++;
    console.log(`[HybridCodexRunner] Attempt ${codexInvocations} starting...`);

    if (codexInvocations === 1) {
      console.log("[HybridCodexRunner] Attempt 1: Injecting realistic defective Astro page (syntax error / missing canonical / wrong title)...");
      const pageFile = path.join(
        req.worktreePath,
        "sites",
        "starter",
        "src",
        "pages",
        "services",
        "gutter-cleaning.astro",
      );
      await mkdir(path.dirname(pageFile), { recursive: true });

      // Realistic defect: Page exists and imports components, but has wrong title ("Bad Title") and invalid Astro syntax in frontmatter
      const defectiveContent = `---
import BaseLayout from '../../layouts/BaseLayout.astro';
import Hero from '../../components/Hero.astro';
import Cta from '../../components/Cta.astro';

// Defect: intentionally missing required title and canonical link definition
const pageTitle = "Wrong Gutter Page";
---

<BaseLayout title={pageTitle} description="Expert gutter cleaning">
  <Hero title={pageTitle} subtitle="Keep gutters clear" />
  <!-- Missing CTA and required sections -->
</BaseLayout>
`;
      await writeFile(pageFile, defectiveContent, "utf8");
      return {
        exitCode: 0,
        timedOut: false,
        version: "codex-cli 0.150.1 (simulated-initial)",
        stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Created initial draft." } }),
        stderr: "",
      };
    }

    console.log("[HybridCodexRunner] Attempt 2: Invoking REAL Codex CLI with Repair Prompt...");
    return realCodex(req);
  };

  const result = await runSiteTask(ACCEPTANCE_TASK, {
    repoRoot,
    codexRunner: hybridCodexRunner,
  });

  console.log("\n[Real Repair Acceptance Result]");
  console.log(`runId:             ${result.runId}`);
  console.log(`status:            ${result.status}`);
  console.log(`totalAttempts:     ${result.totalAttempts}`);
  console.log(`successfulAttempt: ${result.successfulAttempt}`);
  console.log(`finalStage:        ${result.finalStage}`);
  console.log(`duration:          ${result.durationMs}ms`);
  console.log(`artifacts:         ${result.artifacts.runDirectory}`);
  if (result.changes) {
    console.log(`changedFiles:      ${result.changes.changedFiles.join(", ")}`);
    console.log(`patch:             ${result.changes.patchPath}`);
  }

  assert.equal(result.status, "succeeded", `Expected status succeeded, got ${result.status}`);
  assert.ok(
    result.totalAttempts === 2 || result.totalAttempts === 3,
    `Expected totalAttempts 2 or 3, got ${result.totalAttempts}`,
  );
  assert.ok(
    result.successfulAttempt === 2 || result.successfulAttempt === 3,
    `Expected successfulAttempt 2 or 3, got ${result.successfulAttempt}`,
  );
  assert.equal(result.attempts?.length, result.totalAttempts);
  assert.equal(result.attempts[0]?.classification, "repairable");
  assert.equal(result.attempts[result.attempts.length - 1]?.stage, "complete");

  // Validate schema
  const rawResult = JSON.parse(
    await readFile(path.join(repoRoot, result.artifacts.runDirectory, "task-result.json"), "utf8"),
  );
  assert.deepEqual(taskResultSchema.parse(rawResult), rawResult);

  // Validate patch
  const patch = await readFile(path.join(repoRoot, result.artifacts.runDirectory, "diff.patch"), "utf8");
  assert.match(patch, /Gutter Cleaning & Inspection Services/);

  console.log(">>> REAL REPAIR ACCEPTANCE PASS <<<");
  return result;
}

async function runBoundedFailureAcceptance(repoRoot: string) {
  console.log("\n=======================================================");
  console.log("2. BOUNDED-FAILURE ACCEPTANCE (3 failing attempts -> needs_review)");
  console.log("=======================================================");

  let codexInvocations = 0;

  const persistentFailingCodex = async (req: CodexRunRequest): Promise<CodexRunResult> => {
    codexInvocations++;
    console.log(`[PersistentFailingCodex] Attempt ${codexInvocations} producing persistent QA defect...`);

    const pageFile = path.join(
      req.worktreePath,
      "sites",
      "starter",
      "src",
      "pages",
      "services",
      "gutter-cleaning.astro",
    );
    await mkdir(path.dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `---\n// Attempt ${codexInvocations} syntax error\nconst bad: number = "type error";\n---\n<h1>Broken Attempt ${codexInvocations}</h1>\n`,
      "utf8",
    );

    return {
      exitCode: 0,
      timedOut: false,
      version: "codex-cli 0.150.1 (mock-failing)",
      stdout: "",
      stderr: "",
    };
  };

  const result = await runSiteTask(ACCEPTANCE_TASK, {
    repoRoot,
    maxAttempts: 3,
    codexRunner: persistentFailingCodex,
  });

  console.log("\n[Bounded Failure Acceptance Result]");
  console.log(`runId:             ${result.runId}`);
  console.log(`status:            ${result.status}`);
  console.log(`totalAttempts:     ${result.totalAttempts}`);
  console.log(`successfulAttempt: ${result.successfulAttempt}`);
  console.log(`finalStage:        ${result.finalStage}`);
  console.log(`error:             [${result.error?.code}] ${result.error?.message}`);

  assert.equal(result.status, "needs_review", `Expected status needs_review, got ${result.status}`);
  assert.equal(result.totalAttempts, 3, `Expected totalAttempts 3, got ${result.totalAttempts}`);
  assert.equal(result.successfulAttempt, null);
  assert.equal(codexInvocations, 3);
  assert.equal(result.attempts?.length, 3);
  assert.equal(result.attempts[2]?.classification, "exhausted");
  assert.match(result.error!.message, /attempts exhausted/);

  // Validate Attempt 4 does NOT exist
  assert.ok(!existsSync(path.join(repoRoot, result.artifacts.runDirectory, "attempts", "4")));

  console.log(">>> BOUNDED FAILURE ACCEPTANCE PASS <<<");
  return result;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const repairResult = await runRealRepairAcceptance(repoRoot);
  const boundedResult = await runBoundedFailureAcceptance(repoRoot);

  console.log("\n=======================================================");
  console.log("ACCEPTANCE SUMMARY:");
  console.log(`Real Repair Acceptance Run:    ${repairResult.runId} (${repairResult.status}, attempts: ${repairResult.totalAttempts})`);
  console.log(`Bounded Failure Acceptance Run: ${boundedResult.runId} (${boundedResult.status}, attempts: ${boundedResult.totalAttempts})`);
  console.log("=======================================================");
}

main().catch((err) => {
  console.error("ACCEPTANCE RUN FAILED:", err);
  process.exit(1);
});
