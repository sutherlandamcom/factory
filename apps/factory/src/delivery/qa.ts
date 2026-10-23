import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildChildEnv } from "../executor/env.js";
import { productionRouteSchema } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
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
  /**
   * Trusted immutable candidate route snapshot. Absent means legacy fixture
   * QA; present selects the Run 13 remote Candidate QA oracle instead.
   */
  candidateRoutes?: readonly string[];
}): Promise<RemoteQaResult> {
  let candidateRoutes: string[] | undefined;
  if (input.candidateRoutes !== undefined) {
    if (input.candidateRoutes.length === 0 || input.candidateRoutes.length > 200) {
      throw new FactoryError("production_qa_failed", "Candidate route set must contain 1–200 routes.");
    }
    candidateRoutes = input.candidateRoutes.map((route) => productionRouteSchema.parse(route));
    if (new Set(candidateRoutes).size !== candidateRoutes.length) {
      throw new FactoryError("production_qa_failed", "Candidate route set contains duplicate routes.");
    }
    candidateRoutes.sort();
  }
  const testFile = candidateRoutes ? "tests/delivery-candidate.spec.ts" : "tests/qa.spec.ts";
  const result = await runProcess(
    "pnpm",
    ["--filter", "@factory/site-starter", "exec", "playwright", "test", testFile],
    {
      cwd: input.worktree,
      env: buildChildEnv(process.env, {
        CI: "1",
        FACTORY_QA_BASE_URL: input.targetUrl,
        PUBLIC_SITE_URL: input.productionUrl,
        ...(candidateRoutes ? { FACTORY_DELIVERY_EXPECTED_ROUTES: JSON.stringify(candidateRoutes) } : {}),
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
