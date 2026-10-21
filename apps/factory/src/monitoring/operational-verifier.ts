import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { OperationalCheckResult } from "./service.js";

export interface HttpOperationalVerifierOptions {
  timeoutMs?: number;
  allowLocalhost?: boolean;
  maxRedirects?: number;
  maxBodyBytes?: number;
  lookupFn?: typeof lookup;
}

const BLOCKED_HOST_MESSAGE = "URL host resolves to a forbidden network range.";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Normalizes a URL for exact canonical comparison.
 * - Scheme and hostname lowercase
 * - Strips standard ports (80 for http, 443 for https)
 * - Normalizes trailing slash for non-root paths (removes trailing slash)
 * - Strips hash/fragment
 */
export function normalizeCanonicalUrl(rawUrl: string, baseUrl?: string): string {
  const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;
  parsed.hash = "";

  return parsed.toString();
}

/**
 * Validates a target URL against SSRF rules.
 * Blocks private, loopback, link-local, cloud metadata, and multicast ranges.
 */
export async function validateUrlForSsrf(
  rawUrl: string,
  options: { allowLocalhost?: boolean; lookupFn?: typeof lookup } = {},
): Promise<{ ok: boolean; reason?: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is not parseable." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Protocol ${url.protocol} is not allowed.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Credential-bearing URLs are not allowed." };
  }

  const rawHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!rawHost) {
    return { ok: false, reason: "URL has no host." };
  }

  // Handle localhost bypass if explicitly enabled for testing
  if (options.allowLocalhost) {
    if (rawHost === "localhost" || rawHost === "127.0.0.1" || rawHost === "::1") {
      return { ok: true };
    }
  }

  const lookupFn = options.lookupFn ?? lookup;
  let addresses: Array<{ address: string; family: number }> = [];

  if (ipaddr.isValid(rawHost)) {
    addresses = [{ address: rawHost, family: rawHost.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await lookupFn(rawHost, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: "DNS resolution failed." };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: "DNS returned no addresses." };
    }
  }

  for (const { address } of addresses) {
    if (!ipaddr.isValid(address)) {
      return { ok: false, reason: BLOCKED_HOST_MESSAGE };
    }
    const parsedIp = ipaddr.parse(address);

    // If IPv6 is mapped IPv4 (::ffff:192.0.2.1), check IPv4 range
    if (parsedIp.kind() === "ipv6" && (parsedIp as ipaddr.IPv6).isIPv4MappedAddress()) {
      const v4 = (parsedIp as ipaddr.IPv6).toIPv4Address();
      if (isBlockedIpv4(v4, options.allowLocalhost)) {
        return { ok: false, reason: BLOCKED_HOST_MESSAGE };
      }
      continue;
    }

    if (parsedIp.kind() === "ipv4") {
      if (isBlockedIpv4(parsedIp as ipaddr.IPv4, options.allowLocalhost)) {
        return { ok: false, reason: BLOCKED_HOST_MESSAGE };
      }
    } else {
      if (isBlockedIpv6(parsedIp as ipaddr.IPv6, options.allowLocalhost)) {
        return { ok: false, reason: BLOCKED_HOST_MESSAGE };
      }
    }
  }

  return { ok: true };
}

function isBlockedIpv4(ip: ipaddr.IPv4, allowLocalhost?: boolean): boolean {
  const range = ip.range();
  if (allowLocalhost && range === "loopback") {
    return false;
  }
  // linkLocal includes 169.254.169.254 (cloud metadata)
  const blockedRanges = new Set([
    "unspecified",
    "private",
    "loopback",
    "linkLocal",
    "carrierGradeNat",
    "multicast",
    "broadcast",
    "reserved",
  ]);
  return blockedRanges.has(range);
}

function isBlockedIpv6(ip: ipaddr.IPv6, allowLocalhost?: boolean): boolean {
  const range = ip.range();
  if (allowLocalhost && range === "loopback") {
    return false;
  }
  const blockedRanges = new Set([
    "unspecified",
    "loopback",
    "linkLocal",
    "uniqueLocal",
    "multicast",
    "reserved",
    "discard",
  ]);
  return blockedRanges.has(range);
}

/**
 * Real HTTP operational verifier for production monitoring (Run 13 §10 / P1-04).
 * Performs genuine HTTP requests against the target production origin, inspecting:
 * 1. HTTP 200 response
 * 2. <link rel="canonical"> tag and Link header match via exact normalization
 * 3. /robots.txt availability
 * 4. /sitemap.xml availability
 * 5. Meta robots indexability (no noindex)
 * 6. SSRF guards on all URLs and redirect hops
 * 7. Capped response size (2MB)
 */
export class HttpOperationalVerifier {
  private readonly timeoutMs: number;
  private readonly allowLocalhost: boolean;
  private readonly maxRedirects: number;
  private readonly maxBodyBytes: number;
  private readonly lookupFn?: typeof lookup;

  constructor(options: HttpOperationalVerifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.allowLocalhost = options.allowLocalhost ?? false;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.lookupFn = options.lookupFn;
  }

