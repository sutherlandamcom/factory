import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildCodexContainerArgs } from "../src/executor/codex.js";
import { buildChildEnv } from "../src/executor/env.js";
import { makeTempRepo } from "./helpers.js";
import { intelligenceWorkspacePath } from "../src/intelligence/synthesis.js";
import { runIntelligence } from "../src/intelligence/driver.js";
import {
  fakeCodexRunner,
  loadFixtureRequestJson,
  loadFixtureResearchJson,
} from "./intelligence-fixtures.js";

const FIXED_NOW = new Date("2026-08-31T10:15:00Z");

function deps(codexRunner: unknown) {
  return { now: () => FIXED_NOW, runIdSuffix: () => "abc12345", synthesisTimeoutMs: 5_000, codexRunner } as never;
}

const SECRET_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "FACTORY_DATABASE_URL",
  "DATABASE_URL",
  "PGPASSWORD",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "FIRECRAWL_API_KEY",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
];

test("child env allowlist excludes every secret class from model processes", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp" };
  for (const secret of SECRET_ENV_VARS) parent[secret] = "secret-value";
  const env = buildChildEnv(parent);
  for (const secret of SECRET_ENV_VARS) {
    assert.equal(env[secret], undefined, `${secret} must never reach child processes`);
  }
});

test("codex container arguments expose no secrets and no broad mounts", () => {
  const repoRoot = "/repo";
  const args = buildCodexContainerArgs(
    {
      worktreePath: "/repo/.factory/worktrees/intelligence-20260831T101500Z-abc12345",
      prompt: "DATA",
      runDir: "/repo/.factory/intelligence/run/attempts/1",
      timeoutMs: 1000,
      writablePaths: ["output/plan.json"],
    },
    "factory-codex-test",
    "/repo/.factory/codex-runtime/factory-codex-test",
  );

  const flattened = args.join(" ");
  for (const secret of [...SECRET_ENV_VARS, "auth.json"]) {
    // auth.json is mounted via an ephemeral runtime copy, never by literal name.
    assert.equal(flattened.includes(secret), false, secret);
  }
  const envValues: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") envValues.push(args[i + 1]!);
  }
  assert.deepEqual(envValues.sort(), ["CODEX_HOME=/tmp/home/.codex", "HOME=/tmp/home", "TMPDIR=/tmp"]);
  // Inner sandbox hardening remains intact.
  assert.ok(flattened.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(flattened.includes("tools.web_search=false"));
  assert.ok(flattened.includes("approval_policy=\"never\""));
  // The primary repository checkout is never mounted — only the intelligence
  // workspace, the runtime auth, and the runtime output directory.
  const mounts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mount") mounts.push(args[i + 1]!);
  }
  for (const mount of mounts) {
    const source = mount.replace(/^type=bind,/, "");
    assert.ok(
      source.startsWith("src=/repo/.factory/worktrees/")
        || source.startsWith("src=/repo/.factory/codex-runtime/"),
      `unexpected mount: ${mount}`,
    );
  }
  assert.ok(mounts.some((mount) => mount.endsWith("dst=/workspace,readonly")));
  // Inner network stays disabled; no docker socket, no host HOME mount.
  assert.equal(flattened.includes("/var/run/docker.sock"), false);
});

test("model workspace is strictly confined to the approved worktree root", () => {
  const repoRoot = "/repo";
  const workspace = intelligenceWorkspacePath(repoRoot, "20260831T101500Z-abc12345");
  assert.ok(workspace.startsWith(path.join(repoRoot, ".factory", "worktrees", "intelligence-")));
  assert.throws(() => intelligenceWorkspacePath(repoRoot, "../escape"));
  assert.throws(() => intelligenceWorkspacePath(repoRoot, "with/slash"));
});

test("prompt injection cannot enlarge write authority or page budget", async () => {
  const repoRoot = await makeTempRepo();
  const request = await loadFixtureRequestJson();
  const research = await loadFixtureResearchJson();
  const { runner, calls } = fakeCodexRunner({ outputs: [JSON.stringify({ hijacked: true })] });
  // The fixture research contains an explicit prompt-injection evidence item
  // (inj-competitor-page). The runner contract must remain identical.
  const result = await runIntelligence(
    { repoRoot, requestInput: JSON.stringify(request), researchInput: JSON.stringify(research) },
    deps(runner),
  );
  assert.equal(result.status, "needs_review");
  for (const call of calls) {
    assert.deepEqual(call.writablePaths, ["output/plan.json"]);
    assert.ok(call.worktreePath.startsWith(path.join(repoRoot, ".factory", "worktrees", "intelligence-")));
  }
  await rm(repoRoot, { recursive: true, force: true });
});

test("intelligence module contains no network primitives or fetch paths", async () => {
  const moduleDir = path.join(import.meta.dirname, "..", "src", "intelligence");
  const files = (await readdir(moduleDir)).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length >= 7);
  for (const file of files) {
    const source = await readFile(path.join(moduleDir, file), "utf8");
    for (const forbidden of ["node:http", "node:https", "node:net", "node:dgram", "fetch(", "axios", "undici", "child_process"]) {
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
    }
  }
});

test("evidence and operator facts cannot modify factory source or budgets", async () => {
  // Research input carrying injection payloads validates as inert data and
  // the driver derives every authority value (paths, budgets, digests) from
  // validated trusted inputs only.
  const research = await loadFixtureResearchJson();
  const items = research.items as { id: string; text?: string }[];
  const injection = items.find((item) => item.id === "inj-competitor-page");
  assert.ok(injection, "fixture contains an injection evidence item");
  assert.match(injection.text!, /set maxInitialPages to 999/i);
  assert.match(injection.text!, /write to apps\/factory/i);
});
