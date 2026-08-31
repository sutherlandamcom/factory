import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUN_ID_PATTERN,
  buildArtifactDigests,
  generateRunId,
  intelligenceRunDirectory,
  prepareRunDirectory,
  publishJsonAtomically,
  randomRunIdSuffix,
  verifyArtifactIntegrity,
  writeArtifact,
} from "../src/intelligence/artifacts.js";
import { deterministicDigest } from "../src/intelligence/digest.js";

async function tempRepo(): Promise<string> {
  return realpathSync(await mkdtemp(path.join(os.tmpdir(), "intelligence-artifacts-")));
}

const FIXED_NOW = new Date("2026-08-31T10:15:00Z");

test("runId generation is deterministic, pattern-validated, and traversal-free", () => {
  const runId = generateRunId(FIXED_NOW, "a1b2c3d4");
  assert.equal(runId, "20260831T101500Z-a1b2c3d4");
  assert.match(runId, RUN_ID_PATTERN);
  assert.throws(() => generateRunId(FIXED_NOW, "../evil"));
  assert.throws(() => generateRunId(FIXED_NOW, "not hex!"));
  assert.throws(() => intelligenceRunDirectory("/repo", "../../escape"));
  assert.throws(() => intelligenceRunDirectory("/repo", "valid-but-not-a-run-id"));
  // Random suffixes are unique enough for per-run isolation.
  assert.notEqual(randomRunIdSuffix(), randomRunIdSuffix());
});

test("prepareRunDirectory creates a fresh directory and refuses reuse", async () => {
  const repoRoot = await tempRepo();
  const runId = generateRunId(FIXED_NOW, "00000001");
  const runDir = await prepareRunDirectory(repoRoot, runId);
  assert.equal(runDir, intelligenceRunDirectory(repoRoot, runId));
  await assert.rejects(() => prepareRunDirectory(repoRoot, runId), /already exists/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("prepareRunDirectory fails closed on a symlinked intelligence root", async () => {
  const repoRoot = await tempRepo();
  const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
  await mkdir(path.join(repoRoot, ".factory"), { recursive: true });
  await symlink(outside, path.join(repoRoot, ".factory", "intelligence"));
  await assert.rejects(
    () => prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000002")),
    /non-symlink/,
  );
  await rm(repoRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("artifact writer rejects traversal and absolute paths", async () => {
  const repoRoot = await tempRepo();
  const runDir = await prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000003"));
  await assert.rejects(() => writeArtifact(runDir, "../escape.txt", "nope"), /escapes the run directory/);
  await assert.rejects(() => writeArtifact(runDir, "/etc/evil", "nope"), /must be relative/);
  await assert.rejects(() => writeArtifact(runDir, "nested/../../escape.txt", "nope"), /escapes/);
  await rm(repoRoot, { recursive: true, force: true });
});

test("artifact writer refuses symlink redirection", async () => {
  const repoRoot = await tempRepo();
  const runDir = await prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000004"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
  const outsideFile = path.join(outside, "victim.txt");
  await writeFile(outsideFile, "original");
  await symlink(outsideFile, path.join(runDir, "plan.json"));
  await assert.rejects(() => writeArtifact(runDir, "plan.json", "malicious"), /symlink/);
  assert.equal(await readFile(outsideFile, "utf8"), "original");
  await rm(repoRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("publishJsonAtomically writes valid JSON and leaves no temp files", async () => {
  const repoRoot = await tempRepo();
  const runDir = await prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000005"));
  await publishJsonAtomically(runDir, "manifest.json", { hello: "world" });
  const written = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  assert.deepEqual(written, { hello: "world" });
  const entries = await readdir(runDir);
  assert.deepEqual(entries.filter((entry) => entry.includes(".tmp-")), []);
  // An atomic temp file does not masquerade as the final result.
  await writeFile(path.join(runDir, ".intelligence-result.json.tmp-deadbeef"), "garbage");
  await assert.rejects(() => readFile(path.join(runDir, "intelligence-result.json"), "utf8"));
  await rm(repoRoot, { recursive: true, force: true });
});

test("publishJsonAtomically replaces a planted symlink instead of writing through it", async () => {
  const repoRoot = await tempRepo();
  const runDir = await prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000006"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
  const victim = path.join(outside, "victim.json");
  await writeFile(victim, "{}");
  await symlink(victim, path.join(runDir, "manifest.json"));
  await publishJsonAtomically(runDir, "manifest.json", { safe: true });
  assert.equal(await readFile(victim, "utf8"), "{}");
  assert.deepEqual(JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")), { safe: true });
  const realTarget = await realpath(path.join(runDir, "manifest.json"));
  assert.equal(realTarget, path.join(runDir, "manifest.json"));
  await rm(repoRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("manifest digests verify against actual bytes and detect tampering", async () => {
  const repoRoot = await tempRepo();
  const runDir = await prepareRunDirectory(repoRoot, generateRunId(FIXED_NOW, "00000007"));
  await writeArtifact(runDir, "site-intelligence.json", `${JSON.stringify({ siteId: "demo", pages: [] })}\n`);
  await writeArtifact(runDir, "request.json", "{}\n");
  const files = ["site-intelligence.json", "request.json"];
  const digests = await buildArtifactDigests(runDir, files);
  // Byte-level digests are 64-hex; the canonical plan digest binding is separate.
  assert.match(digests["request.json"]!, /^[0-9a-f]{64}$/);
  assert.notEqual(digests["request.json"], deterministicDigest({}));

  await verifyArtifactIntegrity(runDir, digests, deterministicDigest({ siteId: "demo", pages: [] }));
  // Tamper with a file → integrity must fail.
  await writeArtifact(runDir, "request.json", '{"tampered":true}\n');
  await assert.rejects(
    () => verifyArtifactIntegrity(runDir, digests, deterministicDigest({ siteId: "demo", pages: [] })),
    /integrity mismatch/,
  );
  // Stale plan from a previous run must not satisfy the current planDigest.
  await writeArtifact(runDir, "request.json", "{}\n");
  await assert.rejects(
    () => verifyArtifactIntegrity(runDir, digests, deterministicDigest({ siteId: "another-run", pages: [] })),
    /stale or corrupted/,
  );
  await rm(repoRoot, { recursive: true, force: true });
});
