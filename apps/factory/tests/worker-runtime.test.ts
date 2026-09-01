import assert from "node:assert/strict";
import test from "node:test";
import { FactoryError } from "../src/executor/errors.js";
import { extractRespondedModel } from "../src/executor/runtime.js";
import {
  ANTHROPIC_SURFACE_CANDIDATES,
  buildClaudeContainerArgs,
  buildClaudeRuntimeEnv,
  buildClaudeSettingsJson,
  CLAUDE_SENIOR_MODEL,
  CLAUDE_SMALL_FAST_MODEL,
  parseClaudeJsonResult,
  resolveAnthropicSurface,
} from "../src/executor/claude.js";
import { buildKimiConfigToml } from "../src/executor/kimi.js";

test("extractRespondedModel reads the last model field from stream-json events", () => {
  const stream = [
    '{"type":"start"}',
    '{"type":"message","model":"moonshotai/kimi-k3"}',
    "not json at all",
    '{"type":"done","model":"fallback-echo"}',
  ].join("\n");
  assert.equal(extractRespondedModel(stream), "fallback-echo");
  assert.equal(extractRespondedModel("plain text output"), null);
  assert.equal(extractRespondedModel(""), null);
});

test("kimi ephemeral config pins the exact OpenRouter model, effort max, and disables web/MCP/subagents", () => {
  const config = buildKimiConfigToml({
    apiKey: "sk-or-test",
    model: "moonshotai/kimi-k3",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    reasoningEffort: "max",
  });
  assert.match(config, /default_model = "factory-openrouter\/kimi-k3"/);
  assert.match(config, /model = "moonshotai\/kimi-k3"/);
  assert.match(config, /default_effort = "max"/);
  assert.match(config, /effort = "max"/);
  assert.match(config, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(config, /telemetry = false/);
  assert.match(config, /default_permission_mode = "auto"/);
  assert.match(config, /"mcp__\*"/);
  for (const disabled of ["WebSearch", "WebFetch", "Task", "Agent"]) {
    assert.match(config, new RegExp(`"${disabled}"`));
  }
  // Credential materializes ONLY here; it must never appear in logs.
  assert.match(config, /sk-or-test/);
});

test("claude settings deny web tools and subagents and disable MCP/telemetry", () => {
  const settings = JSON.parse(buildClaudeSettingsJson()) as {
    permissions: { defaultMode: string; deny: string[] };
    env: Record<string, string>;
  };
  assert.equal(settings.permissions.defaultMode, "acceptEdits");
  for (const denied of ["WebFetch", "WebSearch", "Task", "Agent"]) {
    assert.ok(settings.permissions.deny.includes(denied));
  }
  assert.equal(settings.env.DISABLE_TELEMETRY, "1");
  assert.equal(settings.env.DISABLE_AUTOUPDATER, "1");
});

test("claude runtime env pins every model alias to exact OpenRouter slugs", () => {
  const env = buildClaudeRuntimeEnv("sk-or-placeholder", "https://openrouter.ai/api");
  assert.equal(env.ANTHROPIC_MODEL, "anthropic/claude-opus-5");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/claude-haiku-4.5");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, CLAUDE_SENIOR_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, CLAUDE_SENIOR_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, CLAUDE_SMALL_FAST_MODEL);
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-or-placeholder");
  for (const value of Object.values(env)) {
    assert.ok(!String(value).startsWith("~"), "no alias models in the runtime env");
  }
});

test("claude container args carry the pinned env and hardened mounts", () => {
  const env = buildClaudeRuntimeEnv("sk-or-placeholder", "https://openrouter.ai/api");
  const args = buildClaudeContainerArgs(
    {
      worktreePath: "/repo/.factory/worktrees/demo",
      prompt: "p",
      runDir: "/repo/.factory/runs/demo/attempts/1",
      timeoutMs: 1000,
      writablePaths: ["sites/starter/src/pages/services/x.astro"],
    },
    "factory-claude-demo-abc",
    "/repo/.factory/claude-runtime/factory-claude-demo-abc",
    env,
  );
  const joined = args.join(" ");
  assert.match(joined, /--read-only/);
  assert.match(joined, /--cap-drop=ALL/);
  assert.match(joined, /--security-opt=no-new-privileges/);
  assert.match(joined, /--network factory-runtime-net/);
  assert.match(joined, /ANTHROPIC_MODEL=anthropic\/claude-opus-5/);
  assert.match(joined, /ANTHROPIC_AUTH_TOKEN=sk-or-placeholder/);
  assert.match(joined, /dst=\/workspace,readonly/);
  assert.match(joined, /dst=\/workspace\/sites\/starter\/src\/pages\/services /);
  assert.match(joined, /dst=\/claude-config,readonly/);
});

test("claude json result parsing is best-effort with null provenance", () => {
  const parsed = parseClaudeJsonResult('{"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.01}');
  assert.equal(parsed?.model, "claude-opus-5");
  assert.equal(parsed?.inputTokens, 10);
  assert.equal(parseClaudeJsonResult("garbage"), null);
  assert.equal(parseClaudeJsonResult("{}")?.model, null);
});

test("anthropic surface probe resolves the first candidate that answers; fails closed on 404s", async () => {
  const calls: string[] = [];
  const surface = await resolveAnthropicSurface("sk-or-test", async (url) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  });
  assert.equal(surface.baseUrl, ANTHROPIC_SURFACE_CANDIDATES[0]!.baseUrl);
  assert.equal(calls.length, 1);

  let index = 0;
  const fallback = await resolveAnthropicSurface("sk-or-test", async (url) => {
    index++;
    calls.push(String(url));
    return new Response("{}", { status: index === 1 ? 404 : 401 });
  });
  assert.equal(fallback.baseUrl, ANTHROPIC_SURFACE_CANDIDATES[1]!.baseUrl);

  await assert.rejects(
    () =>
      resolveAnthropicSurface("sk-or-test", async () => new Response("{}", { status: 404 })),
    (err: unknown) => err instanceof FactoryError && err.code === "claude_runtime_unavailable",
  );
});

