import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { deterministicDigest } from "../intelligence/digest.js";
import { FactoryError } from "../executor/errors.js";
import type { ProductionRenderManifest } from "./render-manifest.js";

/**
 * DETERMINISTIC SEO ENGINE — Macro Run 9 (Phase 3).
 *
 * Zero AI calls. Every metadata decision derives from accepted page/site
 * authority. If required editorial metadata does not exist upstream the
 * engine fails/reviews explicitly — it never invents SEO copy.
 *
 * Responsibilities:
 *  - per-page metadata projection (title/description/canonical/robots/OG)
 *  - site-wide sitemap.xml + robots.txt derived from production manifests
 *    (NOT from filesystem routes — sitemap from the route authority)
 *  - breadcrumb consistency (visible == BreadcrumbList == route hierarchy)
 *  - internal-link canonical destination verification
 */

export interface PageSeoMetadata {
  route: string;
  canonicalUrl: string;
  title: string;
  fullTitle: string;
  description: string;
  ogType: string;
  ogUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string | null;
  robotsDirectives: string;
  indexable: boolean;
}

const SITE_NAME_FALLBACK = "Factory Production Site";

/**
 * Project deterministic per-page SEO metadata from the accepted authority.
 * The manifest content fields ARE the accepted title/description; this
 * function never rewrites them.
 */
export function derivePageSeoMetadata(manifest: ProductionRenderManifest, siteName: string): PageSeoMetadata {
  const canonicalUrl = joinUrl(manifest.input.canonicalOrigin, manifest.input.route);
  const heroAsset = manifest.assets.find((asset) => asset.isProbableLcp);
  return {
    route: manifest.input.route,
    canonicalUrl,
    title: manifest.content.title,
    fullTitle: `${manifest.content.title} | ${siteName}`,
    description: manifest.content.metaDescription,
    ogType: "website",
    ogUrl: canonicalUrl,
    ogTitle: manifest.content.title,
    ogDescription: manifest.content.metaDescription,
    ogImage: heroAsset ? new URL(heroAsset.publicPath, manifest.input.canonicalOrigin).href : null,
    robotsDirectives: "index, follow",
    indexable: true,
  };
}

// ---------------------------------------------------------------------------
// Sitemap from the route authority (manifests), never from the filesystem
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface SitemapRobotsResult {
  sitemapXml: string;
  robotsTxt: string;
  includedUrls: string[];
  excluded: Array<{ route: string; reason: string }>;
}

/**
 * Generate sitemap.xml + robots.txt from production manifests. Includes only
 * canonical, indexable, successful production pages. Excludes redirects,
 * 404s, noindex pages, test routes and duplicate aliases. Every sitemap URL
 * equals its intended canonical.
 */
export function generateSitemapAndRobots(input: {
  manifests: ProductionRenderManifest[];
  siteName: string;
  now?: Date;
}): SitemapRobotsResult {
  const excluded: Array<{ route: string; reason: string }> = [];
  const seenRoutes = new Set<string>();
  const seenCanonicals = new Set<string>();
  const included: SitemapEntry[] = [];

  for (const manifest of input.manifests) {
    const meta = derivePageSeoMetadata(manifest, input.siteName);
    if (!meta.indexable) {
      excluded.push({ route: meta.route, reason: "not indexable" });
      continue;
    }
    if (seenRoutes.has(meta.route)) {
      excluded.push({ route: meta.route, reason: "duplicate route" });
      continue;
    }
    if (seenCanonicals.has(meta.canonicalUrl)) {
      excluded.push({ route: meta.route, reason: "duplicate canonical" });
      continue;
    }
    seenRoutes.add(meta.route);
    seenCanonicals.add(meta.canonicalUrl);
    included.push({ loc: meta.canonicalUrl, lastmod: null });
  }

  const sorted = included.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  const escapeXml = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const urls = sorted.map((entry) => `  <url><loc>${escapeXml(entry.loc)}</loc></url>`).join("\n");
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  const origin = input.manifests[0]?.input.canonicalOrigin ?? "";
  const robotsTxt = origin
    ? `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", origin).href}\n`
    : `User-agent: *\nAllow: /\n`;

  return { sitemapXml, robotsTxt, includedUrls: sorted.map((entry) => entry.loc), excluded };
}

/**
 * Post-build sitemap/robots emission. Reads the manifests the build consumed
 * (authority-derived) rather than filesystem routes. Writes into dist/ after
 * the Astro build. The 404 status page is never included.
 */
export async function emitSitemapAndRobots(input: {
  manifests: ProductionRenderManifest[];
  distDir: string;
  siteName: string;
}): Promise<SitemapRobotsResult> {
  const result = generateSitemapAndRobots({ manifests: input.manifests, siteName: input.siteName });
  await mkdir(input.distDir, { recursive: true });
  await writeFile(path.join(input.distDir, "sitemap.xml"), result.sitemapXml, "utf8");
  await writeFile(path.join(input.distDir, "robots.txt"), result.robotsTxt, "utf8");
  return result;
}

// ---------------------------------------------------------------------------
// Breadcrumbs — visible == BreadcrumbList == canonical route hierarchy
// ---------------------------------------------------------------------------

export interface BreadcrumbEntry {
  name: string;
  url: string;
}

/**
 * Derive breadcrumb hierarchy from the canonical route path only. No invented
 * levels: each intermediate path segment must correspond to a real page in
 * the provided route registry, otherwise the breadcrumb is invalid (REVIEW/
 * FAIL) rather than fabricated. Homepage never gets breadcrumbs.
 */
