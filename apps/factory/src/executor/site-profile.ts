import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSiteProfile, type SiteProfile } from "@factory/contracts";
import { FactoryError } from "./errors.js";

/**
 * Trusted deployment/test origin Factory pins for deterministic QA. This is
 * Factory process configuration, not site identity: it is passed as the
 * validated canonical-origin override for both the site build (PUBLIC_SITE_URL)
 * and the QA/verification expectations so they provably agree.
 */
export const FACTORY_QA_ORIGIN = "https://test.example.com";

export const SITE_PROFILE_RELATIVE_PATH = path.join("sites", "starter", "site-profile.json");

/**
 * Load and validate the SiteProfile inside a worktree using the shared
 * contract. Fails closed on a missing or invalid profile: Factory QA never
 * guesses site identity, and a worktree whose profile was tampered with can
 * not proceed (defense in depth behind the mechanical scope gate).
 */
export async function loadWorktreeSiteProfile(worktreePath: string): Promise<SiteProfile> {
  const profilePath = path.join(worktreePath, SITE_PROFILE_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (error) {
    throw new FactoryError(
      "site_profile_unreadable",
      `SiteProfile is missing or unreadable at ${SITE_PROFILE_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseSiteProfile(raw);
  } catch (error) {
    throw new FactoryError(
      "site_profile_invalid",
      `SiteProfile failed validation at ${SITE_PROFILE_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
