import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAssetStorage, sha256HexBytes } from "../../src/assets/storage.js";
import { AssetService, MAX_UPLOAD_BYTES } from "../../src/assets/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import { FactoryError } from "../../src/executor/errors.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { parseAssetUploadInput } from "@factory/contracts";

/**
 * Asset ingest pipeline acceptance (Macro Run 5):
 *
 * real bytes -> byte-level MIME sniff -> decode -> digest -> storage ->
 * derivatives -> provenance. Negative paths prove fail-closed behavior for
 * unsupported/spoofed/corrupt/oversized/empty input.
 */

let dbInst: FactoryDatabaseInstance;

test.before(async () => {
  dbInst = await setupMigratedTestDatabase();
});

test.after(async () => {
  await dbInst.close();
});

async function makeService(): Promise<{ service: AssetService; storageRoot: string; cleanup: () => Promise<void> }> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-"));
  const storage = createAssetStorage(storageRoot);
  const service = new AssetService({
    store: new AssetStore(dbInst.db),
    storage,
    repoRoot: storageRoot,
  });
  return {
    service,
    storageRoot,
    cleanup: async () => {
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

async function createProject(key: string): Promise<string> {
  const store = new (await import("../../src/persistence/store.js")).FactoryStore(dbInst.db);
  const project = await store.createProject({ key, name: `Project ${key}` });
  return project.id;
}

async function jpegBytes(width: number, height: number, seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: (seed * 37) % 256, g: (seed * 61) % 256, b: (seed * 89) % 256 },
      },
    })
      .jpeg({ quality: 82 })
      .toBuffer(),
  );
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const VALID_UPLOAD = {
  filename: "chamonix-hero.jpg",
  kind: "photo" as const,
  title: "Chamonix homepage hero photograph",
  rightsStatus: "operator_owned" as const,
};

test("ingest: real JPEG upload persists exact-bytes identity, dimensions, derivatives, provenance", async () => {
  const { service, storageRoot, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-ok-${Date.now()}`);
    const bytes = await jpegBytes(1200, 800, 1);
    const result = await service.uploadAsset(projectId, {
      ...VALID_UPLOAD,
      dataBase64: base64(bytes),
    });

    // Exact binary identity.
    assert.match(result.version.binaryDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.version.binaryDigest, sha256HexBytes(bytes));
    assert.equal(result.version.mediaType, "image/jpeg");
    assert.equal(result.version.byteSize, bytes.byteLength);
    assert.equal(result.version.width, 1200);
    assert.equal(result.version.height, 800);
    assert.equal(result.version.approvalState, "pending");
    assert.equal(result.version.rightsStatus, "operator_owned");

    // Provenance: operator upload, evidence-only extracted metadata.
    const provenance = result.version.provenance as { category: string; originalFilename: string; uploadedAt: string };
    assert.equal(provenance.category, "operator_upload");
    assert.equal(provenance.originalFilename, "chamonix-hero.jpg");
    assert.ok(provenance.uploadedAt);

    // Derivatives: web + thumb with real dimensions and own digests.
    assert.equal(result.derivatives.length, 2);
    const web = result.derivatives.find((d) => d.kind === "web")!;
    const thumb = result.derivatives.find((d) => d.kind === "thumb")!;
    assert.equal(web.width, 1200, "web derivative at natural width when under 1600px");
    assert.equal(thumb.width, 320);
    assert.notEqual(web.binaryDigest, result.version.binaryDigest);
    assert.notEqual(thumb.binaryDigest, web.binaryDigest);

    // Original bytes preserved exactly on disk under the content key.
    const storage = createAssetStorage(storageRoot);
    const stored = await storage.getObject(storage.objectKey(result.version.binaryDigest));
    assert.equal(sha256HexBytes(stored), result.version.binaryDigest);

    // Read-back through the service is byte-identical.
    const served = await service.readOriginal(projectId, result.version.id);
    assert.equal(sha256HexBytes(served.bytes), result.version.binaryDigest);
  } finally {
    await cleanup();
  }
});

test("ingest: digest stability — identical bytes produce the identical binary digest", async () => {
  const bytes = await jpegBytes(64, 48, 2);
  assert.equal(sha256HexBytes(bytes), sha256HexBytes(new Uint8Array(bytes)));
});

test("ingest: unsupported byte content is rejected (asset_upload_invalid)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-bad-${Date.now()}`);
    const textBytes = new Uint8Array(Buffer.from("definitely not an image", "utf8"));
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          dataBase64: base64(textBytes),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: extension/MIME mismatch is rejected (jpg filename, PNG bytes)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-spoof-${Date.now()}`);
    const pngBytes = new Uint8Array(
      await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png()
        .toBuffer(),
    );
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          filename: "looks-like-jpg.jpg",
          dataBase64: base64(pngBytes),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: matching PNG upload with .png filename is accepted", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-png-${Date.now()}`);
    const pngBytes = new Uint8Array(
      await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } } })
        .png()
        .toBuffer(),
    );
    const result = await service.uploadAsset(projectId, {
      ...VALID_UPLOAD,
      filename: "chamonix-valley.png",
      dataBase64: base64(pngBytes),
    });
    assert.equal(result.version.mediaType, "image/png");
  } finally {
    await cleanup();
  }
});

