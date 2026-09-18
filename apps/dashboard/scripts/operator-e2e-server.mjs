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
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
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
  // Trusted QA scanners may be installed in the user bin dir (osv-scanner is
  // environment tooling, not a repo dependency); extend PATH so the operator
  // child's executor can resolve them.
  PATH: `${process.env.HOME}/bin:${process.env.PATH ?? ""}`,
  FACTORY_OPERATOR_PORT: String(OPERATOR_PORT),
  FACTORY_DATABASE_URL: process.env.FACTORY_TEST_DATABASE_URL || process.env.FACTORY_DATABASE_URL,
  // E2E runs Search with the deterministic fixture provider/analyst so the
  // full journey never touches a paid provider or the network. This env is
  // read only by the trusted backend (never by the browser).
  FACTORY_SEARCH_MODE: process.env.FACTORY_SEARCH_MODE || "fixture",
  FACTORY_COMPETITOR_MODE: process.env.FACTORY_COMPETITOR_MODE || "fixture",
  // Writer pipeline (Macro Run 4): fixture writer provider so the full
  // journey never touches a paid provider. Trusted backend config only.
  FACTORY_WRITER_MODE: process.env.FACTORY_WRITER_MODE || "fixture",
  // Design/visual pipelines (Macro Runs 6–7): deterministic fixture
  // providers so the journey never touches a paid provider. Fixture
  // authority is never production authority; the E2E journey seeds
  // test-only synthetic production authority through the guarded test
  // harness (see run11-synthetic-authority.ts), never via provider modes.
  FACTORY_DESIGN_MODE: process.env.FACTORY_DESIGN_MODE || "fixture",
  FACTORY_VISUAL_MODE: process.env.FACTORY_VISUAL_MODE || "fixture",
  // Run 11: configure the trusted local QA evidence executor (fixed local
  // OSS tools; the browser journey calls the REAL Operator API action).
  FACTORY_QA_EXECUTOR: process.env.FACTORY_QA_EXECUTOR || "local",
  // Derivatives (Macro Run 10): fixture summary provider so the full
  // journey never touches a paid provider. Trusted backend config only.
  FACTORY_SUMMARY_MODE: process.env.FACTORY_SUMMARY_MODE || "fixture",
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
    if (req.method === "POST" && req.url?.startsWith("/seed-synthetic-authority")) {
      // Run 11 test bootstrap ONLY (§53): seeds test-only synthetic
      // production authority into the DEDICATED test database so the
      // browser journey can exercise downstream workflow mechanics. The
      // seed helper fails closed on any non-test database and is never
      // reachable through the production Operator API. The browser journey
      // does not call this endpoint for any workflow action.
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      await new Promise((resolve) => req.on("end", resolve));
      const { projectId, pageSlug } = JSON.parse(raw || "{}");
      if (!projectId || !pageSlug) return send(400, { error: { code: "validation_error", message: "projectId and pageSlug are required." } });
      // The supervisor is a plain Node process; TypeScript sources are
      // executed through the repository's tsx runtime (same as the operator
      // child itself).
      const seedScript = [
        'import { createDatabaseInstance } from "./src/persistence/db.js";',
        'import { seedRun11SyntheticDesignAuthorityForTest } from "./src/production/qa/run11-synthetic-authority.js";',
        "const db = createDatabaseInstance({ connectionString: process.env.FACTORY_TEST_DATABASE_URL, isTest: true }).db;",
        "const result = await seedRun11SyntheticDesignAuthorityForTest(db, { projectId: process.argv[2], pageSlug: process.argv[3] });",
        "process.stdout.write(JSON.stringify(result));",
        "process.exit(0);",
      ].join("\n");
      const seedFile = path.join(FACTORY_ROOT, ".factory-seed-run11.mts");
      writeFileSync(seedFile, seedScript);
      try {
        const seedRes = spawnSync(
          process.execPath,
          [path.join(FACTORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), seedFile, projectId, pageSlug],
          { cwd: FACTORY_ROOT, env: { ...process.env }, encoding: "utf8", timeout: 180_000 },
        );
        if (seedRes.status !== 0) {
          throw new Error(`synthetic seed failed: ${(seedRes.stderr || seedRes.stdout).slice(-300)}`);
        }
        const result = JSON.parse(seedRes.stdout.trim().split("\n").filter(Boolean).pop());
        return send(200, { ok: true, ...result });
      } finally {
        rmSync(seedFile, { force: true });
      }
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
