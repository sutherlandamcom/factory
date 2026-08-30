import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessResult } from "../src/executor/process.js";
import {
  ACCEPTED_MAIN_FETCH_ARGS,
  assertAuthoritativeOrigin,
  assertTrustedControlPlaneState,
  resolveAcceptedSource,
  resolveTrustedControlPlaneSource,
  type GitRunner,
} from "../src/delivery/source.js";

const accepted = "a".repeat(40);

function result(stdout = ""): ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false };
}

function scriptedGit(outputs: ProcessResult[]): { runner: GitRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      const next = outputs.shift();
      assert.ok(next, `Unexpected Git invocation: ${args.join(" ")}`);
      return next;
    },
  };
}

test("accepted source validates the effective origin before an explicit main fetch", async () => {
  const git = scriptedGit([
    result("https://github.com/sutherlandamcom/factory.git\n"),
    result(),
    result(`${accepted}\n`),
  ]);
  assert.equal(await resolveAcceptedSource("/repo", git.runner), accepted);
  assert.deepEqual(git.calls, [
    ["remote", "get-url", "--all", "origin"],
    [...ACCEPTED_MAIN_FETCH_ARGS],
    ["rev-parse", "--verify", "origin/main^{commit}"],
  ]);
});

test("authoritative origin accepts only canonical GitHub HTTPS and SSH spellings", () => {
  for (const url of [
    "https://github.com/sutherlandamcom/factory",
    "https://github.com/sutherlandamcom/factory.git",
    "git@github.com:sutherlandamcom/factory.git",
    "ssh://git@github.com/sutherlandamcom/factory.git",
  ]) {
    assert.doesNotThrow(() => assertAuthoritativeOrigin(url));
  }
});

test("invalid, credential-bearing, local, and ambiguous origins fail before fetch without disclosure", async () => {
  for (const remote of [
    "https://github.com/attacker/factory.git",
    "https://token-secret@github.com/sutherlandamcom/factory.git",
    "file:///tmp/factory.git",
    "/tmp/factory.git",
    "https://github.com/sutherlandamcom/factory.git\ngit@github.com:sutherlandamcom/factory.git",
  ]) {
    const git = scriptedGit([result(`${remote}\n`)]);
    await assert.rejects(
      resolveAcceptedSource("/repo", git.runner),
      (error: unknown) => {
        const value = error as { code?: string; message?: string };
        return value.code === "accepted_source_remote_mismatch"
          && !value.message?.includes("token-secret");
      },
    );
    assert.deepEqual(git.calls, [["remote", "get-url", "--all", "origin"]]);
  }
});

test("trusted control plane requires accepted HEAD and a clean nonignored worktree", async () => {
  const clean = scriptedGit([
    result("git@github.com:sutherlandamcom/factory.git\n"), result(), result(`${accepted}\n`),
    result(`${accepted}\n`), result(),
  ]);
  assert.equal(await resolveTrustedControlPlaneSource("/repo", clean.runner), accepted);

  assert.throws(
    () => assertTrustedControlPlaneState(accepted, "b".repeat(40), ""),
    (error: unknown) => (error as { code?: string }).code === "control_plane_unaccepted",
  );
  assert.throws(
    () => assertTrustedControlPlaneState(accepted, accepted, "?? untracked.txt\n"),
    (error: unknown) => (error as { code?: string }).code === "control_plane_unaccepted",
  );
});
