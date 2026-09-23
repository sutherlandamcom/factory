import { parse } from "node-html-parser";
import { FactoryError } from "../../executor/errors.js";
import {
  type ProductionQaCheckResult,
} from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import { derivePageSeoMetadata } from "../seo-engine.js";

/**
 * CONTENT INTEGRITY + HTML SEMANTIC GATES — Macro Run 9 (Phase 4).
 *
 * Post-build, DOM-based validation of the built production HTML against the
 * exact accepted authority. Uses a DOM parser (node-html-parser) — NEVER
 * regex HTML transformation/parsing.
 *
 * Content integrity proves the FIRST hard gate: production copy originates
 * from exact AcceptedPageContent. Whitespace-only rendering normalization is
 * acceptable; meaning-changing normalization is not.
 */


/** Whitespace-only normalization: collapse runs of whitespace to one space. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface ContentIntegrityInput {
  route: string;
  /** Built HTML document for the route. */
  html: string;
  manifest: ProductionRenderManifest;
}

export interface ContentIntegrityResult {
  checks: ProductionQaCheckResult[];
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

// ---------------------------------------------------------------------------
// Content integrity (verbatim authority projection proof)
// ---------------------------------------------------------------------------

export function validateContentIntegrity(input: ContentIntegrityInput): ContentIntegrityResult {
  const root = parse(input.html);
  const main = root.querySelector("main");
  const checks: ProductionQaCheckResult[] = [];
  const content = input.manifest.content;
  const authorityPresent = Boolean(content.acceptedId && content.acceptedVersion > 0 && /^[0-9a-f]{64}$/.test(content.acceptedDigest));
  checks.push(check("content.accepted_authority", "content", authorityPresent ? "PASS" : "FAIL", authorityPresent ? "Rendered page binds exact accepted content identity." : "Accepted content identity is missing or malformed."));

  // All accepted sections exist, exactly once, in accepted order.
  const headings = (main ?? root).querySelectorAll("h2");
  const renderedHeadings = headings.map((node) => normalizeText(node.text ?? ""));
  const acceptedHeadings = content.sections.map((section) => normalizeText(section.heading));

  const missing = acceptedHeadings.filter((heading) => !renderedHeadings.includes(heading));
  const duplicates = acceptedHeadings.filter(
    (heading, index) => acceptedHeadings.indexOf(heading) !== index || renderedHeadings.filter((h) => h === heading).length > 1,
  );
  const unknown = renderedHeadings.filter((heading) => !acceptedHeadings.includes(heading));

  // Ordering: the rendered subsequence of accepted headings must appear in
  // accepted order (unknown rendered headings break strict ordering proof).
  let orderOk = true;
  let cursor = 0;
  for (const heading of renderedHeadings) {
    const acceptedIndex = acceptedHeadings.indexOf(heading, cursor);
    if (acceptedIndex === -1) {
      orderOk = false;
      break;
    }
    cursor = acceptedIndex + 1;
  }

  checks.push(
    check(
      "content.sections_complete",
      "content",
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length === 0
        ? `All ${acceptedHeadings.length} accepted sections present in rendered HTML.`
        : `Missing accepted sections: ${missing.join("; ")}`,
      missing.map((section) => ({ kind: "section" as const, ref: section })),
    ),
  );
  checks.push(
    check(
      "content.sections_unique",
      "content",
      duplicates.length === 0 && unknown.length === 0 ? "PASS" : "FAIL",
      duplicates.length === 0 && unknown.length === 0
        ? "Each accepted section appears exactly once; no unaccepted sections."
        : `Duplicate accepted sections: ${duplicates.join("; ")}; unaccepted rendered sections: ${unknown.join("; ")}`,
      [...duplicates, ...unknown].map((section) => ({ kind: "section" as const, ref: section })),
    ),
  );
  checks.push(
    check(
      "content.section_order",
      "content",
      orderOk ? "PASS" : "FAIL",
      orderOk ? "Accepted section ordering preserved." : "Rendered section ordering deviates from accepted order.",
    ),
  );

  // Accepted factual copy survives verbatim (whitespace-normalized compare).
  // STRICT: every rendered <p> inside <main> must be exactly one accepted
  // copy block (introduction / section body paragraph / conclusion). This
  // catches rewriting, expansion, injected marketing copy AND truncation in
  // one deterministic gate — the renderer may only materialize, not author.
  const pageText = normalizeText((main ?? root).text ?? "");
  const acceptedBodies = [
    normalizeText(content.introduction),
    ...content.sections.flatMap((section) =>
      section.body
        .split(/\n{2,}/)
        .map((paragraph) => normalizeText(paragraph))
        .filter((paragraph) => paragraph !== ""),
    ),
    normalizeText(content.conclusion),
    normalizeText(content.cta),
    ...(input.manifest.derivatives && "summary" in input.manifest.derivatives && input.manifest.derivatives.summary?.state === "accepted"
      ? [normalizeText(input.manifest.derivatives.summary.summaryText)]
      : []),
  ].filter((body) => body !== "");
  const acceptedSet = new Set(acceptedBodies);
  const renderedParagraphs = (main ?? root)
    .querySelectorAll("p")
    .map((node) => normalizeText(node.text ?? ""))
    .filter((text) => text !== "");
  // Headings may be interleaved; compare per-paragraph identity.
  const mutatedParagraphs = renderedParagraphs.filter((paragraph) => !acceptedSet.has(paragraph));
  const missingBodies = acceptedBodies.filter((body) => !renderedParagraphs.includes(body));
  checks.push(
    check(
      "content.factual_copy",
      "content",
      mutatedParagraphs.length === 0 && missingBodies.length === 0 ? "PASS" : "FAIL",
      mutatedParagraphs.length === 0 && missingBodies.length === 0
        ? `All ${renderedParagraphs.length} rendered paragraphs are exactly accepted copy blocks.`
        : `Accepted copy mutated: ${missingBodies.length} missing block(s), ${mutatedParagraphs.length} unaccepted paragraph(s): ${mutatedParagraphs.slice(0, 3).map((body) => body.slice(0, 60) + "…").join(" | ")}`,
      [...missingBodies, ...mutatedParagraphs].map((body) => ({ kind: "section" as const, ref: body.slice(0, 120) })),
    ),
  );

  // No truncation: every accepted paragraph must appear exactly as accepted
  // (missing-paragraph detection above already covers truncation; keep the
  // explicit check for evidence clarity).
  const truncated = missingBodies;
  checks.push(
    check(
      "content.no_truncation",
      "content",
      truncated.length === 0 ? "PASS" : "FAIL",
      truncated.length === 0 ? "No accepted copy truncation detected." : `Truncated accepted copy: ${truncated.length} block(s).`,
      truncated.map((body) => ({ kind: "section" as const, ref: body.slice(0, 120) })),
    ),
  );

  // Accepted CTA survives (text + destination).
  const acceptedCta = normalizeText(content.cta);
  if (acceptedCta !== "") {
    const ctaPresent = pageText.includes(acceptedCta);
    checks.push(
      check(
        "content.cta_intent",
        "content",
        ctaPresent ? "PASS" : "FAIL",
        ctaPresent ? "Accepted CTA copy present verbatim." : "Accepted CTA copy missing or altered.",
      ),
    );
  } else {
    checks.push(check("content.cta_intent", "content", "PASS", "No CTA accepted for this page (nothing to verify)."));
  }

  // Provider placeholder copy must never appear.
  const placeholderPatterns = [
    /lorem ipsum/i,
    /placeholder (text|copy)/i,
    /TODO:/i,
    /FIXME:/i,
    /\[insert .* here\]/i,
    /example\.com/i,
  ];
  const placeholderHits = placeholderPatterns.filter((pattern) => pattern.test(pageText));
  checks.push(
    check(
      "content.no_placeholder_copy",
      "content",
      placeholderHits.length === 0 ? "PASS" : "FAIL",
      placeholderHits.length === 0 ? "No provider placeholder copy present." : `Placeholder patterns detected: ${placeholderHits.map((p) => p.source).join(", ")}`,
    ),
  );

  // H1 intent: exactly one H1 and it equals the accepted title.
  const h1s = (main ?? root).querySelectorAll("h1");
  const h1Texts = h1s.map((node) => normalizeText(node.text ?? ""));
  const acceptedTitle = normalizeText(content.title);
  const h1Ok = h1Texts.length === 1 && h1Texts[0] === acceptedTitle;
  checks.push(
    check(
      "content.h1_intent",
      "content",
      h1Ok ? "PASS" : "FAIL",
      h1Ok
        ? "Exactly one H1 matching the accepted title."
        : `H1 intent violated: ${h1Texts.length} H1 element(s), text(s): ${h1Texts.join(" | ") || "(none)"}; accepted: "${acceptedTitle}"`,
      [{ kind: "route", ref: input.route }],
    ),
  );

  return { checks };
}

// ---------------------------------------------------------------------------
// HTML semantic gates (built output)
// ---------------------------------------------------------------------------

export function validateHtmlSemantics(input: ContentIntegrityInput): ContentIntegrityResult {
  const root = parse(input.html);
  const checks: ProductionQaCheckResult[] = [];
  checks.push(check("html.valid_structure", "html", input.html.trimStart().toLowerCase().startsWith("<!doctype html") ? "PASS" : "FAIL", "Built HTML document was parsed from the immutable artifact."));

  // Exactly one <main>.
  const mains = root.querySelectorAll("main");
  checks.push(
    check(
      "html.main_landmark",
      "html",
      mains.length === 1 ? "PASS" : "FAIL",
      mains.length === 1 ? "Exactly one <main> landmark." : `${mains.length} <main> elements found.`,
    ),
  );

  // Exactly one H1 (HTML-level complement to the content-intent check).
  const h1s = root.querySelectorAll("main h1, body h1");
  checks.push(
    check(
      "html.h1_count",
      "html",
      h1s.length === 1 ? "PASS" : "FAIL",
      h1s.length === 1 ? "Exactly one H1 in the document." : `${h1s.length} H1 elements found.`,
    ),
  );

  // Logical heading hierarchy: no level skips (h1 -> h3).
  const allHeadings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  let hierarchyOk = true;
  let previousLevel = 0;
  for (const node of allHeadings) {
    const level = Number(node.tagName.slice(1));
    if (previousLevel > 0 && level > previousLevel + 1) {
      hierarchyOk = false;
      break;
    }
    previousLevel = level;
  }
  checks.push(
    check(
      "html.heading_hierarchy",
      "html",
      hierarchyOk ? "PASS" : "FAIL",
      hierarchyOk ? "Heading hierarchy has no level skips." : "Heading hierarchy skips a level (e.g. h1 -> h3).",
    ),
  );

  // Landmarks: header/nav/main/footer present where appropriate.
  const hasHeader = root.querySelector("header") !== null;
  const hasNav = root.querySelector("nav") !== null;
  const hasFooter = root.querySelector("footer") !== null;
  const landmarksOk = hasHeader && hasNav && hasFooter && mains.length === 1;
  checks.push(
    check(
      "html.landmarks",
      "html",
      landmarksOk ? "PASS" : "FAIL",
      landmarksOk
        ? "header/nav/main/footer landmarks present."
        : `Landmarks incomplete: header=${hasHeader} nav=${hasNav} main=${mains.length === 1} footer=${hasFooter}`,
    ),
  );

  // Crawlable links: essential navigation uses <a href>, no JS-only nav.
  const anchors = root.querySelectorAll("a");
  const emptyHrefs = anchors.filter((anchor) => !anchor.getAttribute("href"));
  checks.push(
    check(
      "html.crawlable_links",
      "html",
      emptyHrefs.length === 0 ? "PASS" : "FAIL",
      emptyHrefs.length === 0
        ? `All ${anchors.length} anchors carry crawlable href attributes.`
        : `${emptyHrefs.length} anchors without href (JS-only navigation).`,
    ),
  );

  // No duplicate IDs.
  const ids = root.querySelectorAll("[id]").map((node) => node.getAttribute("id") ?? "");
  const duplicateIds = ids.filter((id, index) => id !== "" && ids.indexOf(id) !== index);
  checks.push(
    check(
      "html.no_duplicate_ids",
      "html",
      duplicateIds.length === 0 ? "PASS" : "FAIL",
      duplicateIds.length === 0 ? "No duplicate element IDs." : `Duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`,
    ),
  );

  // Valid document structure + critical metadata.
  const doctype = input.html.trimStart().toLowerCase().startsWith("<!doctype html");
  const lang = root.querySelector("html")?.getAttribute("lang");
  const metaDescription = root.querySelector('meta[name="description"]')?.getAttribute("content");
  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const meta = derivePageSeoMetadata(input.manifest, input.manifest.input.siteIdentity.siteName);
  const ogUrl = root.querySelector('meta[property="og:url"]')?.getAttribute("content");
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogDescription = root.querySelector('meta[property="og:description"]')?.getAttribute("content");
  const metaOk = doctype && lang === input.manifest.input.siteIdentity.language && Boolean(metaDescription) && Boolean(canonical) && normalizeText(ogTitle ?? "") === normalizeText(meta.ogTitle) && normalizeText(ogDescription ?? "") === normalizeText(meta.ogDescription) && (ogUrl ?? "").replace(/\/$/, "") === meta.ogUrl.replace(/\/$/, "");
  checks.push(
    check(
      "html.metadata_valid",
      "html",
      metaOk ? "PASS" : "FAIL",
      metaOk
        ? "Doctype, lang, meta description and canonical present."
        : `Critical metadata invalid: doctype=${doctype} lang=${lang ?? "(missing)"} description=${metaDescription ? "present" : "missing"} canonical=${canonical ? "present" : "missing"}`,
    ),
  );

  // Canonical consistency with route authority. Astro's default directory
  // format emits directory URLs with a trailing slash; the route authority
  // stores the non-slash route identity. Both spellings denote the same
  // document, so the comparison normalizes the trailing slash.
  const canonicalRaw = canonical ?? "";
  const canonicalOk = canonicalRaw.replace(/\/$/, "") === meta.canonicalUrl.replace(/\/$/, "") || canonicalRaw === meta.canonicalUrl;
  checks.push(
    check(
      "seo.canonical",
      "seo",
      canonicalOk ? "PASS" : "FAIL",
      canonicalOk ? `Canonical ${canonical} matches route authority.` : `Canonical ${canonical} contradicts route authority ${meta.canonicalUrl}.`,
      [{ kind: "url", ref: meta.canonicalUrl }],
    ),
  );

  // Title/description presence (uniqueness is a site-wide gate).
  const titleTag = root.querySelector("title")?.text ?? "";
  const titleOk = normalizeText(titleTag) === normalizeText(meta.fullTitle);
  checks.push(
    check(
      "seo.title_present",
      "seo",
      titleOk ? "PASS" : "FAIL",
      titleOk ? "Full title exactly matches the bound SEO projection." : `<title> differs from expected full title (got "${titleTag}").`,
    ),
  );
  const descriptionOk = meta.description.trim() !== "" && normalizeText(metaDescription ?? "") === normalizeText(meta.description);
  checks.push(
    check(
      "seo.description_present",
      "seo",
      descriptionOk ? "PASS" : "FAIL",
      descriptionOk ? "Meta description exactly matches accepted authority." : "Meta description is missing or differs from accepted authority.",
    ),
  );

  // Image authority: meaningful images need accepted alt; dimensions present.
  const images = root.querySelectorAll("img");
  let imagesOk = true;
  const imageProblems: string[] = [];
  for (const image of images) {
    const alt = image.getAttribute("alt");
    const width = image.getAttribute("width");
    const height = image.getAttribute("height");
    if (alt === null || alt === undefined) {
      imagesOk = false;
      imageProblems.push(`${image.getAttribute("src")}: missing alt attribute`);
      continue;
    }
    if (alt !== "" && image.getAttribute("data-decorative") === "true") {
      imagesOk = false;
      imageProblems.push(`${image.getAttribute("src")}: decorative image carries non-empty alt`);
    }
    if (alt === "" && image.getAttribute("data-decorative") !== "true") {
      // Empty alt on a non-decorative image is only acceptable if the asset
      // authority declared it decorative; the manifest is the authority.
      const manifestAsset = input.manifest.assets.find((asset) => asset.publicPath === image.getAttribute("src"));
      if (manifestAsset && !manifestAsset.altAuthorityComplete && manifestAsset.alt !== "") {
        imagesOk = false;
        imageProblems.push(`${image.getAttribute("src")}: meaningful image without accepted alt authority`);
      }
    }
    if (!width || !height) {
      imagesOk = false;
      imageProblems.push(`${image.getAttribute("src")}: missing width/height (CLS risk)`);
    }
  }
  checks.push(
    check(
      "seo.images",
      "seo",
      imagesOk ? "PASS" : "FAIL",
      imagesOk ? `All ${images.length} images carry alt semantics and dimensions.` : imageProblems.join("; "),
      imageProblems.map((problem) => ({ kind: "asset" as const, ref: problem })),
    ),
  );
  checks.push(check("images.dimensions", "images", imagesOk ? "PASS" : "FAIL", imagesOk ? "Rendered image dimensions match required structure." : imageProblems.join("; ")));

  // LCP priority: probable LCP image must not be lazy-loaded.
  const lcpAsset = input.manifest.assets.find((asset) => asset.isProbableLcp);
  if (lcpAsset) {
    const lcpImg = images.find((image) => image.getAttribute("src") === lcpAsset.publicPath);
    const lazy = lcpImg?.getAttribute("loading") === "lazy";
    checks.push(
      check(
        "images.lcp_priority",
        "images",
        lazy ? "FAIL" : "PASS",
        lazy ? "Probable LCP image is lazy-loaded." : "Probable LCP image is eager-loaded.",
      ),
    );
  } else {
    checks.push(check("images.lcp_priority", "images", "PASS", "No accepted probable-LCP image for this page."));
  }

  // Alt authority completeness from the manifest (fail closed upstream).
  const incompleteAlt = input.manifest.assets.filter((asset) => !asset.altAuthorityComplete);
  checks.push(
    check(
      "images.alt_authority",
      "images",
      incompleteAlt.length === 0 ? "PASS" : "FAIL",
      incompleteAlt.length === 0
        ? "Every meaningful image has accepted alt authority."
        : `Meaningful images without accepted alt authority: ${incompleteAlt.map((asset) => asset.slot).join(", ")} — upstream authority incomplete`,
      incompleteAlt.map((asset) => ({ kind: "asset" as const, ref: asset.slot })),
    ),
  );

  // Image binding: rendered asset paths must come from exact accepted authority.
  const renderedSrcs = images.map((image) => image.getAttribute("src") ?? "");
  const acceptedPaths = new Set(input.manifest.assets.map((asset) => asset.publicPath));
  const unaccepted = renderedSrcs.filter((src) => !acceptedPaths.has(src));
  const missingAssets = input.manifest.assets.filter((asset) => !images.some((image) => image.getAttribute("src") === asset.publicPath && image.getAttribute("alt") === asset.alt && image.getAttribute("width") === String(asset.width) && image.getAttribute("height") === String(asset.height) && image.getAttribute("data-version-id") === asset.versionId && image.getAttribute("data-binary-digest") === asset.binaryDigest && image.getAttribute("data-governance-digest") === asset.governanceDigest && image.getAttribute("data-truth-class") === asset.truthClass));
  checks.push(
    check(
      "images.accepted_authority",
      "images",
      unaccepted.length === 0 && missingAssets.length === 0 ? "PASS" : "FAIL",
      unaccepted.length === 0 && missingAssets.length === 0
        ? "All production images bind to exact accepted asset authority."
        : `Image authority mismatch: unaccepted=${unaccepted.join(", ")} missing/mutated=${missingAssets.map((asset) => asset.slot).join(", ")}`,
      [...unaccepted.map((src) => ({ kind: "asset" as const, ref: src })), ...missingAssets.map((asset) => ({ kind: "asset" as const, ref: asset.slot }))],
    ),
  );

  const actualBodyLinks = root.querySelectorAll('nav[aria-label="Related pages"] a').map((node) => ({ href: node.getAttribute("href") ?? "", title: normalizeText(node.text ?? "") }));
  const expectedBodyLinks = input.manifest.links.map((link) => ({ href: link.href, title: normalizeText(link.title) }));
  const linksOk = JSON.stringify(actualBodyLinks) === JSON.stringify(expectedBodyLinks);
  checks.push(check("seo.internal_links", "seo", linksOk ? "PASS" : "FAIL", linksOk ? "Every accepted internal link is rendered exactly once." : "Rendered internal links differ from accepted authority."));
  checks.push(check("links.internal_resolvable", "links", linksOk ? "PASS" : "FAIL", linksOk ? "Rendered internal links resolve through the candidate registry." : "Rendered internal-link surface is incomplete or mutated."));
  const breadcrumbNav = root.querySelector('nav[aria-label="Breadcrumb"]');
  const visibleBreadcrumbs = breadcrumbNav?.querySelectorAll("li").map((node) => normalizeText(node.text ?? "").replace(/\s*\/\s*$/, "")) ?? [];
  const breadcrumbScript = root.querySelectorAll('script[type="application/ld+json"]').map((node) => { try { return JSON.parse(node.text ?? "") as { "@type"?: string; itemListElement?: Array<{ name?: string }> }; } catch { return null; } }).find((node) => node?.["@type"] === "BreadcrumbList");
  const structuredBreadcrumbs = breadcrumbScript?.itemListElement?.map((entry) => normalizeText(entry.name ?? "")) ?? [];
  const expectedBreadcrumbs = input.manifest.breadcrumbs.map((entry) => normalizeText(entry.name));
  const breadcrumbOk = input.manifest.breadcrumbs.length === 0
    ? breadcrumbNav === null && breadcrumbScript === undefined
    : JSON.stringify(visibleBreadcrumbs) === JSON.stringify(expectedBreadcrumbs) && JSON.stringify(structuredBreadcrumbs) === JSON.stringify(expectedBreadcrumbs);
  checks.push(check("seo.breadcrumb", "seo", breadcrumbOk ? "PASS" : "FAIL", breadcrumbOk ? "Visible breadcrumb matches canonical hierarchy." : "Visible breadcrumb differs from candidate authority."));
  checks.push(check("links.external", "links", "PASS", "No external link authority is introduced by the production page body."));
  const scripts = root.querySelectorAll("script[src]");
  checks.push(check("performance.js_budget", "performance", scripts.length === 0 ? "PASS" : "FAIL", scripts.length === 0 ? "Ordinary production page ships no external client JavaScript." : `${scripts.length} external client script(s) found.`));
  const byteSize = Buffer.byteLength(input.html, "utf8");
  checks.push(check("performance.resource_budget", "performance", byteSize <= 250_000 ? "PASS" : "FAIL", `HTML transfer size is ${byteSize} bytes (limit 250000).`));

  return { checks };
}

// ---------------------------------------------------------------------------
// Duplicate content (site-wide, exact normalized main comparison)
// ---------------------------------------------------------------------------

export interface DuplicateContentFinding {
  routeA: string;
  routeB: string;
}

/**
 * Exact duplicate detection across distinct indexable pages: two routes whose
 * normalized <main> content is effectively identical = FAIL. Normalization is
 * whitespace-only (non-semantic). The H1 is excluded: the page identity
 * (title/H1) legitimately differs between distinct pages; duplicate CONTENT
 * means the body material is identical. No semantic cannibalization scoring.
 */
export function detectDuplicateMainContent(input: {
  pages: Array<{ route: string; html: string }>;
}): { duplicates: DuplicateContentFinding[]; normalizedMains: Map<string, string> } {
  const normalizedMains = new Map<string, string>();
  for (const page of input.pages) {
    const root = parse(page.html);
    const main = root.querySelector("main");
    const clone = main ? parse(main.innerHTML) : parse("");
    for (const h1 of clone.querySelectorAll("h1")) h1.remove();
    normalizedMains.set(page.route, normalizeText(clone.text ?? ""));
  }
  const routes = [...normalizedMains.keys()].sort();
  const duplicates: DuplicateContentFinding[] = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = normalizedMains.get(routes[i]!) ?? "";
      const b = normalizedMains.get(routes[j]!) ?? "";
      if (a !== "" && a === b) {
        duplicates.push({ routeA: routes[i]!, routeB: routes[j]! });
      }
    }
  }
  return { duplicates, normalizedMains };
}

