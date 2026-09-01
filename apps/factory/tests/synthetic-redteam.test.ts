import assert from "node:assert/strict";
import test from "node:test";
import { runSiteTask } from "../src/executor/run.js";
import { type CodeWorkerRuntime } from "../src/executor/runtime.js";
import { type SiteTask } from "@factory/contracts";
import { writeFile, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTempRepo } from "./helpers.js";

const TASK: SiteTask = {
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair services",
    sections: ["hero", "benefits", "faq", "cta"],
  },
};

const passQa = async () => ({ passed: true, exitCode: 0, timedOut: false });
const passVerify = async () => ({ passed: true, details: "mock verification passed" });
const passReplay = async () => ({ passed: true, details: "mock replay passed" });
const noopDeps = async () => {};

test("synthetic redteam: outside-target write triggers terminal scope_violation (0 escalations)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async (req) => {
    kimiInvocations++;
    // Hostile attempt: write to AGENTS.md outside the authorized target page
    const agentsPath = path.join(req.worktreePath, "AGENTS.md");
    await writeFile(agentsPath, "pwned by probe\n");
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: "moonshotai/kimi-k3",
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "done",
      stderr: "",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-outside-write-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "scope_violation");
  assert.equal(kimiInvocations, 1, "Kimi ran once and was terminated");
  assert.equal(claudeInvocations, 0, "Terminal security failure must NEVER escalate to Claude");
  assert.equal(result.attempts?.length, 1);
});

test("synthetic redteam: second page write triggers terminal scope_violation (0 escalations)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async (req) => {
    kimiInvocations++;
    // Write authorized target
    const targetPath = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "--- \n---\n<h1>Roof Repair</h1>");

    // Also write unauthorized second page
    const extraPath = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "extra.astro");
    await writeFile(extraPath, "--- \n---\n<h1>Extra Page</h1>");

    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: "moonshotai/kimi-k3",
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "done",
      stderr: "",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-second-page-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "scope_violation");
  assert.equal(kimiInvocations, 1);
  assert.equal(claudeInvocations, 0, "Zero Claude escalations on second page write");
});

test("synthetic redteam: symlink escaping worktree triggers scope_violation (0 escalations)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async (req) => {
    kimiInvocations++;
    const targetPath = path.join(req.worktreePath, "sites", "starter", "src", "pages", "services", "roof-repair.astro");
    await mkdir(path.dirname(targetPath), { recursive: true });
    // Attempt symlink trick
    await symlink("/etc/hostname", targetPath).catch(() => undefined);
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: "moonshotai/kimi-k3",
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "done",
      stderr: "",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-symlink-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(kimiInvocations, 1);
  assert.equal(claudeInvocations, 0, "Zero Claude escalations on symlink trick");
});

test("synthetic redteam: provider policy 404 halts immediately (0 second Kimi, 0 Claude)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async () => {
    kimiInvocations++;
    return {
      exitCode: 1,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: null,
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "",
      stderr: "Error: OpenRouter returned HTTP 404: No allowed providers are available for the selected model",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-404-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "provider_not_allowed");
  assert.equal(kimiInvocations, 1, "Exactly 1 attempt made");
  assert.equal(claudeInvocations, 0, "Zero Claude escalation on provider failure");
  assert.equal(result.attempts?.length, 1);
});

test("synthetic redteam: provider 402 insufficient credits halts immediately (0 second Kimi, 0 Claude)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async () => {
    kimiInvocations++;
    return {
      exitCode: 1,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: null,
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "",
      stderr: "Error 402: This request requires more credits than your account balance allows",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-402-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "provider_credit_unavailable");
  assert.equal(kimiInvocations, 1, "Exactly 1 attempt made");
  assert.equal(claudeInvocations, 0, "Zero Claude escalation on credit exhaustion");
  assert.equal(result.attempts?.length, 1);
});

test("synthetic redteam: provider 429 rate limit halts immediately (0 second Kimi, 0 Claude)", async () => {
  const repo = await makeTempRepo();
  let kimiInvocations = 0;
  let claudeInvocations = 0;

  const mockKimi: CodeWorkerRuntime = async () => {
    kimiInvocations++;
    return {
      exitCode: 1,
      timedOut: false,
      runtimeVersion: "mock-kimi 0.39.1",
      requestedModel: "moonshotai/kimi-k3",
      respondedModel: null,
      provider: "openrouter",
      reasoningEffort: "max",
      stdout: "",
      stderr: "HTTP 429: Too Many Requests / Rate limit exceeded",
    };
  };

  const mockClaude: CodeWorkerRuntime = async () => {
    claudeInvocations++;
    return {
      exitCode: 0,
      timedOut: false,
      runtimeVersion: "mock-claude 2.1.150",
      requestedModel: "anthropic/claude-opus-5",
      respondedModel: "anthropic/claude-opus-5",
      provider: "openrouter",
      reasoningEffort: null,
      stdout: "done",
      stderr: "",
    };
  };

  const result = await runSiteTask(TASK, {
    repoRoot: repo,
    runId: `synth-sec-429-${Date.now()}`,
    maxAttempts: 3,
    workerRuntimes: {
      "kimi-code-cli": mockKimi,
      "claude-code": mockClaude,
    },
    runQaFn: passQa,
    verifyFn: passVerify,
    verifyReplayFn: passReplay,
    prepareDependenciesFn: noopDeps,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "provider_rate_limited");
  assert.equal(kimiInvocations, 1, "Exactly 1 attempt made");
  assert.equal(claudeInvocations, 0, "Zero Claude escalation on rate limiting");
  assert.equal(result.attempts?.length, 1);
});
