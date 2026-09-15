import { readFile } from "node:fs/promises";
import path from "node:path";
import { deterministicDigest } from "../../intelligence/digest.js";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import {
  validateContentIntegrity,
  validateHtmlSemantics,
  validateStructuredData,
  detectDuplicateMainContent,
} from "./content-integrity.js";
import { checkSiteWideSeo } from "../seo-engine.js";
import { qaOverallVerdict } from "@factory/contracts";
import { bindQaCheck } from "./registry.js";

/**
 * SITE-WIDE PRODUCTION QA — Macro Run 9 (Phase 4).
 *
 * Deterministic post-build validation across the whole built production
 * output. Page-level PASS is insufficient: this stage proves site-wide
 * invariants (unique routes/canonicals/titles/descriptions, no duplicate
 * main content, sitemap/canonical/JSON-LD consistency, no broken internal
 * links, no redirect loops).
 */

export interface SiteWideQaInput {
  /** Built dist directory of the production Astro output. */
  distDir: string;
  /** The production render manifests the build consumed. */
  manifests: ProductionRenderManifest[];
  /** Redirect authority rules (renderer-neutral). */
  redirectRules: Array<{ source: string; destination: string; kind: string }>;
  siteName: string;
  manifestSetDigest: string;
  repositorySha: string;
  trustedChecks?: ProductionQaCheckResult[];
}

export interface SiteWideQaResult {
  checks: ProductionQaCheckResult[];
  overall: "PASS" | "REVIEW" | "FAIL";
}

function check(
  checkId: ProductionQaCheckResult["checkId"],
  group: ProductionQaCheckResult["group"],
  verdict: ProductionQaCheckResult["verdict"],
  detail: string,
  evidence: ProductionQaCheckResult["evidence"] = [],
): ProductionQaCheckResult {
  return { checkId, group, verdict, detail, evidence };
}

