import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * Crash-safe artifact publication for Blueprint runs.
 *
 * Semantics (mirroring the accepted Intelligence publication):
 * - Every run owns a fresh, unique run directory `.factory/blueprint/<runId>/`;
 *   an existing directory for a new run fails closed (never reuse artifacts).
 * - Intermediate artifacts may appear while the run progresses.
 * - The manifest and the final `blueprint-result.json` are published with
 *   temp-file → rename atomicity, and the definitive result is written LAST.
 * - A partially completed run can therefore never look successful.
 * - Path traversal and symlink redirection fail closed.
 */

export const BLUEPRINT_RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export function generateRunId(now: Date, randomHexSuffix: string): string {
  const compact = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runId = `${compact}-${randomHexSuffix}`;
  if (!BLUEPRINT_RUN_ID_PATTERN.test(runId)) {
    throw new FactoryError("blueprint_artifact_failed", `generated runId is invalid: ${runId}`);
  }
  return runId;
}

export function randomRunIdSuffix(): string {
  return randomBytes(4).toString("hex");
}

export function blueprintRunDirectory(repoRoot: string, runId: string): string {
  if (!BLUEPRINT_RUN_ID_PATTERN.test(runId)) {
    throw new FactoryError("blueprint_artifact_failed", `runId "${runId}" is not a valid run identifier`);
  }
  return path.join(repoRoot, ".factory", "blueprint", runId);
}

async function assertRealNonSymlinkDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstat(directory).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FactoryError(
      "blueprint_artifact_failed",
      `${label} must be a real, non-symlink directory: ${directory}`,
    );
  }
  if ((await realpath(directory)) !== directory) {
    throw new FactoryError("blueprint_artifact_failed", `${label} resolves through a symlink: ${directory}`);
  }
}

export async function prepareRunDirectory(repoRoot: string, runId: string): Promise<string> {
  const root = blueprintRunDirectory(repoRoot, runId);
  const blueprintRoot = path.dirname(root);
  await mkdir(blueprintRoot, { recursive: true });
  await assertRealNonSymlinkDirectory(blueprintRoot, "blueprint artifact root");

  const existing = await lstat(root).catch(() => null);
  if (existing) {
    throw new FactoryError(
      "blueprint_artifact_failed",
      `run directory already exists for runId ${runId}; refusing to reuse previous artifacts`,
    );
  }
  await mkdir(root, { recursive: true });
  await assertRealNonSymlinkDirectory(root, "run directory");
  return root;
}

export function resolveWithinRunDirectory(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new FactoryError(
      "blueprint_artifact_failed",
      `artifact path must be relative to the run directory: ${relativePath}`,
    );
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FactoryError(
      "blueprint_artifact_failed",
      `artifact path escapes the run directory: ${relativePath}`,
    );
  }
  return target;
}

export async function writeArtifact(root: string, relativePath: string, content: string): Promise<void> {
  const target = resolveWithinRunDirectory(root, relativePath);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new FactoryError("blueprint_artifact_failed", `artifact target is a symlink: ${relativePath}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function publishJsonAtomically(root: string, relativePath: string, value: unknown): Promise<void> {
  const target = resolveWithinRunDirectory(root, relativePath);
  const tempTarget = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${randomBytes(4).toString("hex")}`,
  );
  await writeFile(tempTarget, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // rename() replaces any symlink at the destination instead of writing
  // through it, so a planted symlink cannot redirect the publication.
  await rename(tempTarget, target);
}

export async function buildArtifactDigests(
  root: string,
  relativePaths: readonly string[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const bytes = await readFile(resolveWithinRunDirectory(root, relativePath));
    digests[relativePath] = createHash("sha256").update(bytes).digest("hex");
  }
  return digests;
}

/**
 * Stale-artifact / integrity verification: re-read every listed artifact and
 * prove its bytes still match the recorded digest. Also proves that the
 * published blueprint file still canonicalizes to blueprintDigest.
 */
export async function verifyArtifactIntegrity(
  root: string,
  expectedDigests: Record<string, string>,
  blueprintDigest: string,
): Promise<void> {
  for (const [relativePath, expectedDigest] of Object.entries(expectedDigests)) {
    const bytes = await readFile(resolveWithinRunDirectory(root, relativePath)).catch(() => {
      throw new FactoryError(
        "blueprint_artifact_failed",
        `manifest artifact is missing at verification time: ${relativePath}`,
      );
    });
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new FactoryError(
        "blueprint_artifact_failed",
        `artifact integrity mismatch for ${relativePath}: artifacts do not belong to this run`,
      );
    }
  }

  const blueprintRaw = await readFile(resolveWithinRunDirectory(root, "site-blueprint.json"), "utf8");
  const canonicalDigest = deterministicDigest(JSON.parse(blueprintRaw));
  if (canonicalDigest !== blueprintDigest) {
    throw new FactoryError(
      "blueprint_artifact_failed",
      "published blueprint digest does not match blueprintDigest; artifacts are stale or corrupted",
    );
  }
}

export async function removeRunDirectory(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
