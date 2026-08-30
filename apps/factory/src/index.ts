import path from "node:path";
import { readFile } from "node:fs/promises";
import { exampleSiteTask } from "@factory/contracts";
import { runSiteTask } from "./executor/run.js";
import pkg from "../package.json" with { type: "json" };

const USAGE = `Factory control plane v${pkg.version}

Usage:
  pnpm factory site-task <task.json>   Run one SiteTask through the executor
  pnpm factory                         Print this message

Example task: packages/contracts/fixtures/create-roof-repair.json
Run artifacts: .factory/runs/<runId>/ (gitignored)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    console.log(USAGE);
    console.log(
      `Loaded example SiteTask from @factory/contracts: type=${exampleSiteTask.type} site=${exampleSiteTask.siteId} slug=${exampleSiteTask.page.slug}`,
    );
    return 0;
  }

  if (command !== "site-task" || rest.length !== 1) {
    console.error(USAGE);
    return 2;
  }

  const taskPath = rest[0]!;
  // pnpm runs scripts with cwd = the package dir; INIT_CWD is where the user
  // invoked the command, so relative task paths resolve there.
  const invocationDir = process.env.INIT_CWD ?? process.cwd();
  let raw: string;
  let taskInput: unknown;
  try {
    raw = await readFile(path.resolve(invocationDir, taskPath), "utf8");
    taskInput = JSON.parse(raw);
  } catch (err) {
    // Even unreadable/invalid JSON produces a structured failed TaskResult.
    taskInput = { __unparseable: taskPath, __error: err instanceof Error ? err.message : String(err) };
  }

  const result = await runSiteTask(taskInput, { repoRoot: process.cwd() });

  console.log(`runId:        ${result.runId}`);
  console.log(`status:       ${result.status}`);
  console.log(`finalStage:   ${result.finalStage}`);
  console.log(`baseCommit:   ${result.baseCommit || "(unresolved)"}`);
  console.log(`attempts:     total=${result.totalAttempts}${result.successfulAttempt ? ` succeededOn=${result.successfulAttempt}` : ""}`);
  console.log(`duration:     ${result.durationMs}ms`);
  console.log(`artifacts:    ${result.artifacts.runDirectory}`);
  if (result.changes) {
    console.log(`changedFiles: ${result.changes.changedFiles.join(", ") || "(none)"}`);
    console.log(`patch:        ${result.changes.patchPath ?? "(none)"}`);
  }
  if (result.qa) console.log(`qa:           passed=${result.qa.passed} exit=${result.qa.exitCode}`);
  if (result.taskVerification) {
    console.log(`verification: passed=${result.taskVerification.passed} — ${result.taskVerification.details}`);
  }
  if (result.error) console.error(`error:        [${result.error.code}] ${result.error.message}`);

  return result.status === "succeeded" ? 0 : 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
