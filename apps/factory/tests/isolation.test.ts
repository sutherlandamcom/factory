import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexContainerArgs, type CodexRunRequest } from "../src/executor/codex.js";
import {
  codexWorkerBuildArgs,
  expectedColimaMounts,
  parseColimaMountLocations,
  parseFindmntTargets,
} from "../src/executor/isolation.js";

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
  assert.deepEqual(expectedColimaMounts("/repo"), [
    "/repo/.factory/codex-runtime",
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
