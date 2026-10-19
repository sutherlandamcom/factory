import { randomUUID } from "node:crypto";
import { cp, lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";
import { computeArtifactDigest } from "../production/build-service.js";

/**
 * Run 13: stage the EXACT immutable ProductionCandidate bytes for the
 * existing Wrangler Static Assets configuration (./dist).
 *
 * Callers MUST hold the shared delivery lock through Wrangler upload.
 * This function never builds, regenerates, or modifies candidate source.
 */
export interface CandidateArtifactStage {
  repositoryRoot: string;
  projectId: string;
  candidateId: string;
  artifactRef: string;
  expectedDigest: string;
  wranglerSiteDirectory: string;
}

function safeId(segment: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(segment)) {
    throw new FactoryError("artifact_invalid", "Invalid candidate artifact path component.");
  }
  return segment;
}

async function isPresent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function assertRegularTree(dir: string): Promise<number> {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FactoryError("artifact_invalid", "Candidate artifact root is not a real directory.");
  }
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    const meta = await lstat(name);
    if (entry.isDirectory() && meta.isDirectory() && !meta.isSymbolicLink()) {
      count += await assertRegularTree(name);
    } else if (entry.isFile() && meta.isFile() && !meta.isSymbolicLink()) {
      count++;
    } else {
      throw new FactoryError("artifact_invalid", "Unsupported or changed entry in candidate artifact.");
    }
  }
  return count;
}

export async function stageExactCandidateArtifact(input: CandidateArtifactStage): Promise<{
  artifactDigest: string;
  stagedDirectory: string;
}> {
  const expected = path.resolve(
    input.repositoryRoot, ".factory", "production", "projects",
    safeId(input.projectId), "candidates", safeId(input.candidateId), "dist",
  );
  if (path.resolve(input.artifactRef) !== expected) {
    throw new FactoryError("artifact_invalid", "Candidate artifactRef does not match immutable candidate identity.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedDigest)) {
    throw new FactoryError("artifact_invalid", "Missing or malformed candidate artifact digest.");
  }

  const siteDir = path.resolve(input.wranglerSiteDirectory);
  const target = path.join(siteDir, "dist");
  if (await isPresent(target)) {
    throw new FactoryError("artifact_invalid", "Wrangler dist already exists; refusing to overwrite a build.");
  }

  try {
    // Reject parent-directory symlink redirects, not only nested symlinks.
    const canonicalRepo = await realpath(input.repositoryRoot);
    const actualSource = await realpath(expected);
    const trustedSource = path.join(
      canonicalRepo, ".factory", "production", "projects",
      input.projectId, "candidates", input.candidateId, "dist",
    );
    if (actualSource !== trustedSource) {
      throw new FactoryError("artifact_invalid", "Candidate artifact path traverses a symlink.");
    }
    const fileCount = await assertRegularTree(expected);
    if (fileCount === 0) throw new FactoryError("artifact_empty", "Candidate artifact has no files.");
    const sourceDigest = await computeArtifactDigest(expected);
    if (sourceDigest !== input.expectedDigest) {
      throw new FactoryError("artifact_invalid", "Candidate immutable artifact has been modified.");
    }
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    throw new FactoryError("artifact_missing", "Candidate artifact is unavailable or unreadable.");
  }

  const staging = path.join(siteDir, ".factory-candidate-stage-" + randomUUID());
  try {
    await cp(expected, staging, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const count = await assertRegularTree(staging);
    if (count === 0 || (await computeArtifactDigest(staging)) !== input.expectedDigest) {
      throw new FactoryError("artifact_invalid", "Staged byte tree is not identical to ProductionCandidate.");
    }
    if (await isPresent(target)) {
      throw new FactoryError("artifact_invalid", "Wrangler dist was populated concurrently.");
    }
    await rename(staging, target);
    const finalDigest = await computeArtifactDigest(target);
    if (finalDigest !== input.expectedDigest) {
      throw new FactoryError("artifact_invalid", "Final Wrangler upload tree differs from ProductionCandidate.");
    }
    return { artifactDigest: finalDigest, stagedDirectory: target };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
