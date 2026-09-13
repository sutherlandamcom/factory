import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";

/**
 * Content-addressed local storage for Run 7 visual candidates.
 *
 * Identity is SHA-256 over exact provider bytes; keys derive ONLY from
 * validated lowercase hex digests plus fixed segments. Objects live under
 * the gitignored `.factory/visual/candidates/` runtime evidence root (same
 * durability tier as design artifacts and asset objects). Write semantics:
 * temp-file -> rename atomic publication; existing objects are never
 * rewritten (content-addressed immutability).
 */

const VISUAL_ROOT_SEGMENT = ".factory";
const VISUAL_DIR = "visual";
const CANDIDATES_DIR = "candidates";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface VisualCandidateStorage {
  /** Content-addressed key: candidates/sha256/<d2>/<digest>. */
  candidateKey(binaryDigest: string): string;
  /** Write exact bytes (atomic, never overwrites). */
  putCandidate(bytes: Uint8Array): Promise<string>;
  /** Read exact bytes back; missing objects fail closed. */
  getCandidate(storageKey: string): Promise<Uint8Array>;
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertHexDigest(digest: string, label: string): void {
  if (!HEX_DIGEST_PATTERN.test(digest)) {
    throw new FactoryError("visual_provider_output_invalid", `${label} is not a valid lowercase SHA-256 hex digest.`);
  }
}

export function createVisualCandidateStorage(repoRoot: string): VisualCandidateStorage {
  const root = path.resolve(repoRoot, VISUAL_ROOT_SEGMENT, VISUAL_DIR, CANDIDATES_DIR);

  const candidateKey = (binaryDigest: string): string => {
    assertHexDigest(binaryDigest, "candidate binary digest");
    return path.posix.join(CANDIDATES_DIR, "sha256", binaryDigest.slice(0, 2), binaryDigest);
  };

  const absolutePath = (storageKey: string): string => {
    const normalized = path.posix.normalize(storageKey);
    const segments = normalized.split("/");
    const valid =
      normalized.startsWith(`${CANDIDATES_DIR}/sha256/`) &&
      segments.length === 4 &&
      segments.every((segment) => segment.length > 0 && /^[a-z0-9]+$/.test(segment)) &&
      HEX_DIGEST_PATTERN.test(segments[3]!);
    if (!valid) {
      throw new FactoryError("visual_provider_output_invalid", "storage key is not a recognized content-addressed key.");
    }
    const resolved = path.resolve(root, normalized);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FactoryError("visual_provider_output_invalid", "storage key escapes the visual candidate storage root.");
    }
    return resolved;
  };

  const exists = async (target: string): Promise<boolean> => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  };

  return {
    candidateKey,
    async putCandidate(bytes) {
      const digest = sha256HexBytes(bytes);
      const key = candidateKey(digest);
      const target = absolutePath(key);
      await mkdir(path.dirname(target), { recursive: true });
      if (await exists(target)) return digest;
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmp, bytes);
        try {
          await rename(tmp, target);
        } catch {
          if (await exists(target)) return digest;
          throw new FactoryError("visual_provider_output_invalid", "Failed to publish visual candidate to local storage.");
        }
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
      return digest;
    },
    async getCandidate(storageKey) {
      const target = absolutePath(storageKey);
      try {
        return new Uint8Array(await readFile(target));
      } catch {
        throw new FactoryError(
          "visual_provider_output_invalid",
          "Visual candidate is missing from local storage (metadata and bytes diverged).",
        );
      }
    },
  };
}
