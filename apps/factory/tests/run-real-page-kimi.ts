import { runSiteTask } from "../src/executor/run.js";
import { resolveRepositoryRoot } from "../src/repo-root.js";
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

const KIMI_PAGE_TASK: SiteTask = {
  type: "create_page",
  siteId: "starter",
  page: {
    type: "general",
    slug: "/acceptance/kimi-product-path",
    title: "Kimi Product Path Acceptance",
    description: "Acceptance verification page for Kimi product path.",
    sections: ["hero", "cta"],
  },
};

async function main() {
  await assertAcceptancePrerequisites();
  const repoRoot = await resolveRepositoryRoot(process.cwd());
  const runId = `kimi-product-path-${Date.now()}`;

  console.log(`Starting Real Page #1 (Kimi Product Path) with runId=${runId}...`);
  const result = await runSiteTask(KIMI_PAGE_TASK, {
    repoRoot,
    runId,
    maxAttempts: 3,
  });

  console.log("=== REAL PAGE #1 RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "succeeded") {
    console.error(`Page #1 FAILED: ${result.error?.code} - ${result.error?.message}`);
    process.exit(1);
  } else {
    console.log("Page #1 SUCCEEDED!");
  }
}

main().catch((err) => {
  console.error("Uncaught error in Real Page #1:", err);
  process.exit(1);
});
