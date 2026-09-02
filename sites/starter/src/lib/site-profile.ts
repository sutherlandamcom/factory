import { parseSiteProfile, type SiteProfile } from "@factory/contracts";
import rawSiteProfile from "../../site-profile.json" with { type: "json" };

/**
 * The ONE validated site-level identity/configuration for this site.
 *
 * Parsing happens at module initialization: an invalid or missing
 * site-profile.json fails `astro check`/`astro build`/dev-server startup
 * clearly instead of silently rendering a broken shell. Frontmatter-only
 * execution keeps this build-time; no client-side JavaScript is added.
 */
export const siteProfile: SiteProfile = parseSiteProfile(rawSiteProfile);
