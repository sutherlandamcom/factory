import assert from "node:assert/strict";
import test from "node:test";
import {
  validateContentIntegrity,
  validateHtmlSemantics,
  validateStructuredData,
  detectDuplicateMainContent,
} from "../src/production/qa/content-integrity.js";
import {
  derivePageSeoMetadata,
  generateSitemapAndRobots,
  deriveBreadcrumbs,
  breadcrumbJsonLd,
  checkSiteWideSeo,
  checkInternalLinks,
} from "../src/production/seo-engine.js";
import type { ProductionRenderManifest } from "../src/production/render-manifest.js";
import { validateCandidateRedirects } from "../src/production/qa/site-wide.js";

// ---------------------------------------------------------------------------
// Fixture: a valid manifest + a rendered page that faithfully materializes it
// ---------------------------------------------------------------------------

const manifest: ProductionRenderManifest = {
  schemaVersion: "production-v1",
  input: {
    id: "ppin-1",
    version: 1,
    digest: "a".repeat(64),
    projectId: "proj-1",
    pageIdentity: "sutherland-home",
    pageType: "homepage",
    route: "/",
    siteIdentity: { siteId: "sutherland-private-office", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "f".repeat(64) },
  },
  seo: { fullTitle: "Independent advice for consequential French Alps property decisions | Sutherland Private Office", description: "Evidence-led acquisition and asset advisory for international buyers.", canonicalUrl: "https://sutherlandam.com/", ogTitle: "Independent advice for consequential French Alps property decisions | Sutherland Private Office", ogDescription: "Evidence-led acquisition and asset advisory for international buyers.", ogUrl: "https://sutherlandam.com/" },
  content: {
    acceptedId: "wprp-1",
    acceptedVersion: 1,
    acceptedDigest: "b".repeat(64),
    title: "Independent advice for consequential French Alps property decisions",
    metaDescription: "Evidence-led acquisition and asset advisory for international buyers.",
    introduction: "Sutherland Private Office provides evidence-led analysis and decision support.",
    sections: [
      { heading: "Choose the support appropriate to the decision", body: "The two established pathways are the starting points for most engagements." },
      { heading: "What the evidence can and cannot tell you", body: "Market-level evidence cannot determine the value of an individual asset." },
    ],
    conclusion: "An engagement begins with a defined decision and a selective scoping conversation.",
    cta: "Begin with a scoping conversation.",
    internalLinks: ["/", "/services/asset-review"],
  },
  design: { acceptedId: "dacc-1", acceptedVersion: 1, acceptedDigest: "9".repeat(64), tokens: { colors: { primary: "#1A2E35" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "fixture" }, spacing: { md: "16px", lg: "32px" }, rounded: { md: "8px" }, ctaHierarchy: "text only", navigationLanguage: "plain", imageryTreatment: "documentary", sectionRhythm: "measured" }, archetype: { kind: "homepage", sectionPatterns: ["hero", "evidence", "cta"], contentRequirements: [], assetSlots: [{ slot: "hero.primary", role: "hero", requiredRole: "hero" }], primaryCta: "", secondaryCta: "", responsiveBehavior: "stack", trustPresentation: "visible", rendererPrimitives: ["hero", "evidence", "cta"] } },
  links: [{ href: "/", title: "Home" }, { href: "/services/asset-review", title: "Asset Review" }],
  breadcrumbs: [],
  assets: [
    {
      slot: "hero.primary",
      role: "hero",
      truthClass: "illustrative",
      versionId: "asv-1",
      binaryDigest: "c".repeat(64),
      governanceDigest: "d".repeat(64),
      publicPath: "/production-assets/1111111111111111111111111111111111111111111111111111111111111111.jpg",
      width: 1600,
      height: 900,
      alt: "Chamonix valley panorama at dusk",
      altAuthorityComplete: true,
      isProbableLcp: true,
    },
  ],
  manifestDigest: "e".repeat(64),
};

