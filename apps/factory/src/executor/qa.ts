import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { SiteTask } from "@factory/contracts";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";
import { createTaskQaSpec } from "./task-qa.js";
import { FACTORY_QA_ORIGIN, loadWorktreeSiteProfile } from "./site-profile.js";

export interface QaRunResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  foundationPassed: boolean;
  dynamicPassed: boolean;
  failureGate?: "foundation" | "dynamic";
  foundationArtifact: string;
  dynamicArtifact: string;
}

/**
 * Independent Factory QA: the control plane itself runs `pnpm qa` inside the
 * worktree after Codex exits. Codex's own claims are never trusted. CI=1 is
 * set so Playwright never reuses a foreign server on port 4321.
 */
export async function runQa(
  worktreePath: string,
  runDir: string,
  timeoutMs: number,
  task: SiteTask,
): Promise<QaRunResult> {
  // Site identity is parsed from the worktree with the shared contract and
  // fails closed BEFORE any QA subprocess runs. The trusted override makes
  // the site build and these expectations use the exact same canonical origin.
  const profile = await loadWorktreeSiteProfile(worktreePath);

  const foundation = await runProcess("pnpm", ["qa"], {
    cwd: worktreePath,
    env: buildChildEnv(process.env, { CI: "1", PUBLIC_SITE_URL: FACTORY_QA_ORIGIN }),
    timeoutMs,
  });

  const foundationStdout = path.join(runDir, "foundation-qa-stdout.txt");
  const foundationStderr = path.join(runDir, "foundation-qa-stderr.txt");
  await writeFile(foundationStdout, foundation.stdout, "utf8");
  await writeFile(foundationStderr, foundation.stderr, "utf8");

  const taskSpecPath = path.join(runDir, "task-qa-spec.json");
  await writeFile(
    taskSpecPath,
    JSON.stringify(createTaskQaSpec(task, profile, { canonicalOriginOverride: FACTORY_QA_ORIGIN }), null, 2),
    "utf8",
  );

  let dynamic = { exitCode: null as number | null, timedOut: false, stdout: "", stderr: "" };
  if (foundation.exitCode === 0 && !foundation.timedOut) {
    dynamic = await runProcess(
      "pnpm",
      [
        "--filter",
        "@factory/site-starter",
        "exec",
        "playwright",
        "test",
        "tests/task-page.qa.spec.ts",
      ],
      {
        cwd: worktreePath,
        env: buildChildEnv(process.env, {
          CI: "1",
          PUBLIC_SITE_URL: FACTORY_QA_ORIGIN,
          FACTORY_TASK_QA_SPEC: taskSpecPath,
        }),
        timeoutMs,
      },
    );
  }

  const dynamicStdout = path.join(runDir, "dynamic-qa-stdout.txt");
  const dynamicStderr = path.join(runDir, "dynamic-qa-stderr.txt");
  await writeFile(dynamicStdout, dynamic.stdout, "utf8");
  await writeFile(dynamicStderr, dynamic.stderr, "utf8");

  await writeFile(path.join(runDir, "qa-stdout.txt"), `${foundation.stdout}\n${dynamic.stdout}`, "utf8");
  await writeFile(path.join(runDir, "qa-stderr.txt"), `${foundation.stderr}\n${dynamic.stderr}`, "utf8");

  // QA screenshots (gitignored, regenerated per run) are useful evidence.
  const qaArtifacts = path.join(worktreePath, "sites", "starter", "qa-artifacts");
  if (existsSync(qaArtifacts)) {
    const dest = path.join(runDir, "qa-artifacts");
    await mkdir(dest, { recursive: true });
    await cp(qaArtifacts, dest, { recursive: true });
  }

  return {
    passed: foundation.exitCode === 0 && !foundation.timedOut && dynamic.exitCode === 0 && !dynamic.timedOut,
    exitCode: foundation.exitCode !== 0 ? foundation.exitCode : dynamic.exitCode,
    timedOut: foundation.timedOut || dynamic.timedOut,
    foundationPassed: foundation.exitCode === 0 && !foundation.timedOut,
    dynamicPassed: dynamic.exitCode === 0 && !dynamic.timedOut,
    ...(foundation.exitCode !== 0 || foundation.timedOut
      ? { failureGate: "foundation" as const }
      : dynamic.exitCode !== 0 || dynamic.timedOut
        ? { failureGate: "dynamic" as const }
        : {}),
    foundationArtifact: path.basename(foundationStdout),
    dynamicArtifact: path.basename(dynamicStdout),
  };
}
