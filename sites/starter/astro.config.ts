import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type AstroIntegration } from "astro/config";
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

/**
 * Minimal static crawler-discovery output for this launch (PROVEN launch
 * requirement, deliberately NOT an SEO subsystem): after the static build,
 * emit a sitemap over every generated HTML route and a robots.txt pointing
 * at it. URLs derive from the same validated canonical origin the site and
 * QA use, so they can never disagree with canonical/OG metadata.
 */
function staticSitemapAndRobots(origin: string): AstroIntegration {
  return {
    name: "factory-static-sitemap-robots",
    hooks: {
      "astro:build:done": ({ dir, pages, logger }) => {
        // The 404 response is a status page (emitted as 404.html), never an
        // indexable URL. Static-route pathnames keep any .html suffix they
        // were generated with, so normalize and drop 404 in either form.
        const routePaths = pages
          .map((page) => `/${page.pathname.replace(/^\/|\.html$|\/$/g, "")}`)
          .filter((path) => path !== "/404")
          .map((path) => (path === "/" ? "/" : `${path}/`));
        const uniquePaths = [...new Set(routePaths)].sort();
        const escapeXml = (value: string): string =>
          value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");

        const urls = uniquePaths
          .map((path) => `  <url><loc>${escapeXml(new URL(path, origin).href)}</loc></url>`)
          .join("\n");
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

        const robots = `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", origin).href}\n`;

        fs.writeFileSync(new URL("sitemap.xml", dir), sitemap, "utf8");
        fs.writeFileSync(new URL("robots.txt", dir), robots, "utf8");
        logger.info(`sitemap.xml: ${uniquePaths.length} URLs; robots.txt written`);
      },
    },
  };
}

export default defineConfig({
  site,
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [staticSitemapAndRobots(site)],
});
