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
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init?.headers ?? {}) },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
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

test("SSRF guard: adversarial IPv4 and IPv6 literal blocking and public allowing", () => {
  const blockedCases = [
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fe80::1]/",
    "http://[fe90::1]/",
    "http://[febf::1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    "http://[2002:7f00:0001::]/", // 6to4 embedding 127.0.0.1
    "http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo
  ];

  for (const url of blockedCases) {
    const res = validateUrlStructure(url);
    assert.equal(res.ok, false, `Expected blocked for ${url}, got ok: true`);
  }

  const allowedCases = [
    "http://8.8.8.8/",
    "http://1.1.1.1/",
    "http://[2606:4700:4700::1111]/",
    "https://example.com/",
  ];

  for (const url of allowedCases) {
    const res = validateUrlStructure(url);
    assert.equal(res.ok, true, `Expected allowed for ${url}, got ok: false (${res.reason})`);
  }
});

test("SSRF guard: DNS resolution of private A/AAAA records and error paths fail closed", async () => {
  const { validateUrlResolved } = await import("../src/competitors/ssrf-guard.js");
  const lookup = fakeLookup({
    "evil.example.com": [{ address: "10.0.0.5", family: 4 }],
    "evil-ipv6.example.com": [{ address: "fe90::1", family: 6 }],
    "mapped-ipv6.example.com": [{ address: "::ffff:7f00:1", family: 6 }],
    "mixed.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }, // one bad record poisons the host
    ],
    "mixed-v6.example.com": [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "fe80::1", family: 6 }, // one bad v6 poisons the host
    ],
    "good.example.com": [{ address: "93.184.216.34", family: 4 }],
    "good-v6.example.com": [{ address: "2606:4700:4700::1111", family: 6 }],
    "meta.example.com": [{ address: "169.254.169.254", family: 4 }],
    "empty-dns.example.com": [],
  });

  // Allowed public
  assert.equal((await validateUrlResolved("https://good.example.com/", lookup)).ok, true);
  assert.equal((await validateUrlResolved("https://good-v6.example.com/", lookup)).ok, true);

  // Blocked private / link-local / mapped
  assert.equal((await validateUrlResolved("https://evil.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://evil-ipv6.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://mapped-ipv6.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://meta.example.com/", lookup)).ok, false);

  // One public + one private => BLOCKED
  assert.equal((await validateUrlResolved("https://mixed.example.com/", lookup)).ok, false);
  assert.equal((await validateUrlResolved("https://mixed-v6.example.com/", lookup)).ok, false);

  // DNS returns no addresses => blocked
  assert.equal((await validateUrlResolved("https://empty-dns.example.com/", lookup)).ok, false);

  // DNS fails (nonexistent domain) => blocked
  assert.equal((await validateUrlResolved("https://nonexistent.example.com/", lookup)).ok, false);
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

test("acquisition: slow chunked body exceeding timeout aborts and fails with timeout", async () => {
  let streamCancelled = false;
  const slowStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(Buffer.from("<html><body>chunk1"));
      await new Promise((resolve) => setTimeout(resolve, 80));
      try {
        controller.enqueue(Buffer.from("chunk2</body></html>"));
        controller.close();
      } catch {
        // stream might already be closed or cancelled
      }
    },
    cancel() {
      streamCancelled = true;
    },
  });

  const fetchImpl: FetchLike = async () =>
    new Response(slowStream, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "slow-chunk.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });

  const result = await provider.acquire({ url: "https://slow-chunk.example.com/page", timeoutMs: 25 });
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /timed out/i);
});

test("acquisition: 403/429 cancels body stream immediately without buffering huge body", async () => {
  let chunksRead = 0;
  let streamCancelled = false;

  const infiniteStream = new ReadableStream({
    pull(controller) {
      chunksRead++;
      controller.enqueue(Buffer.alloc(64 * 1024, "x"));
    },
    cancel() {
      streamCancelled = true;
    },
  });

  const fetchImpl: FetchLike = async () =>
    new Response(infiniteStream, {
      status: 403,
      headers: { "content-type": "text/html" },
    });

  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "huge-403.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });

  const result = await provider.acquire({ url: "https://huge-403.example.com/blocked" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.httpStatus, 403);
  assert.equal(streamCancelled, true);
  assert.ok(chunksRead <= 1, `Expected immediate cancellation, but read ${chunksRead} chunks`);
});

test("acquisition: non-HTML cancels body stream immediately without buffering huge body", async () => {
  let chunksRead = 0;
  let streamCancelled = false;

  const infiniteStream = new ReadableStream({
    pull(controller) {
      chunksRead++;
      controller.enqueue(Buffer.alloc(64 * 1024, "x"));
    },
    cancel() {
      streamCancelled = true;
    },
  });

  const fetchImpl: FetchLike = async () =>
    new Response(infiniteStream, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });

  const provider = new DirectHttpPageProvider({
    fetchImpl,
    lookupFn: fakeLookup({ "huge-pdf.example.com": [{ address: "93.184.216.34", family: 4 }] }),
  });

  const result = await provider.acquire({ url: "https://huge-pdf.example.com/doc.pdf" });
  assert.equal(result.status, "NON_HTML");
  assert.equal(streamCancelled, true);
  assert.ok(chunksRead <= 1, `Expected immediate cancellation, but read ${chunksRead} chunks`);
});

