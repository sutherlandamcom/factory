import assert from "node:assert/strict";
import test from "node:test";
import { exists } from "../src/production/qa/collector.js";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Run 11 Remediation — Async exists() tests.
 *
 * Requirements:
 *  - Existing path -> true
 *  - Missing path -> false
 *  - Other errors -> follow existing fail-closed policy (throws)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(here, "__test_exists_tmp__");

test("exists: existing file returns true", async () => {
  mkdirSync(tempDir, { recursive: true });
  const testFile = path.join(tempDir, "sample.txt");
  writeFileSync(testFile, "hello");
  try {
    const result = await exists(testFile);
    assert.equal(result, true);
  } finally {
    try { unlinkSync(testFile); } catch {}
    try { rmdirSync(tempDir); } catch {}
  }
});

test("exists: missing file returns false", async () => {
  const missingFile = path.join(here, `missing-${Date.now()}-${Math.random()}.txt`);
  const result = await exists(missingFile);
  assert.equal(result, false);
});

test("exists: non-ENOENT error fails closed by rethrowing", async () => {
  // Pass a path that causes an error other than ENOENT (e.g., null byte on POSIX throws EINVAL or TypeError)
  await assert.rejects(
    async () => {
      await exists("\0invalid-null-byte-path");
    },
    (err: unknown) => {
      // Must not silently swallow non-ENOENT errors
      return err instanceof Error;
    },
  );
});
