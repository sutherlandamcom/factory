#!/usr/bin/env node
/**
 * E2E runner: starts the operator supervisor (which owns the real operator
 * service process), runs Playwright, then shuts the supervisor down.
 * Exit code mirrors Playwright's.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, "..");
const SUPERVISOR_PORT = Number(process.env.FACTORY_E2E_SUPERVISOR_PORT || 4177);

if (!process.env.FACTORY_TEST_DATABASE_URL?.trim()) {
  console.error("[e2e-run] FACTORY_TEST_DATABASE_URL is required (dedicated factory_test DB).");
  process.exit(1);
}

function supervisorCall(pathname, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${SUPERVISOR_PORT}${pathname}`,
      { method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 200
            ? resolve()
            : reject(new Error(`supervisor ${pathname} -> ${res.statusCode}`)),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${pathname} timed out`)));
    req.end();
  });
}

async function waitForSupervisor(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${SUPERVISOR_PORT}/health`, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error("bad status"));
        });
        req.on("error", reject);
        req.setTimeout(1_000, () => req.destroy(new Error("timeout")));
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("supervisor did not become ready");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const supervisor = spawn(
  process.execPath,
  [path.join(DASHBOARD_ROOT, "scripts", "operator-e2e-server.mjs")],
  { stdio: "inherit", env: process.env },
);

let playwrightExit = 1;
try {
  await waitForSupervisor(15_000);
  // Start the real operator service child (serves built dashboard dist).
  await supervisorCall("/start");
  const args = ["exec", "playwright", "test", "--config=playwright.e2e.config.ts"];
  if (process.argv.slice(2).length > 0) args.push(...process.argv.slice(2));
  playwrightExit = await new Promise((resolve) => {
    const pw = spawn("pnpm", args, { cwd: DASHBOARD_ROOT, stdio: "inherit", env: process.env });
    pw.on("exit", resolve);
  });
} finally {
  // Stop the operator child, then the supervisor itself.
  await supervisorCall("/stop").catch(() => {});
  supervisor.kill("SIGTERM");
}

process.exit(playwrightExit);
