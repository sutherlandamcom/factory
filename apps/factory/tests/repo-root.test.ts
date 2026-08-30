import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { artifactDirectory } from "../src/delivery/driver.js";
import { resolveRepositoryRoot, type GitRunner } from "../src/repo-root.js";

/** This file lives at <repo>/apps/factory/tests/, so the repo root is three levels up. */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

function result(stdout = "", exitCode = 0): Awaited<ReturnType<GitRunner>> {
  return { exitCode, signal: null, stdout, stderr: "", timedOut: false };
}

function scriptedGit(outputs: Array<Awaited<ReturnType<GitRunner>> | Error>): {
  runner: GitRunner;
  calls: Array<{ args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  return {
    calls,
    runner: async (args, cwd) => {
      calls.push({ args: [...args], cwd });
      const next = outputs.shift();
      assert.ok(next, `Unexpected Git invocation: ${args.join(" ")}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("resolves exactly the repository top-level when started from the repo root", async () => {
  const git = scriptedGit([result(`${repoRoot}\n`)]);
  assert.equal(await resolveRepositoryRoot(repoRoot, git.runner), repoRoot);
  assert.deepEqual(git.calls, [{ args: ["rev-parse", "--show-toplevel"], cwd: repoRoot }]);
});

test("resolves the repository top-level when started from the package cwd", async () => {
  const packageDir = path.join(repoRoot, "apps", "factory");
  const git = scriptedGit([result(`${repoRoot}\n`)]);
  assert.equal(await resolveRepositoryRoot(packageDir, git.runner), repoRoot);
  assert.equal(git.calls[0]?.cwd, packageDir);
});

test("resolves the repository top-level from a deeply nested directory", async () => {
  const deep = path.join(repoRoot, "apps", "factory", "tests");
  const git = scriptedGit([result(`${repoRoot}\n`)]);
  assert.equal(await resolveRepositoryRoot(deep, git.runner), repoRoot);
});

test("real Git resolves the actual Factory repository top-level from root and package cwds", async () => {
  assert.equal(await resolveRepositoryRoot(repoRoot), repoRoot);
  assert.equal(await resolveRepositoryRoot(path.join(repoRoot, "apps", "factory")), repoRoot);
});

test("default resolution reads the top-level for the current process cwd (pnpm package-cwd delegation)", async () => {
  // `pnpm factory ...` executes the CLI with cwd at apps/factory; the CLI must
  // still resolve the canonical repository root, never the package directory.
  const git = scriptedGit([result(`${repoRoot}\n`)]);
  assert.equal(await resolveRepositoryRoot(process.cwd(), git.runner), repoRoot);
  assert.notEqual(repoRoot, path.join(repoRoot, "apps", "factory"));
});

test("root discovery performs a single local rev-parse — no fetch, no origin access", async () => {
  const git = scriptedGit([result(`${repoRoot}\n`)]);
  await resolveRepositoryRoot(repoRoot, git.runner);
  assert.equal(git.calls.length, 1);
  assert.deepEqual(git.calls[0]?.args, ["rev-parse", "--show-toplevel"]);
});

test("delivery artifacts resolve beneath the canonical root-level .factory hierarchy", () => {
  const dir = artifactDirectory(repoRoot, "deployment-test-id");
  assert.equal(dir.absolute, path.join(repoRoot, ".factory", "deployments", "deployment-test-id"));
  assert.equal(dir.relative, path.join(".factory", "deployments", "deployment-test-id"));
  assert.ok(!dir.absolute.includes(path.join("apps", "factory", ".factory")));
});

test("the documented CLI no longer supplies process.cwd() as the repository root", async () => {
  const cli = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /repoRoot:\s*process\.cwd\(\)/u);
  const wiring = cli.match(/resolveRepositoryRoot\(/gu) ?? [];
  assert.ok(
    wiring.length >= 3,
    "deploy, rollback, and site-task must each resolve the canonical repository root",
  );
});

test("fails closed outside any Git repository", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "factory-no-git-"));
  try {
    const git = scriptedGit([result("", 128)]);
    await assert.rejects(
      resolveRepositoryRoot(outside, git.runner),
      (error: unknown) => (error as { code?: string }).code === "repository_root_unresolved",
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("fails closed when Git cannot be executed", async () => {
  const git = scriptedGit([new Error("spawn git ENOENT")]);
  await assert.rejects(
    resolveRepositoryRoot(repoRoot, git.runner),
    (error: unknown) => (error as { code?: string }).code === "repository_root_unresolved",
  );
});

test("fails closed on unusable Git output", async () => {
  for (const stdout of [
    "",
    '"a quoted/path"\n',
    "relative/path\n",
    "/repo \n", // trailing space: only the newline is stripped, remainder must fail closed
    " /repo\n", // leading space
    " /repo \n",
  ]) {
    const git = scriptedGit([result(stdout)]);
    await assert.rejects(
      resolveRepositoryRoot(repoRoot, git.runner),
      (error: unknown) => (error as { code?: string }).code === "repository_root_unresolved",
    );
  }
});

test("preserves legal whitespace inside the resolved top-level path", async () => {
  const spaced = path.join(repoRoot, "dir with space");
  const git = scriptedGit([result(`${spaced}\n`)]);
  assert.equal(await resolveRepositoryRoot(spaced, git.runner), spaced);
  assert.equal(git.calls[0]?.cwd, spaced);
});
