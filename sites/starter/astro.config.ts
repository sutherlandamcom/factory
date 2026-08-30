import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

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

const publicSiteUrl = process.env.PUBLIC_SITE_URL || "http://localhost:4321";

// PUBLIC_SITE_URL is the canonical origin of the deployed site (see .env.example).
export default defineConfig({
  site: publicSiteUrl,
  vite: {
    plugins: [tailwindcss()],
  },
});
