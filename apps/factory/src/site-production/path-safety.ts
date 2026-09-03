import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { FactoryError } from "../executor/errors.js";

/**
 * Path safety and containment helpers for SiteProductionSpec assets and references.
 *
 * Rules:
 * - Paths must be non-empty relative POSIX paths (forward slashes only).
 * - Traversal sequences ("..", ".") and empty segments are strictly forbidden.
 * - Backslashes, null bytes, colons, and drive letters are forbidden.
 * - At resolution time, resolved target must remain strictly inside the specified root directory.
 * - Symlink traversal outside the root directory is prevented via realpath containment.
 */

export function assertSafeRelativePath(relPath: string, label = "path"): void {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    throw new FactoryError("production_spec_path_invalid", `${label} cannot be empty`);
  }
  if (relPath.startsWith("/") || relPath.startsWith("\\") || path.isAbsolute(relPath)) {
    throw new FactoryError(
      "production_spec_path_invalid",
      `${label} must be relative, not absolute (got "${relPath}")`,
    );
  }
  if (relPath.includes("\\")) {
    throw new FactoryError(
      "production_spec_path_invalid",
      `${label} must use forward slashes only (got "${relPath}")`,
    );
  }
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "" || seg === "." || seg === ".." || !/^[a-zA-Z0-9_.-]+$/.test(seg)) {
      throw new FactoryError(
        "production_spec_path_invalid",
        `${label} segment "${seg}" is invalid (no empty segments, no traversal "..", characters [a-zA-Z0-9_.-] only)`,
      );
    }
  }
}

export async function resolveContainedPath(
  rootDir: string,
  relPath: string,
  label = "file",
): Promise<{ absolutePath: string; exists: boolean }> {
  assertSafeRelativePath(relPath, label);

  const absoluteRoot = path.resolve(rootDir);
  const targetPath = path.resolve(absoluteRoot, relPath);

  // Logical relative check
  const relative = path.relative(absoluteRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FactoryError(
      "production_spec_path_escape",
      `${label} "${relPath}" escapes root directory "${rootDir}"`,
    );
  }

  // Check if file exists on disk
  const stat = await lstat(targetPath).catch(() => null);
  if (!stat) {
    return { absolutePath: targetPath, exists: false };
  }

  // Symlink protection: ensure canonical realpath is contained inside real canonical root
  const realRoot = await realpath(absoluteRoot).catch(() => absoluteRoot);
  const realTarget = await realpath(targetPath).catch(() => targetPath);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new FactoryError(
      "production_spec_path_escape",
      `${label} "${relPath}" resolves through a symlink outside root directory: "${realTarget}"`,
    );
  }

  return { absolutePath: targetPath, exists: true };
}

export async function computeFileSha256AndSize(
  filePath: string,
): Promise<{ digest: string; byteSize: number }> {
  const bytes = await readFile(filePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    digest,
    byteSize: bytes.byteLength,
  };
}
