import type { OperationalCheckResult } from "./service.js";

/**
 * Real HTTP operational verifier for production monitoring (Run 13 §10 / P1-04).
 * Performs genuine HTTP requests against the target production origin, inspecting:
 * 1. HTTP 200 response
 * 2. <link rel="canonical"> tag and Link header match
 * 3. /robots.txt availability
 * 4. /sitemap.xml availability
 */
export class HttpOperationalVerifier {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  async verifyUrl(targetUrl: string, expectedCanonicalUrl: string): Promise<OperationalCheckResult> {
    const timeout = this.options.timeoutMs ?? 10_000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(targetUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "Factory-Operational-Verifier/1.0" },
      });
      clearTimeout(timer);

      const statusCode = resp.status;
      const html = await resp.text().catch(() => "");

      // Canonical check
      const canonicalHeader = resp.headers.get("link");
      const canonicalTagMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
      const canonicalHref = canonicalTagMatch ? canonicalTagMatch[1] : null;
      const canonicalMatches = canonicalHref
        ? canonicalHref.startsWith(expectedCanonicalUrl) || expectedCanonicalUrl.startsWith(canonicalHref)
        : (canonicalHeader ? canonicalHeader.includes(expectedCanonicalUrl) : false);

      // Robots check
      let robotsValid = false;
      try {
        const robotsUrl = new URL("/robots.txt", targetUrl).toString();
        const robotsResp = await fetch(robotsUrl, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
        robotsValid = Boolean(robotsResp && robotsResp.status === 200);
      } catch {
        robotsValid = false;
      }

      // Sitemap check
      let sitemapValid = false;
      try {
        const sitemapUrl = new URL("/sitemap.xml", targetUrl).toString();
        const sitemapResp = await fetch(sitemapUrl, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
        sitemapValid = Boolean(sitemapResp && sitemapResp.status === 200);
      } catch {
        sitemapValid = false;
      }

      const passed = statusCode === 200 && canonicalMatches && robotsValid && sitemapValid;
      return {
        status: passed ? "PASS" : "FAIL",
        statusCode,
        canonicalMatches,
        robotsValid,
        sitemapValid,
        summary: passed
          ? `HTTP 200, canonical matched, robots.txt and sitemap.xml verified.`
          : `Operational check failed (HTTP ${statusCode}, canonical=${canonicalMatches}, robots=${robotsValid}, sitemap=${sitemapValid}).`,
        errorMessage: passed ? null : `Target verification failed: status=${statusCode}`,
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
