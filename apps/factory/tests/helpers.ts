import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a minimal temp git repo shaped like the Factory monorepo (only the
 * paths the executor cares about) with one clean commit. Returns the real
 * path (macOS temp dirs are symlinked; git resolves them).
 */
export async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "factory-test-"));
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.email", "test@factory.local"]);
  gitIn(dir, ["config", "user.name", "Factory Test"]);
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\ndist/\n.factory/\n", "utf8");
  await mkdir(path.join(dir, "sites", "starter", "src", "pages"), { recursive: true });
  await writeFile(
    path.join(dir, "sites", "starter", "src", "pages", "index.astro"),
    "---\n---\n<h1>Home</h1>\n",
    "utf8",
  );
  await writeFile(path.join(dir, "package.json"), '{"name":"tmp","private":true}\n', "utf8");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return realpathSync(dir);
}
