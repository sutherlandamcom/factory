import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  HttpOperationalVerifier,
  normalizeCanonicalUrl,
  validateUrlForSsrf,
} from "../src/monitoring/operational-verifier.js";

test("normalizeCanonicalUrl handles case, default ports, and trailing slashes consistently", () => {
  const norm1 = normalizeCanonicalUrl("HTTP://EXAMPLE.COM:80/services/");
  assert.equal(norm1, "http://example.com/services");

  const norm2 = normalizeCanonicalUrl("https://example.com:443/services");
  assert.equal(norm2, "https://example.com/services");

  const normRoot = normalizeCanonicalUrl("https://example.com:443/");
  assert.equal(normRoot, "https://example.com/");
});

test("HttpOperationalVerifier rejects prefix and substring canonical spoofing (P1-04)", async () => {
  // Setup a test server
  const server = http.createServer((req, res) => {
    if (req.url === "/services-bad") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><head><link rel="canonical" href="https://example.com/services-bad"></head><body>Bad</body></html>');
      return;
    }
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /");
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end("<urlset></urlset>");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
    // Candidate has canonical href https://example.com/services-bad, expected is https://example.com/services
    // Under previous defective implementation, "https://example.com/services-bad".startsWith("https://example.com/services") was true!
    const result = await verifier.verifyUrl(
      `http://127.0.0.1:${port}/services-bad`,
      "https://example.com/services",
    );

    assert.equal(result.status, "FAIL");
    assert.equal(result.canonicalMatches, false);
    assert.match(result.errorMessage ?? "", /Canonical mismatch/);
  } finally {
    server.close();
  }
});

test("HttpOperationalVerifier passes exact matching canonical (P1-04)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/services") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><head><link rel="canonical" href="https://example.com/services/"></head><body>Good</body></html>');
      return;
    }
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /");
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end("<urlset></urlset>");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
    const result = await verifier.verifyUrl(
      `http://127.0.0.1:${port}/services`,
      "https://example.com/services",
    );

    assert.equal(result.status, "PASS");
    assert.equal(result.canonicalMatches, true);
    assert.equal(result.robotsValid, true);
    assert.equal(result.sitemapValid, true);
  } finally {
    server.close();
  }
});

test("HttpOperationalVerifier detects noindex directive and fails (P1-04)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/noindex-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><head><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="https://example.com/noindex-page"></head><body>Noindex</body></html>');
      return;
    }
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /");
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end("<urlset></urlset>");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
    const result = await verifier.verifyUrl(
      `http://127.0.0.1:${port}/noindex-page`,
      "https://example.com/noindex-page",
    );

    assert.equal(result.status, "FAIL");
    assert.match(result.errorMessage ?? "", /noindex/);
  } finally {
    server.close();
  }
});

test("validateUrlForSsrf blocks private ranges, cloud metadata, and loopback by default", async () => {
  // Loopback
  const loopback = await validateUrlForSsrf("http://127.0.0.1:8080/");
  assert.equal(loopback.ok, false);

  // Cloud metadata
  const metadata = await validateUrlForSsrf("http://169.254.169.254/latest/meta-data");
  assert.equal(metadata.ok, false);

  // Private RFC 1918
  const priv1 = await validateUrlForSsrf("http://10.0.0.1/");
  assert.equal(priv1.ok, false);

  const priv2 = await validateUrlForSsrf("http://192.168.1.1/");
  assert.equal(priv2.ok, false);

  const priv3 = await validateUrlForSsrf("http://172.16.0.1/");
  assert.equal(priv3.ok, false);

  // Non-HTTP
  const nonHttp = await validateUrlForSsrf("file:///etc/passwd");
  assert.equal(nonHttp.ok, false);

  // Credentials
  const creds = await validateUrlForSsrf("http://user:pass@example.com/");
  assert.equal(creds.ok, false);

  // allowLocalhost allows 127.0.0.1 but STILL BLOCKS 169.254.169.254
  const loopbackAllowed = await validateUrlForSsrf("http://127.0.0.1:8080/", { allowLocalhost: true });
  assert.equal(loopbackAllowed.ok, true);

  const metadataStillBlocked = await validateUrlForSsrf("http://169.254.169.254/latest/meta-data", { allowLocalhost: true });
  assert.equal(metadataStillBlocked.ok, false);
});

test("HttpOperationalVerifier prevents redirect-based SSRF into private IP", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect-to-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/secret" });
      res.end();
      return;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
    const result = await verifier.verifyUrl(
      `http://127.0.0.1:${port}/redirect-to-metadata`,
      "https://example.com/test",
    );

    assert.equal(result.status, "FAIL");
    assert.match(result.summary, /SSRF blocked/);
  } finally {
    server.close();
  }
});

test("HttpOperationalVerifier blocks redirect to an unauthorized origin (P1-02)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect-to-external") {
      res.writeHead(302, { Location: "https://evil-unauthorized.com/hijack" });
      res.end();
      return;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
    const result = await verifier.verifyUrl(
      `http://127.0.0.1:${port}/redirect-to-external`,
      "https://example.com/test",
    );

    assert.equal(result.status, "FAIL");
    assert.match(result.summary, /Redirect to unauthorized origin/);
  } finally {
    server.close();
  }
});

test("HttpOperationalVerifier closes DNS rebinding gap via connect-time validation (P1-02)", async () => {
  let callCount = 0;
  // DNS rebinding simulator: returns public IP on preflight check, then rebinds to cloud metadata IP on connect
  const rebindingLookup = async (hostname: string, opts?: any) => {
    callCount++;
    if (callCount === 1) {
      // First call (preflight validation): return safe public IP
      return [{ address: "93.184.216.34", family: 4 }];
    }
    // Subsequent call (actual connect-time socket resolution): malicious DNS rebinding to metadata!
    return [{ address: "169.254.169.254", family: 4 }];
  };

  const verifier = new HttpOperationalVerifier({
    allowLocalhost: true,
    lookupFn: rebindingLookup as any,
  });

  const result = await verifier.verifyUrl(
    "http://rebind-test.example.com/",
    "http://rebind-test.example.com/",
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /forbidden network range/);
  assert.ok(callCount >= 2, `Expected connect-time lookup to be called, got ${callCount} calls`);
});

test("HttpOperationalVerifier enforces configured trustedOrigins (P1-02)", async () => {
  const verifier = new HttpOperationalVerifier({
    allowLocalhost: true,
    trustedOrigins: ["https://trusted-site.com"],
  });

  // Attempting to verify an untrusted origin must fail immediately
  const result = await verifier.verifyUrl(
    "https://untrusted-site.com/page",
    "https://untrusted-site.com/page",
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /Target URL origin https:\/\/untrusted-site\.com is not in trusted origins/);
});