function renderFaithfulPage(manifest: ProductionRenderManifest): string {
  return `<!doctype html>
<html lang="${manifest.input.siteIdentity.language}">
<head>
  <meta charset="utf-8" />
  <title>${manifest.seo.fullTitle}</title>
  <meta name="description" content="${manifest.content.metaDescription}" />
  <link rel="canonical" href="https://sutherlandam.com/" />
  <meta property="og:url" content="https://sutherlandam.com/" />
  <meta property="og:title" content="${manifest.seo.ogTitle}" />
  <meta property="og:description" content="${manifest.content.metaDescription}" />
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"${manifest.content.title}","url":"https://sutherlandam.com/"}</script>
</head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <h1>${manifest.content.title}</h1>
    <p>${manifest.content.introduction}</p>
    <img src="${manifest.assets[0]!.publicPath}" alt="${manifest.assets[0]!.alt}" width="1600" height="900" loading="eager" data-version-id="${manifest.assets[0]!.versionId}" data-binary-digest="${manifest.assets[0]!.binaryDigest}" data-governance-digest="${manifest.assets[0]!.governanceDigest}" data-truth-class="${manifest.assets[0]!.truthClass}" />
    ${manifest.content.sections.map((section) => `<section><h2>${section.heading}</h2><p>${section.body}</p></section>`).join("\n    ")}
    <p>${manifest.content.conclusion}</p>
    <p>${manifest.content.cta}</p>
    <nav aria-label="Related pages">${manifest.links.map((link) => `<a href="${link.href}">${link.title}</a>`).join("")}</nav>
  </main>
  <footer>Factory Production Site</footer>
</body>
</html>`;
}

function verdictOf(checks: Array<{ checkId: string; verdict: string }>, checkId: string): string {
  const found = checks.find((entry) => entry.checkId === checkId);
  assert.ok(found, `missing check ${checkId}`);
  return found.verdict;
}

test("faithful rendering passes all content-integrity gates", () => {
  const html = renderFaithfulPage(manifest);
  const content = validateContentIntegrity({ route: "/", html, manifest });
  assert.equal(content.checks.filter((entry) => entry.verdict === "FAIL").length, 0, JSON.stringify(content.checks.filter((e) => e.verdict === "FAIL")));
});

test("MUTATION: deleting a section fails content.sections_complete", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    /<section><h2>What the evidence can and cannot tell you<\/h2>.*?<\/section>/s,
    "",
  );
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.sections_complete"), "FAIL");
});

test("MUTATION: duplicating a section fails content.sections_unique", () => {
  const section = `<section><h2>${manifest.content.sections[0]!.heading}</h2><p>${manifest.content.sections[0]!.body}</p></section>`;
  const mutated = renderFaithfulPage(manifest).replace(section, section + section);
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.sections_unique"), "FAIL");
});

test("MUTATION: changing accepted text fails content.factual_copy", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    manifest.content.sections[0]!.body,
    manifest.content.sections[0]!.body + " Slightly reworded for SEO.",
  );
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.factual_copy"), "FAIL");
});

test("MUTATION: truncating accepted text fails content.no_truncation + factual_copy", () => {
  const truncatedBody = manifest.content.sections[0]!.body.slice(0, 40);
  const mutated = renderFaithfulPage(manifest).replace(manifest.content.sections[0]!.body, truncatedBody);
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.factual_copy"), "FAIL");
});

test("MUTATION: injecting an unaccepted marketing paragraph fails content.sections_unique", () => {
  const injected = renderFaithfulPage(manifest).replace(
    "<p>" + manifest.content.conclusion + "</p>",
    "<section><h2>Why we are the best</h2><p>Unrivalled excellence, contact us today!</p></section><p>" + manifest.content.conclusion + "</p>",
  );
  const result = validateContentIntegrity({ route: "/", html: injected, manifest });
  assert.equal(verdictOf(result.checks, "content.sections_unique"), "FAIL");
});

test("MUTATION: substituting CTA text fails content.cta_intent", () => {
  const mutated = renderFaithfulPage(manifest).replace(manifest.content.cta, "Call now for exclusive deals!");
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.cta_intent"), "FAIL");
});

test("MUTATION: provider placeholder copy fails content.no_placeholder_copy", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    manifest.content.introduction,
    "Lorem ipsum dolor sit amet " + manifest.content.introduction,
  );
  const result = validateContentIntegrity({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "content.no_placeholder_copy"), "FAIL");
});

test("MUTATION: second H1 fails content.h1_intent and html.h1_count", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    "<h2>" + manifest.content.sections[0]!.heading + "</h2>",
    "<h1>" + manifest.content.sections[0]!.heading + "</h1>",
  );
  const contentResult = validateContentIntegrity({ route: "/", html: mutated, manifest });
  const htmlResult = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(contentResult.checks, "content.h1_intent"), "FAIL");
  assert.equal(verdictOf(htmlResult.checks, "html.h1_count"), "FAIL");
});

test("MUTATION: heading hierarchy skip (h1->h3) fails html.heading_hierarchy", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    "<h2>" + manifest.content.sections[0]!.heading + "</h2>",
    "<h3>" + manifest.content.sections[0]!.heading + "</h3>",
  );
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "html.heading_hierarchy"), "FAIL");
});

test("MUTATION: wrong canonical fails seo.canonical", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    '<link rel="canonical" href="https://sutherlandam.com/" />',
    '<link rel="canonical" href="https://evil.example/clone" />',
  );
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.canonical"), "FAIL");
});

