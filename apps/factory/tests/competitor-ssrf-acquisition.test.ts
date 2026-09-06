import test from "node:test";
import assert from "node:assert/strict";
import { DirectHttpPageProvider } from "../src/competitors/direct-http.js";
import { validateUrlStructure } from "../src/competitors/ssrf-guard.js";
import type { FetchLike } from "../src/competitors/direct-http.js";

/**
 * SSRF + acquisition adversarial tests. All network behavior is injected
 * (no real outbound calls). DNS lookups are stubbed per test.
 */

function fakeLookup(map: Record<string, Array<{ address: string; family: number }>>) {
  return (async (host: string) => {
    const hit = map[host];
    if (!hit) throw Object.assign(new Error(`lookup ${host} ENOTFOUND`), { code: "ENOTFOUND" });
    return hit;
  }) as unknown as typeof import("node:dns/promises").lookup;
}

function htmlResponse(url: string, body: string, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init?.headers ?? {}) },
    url,
  });
}

test("SSRF guard: structure rejects non-http, credentials and forbidden IP literals", () => {
  assert.equal(validateUrlStructure("ftp://example.com/x").ok, false);
  assert.equal(validateUrlStructure("file:///etc/passwd").ok, false);
  assert.equal(validateUrlStructure("https://user:pass@example.com/").ok, false);
  assert.equal(validateUrlStructure("http://127.0.0.1/").ok, false);
  assert.equal(validateUrlStructure("http://10.1.2.3/").ok, false);
  assert.equal(validateUrlStructure("http://169.254.169.254/latest/meta-data/").ok, false);
  assert.equal(validateUrlStructure("http://192.168.0.10/").ok, false);
  assert.equal(validateUrlStructure("http://[::1]/").ok, false);
  assert.equal(validateUrlStructure("http://[fe80::1]/").ok, false);
  assert.equal(validateUrlStructure("http://[fd00::5]/").ok, false);
  assert.equal(validateUrlStructure("https://example.com/page").ok, true);
});

test("SSRF guard: DNS resolution of private A records fails closed", async () => {
  const { validateUrlResolved } = await import("../src/competitors/ssrf-guard.js");
  const lookup = fakeLookup({
    "evil.example.com": [{ address: "10.0.0.5", family: 4 }],
    "mixed.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }, // one bad record poisons the host
    ],
    "good.example.com": [{ address: "93.184.216.34", family: 4 }],
    "meta.example.com": [{ address: "169.254.169.254", family: 4 }],
  });
  assert.equal((await validateUrlResolved("https://evil.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://mixed.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://meta.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://good.example.com/", lookup)).ok, true);
});

test("acquisition: successful HTML page captures final URL, status, digest", async () => {
  const fetchImpl: FetchLike = async () => htmlResponse("https://example.com/guide", "<html><body>ok</body></html>");
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://example.com/guide" });
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") {
    assert.equal(result.finalUrl, "https://example.com/guide");
    assert.equal(result.httpStatus, 200);
    assert.ok(result.rawBytes.length > 0);
    assert.equal(result.rawDigest.length, 64);
  }
});

test("acquisition: 403 recorded as BLOCKED, never bypassed", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response("nope", { status: 403, headers: { "content-type": "text/html" } });
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "blocked.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://blocked.example.com/x" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.httpStatus, 403);
});

test("acquisition: PDF content type is NON_HTML; octet-stream is UNSUPPORTED", async () => {
  const pdf: FetchLike = async () =>
    new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } });
  const providerPdf = new DirectHttpPageProvider({
    fetchImpl: pdf,
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  assert.equal((await providerPdf.acquire({ url: "https://example.com/doc.pdf" })).status, "NON_HTML");

  const bin: FetchLike = async () =>
    new Response("\x00\x01", { status: 200, headers: { "content-type": "application/octet-stream" } });
  const providerBin = new DirectHttpPageProvider({
    fetchImpl: bin,
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  assert.equal((await providerBin.acquire({ url: "https://example.com/blob" })).status, "UNSUPPORTED");
});

test("acquisition: redirect chain followed with per-hop validation and final URL capture", async () => {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    urls.push(input);
    if (urls.length === 1) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
    }
    return htmlResponse("https://example.com/final", "<html>final</html>");
  };
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://example.com/start" });
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") assert.equal(result.finalUrl, "https://example.com/final");
  assert.equal(urls.length, 2);
});

test("acquisition: redirect to private network FAILS CLOSED (per-hop revalidation)", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(null, { status: 301, headers: { location: "http://127.0.0.1:9000/admin" } });
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "public.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://public.example.com/redirect" });
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /forbidden network range/);
});

test("acquisition: oversized response is UNSUPPORTED, not silently truncated", async () => {
  const big = "x".repeat(1000);
  const fetchImpl: FetchLike = async () =>
    htmlResponse("https://example.com/big", `<html>${big.repeat(50)}</html>`);
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://example.com/big", maxBytes: 4096 });
  assert.equal(result.status, "UNSUPPORTED");
  assert.match(result.reason, /hard acquisition limit/);
});

test("acquisition: 404/500 map to FAILED; network error maps to FAILED", async () => {
  const provider404 = new DirectHttpPageProvider({
    fetchImpl: async () => new Response("gone", { status: 404, headers: { "content-type": "text/html" } }),
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  assert.equal((await provider404.acquire({ url: "https://example.com/gone" })).status, "FAILED");

  const providerNet = new DirectHttpPageProvider({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    lookupFn: fakeLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const net = await providerNet.acquire({ url: "https://example.com/x" });
  assert.equal(net.status, "FAILED");
});

test("acquisition: timeout produces FAILED outcome", async () => {
  const fetchImpl: FetchLike = async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "slow.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });
  const result = await provider.acquire({ url: "https://slow.example.com/x", timeoutMs: 20 });
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /timed out/);
});
