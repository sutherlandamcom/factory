import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexContainerArgs, type CodexRunRequest } from "../src/executor/codex.js";
import {
  CLAUDE_VERSION,
  CLAUDE_WORKER_IMAGE,
  CODEX_WORKER_IMAGE,
  KIMI_VERSION,
  KIMI_WORKER_IMAGE,
  claudeWorkerBuildArgs,
  codexWorkerBuildArgs,
  expectedColimaMounts,
  kimiWorkerBuildArgs,
  parseColimaMountLocations,
  parseFindmntTargets,
} from "../src/executor/isolation.js";
import { buildEgressRuleSpecs, iptablesSpecToDelete, parseAhostsv4Ips } from "../src/executor/network.js";

test("Codex worker build uses the explicitly named isolation Dockerfile", () => {
  const args = codexWorkerBuildArgs("/repo");
  assert.deepEqual(args.slice(0, 4), [
    "build",
    "--pull",
    "--file",
    "/repo/apps/factory/isolation/codex-worker.Dockerfile",
  ]);
  assert.equal(args.at(-1), "/repo/apps/factory/isolation");
});

test("Colima mount parser returns only explicit host locations", () => {
  const yaml = `mounts:\n  - location: /repo/.factory/worktrees\n    writable: true\n  - location: '/repo/.factory/codex-runtime'\n    writable: true\nruntime: docker\n`;
  assert.deepEqual(parseColimaMountLocations(yaml), [
    "/repo/.factory/codex-runtime",
    "/repo/.factory/worktrees",
  ]);
  // Four mounts after the code-worker migration: legacy codex runtime plus
  // the two ephemeral routed-runtime homes.
  assert.deepEqual(expectedColimaMounts("/repo"), [
    "/repo/.factory/claude-runtime",
    "/repo/.factory/codex-runtime",
    "/repo/.factory/kimi-runtime",
    "/repo/.factory/worktrees",
  ]);
});

test("effective mount parser reads findmnt JSON without line-oriented path parsing", () => {
  assert.deepEqual(
    parseFindmntTargets(JSON.stringify({ filesystems: [{ target: "/z", children: [{ target: "/path with spaces" }] }] })),
    ["/path with spaces", "/z"],
  );
});

test("Codex container is hardened and receives one writable page-parent mount", () => {
  const request: CodexRunRequest = {
    worktreePath: "/repo/.factory/worktrees/run-1",
    runDir: "/repo/.factory/runs/run-1/attempts/1",
    prompt: "task",
    timeoutMs: 1000,
    writablePaths: ["sites/starter/src/pages/services/chimney-repair.astro"],
  };
  const args = buildCodexContainerArgs(request, "factory-codex-test", "/repo/.factory/codex-runtime/run-1");
  const rendered = args.join("\n");
  for (const required of [
    "--rm",
    "--interactive",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--security-opt=seccomp=unconfined",
    "--security-opt=apparmor=unconfined",
    "--network=bridge",
    "--skip-git-repo-check",
    "/workspace/.agents:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=",
    "/workspace/.codex:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=",
    "type=bind,src=/repo/.factory/worktrees/run-1,dst=/workspace,readonly",
    "type=bind,src=/repo/.factory/worktrees/run-1/sites/starter/src/pages/services,dst=/workspace/sites/starter/src/pages/services",
    "type=bind,src=/repo/.factory/codex-runtime/run-1/auth,dst=/codex-auth,readonly",
    "CODEX_HOME=/tmp/home/.codex",
    "sandbox_workspace_write.network_access=false",
    "tools.web_search=false",
  ]) assert.ok(rendered.includes(required), `missing ${required}`);
  // SiteTask authority layout is unchanged: readonly workspace root plus the
  // exact page-parent writable bind — never a fully writable workspace.
  assert.ok(!rendered.includes("dst=/workspace\n") && rendered.includes("dst=/workspace,readonly"));
  assert.ok(!rendered.includes("docker.sock"));
  assert.ok(!rendered.includes("src=/,dst=/workspace"));
});

test("kimi and claude worker builds use their pinned Dockerfiles and exact versions", () => {
  const kimiArgs = kimiWorkerBuildArgs("/repo");
  assert.deepEqual(kimiArgs.slice(0, 4), ["build", "--pull", "--file", "/repo/apps/factory/isolation/kimi-worker.Dockerfile"]);
  assert.ok(kimiArgs.includes(`--build-arg`));
  assert.ok(kimiArgs.includes(`KIMI_VERSION=${KIMI_VERSION}`));
  assert.ok(kimiArgs.includes(KIMI_WORKER_IMAGE));

  const claudeArgs = claudeWorkerBuildArgs("/repo");
  assert.deepEqual(claudeArgs.slice(0, 4), ["build", "--pull", "--file", "/repo/apps/factory/isolation/claude-worker.Dockerfile"]);
  assert.ok(claudeArgs.includes(`CLAUDE_VERSION=${CLAUDE_VERSION}`));
  assert.ok(claudeArgs.includes(CLAUDE_WORKER_IMAGE));

  // Exact pinned versions, never floating tags.
  assert.equal(KIMI_VERSION, "0.39.1");
  assert.equal(CLAUDE_VERSION, "2.1.150");
  assert.ok(!CODEX_WORKER_IMAGE.includes("latest"));
});

test("egress rule builder scopes allow rules before the catch-all drop", () => {
  const specs = buildEgressRuleSpecs("192.168.215.0/24", ["198.51.100.7", "203.0.113.9"]);
  assert.equal(specs.length, 4);
  assert.ok(specs[0]!.args.includes("ESTABLISHED,RELATED"));
  assert.ok(specs[1]!.args.includes("-d") && specs[1]!.args.includes("198.51.100.7"));
  assert.ok(specs[2]!.args.includes("203.0.113.9"));
  const drop = specs.at(-1)!.args;
  assert.deepEqual(drop.slice(-2), ["-j", "DROP"]);
  for (const spec of specs) {
    assert.ok(spec.args.includes("factory-runtime-egress"));
    assert.ok(spec.args.includes("192.168.215.0/24"));
  }
});

test("only Factory-owned DOCKER-USER rules are ever deleted", () => {
  assert.deepEqual(
    iptablesSpecToDelete("-A DOCKER-USER -s 10.0.0.0/24 -m comment --comment factory-runtime-egress -j DROP"),
    ["-D", "DOCKER-USER", "-s", "10.0.0.0/24", "-m", "comment", "--comment", "factory-runtime-egress", "-j", "DROP"],
  );
  assert.equal(iptablesSpecToDelete("-A DOCKER-USER -j RETURN"), null);
  assert.equal(iptablesSpecToDelete("-A DOCKER-USER -s 10.0.0.0/24 -j DROP"), null);
  assert.equal(iptablesSpecToDelete("-A INPUT -s 10.0.0.0/24 -m comment --comment factory-runtime-egress -j DROP"), null);
});

test("ahostsv4 parser extracts unique sorted IPv4 addresses", () => {
  assert.deepEqual(
    parseAhostsv4Ips("198.51.100.7    STREAM openrouter.ai\n203.0.113.9     STREAM openrouter.ai\n198.51.100.7     STREAM openrouter.ai\n"),
    ["198.51.100.7", "203.0.113.9"],
  );
  assert.deepEqual(parseAhostsv4Ips(""), []);
  assert.deepEqual(parseAhostsv4Ips("no ips here"), []);
});
