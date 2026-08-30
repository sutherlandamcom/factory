import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

export interface IntegrityEntry {
  path: string;
  kind: "file" | "symlink" | "other";
  mode: number;
  digest: string;
}

export interface IntegritySnapshot {
  entries: IntegrityEntry[];
}

export interface IntegrityComparison {
  passed: boolean;
  violations: string[];
}

export const TRUSTED_FACTORY_OUTPUT_ROOTS = [
  ".factory",
  "sites/starter/dist",
  "sites/starter/.astro",
  "sites/starter/test-results",
  "sites/starter/playwright-report",
  "sites/starter/qa-artifacts",
] as const;

export function isFactoryOutput(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return TRUSTED_FACTORY_OUTPUT_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

async function ignoredPaths(worktreePath: string): Promise<string[]> {
  const result = await runProcess(
    "git",
    ["-C", worktreePath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: worktreePath, env: buildChildEnv(), timeoutMs: 60_000 },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new FactoryError(
      "integrity_snapshot_failed",
      `failed to enumerate ignored files: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  const paths = result.stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths.filter((file) => !isFactoryOutput(file)).sort((a, b) => a.localeCompare(b));
}

async function describeEntry(worktreePath: string, relativePath: string): Promise<IntegrityEntry> {
  const absolutePath = path.join(worktreePath, relativePath);
  const stat = await lstat(absolutePath);
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    return {
      path: relativePath,
      kind: "symlink",
      mode,
      digest: createHash("sha256").update(target).digest("hex"),
    };
  }
  if (stat.isFile()) {
    return {
      path: relativePath,
      kind: "file",
      mode,
      digest: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
    };
  }
  return {
    path: relativePath,
    kind: "other",
    mode,
    digest: createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.size}`).digest("hex"),
  };
}

/** Capture all ignored state except explicit Factory-owned build/test outputs. */
export async function captureIntegritySnapshot(worktreePath: string): Promise<IntegritySnapshot> {
  const entries: IntegrityEntry[] = [];
  const paths = await ignoredPaths(worktreePath);
  const batchSize = 64;
  for (let index = 0; index < paths.length; index += batchSize) {
    entries.push(
      ...(await Promise.all(
        paths.slice(index, index + batchSize).map((relativePath) => describeEntry(worktreePath, relativePath)),
      )),
    );
  }
  return { entries };
}

export function compareIntegritySnapshots(
  baseline: IntegritySnapshot,
  current: IntegritySnapshot,
): IntegrityComparison {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b));
  const violations: string[] = [];

  for (const file of paths) {
    const oldEntry = before.get(file);
    const newEntry = after.get(file);
    if (!oldEntry) violations.push(`${file}: ignored file created`);
    else if (!newEntry) violations.push(`${file}: ignored file removed`);
    else if (
      oldEntry.kind !== newEntry.kind ||
      oldEntry.mode !== newEntry.mode ||
      oldEntry.digest !== newEntry.digest
    ) {
      violations.push(`${file}: ignored file content, type, or mode changed`);
    }
  }

  return { passed: violations.length === 0, violations };
}