export async function runSiteWideQa(input: SiteWideQaInput): Promise<SiteWideQaResult> {
  const checks: ProductionQaCheckResult[] = [];

  // Load built HTML per route (Astro directory format: <route>/index.html).
  const pages: Array<{ route: string; html: string }> = [];
  for (const manifest of input.manifests) {
    const file =
      manifest.input.route === "/"
        ? path.join(input.distDir, "index.html")
        : path.join(input.distDir, manifest.input.route.replace(/^\//, ""), "index.html");
    try {
      const html = await readFile(file, "utf8");
      pages.push({ route: manifest.input.route, html });
    } catch {
      checks.push(
        check("html.valid_structure", "html", "FAIL", `Built HTML missing for route ${manifest.input.route}.`),
      );
    }
  }

  // Per-page gates against each built page.
  const pageResults = [];
  for (const page of pages) {
    const manifest = input.manifests.find((entry) => entry.input.route === page.route)!;
    pageResults.push({
      route: page.route,
      content: validateContentIntegrity({ route: page.route, html: page.html, manifest }),
      html: validateHtmlSemantics({ route: page.route, html: page.html, manifest }),
      structured: validateStructuredData({ route: page.route, html: page.html, manifest }),
    });
  }
  for (const result of pageResults) {
    checks.push(...[...result.content.checks, ...result.html.checks, ...result.structured.checks].map((entry) => bindQaCheck(entry, {
      scope: "page", subject: result.route, tool: "factory-html-qa", toolVersion: "production-v2",
    })));
  }

  // Duplicate main content across distinct routes.
  const duplicateResult = detectDuplicateMainContent({ pages });
  checks.push(
    check(
      "content.no_duplicate_pages",
      "content",
      duplicateResult.duplicates.length === 0 ? "PASS" : "FAIL",
      duplicateResult.duplicates.length === 0
        ? `No exact duplicate main content across ${pages.length} production pages.`
        : `Exact duplicate main content: ${duplicateResult.duplicates.map((finding) => `${finding.routeA} == ${finding.routeB}`).join("; ")}`,
      duplicateResult.duplicates.map((finding) => ({
        kind: "route" as const,
        ref: `${finding.routeA}~${finding.routeB}`,
      })),
    ),
  );

  // Site-wide metadata uniqueness + canonical consistency.
  const siteWide = checkSiteWideSeo(input.manifests, input.siteName);
  checks.push(
    check(
      "seo.title_unique",
      "seo",
      siteWide.duplicateTitles.length === 0 && siteWide.missingTitles.length === 0 ? "PASS" : "FAIL",
      siteWide.duplicateTitles.length === 0 && siteWide.missingTitles.length === 0
        ? "All indexable pages carry unique titles."
        : `Duplicate titles: ${siteWide.duplicateTitles.length}; missing titles: ${siteWide.missingTitles.join(", ")}`,
    ),
  );
  checks.push(
    check(
      "seo.description_unique",
      "seo",
      siteWide.duplicateDescriptions.length === 0 && siteWide.missingDescriptions.length === 0 ? "PASS" : "FAIL",
      siteWide.duplicateDescriptions.length === 0 && siteWide.missingDescriptions.length === 0
        ? "All indexable pages carry unique meaningful descriptions."
        : `Duplicate descriptions: ${siteWide.duplicateDescriptions.length}; missing: ${siteWide.missingDescriptions.join(", ")}`,
    ),
  );

  // Sitemap consistency: every sitemap URL equals an intended canonical
  // (trailing-slash-normalized: Astro's directory format emits slash URLs).
  const sitemapPath = path.join(input.distDir, "sitemap.xml");
  try {
    const sitemapXml = await readFile(sitemapPath, "utf8");
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!.replace(/\/$/, ""));
    const expectedCanonicals = input.manifests.map(
      (manifest) => manifest.seo.canonicalUrl.replace(/\/$/, ""),
    );
    const sortedExpected = [...expectedCanonicals].sort();
    const sortedLocs = [...locs].sort();
    const sitemapOk =
      sortedLocs.length === sortedExpected.length && sortedLocs.every((loc, index) => loc === sortedExpected[index]);
    checks.push(
      check(
        "seo.sitemap",
        "seo",
        sitemapOk ? "PASS" : "FAIL",
        sitemapOk
          ? `Sitemap carries exactly the ${sortedExpected.length} canonical production URLs.`
          : `Sitemap contradicts route authority: sitemap=${sortedLocs.join(",")} expected=${sortedExpected.join(",")}`,
      ),
    );
  } catch {
    checks.push(check("seo.sitemap", "seo", "FAIL", "sitemap.xml missing from built output."));
  }
  try {
    const robots = await readFile(path.join(input.distDir, "robots.txt"), "utf8");
    const expected = new URL("/sitemap.xml", input.manifests[0]!.input.siteIdentity.canonicalOrigin).href;
    checks.push(check("seo.robots", "seo", robots.includes(`Sitemap: ${expected}`) ? "PASS" : "FAIL", "robots.txt binds the candidate sitemap authority."));
  } catch {
    checks.push(check("seo.robots", "seo", "FAIL", "robots.txt missing from built output."));
  }

  // Internal-link existence and visible anchor equality are page gates. The
  // compiler has already resolved them against this complete registry.
  const knownRoutes = new Set(input.manifests.map((manifest) => manifest.input.route));

  // Redirect authority: no loops, no chains, no sitemap inclusion of sources.
  const redirectProblems = validateCandidateRedirects(input.redirectRules, knownRoutes);
  checks.push(
    check(
      "links.canonical_destination",
      "links",
      redirectProblems.length === 0 ? "PASS" : "FAIL",
      redirectProblems.length === 0
        ? `Redirect authority valid (${input.redirectRules.length} rules).`
        : redirectProblems.join("; "),
    ),
  );

  // Built-output security surface: no secrets/internal metadata in public HTML.
  const secretPatterns = [
    /postgres(ql)?:\/\/[^\s"']+:[^\s"']+/i,
    /sk-[a-zA-Z0-9]{20,}/,
    /AIza[a-zA-Z0-9_-]{30,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\/Users\/[a-z]/i,
    /\.factory\/assets\//,
  ];
  let securityOk = true;
  const securityHits: string[] = [];
  for (const page of pages) {
    for (const pattern of secretPatterns) {
      if (pattern.test(page.html)) {
        securityOk = false;
        securityHits.push(`${page.route}: pattern ${pattern.source}`);
      }
    }
  }
  checks.push(
    check(
      "security.public_output",
      "security",
      securityOk ? "PASS" : "FAIL",
      securityOk
        ? `No secret/internal-metadata patterns in ${pages.length} built pages.`
        : `Secret/internal patterns detected (values redacted): ${securityHits.length} hit(s)`,
      securityHits.map((hit) => ({ kind: "route" as const, ref: hit.split(":")[0] ?? hit })),
    ),
  );

  const siteCheckIds = new Set(["content.no_duplicate_pages", "seo.title_unique", "seo.description_unique", "seo.robots", "seo.sitemap", "links.canonical_destination", "security.public_output"]);
  const boundChecks = checks.map((entry) => entry.scope ? entry : bindQaCheck(entry, {
    scope: siteCheckIds.has(entry.checkId) ? "site" : "page",
    subject: siteCheckIds.has(entry.checkId) ? input.manifestSetDigest : input.manifests[0]!.input.route,
    tool: "factory-site-qa",
    toolVersion: "production-v2",
  }));
  boundChecks.push(...(input.trustedChecks ?? []));
  return { checks: boundChecks, overall: qaOverallVerdict(boundChecks) };
}

export function validateCandidateRedirects(
  rules: Array<{ source: string; destination: string; kind: string }>,
  knownRoutes: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    if (rule.source === rule.destination) problems.push(`Redirect loop: ${rule.source} -> ${rule.destination}`);
    if (rules.some((other) => other.source === rule.destination)) problems.push(`Redirect chain: ${rule.source} -> ${rule.destination} (destination is itself a redirect source)`);
    if (knownRoutes.has(rule.source)) problems.push(`Redirect source ${rule.source} collides with a production route`);
  }
  return problems;
}

/** Deterministic digest over the site-wide QA result (evidence identity). */
export function siteWideQaDigest(result: SiteWideQaResult): string {
  return deterministicDigest({
    overall: result.overall,
    checks: result.checks.map((entry) => ({
      checkId: entry.checkId,
      group: entry.group,
      verdict: entry.verdict,
      detail: entry.detail,
    })),
  });
}
