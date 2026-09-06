import { parse, type HTMLElement } from "node-html-parser";
import type { CompetitorPageExtracted, EvidenceSegment } from "@factory/contracts";

/**
 * Deterministic structural extraction (Macro Run 3, P3).
 *
 * NO model involvement: Factory extracts title, meta, canonical, headings,
 * text blocks, questions, lists, tables, JSON-LD signals, citations, dates,
 * CTA candidates and word count with deterministic code. Hostile/malformed
 * pages must never crash the extractor — bounded, defensive parsing.
 *
 * Extraction metadata is explicit: boilerplate/technical noise removal is
 * deterministic and versioned (EXTRACTION_VERSION); nothing else is dropped.
 * Semantic REDUCTION (what the analyst packet keeps) lives in packet.ts and
 * is separately disclosed with truncation metadata.
 */

export const EXTRACTION_VERSION = "extract-v1";

/** Normalized text of a node with collapsed whitespace and no control chars. */
function normalizeText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "footer",
  "aside",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
];

/** Cookie/consent banner heuristic: id/class markers commonly used by CMPs. */
const COOKIE_MARKERS = [
  "cookie",
  "consent",
  "gdpr",
  "cmp-",
  "onetrust",
  "usercentrics",
  "termly",
];

function isCookieBanner(el: HTMLElement): boolean {
  const idClass = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`.toLowerCase();
  if (COOKIE_MARKERS.some((m) => idClass.includes(m))) {
    const text = el.text.toLowerCase();
    if (text.includes("cookie") || text.includes("consent") || text.includes("privacy")) {
      return true;
    }
  }
  return false;
}

function stripNoise(root: HTMLElement): void {
  for (const selector of NOISE_SELECTORS) {
    try {
      for (const el of root.querySelectorAll(selector)) {
        if (selector === "footer" && isCookieBanner(el)) continue; // handled below
        el.remove();
      }
    } catch {
      // invalid selector on hostile input: skip
    }
  }
  // Cookie banners (any element carrying CMP markers).
  try {
    for (const el of root.querySelectorAll("div,section")) {
      if (isCookieBanner(el)) el.remove();
    }
  } catch {
    // ignore
  }
}

function segment(kind: EvidenceSegment["kind"], text: string, counter: { n: number }, level?: number): EvidenceSegment | null {
  const clean = normalizeText(text);
  if (!clean || clean.length < 2) return null;
  if (clean.length > 2000) {
    // Bounded segment text: extraction bound, disclosed by versioned policy.
    counter.n += 1;
    return { id: `seg-${String(counter.n).padStart(3, "0")}`, kind, text: clean.slice(0, 2000), ...(level !== undefined ? { level } : {}) };
  }
  counter.n += 1;
  return { id: `seg-${String(counter.n).padStart(3, "0")}`, kind, text: clean, ...(level !== undefined ? { level } : {}) };
}

/** Extract questions from visible text: sentences ending in "?" up to bound. */
function extractQuestions(texts: string[], limit: number): string[] {
  const questions: string[] = [];
  for (const text of texts) {
    for (const candidate of text.split(/(?<=[.?!])\s+/)) {
      const clean = normalizeText(candidate);
      if (clean.endsWith("?") && clean.length >= 8 && clean.length <= 500 && !questions.includes(clean)) {
        questions.push(clean);
        if (questions.length >= limit) return questions;
      }
    }
  }
  return questions;
}

const CTA_PATTERNS = [
  /\b(contact|book|reserve|call|get a quote|request|sign up|subscribe|learn more|buy now|order|enquire|inquire|download|start (?:your|a)|free (?:quote|consultation|trial))\b/i,
];

const DATE_PATTERNS: Array<[RegExp, "publicationDate" | "updatedDate"]> = [
  [/"datePublished"\s*:\s*"([^"]+)"/, "publicationDate"],
  [/"dateModified"\s*:\s*"([^"]+)"/, "updatedDate"],
];

function extractJsonLdTypes(rawHtml: string): { types: string[]; hasFaq: boolean; dates: Partial<Record<"publicationDate" | "updatedDate", string>> } {
  const types = new Set<string>();
  const dates: Partial<Record<"publicationDate" | "updatedDate", string>> = {};
  // Scan raw HTML for JSON-LD blocks (the parser drops script text by design).
  const blocks: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = re.exec(rawHtml)) !== null) {
    if (blockMatch[1]) blocks.push(blockMatch[1]);
  }
  const raw = blocks.join("\n");
  if (!raw) return { types: [], hasFaq: false, dates };
  let hasFaq = /"@type"\s*:\s*"FAQPage"/.test(raw) || /"@type"\s*:\s*"Question"/.test(raw);
  for (const m of raw.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) {
    if (m[1]) types.add(m[1].slice(0, 100));
  }
  if (types.has("FAQPage")) hasFaq = true;
  for (const [pattern, field] of DATE_PATTERNS) {
    const m = pattern.exec(raw);
    if (m?.[1]) dates[field] = m[1].slice(0, 40);
  }
  return { types: [...types].slice(0, 20), hasFaq, dates };
}

/** Extract publication/update dates from meta tags as fallback signals. */
function extractMetaDates(root: HTMLElement): Partial<Record<"publicationDate" | "updatedDate", string>> {
  const dates: Partial<Record<"publicationDate" | "updatedDate", string>> = {};
  const metaSelectors: Array<[string, "publicationDate" | "updatedDate"]> = [
    ["meta[property='article:published_time']", "publicationDate"],
    ["meta[name='date']", "publicationDate"],
    ["meta[property='article:modified_time']", "updatedDate"],
    ["meta[name='last-modified']", "updatedDate"],
  ];
  for (const [selector, field] of metaSelectors) {
    try {
      const el = root.querySelector(selector);
      const content = el?.getAttribute("content");
      if (content && !dates[field]) dates[field] = normalizeText(content).slice(0, 40);
    } catch {
      // ignore
    }
  }
  return dates;
}

/**
 * Extract structural evidence from raw HTML. Never throws on malformed
 * input: bounded defensive parsing returns a minimal extraction.
 */
export function extractCompetitorPage(html: string): CompetitorPageExtracted {
  const counter = { n: 0 };
  let root: HTMLElement;
  try {
    root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  } catch {
    return minimalExtraction();
  }

  const pageTitle = normalizeText(root.querySelector("title")?.text ?? "").slice(0, 500) || undefined;
  const metaDescription = normalizeText(root.querySelector("meta[name='description']")?.getAttribute("content") ?? "").slice(0, 1000) || undefined;
  let canonicalUrl: string | undefined;
  try {
    const canonical = root.querySelector("link[rel='canonical']")?.getAttribute("href");
    if (canonical) {
      const u = new URL(canonical, "https://placeholder.invalid");
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "placeholder.invalid") {
        canonicalUrl = u.toString();
      }
    }
  } catch {
    canonicalUrl = undefined;
  }
  const h1 = normalizeText(root.querySelector("h1")?.text ?? "").slice(0, 500) || undefined;

  stripNoise(root);

  // Headings H2/H3 (H1 captured above; deeper levels add noise).
  const headings: EvidenceSegment[] = [];
  try {
    for (const level of [2, 3] as const) {
      for (const el of root.querySelectorAll(`h${level}`)) {
        const seg = segment("heading", el.text, counter, level);
        if (seg && headings.length < 200) headings.push(seg);
      }
    }
  } catch {
    // ignore
  }

  // Main text blocks: paragraphs + list items + table cells + FAQ blocks.
  const segments: EvidenceSegment[] = [...headings];
  const textPieces: string[] = [];
  try {
    for (const el of root.querySelectorAll("p")) {
      const seg = segment("paragraph", el.text, counter);
      if (seg && segments.length < 400) {
        segments.push(seg);
        textPieces.push(seg.text);
      }
    }
    for (const el of root.querySelectorAll("li")) {
      const seg = segment("list", el.text, counter);
      if (seg && segments.length < 400) {
        segments.push(seg);
        textPieces.push(seg.text);
      }
    }
    for (const el of root.querySelectorAll("td,th")) {
      const seg = segment("table", el.text, counter);
      if (seg && segments.length < 400) {
        segments.push(seg);
        textPieces.push(seg.text);
      }
    }
    for (const el of root.querySelectorAll("h2,h3,h4,summary,dt")) {
      const text = normalizeText(el.text);
      if (text.endsWith("?") && segments.length < 400) {
        const seg = segment("question", text, counter);
        if (seg) segments.push(seg);
      }
    }
  } catch {
    // ignore
  }

  const questions = extractQuestions(textPieces, 100);
  const jsonLd = extractJsonLdTypes(html);
  const metaDates = extractMetaDates(root);
  const jsonLdTypes = jsonLd.types;

  // Outbound citations (bounded, absolute URLs only).
  const outboundLinks: Array<{ url: string; text?: string }> = [];
  try {
    for (const el of root.querySelectorAll("a[href]")) {
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#")) continue;
      try {
        const u = new URL(href, "https://placeholder.invalid");
        if (u.hostname === "placeholder.invalid") continue;
        if (u.protocol !== "https:" && u.protocol !== "http:") continue;
        if (u.username || u.password) continue;
        const text = normalizeText(el.text).slice(0, 300) || undefined;
        const url = u.toString();
        if (outboundLinks.length < 50 && !outboundLinks.some((l) => l.url === url)) {
          outboundLinks.push({ url, ...(text ? { text } : {}) });
        }
      } catch {
        // skip malformed href
      }
    }
  } catch {
    // ignore
  }

  // CTA candidates: short imperative texts in links/buttons.
  const ctaSignals: string[] = [];
  try {
    for (const el of root.querySelectorAll("a,button,input[type='submit']")) {
      const text = normalizeText(el.text ?? el.getAttribute("value") ?? "");
      if (text && text.length <= 100 && CTA_PATTERNS.some((p) => p.test(text)) && !ctaSignals.includes(text)) {
        ctaSignals.push(text);
        if (ctaSignals.length >= 30) break;
      }
    }
  } catch {
    // ignore
  }

  const wordCount = textPieces.join(" ").split(/\s+/).filter(Boolean).length;

  return {
    ...(pageTitle ? { pageTitle } : {}),
    ...(metaDescription ? { metaDescription } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(h1 ? { h1 } : {}),
    headings,
    segments,
    questions,
    jsonLdTypes,
    hasFaqSchema: jsonLd.hasFaq,
    outboundLinks,
    ...(jsonLd.dates.publicationDate ?? metaDates.publicationDate
      ? { publicationDate: (jsonLd.dates.publicationDate ?? metaDates.publicationDate)! }
      : {}),
    ...(jsonLd.dates.updatedDate ?? metaDates.updatedDate
      ? { updatedDate: (jsonLd.dates.updatedDate ?? metaDates.updatedDate)! }
      : {}),
    ctaSignals,
    wordCount,
    extractionVersion: EXTRACTION_VERSION,
  };
}

function minimalExtraction(): CompetitorPageExtracted {
  return {
    headings: [],
    segments: [],
    questions: [],
    jsonLdTypes: [],
    hasFaqSchema: false,
    outboundLinks: [],
    ctaSignals: [],
    wordCount: 0,
    extractionVersion: EXTRACTION_VERSION,
  };
}

/** Digest helper for extraction determinism checks (store computes the official one). */
export function canonicalExtractionJson(extracted: CompetitorPageExtracted): string {
  return JSON.stringify(extracted);
}
