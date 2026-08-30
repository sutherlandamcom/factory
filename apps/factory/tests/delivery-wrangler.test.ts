import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "../src/executor/env.js";
import {
  buildWranglerEnv,
  parseCurrentVersion,
  parseVersionUpload,
  WranglerClient,
} from "../src/delivery/wrangler.js";

test("Cloudflare credentials cross only the narrow Wrangler environment", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CLOUDFLARE_API_TOKEN: "secret-token",
    CLOUDFLARE_ACCOUNT_ID: "secret-account",
    DATABASE_URL: "postgres://secret",
    PUBLIC_SITE_URL: "https://should-not-cross.example",
  };
  const generic = buildChildEnv(parent);
  assert.equal(generic.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(generic.CLOUDFLARE_ACCOUNT_ID, undefined);

  const wrangler = buildWranglerEnv(parent, "/tmp/fresh.ndjson");
  assert.equal(wrangler.CLOUDFLARE_API_TOKEN, "secret-token");
  assert.equal(wrangler.CLOUDFLARE_ACCOUNT_ID, "secret-account");
  assert.equal(wrangler.DATABASE_URL, undefined);
  assert.equal(wrangler.PUBLIC_SITE_URL, undefined);
  assert.equal(wrangler.WRANGLER_OUTPUT_FILE_PATH, "/tmp/fresh.ndjson");
});

test("Wrangler client refuses stale structured mutation output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-wrangler-stale-"));
  try {
    const site = path.join(root, "site");
    const artifacts = path.join(root, "artifacts");
    await mkdir(site);
    await mkdir(artifacts);
    await writeFile(path.join(artifacts, "wrangler-upload.ndjson"), "stale\n");
    const client = new WranglerClient(site, artifacts, {
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
    });
    await assert.rejects(
      () => client.upload("factory-site"),
      (error: unknown) => (error as { code?: string }).code === "provider_output_stale",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload parser requires one matching structured success record", () => {
  const raw = [
    JSON.stringify({ type: "wrangler-session", version: 1 }),
    JSON.stringify({
      type: "version-upload",
      version: 1,
      worker_name: "factory-site",
      version_id: "candidate-v1",
      preview_url: "https://abc-factory-site.example.workers.dev",
    }),
  ].join("\n");
  assert.deepEqual(parseVersionUpload(raw, "factory-site"), {
    workerName: "factory-site",
    versionId: "candidate-v1",
    previewUrl: "https://abc-factory-site.example.workers.dev/",
  });
  assert.throws(() => parseVersionUpload("not-json", "factory-site"), /malformed structured JSON/);
  assert.throws(
    () => parseVersionUpload(raw, "other-worker"),
    (error: unknown) => (error as { code?: string }).code === "provider_identity_mismatch",
  );
});

test("production state parser fails closed on split traffic", () => {
  assert.equal(parseCurrentVersion("[]"), null);
  assert.equal(
    parseCurrentVersion(JSON.stringify([{ versions: [{ version_id: "v1", percentage: 100 }] }])),
    "v1",
  );
  assert.equal(
    parseCurrentVersion(JSON.stringify([
      { versions: [{ version_id: "old", percentage: 100 }] },
      { versions: [{ version_id: "new", percentage: 100 }] },
    ])),
    "new",
  );
  assert.throws(
    () => parseCurrentVersion(JSON.stringify([{ versions: [
      { version_id: "v1", percentage: 50 },
      { version_id: "v2", percentage: 50 },
    ] }])),
    (error: unknown) => (error as { code?: string }).code === "deployment_drift",
  );
});
