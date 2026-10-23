import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalTrustedQaEvidenceExecutor } from "../src/production/qa/collector.js";
import type { RunProcessOptions, ProcessResult } from "../src/executor/process.js";

type Input = { distDir: string; routes: string[]; repoRoot: string; manifestSetDigest: string };
type Check = { verdict: string };
const ok: ProcessResult = { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false };
const report = () => ({ categories: { performance: { score: 1 }, seo: { score: 1 }, "best-practices": { score: 1 } }, audits: { "largest-contentful-paint": { numericValue: 100 }, "cumulative-layout-shift": { numericValue: 0 }, "total-blocking-time": { numericValue: 0 } } });
async function output(dir: string, data: unknown = report()) {
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "report.json");
  await writeFile(jsonPath, JSON.stringify(data));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify([{ url: "http://localhost/", jsonPath }]));
}
function execute(input: Input, runner: (command: string, args: string[], options: RunProcessOptions) => Promise<ProcessResult>) {
  const executor = new LocalTrustedQaEvidenceExecutor(runner);
  return (executor as unknown as { collectLighthouse(i: Input, v: Map<string, string>): Promise<Check[]> }).collectLighthouse(input, new Map([["lighthouse-ci", "0.15.1"]]));
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "factory-lhci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sites", "starter"), { recursive: true });
  return { repoRoot: root, distDir: path.join(root, "candidate-dist"), routes: ["/"], manifestSetDigest: "candidate-manifest" };
}
function exportDir(args: string[]) { return args.find(a => a.startsWith("--upload.outputDir="))!.split("=").slice(1).join("="); }

test("SF-F04 old PASS cannot survive failed or missing current Lighthouse output", async t => {
  for (const exitCode of [1, 0]) await t.test(`current exit ${exitCode} without output`, async t => {
    const input = await fixture(t);
    await output(path.join(input.repoRoot, "qa-artifacts", "lhci-e2e"));
    await assert.rejects(execute(input, async () => ({ ...ok, exitCode })));
  });
});
test("SF-F04 malformed and incomplete current Lighthouse evidence fails closed", async t => {
  for (const kind of ["json", "metrics", "category", "outside"]) await t.test(kind, async t => {
    const input = await fixture(t);
    await assert.rejects(execute(input, async (_command, args) => {
      const dir = exportDir(args);
      if (kind === "outside") {
        const outside = path.join(input.repoRoot, "old-reports");
        await output(outside);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "manifest.json"), await import("node:fs/promises").then(fs => fs.readFile(path.join(outside, "manifest.json"))));
      } else if (kind === "json") {
        await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "manifest.json"), "invalid json");
      } else {
        const data = report();
        if (kind === "metrics") delete (data.audits as Record<string, unknown>)["largest-contentful-paint"];
        else delete (data.categories as Record<string, unknown>).performance;
        await output(dir, data);
      }
      return ok;
    }));
  });
});
test("SF-F04 overlapping executions isolate internal storage, reports and cleanup", async t => {
  const input = await fixture(t);
  const calls: Partial<Record<"first" | "second", { args: string[]; cwd: string }>> = {};
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let secondStarted!: () => void;
  const started = new Promise<void>(resolve => { secondStarted = resolve; });
  const first = execute(input, async (_command, args, opts) => {
    // Deliberately let the second invocation produce evidence first: invocation
    // identity must not depend on filesystem scheduling or runner arrival order.
    await started;
    calls.first = { args, cwd: opts.cwd }; await output(exportDir(args)); return ok;
  });
  const second = execute(input, async (_command, args, opts) => {
    calls.second = { args, cwd: opts.cwd }; await output(exportDir(args)); secondStarted(); await wait; return ok;
  });
  try {
    assert.equal((await first)[0]!.verdict, "PASS");
    assert.notEqual(calls.first!.cwd, calls.second!.cwd, "LHCI internal storage must be execution-local");
    assert.notEqual(exportDir(calls.first!.args), exportDir(calls.second!.args));
    await access(path.join(exportDir(calls.second!.args), "manifest.json"));
  } finally { release(); }
  assert.equal((await second)[0]!.verdict, "PASS");
  for (const call of Object.values(calls)) await assert.rejects(access(exportDir(call.args)), "own output must be cleaned");
});
