import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { resolveRepositoryRoot } from "../repo-root.js";
import { FactoryError } from "../executor/errors.js";

/**
 * Content-addressed artifact storage for design provider outputs (Run 6).
 *
 * Identity is SHA-256 over exact bytes; storage keys are derived ONLY from
 * validated lowercase hex digests plus fixed segments. Objects live under
 * the gitignored `.factory/design/` runtime evidence root (same durability
 * tier as asset artifacts); PostgreSQL stores the authority metadata
 * (candidate rows reference artifact digests, never raw bytes).
 *
 * Raw provider artifacts (HTML, screenshots, DESIGN.md, provider responses)
 * are preserved for debugging, reproducibility, bake-off evidence and human
 * review. They are NOT production authority.
 */

const DESIGN_ROOT_SEGMENT = ".factory";
const DESIGN_DIR = "design";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type DesignArtifactKind = "design_md" | "screen_html" | "screen_screenshot" | "provider_response";

const KIND_SEGMENTS: Record<DesignArtifactKind, string> = {
  design_md: "design-md",
  screen_html: "screen-html",
  screen_screenshot: "screen-screenshots",
  provider_response: "provider-responses",
};

const KIND_MEDIA_TYPES: Record<DesignArtifactKind, string> = {
  design_md: "text/markdown",
  screen_html: "text/html",
  screen_screenshot: "image/png",
  provider_response: "application/json",
};

export interface DesignArtifactStorage {
  /** Content-addressed key for an artifact: <kind-dir>/sha256/<d2>/<digest>. */
  artifactKey(kind: DesignArtifactKind, digest: string): string;
  /** Write exact bytes; returns the digest (atomic, never overwrites). */
  putArtifact(kind: DesignArtifactKind, bytes: Uint8Array): Promise<string>;
  /** Read exact bytes back plus media type; missing objects fail closed. */
  getArtifact(kind: DesignArtifactKind, digest: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Read by digest across kinds (preview serving). */
  getArtifactByDigest(digest: string): Promise<{ bytes: Uint8Array; mediaType: string } | null>;
  hasArtifact(kind: DesignArtifactKind, digest: string): Promise<boolean>;
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertHexDigest(digest: string, label: string): void {
  if (!HEX_DIGEST_PATTERN.test(digest)) {
    throw new FactoryError("design_provider_output_invalid", `${label} is not a valid lowercase SHA-256 hex digest.`);
  }
}

export function createDesignArtifactStorage(repoRoot?: string): DesignArtifactStorage {
  // Root is the GIT TOPLEVEL (like the accepted Run 5 asset storage), not
  // process.cwd(): pnpm executes scripts with the package directory as cwd,
  // so a cwd-derived root would relocate artifacts per invocation context
  // and strand DB-referenced digests. resolveRepositoryRoot is async; the
  // root is resolved lazily on first use and cached.
  let cachedRoot: string | null = repoRoot ? path.resolve(repoRoot) : null;
  const resolveRoot = (): string => {
    if (cachedRoot) return cachedRoot;
    throw new FactoryError(
      "design_provider_output_invalid",
      "Design artifact storage root not initialized; construct via createDesignArtifactStorageAsync or pass an explicit repoRoot.",
    );
  };
  return buildStorage(resolveRoot);
}

/**
 * Async construction used by the service layer: resolves the Git repository
 * toplevel once (read-only git operation) and caches it for the storage
 * lifetime.
 */
export async function createDesignArtifactStorageAsync(repoRoot?: string): Promise<DesignArtifactStorage> {
  const root = path.resolve(repoRoot ?? (await resolveRepositoryRoot()), DESIGN_ROOT_SEGMENT, DESIGN_DIR);
  return buildStorage(() => root);
}

function buildStorage(resolveRoot: () => string): DesignArtifactStorage {
  const root = resolveRoot();

  const artifactKey = (kind: DesignArtifactKind, digest: string): string => {
    assertHexDigest(digest, "artifact digest");
    const kindSegment = KIND_SEGMENTS[kind];
    if (!kindSegment) {
      throw new FactoryError("design_provider_output_invalid", `Unknown design artifact kind: ${String(kind)}`);
    }
    return path.posix.join(kindSegment, "sha256", digest.slice(0, 2), digest);
  };

  const absolutePath = (storageKey: string): string => {
    const normalized = path.posix.normalize(storageKey);
    const segments = normalized.split("/");
    const valid =
      segments.length === 4 &&
      Object.values(KIND_SEGMENTS).includes(segments[0]!) &&
      segments[1] === "sha256" &&
      segments[2]!.length === 2 &&
      /^[a-z0-9]+$/.test(segments[2]!) &&
      HEX_DIGEST_PATTERN.test(segments[3]!);
    if (!valid) {
      throw new FactoryError("design_provider_output_invalid", "storage key is not a recognized content-addressed key.");
    }
    const resolved = path.resolve(root, normalized);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FactoryError("design_provider_output_invalid", "storage key escapes the design artifact storage root.");
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
    artifactKey,
    async putArtifact(kind, bytes) {
      const digest = sha256HexBytes(bytes);
      const key = artifactKey(kind, digest);
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
          throw new FactoryError("design_provider_output_invalid", "Failed to publish design artifact to local storage.");
        }
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
      return digest;
    },
    async getArtifact(kind, digest) {
      assertHexDigest(digest, "artifact digest");
      const target = absolutePath(artifactKey(kind, digest));
      try {
        return { bytes: new Uint8Array(await readFile(target)), mediaType: KIND_MEDIA_TYPES[kind] };
      } catch {
        throw new FactoryError(
          "design_provider_output_invalid",
          "Design artifact is missing from local storage (metadata and bytes diverged).",
        );
      }
    },
    async getArtifactByDigest(digest) {
      if (!HEX_DIGEST_PATTERN.test(digest)) return null;
      for (const kind of Object.keys(KIND_SEGMENTS) as DesignArtifactKind[]) {
        const target = absolutePath(artifactKey(kind, digest));
        if (await exists(target)) {
          try {
            return { bytes: new Uint8Array(await readFile(target)), mediaType: KIND_MEDIA_TYPES[kind] };
          } catch {
            return null;
          }
        }
      }
      return null;
    },
    async hasArtifact(kind, digest) {
      try {
        assertHexDigest(digest, "artifact digest");
        return await exists(absolutePath(artifactKey(kind, digest)));
      } catch {
        return false;
      }
    },
  };
}
