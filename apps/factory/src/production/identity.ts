import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadWorktreeSiteProfile } from "../executor/site-profile.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

const execFileAsync = promisify(execFile);
export const PRODUCTION_RENDERER_POLICY_VERSION = "production-policy-v2";

export async function loadProductionBuildIdentity(repoRoot: string) {
  const profile = await loadWorktreeSiteProfile(repoRoot);
  const packagePath = path.join(repoRoot, "sites", "starter", "package.json");
  const packageData = JSON.parse(await readFile(packagePath, "utf8")) as { dependencies?: Record<string, string> };
  const declared = packageData.dependencies?.astro;
  const installedData = JSON.parse(await readFile(path.join(repoRoot, "sites", "starter", "node_modules", "astro", "package.json"), "utf8")) as { version?: string };
  if (!installedData.version || declared !== installedData.version) {
    throw new FactoryError("production_build_rejected", `Astro must be declared and installed at one exact version (declared=${String(declared)}, installed=${String(installedData.version)}).`);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const repositorySha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(repositorySha)) throw new FactoryError("production_build_rejected", "Repository SHA is invalid.");
  const lockfileDigest = createHash("sha256").update(await readFile(path.join(repoRoot, "pnpm-lock.yaml"))).digest("hex");
  return {
    siteIdentity: {
      siteId: profile.siteId,
      siteName: profile.siteName,
      canonicalOrigin: profile.canonicalOrigin,
      language: profile.language,
      profileDigest: deterministicDigest(profile),
    },
    rendererVersion: installedData.version,
    rendererPolicyVersion: PRODUCTION_RENDERER_POLICY_VERSION,
    repositorySha,
    lockfileDigest,
  };
}
