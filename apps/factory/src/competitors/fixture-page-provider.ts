import type { CompetitorPageProvider, PageAcquisitionOutcome } from "./direct-http.js";

/**
 * Deterministic fixture page provider (tests/CI/E2E only).
 *
 * Serves bounded synthetic HTML pages for the fixture SERP domains so the
 * full competitor/gap journey runs end-to-end with zero network and zero
 * spend. Selected only by trusted backend configuration
 * (FACTORY_COMPETITOR_MODE=fixture); never reachable from production config
 * and never from the browser.
 *
 * Content intentionally includes headings/questions/tables so deterministic
 * extraction and the fixture analysts have real structure to consume.
 */
export class FixturePageProvider implements CompetitorPageProvider {
  readonly id = "fixture_page";

  private readonly now: () => Date;

  constructor(deps: { now?: () => Date } = {}) {
    this.now = deps.now ?? (() => new Date("2026-09-06T10:00:00.000Z"));
  }

  readiness(): { configured: boolean; reason?: string } {
    return { configured: true };
  }

  async acquire(request: { url: string }): Promise<PageAcquisitionOutcome> {
    const url = request.url;
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();

    if (host === "blocked.example.net") {
      return {
        status: "BLOCKED",
        httpStatus: 403,
        contentType: "text/html",
        finalUrl: url,
        observedAt: this.now(),
        reason: "Page blocked the acquisition (HTTP 403).",
      };
    }

    const html = fixturePageHtml(host, url);
    return {
      status: "SUCCESS",
      finalUrl: url,
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      rawBytes: Buffer.from(html),
      rawDigest: createDigest(html),
      truncated: false,
      observedAt: this.now(),
    };
  }
}

function fixturePageHtml(host: string, url: string): string {
  const topic = url.split("/").pop()?.replace(/-/g, " ") ?? "the topic";
  return `<!doctype html><html><head>
<title>Guide to ${topic} | ${host}</title>
<meta name="description" content="Fixture competitor guide covering ${topic}.">
<link rel="canonical" href="${url}">
<script type="application/ld+json">{"@type":"Article","datePublished":"2025-04-01","dateModified":"2025-08-15"}</script>
</head><body>
<h1>Complete guide to ${topic}</h1>
<h2>What does ${topic} cost?</h2>
<p>Costs for ${topic} vary by season and scope. Fixture pricing guidance follows.</p>
<h2>How do providers structure ${topic} engagements?</h2>
<p>Providers differ in process transparency for ${topic}. Fixture process notes.</p>
<h2>What are the main risks of ${topic}?</h2>
<p>Risks of ${topic} include cost overruns and regulatory changes. Fixture risk notes.</p>
<table><tr><th>Option</th><th>Typical range</th></tr><tr><td>Basic</td><td>Low</td></tr><tr><td>Premium</td><td>High</td></tr></table>
<a class="btn" href="/contact">Contact us</a>
<a href="https://source-fixture.example.org/data">Source</a>
</body></html>`;
}

function createDigest(value: string): string {
  // Deterministic lightweight digest (store computes the official one).
  let h1 = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0").repeat(8);
}
