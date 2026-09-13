import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";

/**
 * Content-addressed local object storage for project assets (Macro Run 5).
 *
 * Binary identity is the SHA-256 over the exact object bytes; storage keys
 * are derived ONLY from validated lowercase hex digests plus fixed segments
 * — operator-supplied filenames never reach a filesystem path. Objects live
 * under the gitignored `.factory/assets/` runtime evidence root (same
 * durability tier as blueprint artifacts); PostgreSQL remains the
 * authoritative metadata/lifecycle state.
 *
 * Write semantics: temp-file -> rename for atomic publication; an object
 * already present under its digest key is left untouched (content-addressed
 * objects are immutable, so overwrite is impossible by construction).
 */

const ASSETS_ROOT_SEGMENT = ".factory";
const OBJECTS_SEGMENT = "assets";
const OBJECTS_DIR = "objects";
const DERIVATIVES_DIR = "derivatives";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface AssetStorage {
  /** Content-addressed key for an original object: objects/sha256/<d2>/<digest>. */
  objectKey(binaryDigest: string): string;
  /** Content-addressed key for a derivative object: derivatives/sha256/<d2>/<digest>. */
  derivativeKey(binaryDigest: string): string;
  /** Absolute filesystem path for a storage key (contained; fails closed). */
  absolutePath(storageKey: string): string;
  /** Write exact bytes at the digest-derived key (atomic, never overwrites). */
  putObject(storageKey: string, bytes: Uint8Array): Promise<void>;
  /** Read exact bytes back; missing objects fail closed. */
  getObject(storageKey: string): Promise<Uint8Array>;
  /** True when an object exists under the given key. */
  hasObject(storageKey: string): Promise<boolean>;
}

/** SHA-256 over the exact bytes (binary identity — NOT a governance digest). */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertHexDigest(digest: string, label: string): void {
  if (!HEX_DIGEST_PATTERN.test(digest)) {
    throw new FactoryError("asset_storage_failed", `${label} is not a valid lowercase SHA-256 hex digest.`);
  }
}

export function createAssetStorage(repoRoot: string): AssetStorage {
  const assetsRoot = path.resolve(repoRoot, ASSETS_ROOT_SEGMENT, OBJECTS_SEGMENT);

  const objectKey = (binaryDigest: string): string => {
    assertHexDigest(binaryDigest, "binary digest");
    // Two-character fan-out keeps directories small; every path segment is
    // either a fixed literal or validated hex — no external input involved.
    return path.posix.join(OBJECTS_DIR, "sha256", binaryDigest.slice(0, 2), binaryDigest);
  };

  const derivativeKey = (binaryDigest: string): string => {
    assertHexDigest(binaryDigest, "derivative digest");
    return path.posix.join(DERIVATIVES_DIR, "sha256", binaryDigest.slice(0, 2), binaryDigest);
  };

  const absolutePath = (storageKey: string): string => {
    // Fail closed on anything that is not an exact, generated key shape.
    const normalized = path.posix.normalize(storageKey);
    const segments = normalized.split("/");
    const valid =
      (normalized.startsWith(`${OBJECTS_DIR}/sha256/`) ||
        normalized.startsWith(`${DERIVATIVES_DIR}/sha256/`)) &&
      segments.length === 4 &&
      segments.every((segment) => segment.length > 0 && /^[a-z0-9]+$/.test(segment)) &&
      HEX_DIGEST_PATTERN.test(segments[3]!);
    if (!valid) {
      throw new FactoryError("asset_storage_failed", `storage key is not a recognized content-addressed key.`);
    }
    const resolved = path.resolve(assetsRoot, normalized);
    const relative = path.relative(assetsRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FactoryError("asset_storage_failed", "storage key escapes the asset storage root.");
    }
    return resolved;
  };

  return {
    objectKey,
    derivativeKey,
    absolutePath,
    async putObject(storageKey, bytes) {
      const target = absolutePath(storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      // Content-addressed immutability: existing objects are never rewritten.
      if (await exists(target)) return;
      // Publish atomically via temp file -> rename inside the same directory.
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmp, bytes);
        try {
          await rename(tmp, target);
        } catch {
          // Concurrent publication of the identical digest: verify presence
          // and treat as success; the object is byte-identical by construction.
          if (await exists(target)) return;
          throw new FactoryError("asset_storage_failed", "Failed to publish asset object to local storage.");
        }
      } finally {
        // Best-effort temp cleanup on failure paths (rename already moved it
        // on success; remove() tolerates a missing file).
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    },
    async getObject(storageKey) {
      const target = absolutePath(storageKey);
      try {
        return new Uint8Array(await readFile(target));
      } catch {
        throw new FactoryError(
          "asset_storage_failed",
          "Asset object is missing from local storage (metadata and bytes diverged).",
        );
      }
    },
    async hasObject(storageKey) {
      try {
        return await exists(absolutePath(storageKey));
      } catch {
        return false;
      }
    },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
