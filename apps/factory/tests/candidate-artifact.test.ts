import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageExactCandidateArtifact } from "../src/delivery/candidate-artifact.js";
import { computeArtifactDigest } from "../src/production/build-service.js";

async function fixture() {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "factory-run13-stage-"));
  const projectId = "prj-test";
  const candidateId = "pcand-test";
  const artifactRef = path.join(repositoryRoot, ".factory", "production", "projects", projectId, "candidates", candidateId, "dist");
  const wranglerSiteDirectory = path.join(repositoryRoot, "isolated", "sites", "starter");
  await mkdir(path.join(artifactRef, "sub"), { recursive: true });
  await mkdir(wranglerSiteDirectory, { recursive: true });
  await writeFile(path.join(artifactRef, "index.html"), "<h1>Hello</h1>");
  await writeFile(path.join(artifactRef, "sub", "asset.css"), "body{}\n");
  const expectedDigest = await computeArtifactDigest(artifactRef);
  return { repositoryRoot, projectId, candidateId, artifactRef, wranglerSiteDirectory, expectedDigest };
}

test("stages exact candidate bytes into isolated Wrangler upload location", async () => {
  const f = await fixture();
  try {
    const staged = await stageExactCandidateArtifact(f);
    assert.equal(staged.artifactDigest, f.expectedDigest);
    assert.equal(staged.stagedDirectory, path.join(f.wranglerSiteDirectory, "dist"));
    assert.equal(await readFile(path.join(staged.stagedDirectory, "index.html"), "utf8"), "<h1>Hello</h1>");
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects modified candidate and never stages a fresh build", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.artifactRef, "index.html"), "tampered");
    await assert.rejects(stageExactCandidateArtifact(f), /modified/);
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects artifactRef bound to a different candidate", async () => {
  const f = await fixture();
  try {
    await assert.rejects(stageExactCandidateArtifact({ ...f, candidateId: "another-candidate" }), /does not match/);
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects pre-existing Wrangler dist rather than overwriting unrelated build", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.wranglerSiteDirectory, "dist"));
    await assert.rejects(stageExactCandidateArtifact(f), /already exists/);
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects symlinks inside a candidate artifact", async () => {
  const f = await fixture();
  try {
    await symlink(path.join(f.artifactRef, "index.html"), path.join(f.artifactRef, "shadow.html"));
    await assert.rejects(stageExactCandidateArtifact(f), /Unsupported or changed entry/);
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects symlink redirects in immutable candidate parent path", async () => {
  const f = await fixture();
  try {
    const projects = path.join(f.repositoryRoot, ".factory", "production", "projects");
    const external = path.join(f.repositoryRoot, "other");
    // Redirect the project directory through a symlink while retaining the
    // exact expected bytes and lexical artifactRef.
    const sourceProject = path.join(projects, f.projectId);
    const { rename } = await import("node:fs/promises");
    await rename(sourceProject, external);
    await symlink(external, sourceProject, "dir");
    await assert.rejects(stageExactCandidateArtifact(f), /traverses a symlink/);
  } finally {
    await rm(f.repositoryRoot, { recursive: true, force: true });
  }
});