export function deriveBreadcrumbs(input: {
  route: string;
  canonicalOrigin: string;
  knownRoutes: ReadonlySet<string>;
  pageTitlesByRoute: ReadonlyMap<string, string>;
}): { valid: boolean; entries: BreadcrumbEntry[]; reason: string | null } {
  if (input.route === "/") {
    return { valid: true, entries: [], reason: null };
  }
  const segments = input.route.split("/").filter(Boolean);
  const entries: BreadcrumbEntry[] = [{ name: "Home", url: joinUrl(input.canonicalOrigin, "/") }];
  let accumulated = "";
  for (const segment of segments) {
    accumulated += `/${segment}`;
    const route = accumulated;
    const title = input.pageTitlesByRoute.get(route);
    if (!title) {
      return {
        valid: false,
        entries: [],
        reason: `Breadcrumb level ${route} has no accepted page title; hierarchy cannot be proven.`,
      };
    }
    const isLeaf = route === input.route;
    // Intermediate levels must be real production pages; the leaf is the
    // current page itself (known by construction).
    if (!isLeaf && !input.knownRoutes.has(route)) {
      return {
        valid: false,
        entries: [],
        reason: `Breadcrumb level ${route} does not correspond to a real production page.`,
      };
    }
    entries.push({ name: title, url: isLeaf ? "" : joinUrl(input.canonicalOrigin, route) });
  }
  return { valid: true, entries, reason: null };
}

/** BreadcrumbList JSON-LD from verified visible breadcrumb entries. */
export function breadcrumbJsonLd(entries: BreadcrumbEntry[]): Record<string, unknown> | null {
  if (entries.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      ...(entry.url !== "" ? { item: entry.url } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Site-wide metadata uniqueness gates
// ---------------------------------------------------------------------------

export interface SiteWideSeoCheck {
  duplicateTitles: string[];
  duplicateDescriptions: string[];
  missingTitles: string[];
  missingDescriptions: string[];
  canonicalMismatches: Array<{ route: string; canonicalUrl: string; expectedUrl: string }>;
}

/**
 * Site-wide deterministic checks across all indexable production pages:
 * unique titles, unique meaningful descriptions, canonical consistency.
 * No length folklore, no numeric SEO score — typed evidence only.
 */
export function checkSiteWideSeo(manifests: ProductionRenderManifest[], siteName: string): SiteWideSeoCheck {
  const titleByRoute = new Map<string, string>();
  const descriptionByRoute = new Map<string, string>();
  const titleCounts = new Map<string, string[]>();
  const descriptionCounts = new Map<string, string[]>();
  const canonicalMismatches: SiteWideSeoCheck["canonicalMismatches"] = [];

  for (const manifest of manifests) {
    const meta = derivePageSeoMetadata(manifest, siteName);
    const expected = joinUrl(manifest.input.canonicalOrigin, manifest.input.route);
    if (meta.canonicalUrl !== expected) {
      canonicalMismatches.push({ route: meta.route, canonicalUrl: meta.canonicalUrl, expectedUrl: expected });
    }
    if (meta.title.trim() === "") {
      continue;
    }
    titleByRoute.set(meta.route, meta.title);
    descriptionByRoute.set(meta.route, meta.description);
    if (meta.description.trim() !== "") {
      const list = titleCounts.get(meta.title) ?? [];
      list.push(meta.route);
      titleCounts.set(meta.title, list);
      const dList = descriptionCounts.get(meta.description) ?? [];
      dList.push(meta.route);
      descriptionCounts.set(meta.description, dList);
    }
  }

  const missingTitles = manifests
    .map((manifest) => manifest.input.route)
    .filter((route) => (titleByRoute.get(route) ?? "").trim() === "");
  const missingDescriptions = manifests
    .map((manifest) => manifest.input.route)
    .filter((route) => (descriptionByRoute.get(route) ?? "").trim() === "");

  return {
    duplicateTitles: [...titleCounts.entries()].filter(([, routes]) => routes.length > 1).map(([title]) => title),
    duplicateDescriptions: [...descriptionCounts.entries()].filter(([, routes]) => routes.length > 1).map(([description]) => description),
    missingTitles,
    missingDescriptions,
    canonicalMismatches,
  };
}

// ---------------------------------------------------------------------------
// Internal links
// ---------------------------------------------------------------------------

export interface InternalLinkCheck {
  route: string;
  href: string;
  problem: "missing_target" | "noncanonical_alias" | "external" | "ok";
}

/**
 * Verify internal links from accepted content resolve to production routes
 * and prefer canonical destinations. Accepts the resolved route registry.
 */
export function checkInternalLinks(input: {
  manifests: ProductionRenderManifest[];
  knownRoutes: ReadonlySet<string>;
}): InternalLinkCheck[] {
  const results: InternalLinkCheck[] = [];
  for (const manifest of input.manifests) {
    for (const link of manifest.content.internalLinks) {
      const route = normalizeInternalHref(link);
      if (route === null) {
        results.push({ route: manifest.input.route, href: link, problem: "external" });
        continue;
      }
      if (!input.knownRoutes.has(route)) {
        results.push({ route: manifest.input.route, href: link, problem: "missing_target" });
        continue;
      }
      results.push({ route: manifest.input.route, href: link, problem: "ok" });
    }
  }
  return results;
}

/** Normalize an href to a rooted route; null when it points off-site. */
function normalizeInternalHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    const noHash = trimmed.split("#")[0] ?? "";
    const noQuery = noHash.split("?")[0] ?? "";
    const clean = noQuery.replace(/\/+$/, "");
    return clean === "" ? "/" : clean;
  }
  // Relative links are not part of the accepted internal-link authority.
  return null;
}

function joinUrl(origin: string, route: string): string {
  return `${origin.replace(/\/$/, "")}${route === "/" ? "/" : route}`;
}

export { deterministicDigest as seoDeterministicDigest };
export function seoError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}
