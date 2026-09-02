import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../src/executor/process.js";
import { buildChildEnv } from "../src/executor/env.js";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tsxBin = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");

const evalScript = `
(async () => {
  const module = await import('./sites/starter/playwright.config.ts');
  console.log(JSON.stringify({ baseURL: module.default.use.baseURL, webServer: module.default.webServer ?? null }));
})()
`;

test("remote Playwright mode targets HTTPS and does not start local Astro preview", async () => {
  const result = await runProcess(
    tsxBin,
    ["--eval", evalScript],
    {
      cwd: repoRoot,
      env: buildChildEnv(process.env, {
        FACTORY_QA_BASE_URL: "https://candidate.example.workers.dev",
        PUBLIC_SITE_URL: "https://production.example.com",
      }),
      timeoutMs: 30_000,
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const config = JSON.parse(result.stdout.trim()) as { baseURL: string; webServer: unknown };
  assert.equal(config.baseURL, "https://candidate.example.workers.dev");
  assert.equal(config.webServer, null);
});

test("local Playwright mode preserves built Astro preview server", async () => {
  const result = await runProcess(
    tsxBin,
    ["--eval", evalScript],
    {
      cwd: repoRoot,
      env: buildChildEnv(process.env, { FACTORY_QA_PORT: "4567" }),
      timeoutMs: 30_000,
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const config = JSON.parse(result.stdout.trim()) as {
    baseURL: string;
    webServer: { command: string; url: string };
  };
  assert.equal(config.baseURL, "http://localhost:4567");
  assert.match(config.webServer.command, /pnpm run build.*pnpm run preview/);
  assert.equal(config.webServer.url, "http://localhost:4567");
});

test("Playwright webServer environment derives PUBLIC_SITE_URL from validated profile and respects explicit override", async () => {
  const envCheckScript = `
(async () => {
  const module = await import('./sites/starter/playwright.config.ts');
  console.log(JSON.stringify({
    publicSiteUrl: module.default.webServer?.env?.PUBLIC_SITE_URL ?? null,
  }));
})()
`;
  const defaultResult = await runProcess(
    tsxBin,
    ["--eval", envCheckScript],
    {
      cwd: repoRoot,
      env: buildChildEnv(process.env, {}),
      timeoutMs: 30_000,
    },
  );
  assert.equal(defaultResult.exitCode, 0, defaultResult.stderr);
  const defaultConfig = JSON.parse(defaultResult.stdout.trim()) as { publicSiteUrl: string };
  assert.equal(defaultConfig.publicSiteUrl, "http://localhost:4321");

  const overrideResult = await runProcess(
    tsxBin,
    ["--eval", envCheckScript],
    {
      cwd: repoRoot,
      env: buildChildEnv(process.env, { PUBLIC_SITE_URL: "https://test.example.com" }),
      timeoutMs: 30_000,
    },
  );
  assert.equal(overrideResult.exitCode, 0, overrideResult.stderr);
  const overrideConfig = JSON.parse(overrideResult.stdout.trim()) as { publicSiteUrl: string };
  assert.equal(overrideConfig.publicSiteUrl, "https://test.example.com");
});