test("ingest: corrupt image bytes that cannot decode are rejected", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-corrupt-${Date.now()}`);
    // Valid JPEG magic (sniffs as jpeg) followed by garbage the decoder rejects.
    const corrupt = new Uint8Array(2048);
    corrupt[0] = 0xff;
    corrupt[1] = 0xd8;
    corrupt[2] = 0xff;
    corrupt[3] = 0xe0;
    for (let i = 4; i < corrupt.length; i++) corrupt[i] = (i * 31) % 256;
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          dataBase64: base64(corrupt),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: zero-byte input is rejected", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-empty-${Date.now()}`);
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          dataBase64: base64(new Uint8Array(0)),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: oversized upload beyond MAX_UPLOAD_BYTES is rejected", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-big-${Date.now()}`);
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    // Not decodable anyway; the size gate must fire first with the same code.
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          dataBase64: base64(oversized),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: duplicate exact bytes within a project produce a typed conflict, not a raw 500", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-dup-${Date.now()}`);
    const bytes = await jpegBytes(200, 150, 3);
    const input = { ...VALID_UPLOAD, dataBase64: base64(bytes) };
    const first = await service.uploadAsset(projectId, input);
    // Same bytes, different logical identity (different title) -> distinct
    // asset, but UNIQUE(project_id, binary_digest) forbids a second version
    // row carrying the same bytes.
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...input,
          title: "A different logical asset",
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_assignment_conflict",
    );
    assert.equal(first.version.version, 1);
  } finally {
    await cleanup();
  }
});

