import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv } from "../src/executor/env.js";

test("child env forwards only the allowlist", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/test",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/home/test/.codex",
    CLOUDFLARE_API_TOKEN: "cf-secret",
    GITHUB_TOKEN: "gh-secret",
    DATABASE_URL: "postgres://secret",
    DATAFORSEO_KEY: "dfs-secret",
    FIRECRAWL_API_KEY: "fc-secret",
    SMTP_PASSWORD: "smtp-secret",
    OPENAI_API_KEY: "sk-secret",
    RANDOM_API_KEY: "random-secret",
  };
  const env = buildChildEnv(parent);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.CODEX_HOME, "/home/test/.codex");
  for (const secret of [
    "CLOUDFLARE_API_TOKEN",
    "GITHUB_TOKEN",
    "DATABASE_URL",
    "DATAFORSEO_KEY",
    "FIRECRAWL_API_KEY",
    "SMTP_PASSWORD",
    "OPENAI_API_KEY",
    "RANDOM_API_KEY",
  ]) {
    assert.equal(env[secret], undefined, `${secret} must not be forwarded`);
  }
  // No secret values leak anywhere in the child env.
  assert.ok(!Object.values(env).some((v) => v !== undefined && v.includes("secret")));
});