test("MUTATION: wrong og:url fails exact metadata equality", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    '<meta property="og:url" content="https://sutherlandam.com/" />',
    '<meta property="og:url" content="https://sutherlandam.com/alias" />',
  );
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "html.metadata_valid"), "FAIL");
});

test("MUTATION: title suffix injection fails exact title equality", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    `<title>${manifest.seo.fullTitle}</title>`,
    `<title>${manifest.seo.fullTitle} | Injected</title>`,
  );
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.title_present"), "FAIL");
});

test("MUTATION: structured-data URL contradicting canonical fails", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    '"url":"https://sutherlandam.com/"',
    '"url":"https://other.example/page"',
  );
  const result = validateStructuredData({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.structured_data_urls"), "FAIL");
});

test("MUTATION: unparseable JSON-LD fails seo.structured_data", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    '{"@context":"https://schema.org"',
    '{"@context":"https://schema.org" BROKEN',
  );
  const result = validateStructuredData({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.structured_data"), "FAIL");
});

test("MUTATION: meaningful image without accepted alt authority fails images.alt_authority", () => {
  const brokenManifest: ProductionRenderManifest = {
    ...manifest,
    assets: [{ ...manifest.assets[0]!, alt: "", altAuthorityComplete: false }],
  };
  const html = renderFaithfulPage(brokenManifest);
  const result = validateHtmlSemantics({ route: "/", html, manifest: brokenManifest });
  assert.equal(verdictOf(result.checks, "images.alt_authority"), "FAIL");
});

test("MUTATION: image dimensions missing fails seo.images", () => {
  const mutated = renderFaithfulPage(manifest).replace(' width="1600" height="900"', "");
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.images"), "FAIL");
});

test("MUTATION: LCP image lazy-loaded fails images.lcp_priority", () => {
  const mutated = renderFaithfulPage(manifest).replace('loading="eager"', 'loading="lazy"');
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "images.lcp_priority"), "FAIL");
});

test("MUTATION: unaccepted image substitution fails images.accepted_authority", () => {
  const mutated = renderFaithfulPage(manifest).replace(
    manifest.assets[0]!.publicPath,
    "/production-assets/9999999999999999999999999999999999999999999999999999999999999999.jpg",
  );
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "images.accepted_authority"), "FAIL");
});

test("MUTATION: changed or removed rendered alt fails exact image authority", () => {
  for (const replacement of ['alt="Changed authority"', ""]) {
    const mutated = renderFaithfulPage(manifest).replace(`alt="${manifest.assets[0]!.alt}"`, replacement);
    const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
    assert.equal(verdictOf(result.checks, "images.accepted_authority"), "FAIL");
  }
});

test("MUTATION: accepted internal anchor missing from rendered HTML fails", () => {
  const accepted = manifest.links[1]!;
  const mutated = renderFaithfulPage(manifest).replace(`<a href="${accepted.href}">${accepted.title}</a>`, "");
  const result = validateHtmlSemantics({ route: "/", html: mutated, manifest });
  assert.equal(verdictOf(result.checks, "seo.internal_links"), "FAIL");
  assert.equal(verdictOf(result.checks, "links.internal_resolvable"), "FAIL");
});

test("MUTATION: duplicate main content across routes is detected", () => {
  const pageA = renderFaithfulPage(manifest);
  const otherManifest: ProductionRenderManifest = {
    ...manifest,
    input: { ...manifest.input, route: "/services/asset-review" },
    content: { ...manifest.content, title: "Different title", metaDescription: "Different description" },
  };
  const pageB = renderFaithfulPage(otherManifest).replace(
    /<h1>[^<]*<\/h1>/,
    `<h1>${otherManifest.content.title}</h1>`,
  );
  const result = detectDuplicateMainContent({ pages: [
    { route: "/", html: pageA },
    { route: "/services/asset-review", html: pageB },
  ]});
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]!.routeA, "/");
});

test("duplicate detection passes for genuinely different pages", () => {
  const pageA = renderFaithfulPage(manifest);
  const otherManifest: ProductionRenderManifest = {
    ...manifest,
    input: { ...manifest.input, route: "/services/asset-review" },
    content: {
      ...manifest.content,
      title: "Asset review",
      introduction: "A completely different page about asset reviews.",
      sections: [{ heading: "Review scope", body: "Structured evidence and risk review of a specific property." }],
      conclusion: "A documented assessment.",
      cta: "Request an asset review.",
    },
  };
  const pageB = renderFaithfulPage(otherManifest);
  const result = detectDuplicateMainContent({ pages: [
    { route: "/", html: pageA },
    { route: "/services/asset-review", html: pageB },
  ]});
  assert.equal(result.duplicates.length, 0);
});

