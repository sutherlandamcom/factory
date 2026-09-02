import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { resolveCanonicalOrigin } from "@factory/contracts";
import { siteProfile } from "./src/lib/site-profile";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const siteDir = fileURLToPath(new URL(".", import.meta.url));

// Load .env files using Node's built-in process.loadEnvFile().
// Root .env is loaded first, then site-local .env.
// Shell-provided process.env takes precedence as loadEnvFile does not overwrite existing keys.
for (const dir of [rootDir, siteDir]) {
  const envPath = `${dir}.env`;
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

// PUBLIC_SITE_URL is the trusted canonical-origin override of the deployed
// site (see .env.example). When explicitly configured it must pass the same
// validation as SiteProfile.canonicalOrigin; otherwise the validated profile
// value is used. Invalid overrides fail the build; they never silently fall
// back. SiteTask content and model output have no path to this decision.
const site = resolveCanonicalOrigin({
  override: process.env.PUBLIC_SITE_URL,
  profile: siteProfile,
});

export default defineConfig({
  site,
  vite: {
    plugins: [tailwindcss()],
  },
});