  /**
   * Safely fetches a URL, following redirects up to maxRedirects,
   * validating each redirect hop against SSRF rules, and capping body size.
   */
  private async safeFetch(
    initialUrl: string,
    timeoutMs: number,
  ): Promise<{ response: Response; body: string; finalUrl: string }> {
    let currentUrl = initialUrl;
    let redirectCount = 0;

    while (redirectCount <= this.maxRedirects) {
      const ssrfCheck = await validateUrlForSsrf(currentUrl, {
        allowLocalhost: this.allowLocalhost,
        lookupFn: this.lookupFn,
      });
      if (!ssrfCheck.ok) {
        throw new Error(`SSRF blocked for URL ${currentUrl}: ${ssrfCheck.reason}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let resp: Response;
      try {
        resp = await fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "Factory-Operational-Verifier/1.0" },
        });
      } finally {
        clearTimeout(timer);
      }

      // Check if redirect
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const location = resp.headers.get("location");
        if (!location) {
          throw new Error(`HTTP ${resp.status} redirect without Location header from ${currentUrl}`);
        }
        redirectCount++;
        if (redirectCount > this.maxRedirects) {
          throw new Error(`Exceeded maximum redirect limit (${this.maxRedirects})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Read response body up to maxBodyBytes
      const body = await this.readBodyCapped(resp);
      return { response: resp, body, finalUrl: currentUrl };
    }

    throw new Error(`Exceeded maximum redirect limit (${this.maxRedirects})`);
  }

  private async readBodyCapped(resp: Response): Promise<string> {
    if (!resp.body) {
      return "";
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.byteLength;
          if (bytesRead > this.maxBodyBytes) {
            // Cap at maxBodyBytes
            const allowedBytes = value.byteLength - (bytesRead - this.maxBodyBytes);
            if (allowedBytes > 0) {
              chunks.push(value.slice(0, allowedBytes));
            }
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
    } catch {
      // Stream error or cancel
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(combined);
  }

  async verifyUrl(targetUrl: string, expectedCanonicalUrl: string): Promise<OperationalCheckResult> {
    try {
      const { response: resp, body: html } = await this.safeFetch(targetUrl, this.timeoutMs);
      const statusCode = resp.status;

      // 1. Exact Canonical check
      const normalizedExpected = normalizeCanonicalUrl(expectedCanonicalUrl, targetUrl);

      // Inspect HTML <link rel="canonical" href="...">
      const canonicalTagMatch =
        html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
        html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
      const canonicalHref = canonicalTagMatch ? canonicalTagMatch[1] : null;

      // Inspect Link: <...>; rel="canonical" header
      const linkHeader = resp.headers.get("link");
      let headerCanonicalHref: string | null = null;
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel=["']canonical["']/i);
        if (match && match[1]) {
          headerCanonicalHref = match[1];
        }
      }

      let canonicalMatches = false;
      if (canonicalHref) {
        try {
          const normalizedFound = normalizeCanonicalUrl(canonicalHref, targetUrl);
          canonicalMatches = normalizedFound === normalizedExpected;
        } catch {
          canonicalMatches = false;
        }
      } else if (headerCanonicalHref) {
        try {
          const normalizedFound = normalizeCanonicalUrl(headerCanonicalHref, targetUrl);
          canonicalMatches = normalizedFound === normalizedExpected;
        } catch {
          canonicalMatches = false;
        }
      }

      // 2. Meta robots indexability check
      const hasNoindexTag =
        /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex[^"']*["']/i.test(html) ||
        /<meta[^>]*content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(html);
      const hasNoindexHeader = /noindex/i.test(resp.headers.get("x-robots-tag") ?? "");
      const hasNoindex = hasNoindexTag || hasNoindexHeader;

      // 3. Robots.txt check
      let robotsValid = false;
      try {
        const robotsUrl = new URL("/robots.txt", targetUrl).toString();
        const robotsResult = await this.safeFetch(robotsUrl, 5_000);
        robotsValid = robotsResult.response.status === 200;
      } catch {
        robotsValid = false;
      }

      // 4. Sitemap.xml check
      let sitemapValid = false;
      try {
        const sitemapUrl = new URL("/sitemap.xml", targetUrl).toString();
        const sitemapResult = await this.safeFetch(sitemapUrl, 5_000);
        sitemapValid = sitemapResult.response.status === 200;
      } catch {
        sitemapValid = false;
      }

      const passed = statusCode === 200 && canonicalMatches && robotsValid && sitemapValid && !hasNoindex;

      let errorMessage: string | null = null;
      if (!passed) {
        if (statusCode !== 200) {
          errorMessage = `Target HTTP status ${statusCode}`;
        } else if (!canonicalMatches) {
          errorMessage = `Canonical mismatch: found '${canonicalHref ?? headerCanonicalHref}', expected '${expectedCanonicalUrl}'`;
        } else if (hasNoindex) {
          errorMessage = "Page contains noindex directive blocking indexing";
        } else if (!robotsValid) {
          errorMessage = "robots.txt is missing or returned non-200";
        } else if (!sitemapValid) {
          errorMessage = "sitemap.xml is missing or returned non-200";
        } else {
          errorMessage = "Operational check failed";
        }
      }

      return {
        status: passed ? "PASS" : "FAIL",
        statusCode,
        canonicalMatches,
        robotsValid,
        sitemapValid,
        summary: passed
          ? "HTTP 200, exact canonical matched, robots.txt and sitemap.xml verified, indexable."
          : `Operational check failed: ${errorMessage}`,
        errorMessage,
      };
    } catch (err: any) {
      return {
        status: "FAIL",
        statusCode: 0,
        canonicalMatches: false,
        robotsValid: false,
        sitemapValid: false,
        summary: `Connection error: ${err.message}`,
        errorMessage: err.message,
      };
    }
  }
}
