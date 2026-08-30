import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildChildEnv } from "../executor/env.js";
import { runProcess } from "../executor/process.js";

export interface RemoteQaResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runRemoteQa(input: {
  worktree: string;
  targetUrl: string;
  productionUrl: string;
  artifactDirectory: string;
  phase: "preview" | "production" | "rollback";
  timeoutMs?: number;
}): Promise<RemoteQaResult> {
  const result = await runProcess(
    "pnpm",
    ["--filter", "@factory/site-starter", "exec", "playwright", "test", "tests/qa.spec.ts"],
    {
      cwd: input.worktree,
      env: buildChildEnv(process.env, {
        CI: "1",
        FACTORY_QA_BASE_URL: input.targetUrl,
        PUBLIC_SITE_URL: input.productionUrl,
      }),
      timeoutMs: input.timeoutMs ?? 900_000,
    },
  );
  await writeFile(path.join(input.artifactDirectory, `${input.phase}-qa-stdout.txt`), result.stdout, "utf8");
  await writeFile(path.join(input.artifactDirectory, `${input.phase}-qa-stderr.txt`), result.stderr, "utf8");

  const qaArtifacts = path.join(input.worktree, "sites", "starter", "qa-artifacts");
  if (existsSync(qaArtifacts)) {
    const target = path.join(input.artifactDirectory, `${input.phase}-qa-artifacts`);
    await mkdir(target, { recursive: true });
    await cp(qaArtifacts, target, { recursive: true });
  }
  return {
    passed: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
