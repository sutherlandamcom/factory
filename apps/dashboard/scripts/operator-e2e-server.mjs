#!/usr/bin/env node
/**
 * Operator E2E server supervisor.
 *
 * Starts the real Operator service (which serves the built dashboard dist)
 * as a child process against the dedicated test PostgreSQL database, waits
 * for readiness, and supports a REAL process restart (SIGTERM -> start
 * again) WITHOUT touching the database — the persistence-restart step of
 * the operator journey.
 *
 * Protocol (for the E2E spec):
 * - Parent process env FACTORY_E2E_SUPERVISOR_PORT (default 4177) serves a
 *   tiny control API: POST /start, POST /restart, POST /stop.
 * - Child operator server port: FACTORY_OPERATOR_PORT (default 4175).
 *
 * The child is the production entrypoint (tsx src/operator/server.ts) — the
 * supervisor adds no behavior of its own.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPERATOR_PORT = Number(process.env.FACTORY_OPERATOR_PORT || 4175);
const SUPERVISOR_PORT = Number(process.env.FACTORY_E2E_SUPERVISOR_PORT || 4177);
const FACTORY_ROOT = path.resolve(__dirname, "../../factory");
// The operator server reads FACTORY_DATABASE_URL in production mode; the E2E
// targets the dedicated test database validated by operator-e2e-setup.mjs.
// The port is passed explicitly so the child always matches the port the
// supervisor and Playwright wait on.
const CHILD_ENV = {
  ...process.env,
  FACTORY_OPERATOR_PORT: String(OPERATOR_PORT),
  FACTORY_DATABASE_URL: process.env.FACTORY_TEST_DATABASE_URL || process.env.FACTORY_DATABASE_URL,
  // E2E runs Search with the deterministic fixture provider/analyst so the
  // full journey never touches a paid provider or the network. This env is
  // read only by the trusted backend (never by the browser).
  FACTORY_SEARCH_MODE: process.env.FACTORY_SEARCH_MODE || "fixture",
  FACTORY_COMPETITOR_MODE: process.env.FACTORY_COMPETITOR_MODE || "fixture",
};

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let stopping = false;

function log(msg) {
  console.log(`[operator-supervisor] ${msg}`);
}

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not ready within ${timeoutMs}ms`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

async function startOperator() {
  if (child) throw new Error("operator already running");
  child = spawn(
    process.execPath,
    [path.join(FACTORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/operator/server.ts"],
    {
      cwd: FACTORY_ROOT,
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => process.stdout.write(`[operator] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[operator] ${d}`));
  child.once("exit", (code, signal) => {
    log(`operator exited code=${code} signal=${signal}`);
    child = null;
  });
  await waitForPort(OPERATOR_PORT, "127.0.0.1", 30_000);
  log(`operator ready on 127.0.0.1:${OPERATOR_PORT}`);
}

async function stopOperator() {
  if (!child) return;
  stopping = true;
  const c = child;
  await new Promise((resolve) => {
    c.once("exit", resolve);
    c.kill("SIGTERM");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
  stopping = false;
  log("operator stopped");
}

async function restartOperator() {
  await stopOperator();
  await startOperator();
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "POST" && req.url === "/start") {
      await startOperator();
      return send(200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/restart") {
      await restartOperator();
      return send(200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/stop") {
      await stopOperator();
      return send(200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true, running: Boolean(child) });
    }
    return send(404, { error: { code: "not_found", message: "unknown" } });
  } catch (err) {
    return send(500, { error: { code: "supervisor_error", message: err instanceof Error ? err.message : String(err) } });
  }
});

server.listen(SUPERVISOR_PORT, "127.0.0.1", () => {
  log(`supervisor control on 127.0.0.1:${SUPERVISOR_PORT}`);
});

async function shutdown() {
  await stopOperator();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
