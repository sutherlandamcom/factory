import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

/**
 * Persistence safety acceptance: the persistence test harness must fail
 * BEFORE any connection attempt when FACTORY_TEST_DATABASE_URL is
 * missing/blank, and fail CLOSED when the URL targets any database other
 * than the dedicated factory_test database. No localhost fallback, no port
 * heuristic.
 *
 * Each case runs in an isolated child process so the ambient CI/local env
 * cannot influence the outcome and the helpers module (which validates at
 * import time) is evaluated under the exact env under test.
 */

const FACTORY_ROOT = new URL("../..", import.meta.url).pathname;
const EVAL_SNIPPET =
  'import("./tests/persistence/helpers.js").then(m => { m.resolveTestDatabaseUrl(); console.log("OK:" + m.TEST_DATABASE_URL); }).catch(e => { console.error("REJECTED:" + (e.code ?? e.name)); console.error("DETAIL:" + (e.message ?? String(e))); process.exit(1); })';

function runHarness(env: NodeJS.ProcessEnv): { status: number; output: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", EVAL_SNIPPET],
      { cwd: FACTORY_ROOT, env: { ...process.env, ...env }, stdio: "pipe", timeout: 30_000 },
    ).toString();
    return { status: 0, output: stdout };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      output: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? ""),
    };
  }
}

test("harness: missing FACTORY_TEST_DATABASE_URL fails before connection", () => {
  const result = runHarness({ FACTORY_TEST_DATABASE_URL: "" });
  assert.equal(result.status, 1, "blank env must cause a hard failure");
  assert.match(result.output, /REJECTED:test_database_url_required/);
});

test("harness: blank (whitespace) FACTORY_TEST_DATABASE_URL fails before connection", () => {
  const result = runHarness({ FACTORY_TEST_DATABASE_URL: "   " });
  assert.equal(result.status, 1);
  assert.match(result.output, /REJECTED:test_database_url_required/);
});

test("harness: wrong database name fails closed", () => {
  const result = runHarness({
    FACTORY_TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/not_factory_test",
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /REJECTED:test_database_url_invalid/);
  assert.match(result.output, /DETAIL:.*"factory_test"/);
});

test("harness: invalid URL fails closed", () => {
  const result = runHarness({ FACTORY_TEST_DATABASE_URL: "not-a-postgres-url" });
  assert.equal(result.status, 1);
  assert.match(result.output, /REJECTED:test_database_url_invalid/);
});

test("harness: explicit dedicated factory_test URL passes (any host port)", () => {
  const result = runHarness({
    FACTORY_TEST_DATABASE_URL: "postgresql://factory:factory_test_password@127.0.0.1:6543/factory_test",
  });
  assert.equal(result.status, 0, "dedicated factory_test on any port must pass");
  assert.match(result.output, /^OK:postgresql:\/\/factory:.*factory_test$/m);
});