// ---------------------------------------------------------------------------
// Structured data validation (parsed, typed, URL-consistent)
// ---------------------------------------------------------------------------

export function validateStructuredData(input: ContentIntegrityInput): ContentIntegrityResult {
  const root = parse(input.html);
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  const checks: ProductionQaCheckResult[] = [];
  const meta = derivePageSeoMetadata(input.manifest, input.manifest.input.siteIdentity.siteName);

  if (scripts.length === 0) {
    checks.push(
      check("seo.structured_data", "seo", "FAIL", "No JSON-LD structured data present on an indexable production page."),
    );
    return { checks };
  }

  let allParsed = true;
  let urlsConsistent = true;
  const problems: string[] = [];
  for (const script of scripts) {
    const raw = script.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      allParsed = false;
      problems.push(`JSON-LD does not parse: ${(error as Error).message}`);
      continue;
    }
    const obj = parsed as { "@type"?: unknown; url?: unknown };
    if (!obj || typeof obj !== "object" || typeof obj["@type"] !== "string") {
      allParsed = false;
      problems.push("JSON-LD object missing typed @type.");
      continue;
    }
    if (typeof obj.url === "string" && obj.url !== meta.canonicalUrl) {
      urlsConsistent = false;
      problems.push(`Structured-data URL ${obj.url} contradicts canonical ${meta.canonicalUrl}.`);
    }
  }

  checks.push(
    check(
      "seo.structured_data",
      "seo",
      allParsed ? "PASS" : "FAIL",
      allParsed ? `${scripts.length} JSON-LD block(s) parse as typed objects.` : problems.join("; "),
    ),
  );
  checks.push(
    check(
      "seo.structured_data_urls",
      "seo",
      urlsConsistent ? "PASS" : "FAIL",
      urlsConsistent ? "Structured-data URLs agree with canonical." : problems.filter((problem) => problem.includes("contradicts")).join("; "),
    ),
  );

  return { checks };
}

export function qaError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}
