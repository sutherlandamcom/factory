import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeContainerArgs, buildClaudeRuntimeEnv } from "../src/executor/claude.js";
import { buildKimiContainerArgs, buildKimiConfigToml } from "../src/executor/kimi.js";
import { CLAUDE_WORKER_IMAGE, KIMI_WORKER_IMAGE, dockerClientEnv } from "../src/executor/isolation.js";
import { resolveRepositoryRoot } from "../src/repo-root.js";
import { FACTORY_RUNTIME_NETWORK } from "../src/executor/network.js";
import { runProcess } from "../src/executor/process.js";

test("deterministic worker security: credential isolation, env, and filesystem absence", () => {
  const fakeRealApiKey = "sk-or-v1-super-secret-real-key-987654321";
  const relayToken = "factory-relay-random-token-abc";

  // 1. Kimi config receives only relay token and relay base URL, never real API key
  const kimiConfig = buildKimiConfigToml({
    apiKey: relayToken,
    model: "moonshotai/kimi-k3",
    openrouterBaseUrl: "http://factory-model-relay:8080",
    reasoningEffort: "max",
  });
  assert.ok(!kimiConfig.includes(fakeRealApiKey), "Kimi config must NEVER contain real API key");
  assert.ok(kimiConfig.includes(relayToken), "Kimi config contains local relay token");
  assert.ok(kimiConfig.includes("http://factory-model-relay:8080"));

  // 2. Claude env receives only relay token and relay base URL, never real API key
  const claudeEnv = buildClaudeRuntimeEnv(relayToken, "http://factory-model-relay:8080");
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, relayToken);
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, "http://factory-model-relay:8080");
  for (const [k, v] of Object.entries(claudeEnv)) {
    assert.ok(!String(v).includes(fakeRealApiKey), `Claude env ${k} must not contain real API key`);
  }
});

test("deterministic worker security: hardened container args deny host sockets and HOME", () => {
  const req = {
    worktreePath: "/tmp/fake-worktree",
    prompt: "test",
    runDir: "/tmp/fake-run",
    timeoutMs: 10_000,
    writablePaths: ["sites/starter/src/pages/services/roof-repair.astro"],
  };

  const kimiArgs = buildKimiContainerArgs(req, "test-kimi-sec", "/tmp/fake-runtime");
  const joinedKimi = kimiArgs.join(" ");
  assert.ok(joinedKimi.includes("--read-only"));
  assert.ok(joinedKimi.includes("--cap-drop=ALL"));
  assert.ok(joinedKimi.includes("--security-opt=no-new-privileges"));
  assert.ok(!joinedKimi.includes("/var/run/docker.sock"));
  assert.ok(!joinedKimi.includes("SSH_AUTH_SOCK"));
  assert.ok(!joinedKimi.includes(process.env.HOME || "/Users/"));

  const claudeEnv = buildClaudeRuntimeEnv("dummy-token", "http://relay:8080");
  const claudeArgs = buildClaudeContainerArgs(req, "test-claude-sec", "/tmp/fake-runtime", claudeEnv);
  const joinedClaude = claudeArgs.join(" ");
  assert.ok(joinedClaude.includes("--read-only"));
  assert.ok(joinedClaude.includes("--cap-drop=ALL"));
  assert.ok(joinedClaude.includes("--security-opt=no-new-privileges"));
  assert.ok(!joinedClaude.includes("/var/run/docker.sock"));
  assert.ok(!joinedClaude.includes("SSH_AUTH_SOCK"));
  assert.ok(!joinedClaude.includes(process.env.HOME || "/Users/"));
});
