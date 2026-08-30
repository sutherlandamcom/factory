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
