import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

export interface QaRunResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
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
): Promise<QaRunResult> {
  const result = await runProcess("pnpm", ["qa"], {
    cwd: worktreePath,
    env: buildChildEnv(process.env, { CI: "1" }),
    timeoutMs,
  });

  await writeFile(path.join(runDir, "qa-stdout.txt"), result.stdout, "utf8");
  await writeFile(path.join(runDir, "qa-stderr.txt"), result.stderr, "utf8");

  // QA screenshots (gitignored, regenerated per run) are useful evidence.
  const qaArtifacts = path.join(worktreePath, "sites", "starter", "qa-artifacts");
  if (existsSync(qaArtifacts)) {
    const dest = path.join(runDir, "qa-artifacts");
    await mkdir(dest, { recursive: true });
    await cp(qaArtifacts, dest, { recursive: true });
  }

  return {
    passed: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