// ---------------------------------------------------------------------------
// SEO engine
// ---------------------------------------------------------------------------

test("SEO metadata derives deterministically from accepted authority", () => {
  const meta = derivePageSeoMetadata(manifest, "Sutherland Private Office");
  assert.equal(meta.canonicalUrl, "https://sutherlandam.com/");
  assert.equal(meta.title, manifest.content.title);
  assert.equal(meta.ogUrl, meta.canonicalUrl);
  assert.equal(meta.ogImage, `https://sutherlandam.com${manifest.assets[0]!.publicPath}`);
  assert.equal(meta.indexable, true);
});

test("sitemap includes only canonical indexable pages; every URL equals canonical", () => {
  const second: ProductionRenderManifest = {
    ...manifest,
    input: { ...manifest.input, route: "/services/asset-review" },
    seo: { ...manifest.seo, canonicalUrl: "https://sutherlandam.com/services/asset-review", ogUrl: "https://sutherlandam.com/services/asset-review" },
  };
  const result = generateSitemapAndRobots({ manifests: [manifest, second], siteName: "Sutherland Private Office" });
  assert.deepEqual(result.includedUrls.sort(), [
    "https://sutherlandam.com/",
    "https://sutherlandam.com/services/asset-review",
  ]);
  assert.match(result.sitemapXml, /<loc>https:\/\/sutherlandam\.com\/<\/loc>/);
  assert.match(result.robotsTxt, /Sitemap: https:\/\/sutherlandam\.com\/sitemap\.xml/);
});

test("site-wide SEO check detects duplicate titles/descriptions", () => {
  const second: ProductionRenderManifest = {
    ...manifest,
    input: { ...manifest.input, route: "/services/asset-review" },
    seo: { ...manifest.seo, canonicalUrl: "https://sutherlandam.com/services/asset-review", ogUrl: "https://sutherlandam.com/services/asset-review" },
  };
  const result = checkSiteWideSeo([manifest, second], "Sutherland Private Office");
  assert.equal(result.duplicateTitles.length, 1);
  assert.equal(result.duplicateDescriptions.length, 1);
});

test("internal link to missing route is flagged", () => {
  const result = checkInternalLinks({
    manifests: [manifest],
    knownRoutes: new Set(["/"]),
  });
  assert.ok(result.some((entry) => entry.href === "/services/asset-review" && entry.problem === "missing_target"));
});

test("breadcrumbs derive from real route hierarchy only; homepage exempt", () => {
  const home = deriveBreadcrumbs({
    route: "/",
    canonicalOrigin: "https://sutherlandam.com",
    knownRoutes: new Set(["/"]),
    pageTitlesByRoute: new Map([["/", "Home"]]),
  });
  assert.equal(home.valid, true);
  assert.equal(home.entries.length, 0);

  const invented = deriveBreadcrumbs({
    route: "/services/asset-review",
    canonicalOrigin: "https://sutherlandam.com",
    knownRoutes: new Set(["/"]),
    pageTitlesByRoute: new Map([["/", "Home"]]),
  });
  assert.equal(invented.valid, false);

  const real = deriveBreadcrumbs({
    route: "/services/asset-review",
    canonicalOrigin: "https://sutherlandam.com",
    knownRoutes: new Set(["/", "/services"]),
    pageTitlesByRoute: new Map([
      ["/", "Home"],
      ["/services", "Services"],
      ["/services/asset-review", "Asset review"],
    ]),
  });
  assert.equal(real.valid, true);
  assert.equal(real.entries.length, 3);
  assert.equal(real.entries[2]!.url, "", "leaf breadcrumb is the current page (no self-link)");
  assert.deepEqual(breadcrumbJsonLd(real.entries)?.["@type"], "BreadcrumbList");
});

test("candidate redirect snapshot rejects loops, chains, and route collisions but accepts one-hop rules", () => {
  const routes = new Set(["/", "/current"]);
  assert.match(validateCandidateRedirects([{ source: "/old", destination: "/old", kind: "permanent" }], routes)[0]!, /loop/i);
  assert.ok(validateCandidateRedirects([
    { source: "/a", destination: "/b", kind: "permanent" },
    { source: "/b", destination: "/current", kind: "permanent" },
  ], routes).some((problem) => /chain/i.test(problem)));
  assert.ok(validateCandidateRedirects([{ source: "/current", destination: "/", kind: "permanent" }], routes).some((problem) => /collides/i.test(problem)));
  assert.deepEqual(validateCandidateRedirects([{ source: "/old", destination: "/current", kind: "permanent" }], routes), []);
});
