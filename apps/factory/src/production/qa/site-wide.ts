import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "node-html-parser";
import { deterministicDigest } from "../../intelligence/digest.js";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import {
  validateContentIntegrity,
  validateHtmlSemantics,
  validateStructuredData,
  detectDuplicateMainContent,
} from "./content-integrity.js";
import { checkSiteWideSeo, checkInternalLinks } from "../seo-engine.js";
import { qaOverallVerdict } from "@factory/contracts";

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
    checks.push(...result.content.checks, ...result.html.checks, ...result.structured.checks);
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
  checks.push(
    check(
      "seo.canonical",
      "seo",
      siteWide.canonicalMismatches.length === 0 ? "PASS" : "FAIL",
      siteWide.canonicalMismatches.length === 0
        ? "All canonicals agree with route authority."
        : `Canonical contradictions: ${siteWide.canonicalMismatches.map((mismatch) => `${mismatch.route} -> ${mismatch.canonicalUrl}`).join("; ")}`,
      siteWide.canonicalMismatches.map((mismatch) => ({ kind: "url" as const, ref: mismatch.route })),
    ),
  );

  // Sitemap consistency: every sitemap URL equals an intended canonical
  // (trailing-slash-normalized: Astro's directory format emits slash URLs).
  const sitemapPath = path.join(input.distDir, "sitemap.xml");
  try {
    const sitemapXml = await readFile(sitemapPath, "utf8");
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!.replace(/\/$/, ""));
    const expectedCanonicals = input.manifests.map(
      (manifest) => `${manifest.input.canonicalOrigin.replace(/\/$/, "")}${manifest.input.route}`.replace(/\/$/, "") || manifest.input.canonicalOrigin,
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

  // Internal links resolve.
  const knownRoutes = new Set(input.manifests.map((manifest) => manifest.input.route));
  const linkChecks = checkInternalLinks({ manifests: input.manifests, knownRoutes });
  const brokenLinks = linkChecks.filter((link) => link.problem === "missing_target");
  checks.push(
    check(
      "seo.internal_links",
      "seo",
      brokenLinks.length === 0 ? "PASS" : "FAIL",
      brokenLinks.length === 0
        ? `All ${linkChecks.length} accepted internal links resolve to production routes.`
        : `Broken internal links: ${brokenLinks.map((link) => `${link.route} -> ${link.href}`).join("; ")}`,
      brokenLinks.map((link) => ({ kind: "url" as const, ref: `${link.route}${link.href}` })),
    ),
  );

  // Redirect authority: no loops, no chains, no sitemap inclusion of sources.
  const redirectProblems: string[] = [];
  for (const rule of input.redirectRules) {
    if (rule.source === rule.destination) {
      redirectProblems.push(`Redirect loop: ${rule.source} -> ${rule.destination}`);
    }
    // One-hop preference: destination must not be another redirect source.
    if (input.redirectRules.some((other) => other.source === rule.destination)) {
      redirectProblems.push(`Redirect chain: ${rule.source} -> ${rule.destination} (destination is itself a redirect source)`);
    }
    if (knownRoutes.has(rule.source)) {
      redirectProblems.push(`Redirect source ${rule.source} collides with a production route`);
    }
  }
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

  // JS budget: zero client JS on ordinary production pages.
  const jsReferences: string[] = [];
  for (const page of pages) {
    const root = parse(page.html);
    for (const script of root.querySelectorAll("script[src]")) {
      const src = script.getAttribute("src") ?? "";
      if (!src.includes("ld+json")) jsReferences.push(`${page.route}: ${src}`);
    }
  }
  checks.push(
    check(
      "performance.js_budget",
      "performance",
      jsReferences.length === 0 ? "PASS" : "REVIEW",
      jsReferences.length === 0
        ? "Zero external client JS on all production pages."
        : `External client JS references (justify each): ${jsReferences.join("; ")}`,
      jsReferences.map((ref) => ({ kind: "route" as const, ref: ref.split(":")[0] ?? ref })),
    ),
  );

  return { checks, overall: qaOverallVerdict(checks) };
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
