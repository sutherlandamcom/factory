import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv } from "../src/executor/env.js";
import { resolveDatabaseConfig, sanitizeDatabaseUrl } from "../src/persistence/config.js";
import { buildFailureReport } from "../src/executor/classify.js";
import { runSiteTask } from "../src/executor/run.js";
import { FactoryError } from "../src/executor/errors.js";

const SYNTHETIC_SECRET = "SUPER_SECRET_SYNTHETIC_PASSWORD_998877";
const SYNTHETIC_DATABASE_URL = `postgresql://factory_user:${SYNTHETIC_SECRET}@db.example.internal:5432/factory_prod`;

test("sanitizeDatabaseUrl redacts database credentials from URLs and messages", () => {
  const sanitized = sanitizeDatabaseUrl(SYNTHETIC_DATABASE_URL);
  assert.ok(!sanitized.includes(SYNTHETIC_SECRET), "Secret password must be redacted");
  assert.match(sanitized, /postgresql:\/\/factory_user:\*\*\*@db\.example\.internal:5432\/factory_prod/);

  const errorMsg = `Connection failed: error connecting to ${SYNTHETIC_DATABASE_URL}`;
  const sanitizedMsg = sanitizeDatabaseUrl(errorMsg);
  assert.ok(!sanitizedMsg.includes(SYNTHETIC_SECRET));
});

test("database credentials are excluded from child process environment", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    FACTORY_DATABASE_URL: SYNTHETIC_DATABASE_URL,
    DATABASE_URL: SYNTHETIC_DATABASE_URL,
    PGPASSWORD: SYNTHETIC_SECRET,
    PGPASSFILE: "/tmp/pgpass",
    PGSERVICE: "service_name",
    PGSERVICEFILE: "/tmp/pgservice",
  };

  const childEnv = buildChildEnv(parentEnv);

  for (const forbiddenKey of [
    "FACTORY_DATABASE_URL",
    "DATABASE_URL",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
  ]) {
    assert.equal(childEnv[forbiddenKey], undefined, `${forbiddenKey} must not be in child environment`);
  }

  // Ensure no secret value appears anywhere in child environment values
  for (const [key, value] of Object.entries(childEnv)) {
    assert.ok(
      !value?.includes(SYNTHETIC_SECRET),
      `Environment variable ${key} contains secret credential value!`,
    );
  }
});

test("database configuration error does not leak secrets in error message", () => {
  assert.throws(
    () => {
      resolveDatabaseConfig({
        url: `invalid-protocol://factory:${SYNTHETIC_SECRET}@host:5432/db`,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof FactoryError);
      assert.equal(err.code, "database_configuration_invalid");
      assert.ok(
        !err.message.includes(SYNTHETIC_SECRET),
        `Error message must not leak password: ${err.message}`,
      );
      return true;
    },
  );
});

test("FailureReport and TaskResult scrub synthetic database secrets", async () => {
  const failureReport = buildFailureReport({
    runId: "run-test-123",
    attemptNumber: 1,
    failingStage: "qa",
    failureCode: "qa_failed",
    message: `Database error encountered: ${SYNTHETIC_DATABASE_URL}`,
    stdout: `Stdout containing secret url: ${SYNTHETIC_DATABASE_URL}`,
    stderr: `Stderr containing connection string: ${SYNTHETIC_DATABASE_URL}`,
    targetSlug: "/services/roof-repair",
    changedFiles: ["sites/starter/src/pages/services/roof-repair.astro"],
    authorizedScope: "sites/starter/src/pages/services/roof-repair.astro",
  });

  const reportJson = JSON.stringify(failureReport);
  assert.ok(
    !reportJson.includes(SYNTHETIC_SECRET),
    "FailureReport JSON must not contain raw secret password",
  );
  assert.ok(
    reportJson.includes("***"),
    "FailureReport JSON must contain redacted placeholder",
  );
});
