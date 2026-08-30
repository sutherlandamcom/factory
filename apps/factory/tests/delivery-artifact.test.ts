import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digestArtifact } from "../src/delivery/artifact.js";

test("artifact digest is stable across creation order and changes with path or content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-artifact-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(path.join(first, "nested"), { recursive: true });
    await writeFile(path.join(first, "z.html"), "z");
    await writeFile(path.join(first, "nested", "a.txt"), "a");
    await mkdir(path.join(second, "nested"), { recursive: true });
    await writeFile(path.join(second, "nested", "a.txt"), "a");
    await writeFile(path.join(second, "z.html"), "z");
    assert.equal(await digestArtifact(first), await digestArtifact(second));

    await writeFile(path.join(second, "z.html"), "changed");
    assert.notEqual(await digestArtifact(first), await digestArtifact(second));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