test("ingest: same title + kind appends version 2 on the same logical asset", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-v2-${Date.now()}`);
    const v1 = await service.uploadAsset(projectId, {
      ...VALID_UPLOAD,
      dataBase64: base64(await jpegBytes(300, 200, 4)),
    });
    const v2 = await service.uploadAsset(projectId, {
      ...VALID_UPLOAD,
      dataBase64: base64(await jpegBytes(300, 200, 5)),
    });
    assert.equal(v1.asset.id, v2.asset.id, "same identity -> same logical asset");
    assert.equal(v1.version.version, 1);
    assert.equal(v2.version.version, 2);
    assert.notEqual(v1.version.binaryDigest, v2.version.binaryDigest);
  } finally {
    await cleanup();
  }
});

test("ingest: contract parser rejects malformed upload payloads (fail closed)", () => {
  assert.throws(() => parseAssetUploadInput({ dataBase64: "not base64!!", filename: "x.jpg", kind: "photo", title: "t", rightsStatus: "operator_owned" }));
  assert.throws(() => parseAssetUploadInput({ dataBase64: Buffer.from("x").toString("base64"), filename: "x.jpg", kind: "video", title: "t", rightsStatus: "operator_owned" }));
  assert.throws(() => parseAssetUploadInput({ dataBase64: Buffer.from("x").toString("base64"), filename: "x.jpg", kind: "photo", title: "t", rightsStatus: "operator_owned", extra: 1 }));
});

test("storage: keys are content-addressed and reject non-digest input", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-keys-"));
  try {
    const storage = createAssetStorage(storageRoot);
    const key = storage.objectKey("a".repeat(64));
    assert.equal(key, `objects/sha256/aa/${"a".repeat(64)}`);
    assert.throws(() => storage.objectKey("../evil"));
    assert.throws(() => storage.objectKey("A".repeat(64)));
    assert.throws(() => storage.absolutePath("../../etc/passwd"));
    assert.throws(() => storage.absolutePath("objects/sha256/aa/not-a-digest"));
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("storage: putObject never overwrites an existing content-addressed object", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-imm-"));
  try {
    const storage = createAssetStorage(storageRoot);
    const bytesA = new Uint8Array(Buffer.from("payload-a"));
    const digestA = sha256HexBytes(bytesA);
    await storage.putObject(storage.objectKey(digestA), bytesA);
    const firstStat = await stat(storage.absolutePath(storage.objectKey(digestA)));
    // Re-put identical bytes: no rewrite (mtime unchanged proves no overwrite).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await storage.putObject(storage.objectKey(digestA), bytesA);
    const secondStat = await stat(storage.absolutePath(storage.objectKey(digestA)));
    assert.equal(firstStat.mtimeMs, secondStat.mtimeMs, "existing object must not be rewritten");
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("storage: filename input never becomes a path (traversal-safe by construction)", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-trav-"));
  try {
    const storage = createAssetStorage(storageRoot);
    // A malicious "filename" can never reach the storage layer: keys derive
    // from validated digests only.
    const malicious = "../../.env";
    assert.throws(() => storage.absolutePath(malicious));
    const digest = sha256HexBytes(new Uint8Array(Buffer.from("x")));
    const key = storage.objectKey(digest);
    assert.ok(!key.includes(malicious));
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("storage: write + read-back round-trip preserves exact bytes", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-rw-"));
  try {
    const storage = createAssetStorage(storageRoot);
    const bytes = await jpegBytes(50, 40, 6);
    const digest = sha256HexBytes(bytes);
    await storage.putObject(storage.derivativeKey(digest), bytes);
    const round = await storage.getObject(storage.derivativeKey(digest));
    assert.equal(sha256HexBytes(round), digest);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("storage: getObject on a missing object fails closed", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-storage-miss-"));
  try {
    const storage = createAssetStorage(storageRoot);
    const digest = sha256HexBytes(new Uint8Array(Buffer.from("missing")));
    await assert.rejects(() => storage.getObject(storage.objectKey(digest)), FactoryError);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("ingest: webp uploads are accepted (supported media type)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-webp-${Date.now()}`);
    const webpBytes = new Uint8Array(
      await sharp({ create: { width: 60, height: 45, channels: 3, background: { r: 5, g: 6, b: 7 } } })
        .webp()
        .toBuffer(),
    );
    const result = await service.uploadAsset(projectId, {
      ...VALID_UPLOAD,
      filename: "chamonix-detail.webp",
      dataBase64: base64(webpBytes),
    });
    assert.equal(result.version.mediaType, "image/webp");
  } finally {
    await cleanup();
  }
});

test("ingest: SVG is rejected even with a matching .svg filename (unsupported format)", async () => {
  const { service, cleanup } = await makeService();
  try {
    const projectId = await createProject(`ingest-svg-${Date.now()}`);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "utf8");
    // file-type does not sniff SVG from a bare buffer; either way the result
    // must be asset_upload_invalid (unsupported or unrecognized).
    await assert.rejects(
      () =>
        service.uploadAsset(projectId, {
          ...VALID_UPLOAD,
          filename: "mark.svg",
          dataBase64: base64(new Uint8Array(svg)),
        }),
      (error: unknown) => error instanceof FactoryError && error.code === "asset_upload_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("ingest: writeFile helper is not used for storage paths (import audit)", async () => {
  // Static guard: the service must not construct paths from input.filename.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/assets/service.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("path.join("), "service must never build filesystem paths itself");
  assert.ok(!src.includes("input.filename)"), "filename must not flow into path construction");
});
