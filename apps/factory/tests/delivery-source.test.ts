import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAcceptedSource } from "../src/delivery/source.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("delivery resolves only exact fetched origin/main, never local HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-delivery-source-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const checkout = path.join(root, "checkout");
    git(root, "init", "--bare", remote);
    git(root, "init", seed);
    git(seed, "config", "user.email", "factory@example.com");
    git(seed, "config", "user.name", "Factory Test");
    await writeFile(path.join(seed, "accepted.txt"), "accepted\n");
    git(seed, "add", "accepted.txt");
    git(seed, "commit", "-m", "accepted");
    git(seed, "branch", "-M", "main");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(root, "clone", remote, checkout);
    git(checkout, "config", "user.email", "factory@example.com");
    git(checkout, "config", "user.name", "Factory Test");
    git(checkout, "switch", "-c", "local-only", "origin/main");
    await writeFile(path.join(checkout, "local.txt"), "not accepted\n");
    git(checkout, "add", "local.txt");
    git(checkout, "commit", "-m", "local only");

    const accepted = git(checkout, "rev-parse", "origin/main");
    assert.notEqual(git(checkout, "rev-parse", "HEAD"), accepted);
    assert.equal(await resolveAcceptedSource(checkout), accepted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
