import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import ipaddr from "ipaddr.js";
import { FactoryError } from "../executor/errors.js";

/**
 * SSRF guard for untrusted external SERP URLs (Macro Run 3, P1 requirement).
 *
 * External SERP result URLs are UNTRUSTED. This guard rejects:
 * - non-http(s) protocols;
 * - credential-bearing URLs;
 * - any hostname resolving (all A/AAAA records) to loopback, private,
 *   link-local, unique-local, reserved or cloud-metadata ranges
 *   (IPv4 + IPv6);
 * - non-obvious IP-literal hosts in forbidden ranges.
 *
 * Redirects must be revalidated on EVERY hop by the acquisition provider:
 * a public URL that redirects to a private host fails closed.
 *
 * Residual limitation (documented, accepted for v0): a hostile DNS server
 * can rebind between this validation and the actual socket connect
 * (TOCTOU). Mitigation is validate-before-fetch on every hop; socket-level
 * pinning is deferred to a later hardening slice with explicit review.
 *
 * Range classification (Run 4.1 W1) is delegated to the maintained
 * `ipaddr.js` package instead of hand-rolled BigInt range tables — the
 * hand-rolled variant is the exact code class that produced CVE-graded
 * SSRF-classification bugs in peer libraries. The blocked-set POLICY is
 * unchanged and proven byte-identical by a frozen 90-vector equivalence
 * harness (tests/competitor-ssrf-vectors.test.ts). Parsing stays behind
 * the strict pre-existing gates (dotted-quad regex + octet bound check for
 * IPv4, node:net isIPv6 + explicit BigInt expansion for IPv6) so parse
 * semantics are also unchanged; unparsable input still fails closed.
 */

export class SsrfBlockedError extends FactoryError {
  constructor(message: string) {
    super("competitor_page_failed", message);
  }
}

const BLOCKED_HOST_MESSAGE = "URL host resolves to a forbidden network range.";

// ---------------------------------------------------------------------------
// IPv4 classification (ipaddr.js standard categories + policy-only additions)
// ---------------------------------------------------------------------------

/**
 * Policy-only blocked IPv4 CIDRs that ipaddr.js classifies as ordinary
 * unicast. The legacy implementation blocked these explicitly; the policy is
 * preserved verbatim (Run 4.1 W1). `reserved` (which already covers
 * 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 198.18.0.0/15, 198.51.100.0/24,
 * 203.0.113.0/24 and 240.0.0.0/4 in ipaddr.js) is handled separately below.
 */
const POLICY_BLOCKED_IPV4_CIDRS: Array<[number, number, number, number, number]> = [
  // (none currently — every policy-only IPv4 range is covered by ipaddr's
  //  standard categories: unspecified, private, loopback, linkLocal,
  //  carrierGradeNat, multicast, broadcast, reserved. The table shape is kept
  //  so future policy-only additions have an explicit, reviewed home.)
];

/** IPv4 range names from ipaddr.js that this policy blocks. */
const BLOCKED_IPV4_RANGES = new Set([
  "unspecified", // 0.0.0.0/8 (this-network; legacy blocked 0.0.0.0/24 — superset is conservative, see ADR)
  "private", // 10/8, 172.16/12, 192.168/16
  "loopback", // 127/8
  "linkLocal", // 169.254/16 (incl. cloud metadata 169.254.169.254)
  "carrierGradeNat", // 100.64/10
  "multicast", // 224/4
  "broadcast", // 255.255.255.255/32
  "reserved", // 192.0.0/24, 192.0.2/24, 192.88.99/24, 198.18/15, 198.51.100/24, 203.0.113/24, 240/4
]);

/** Legacy IPv4 gate: strict dotted-quad with bounded octets. */
function isStrictDottedQuad(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** Legacy IPv4 numeric form (used by parseIpv6ToBigInt embedded-v4 handling). */
function ipv4ToBigInt(ip: string): bigint | null {
  if (!isStrictDottedQuad(ip)) return null;
  let value = 0n;
  for (const part of ip.split(".")) {
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

/**
 * Classify an IPv4 address against the blocked policy via ipaddr.js.
 * Unparsable input fails closed (blocked), matching legacy behavior.
 */
function isBlockedIpv4(ip: string): boolean {
  if (!isStrictDottedQuad(ip)) return true; // unparsable => treat as hostile
  let addr: ipaddr.IPv4;
  try {
    const parsed = ipaddr.parse(ip);
    if (parsed.kind() !== "ipv4") return true;
    addr = parsed as ipaddr.IPv4;
  } catch {
    return true; // unparsable => treat as hostile
  }
  const range = addr.range();
  if (BLOCKED_IPV4_RANGES.has(range)) return true;
  for (const [a, b, c, d] of POLICY_BLOCKED_IPV4_CIDRS) {
    if (
      addr.octets[0] === a &&
      addr.octets[1] === b &&
      addr.octets[2] === c &&
      addr.octets[3] === d
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// IPv6 classification (ipaddr.js standard categories + embedded-v4 policy)
// ---------------------------------------------------------------------------

/**
 * Robust IPv6 parser converting any valid IPv6 textual representation
 * (including compressed :: and embedded IPv4) into a 128-bit unsigned BigInt.
 * Returns null if the representation is invalid.
 *
 * Kept byte-identical from the legacy implementation: it is parse-only (no
 * classification) and existing tests assert its exact numeric output.
 */
export function parseIpv6ToBigInt(ip: string): bigint | null {
  // Strip optional zone index e.g. %eth0
  const zoneIndex = ip.indexOf("%");
  const cleanIp = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  if (!isIPv6(cleanIp)) return null;

  let normalized = cleanIp.toLowerCase();
  // Handle dotted-quad IPv4 suffix if present (e.g. ::ffff:192.168.0.1 or ::127.0.0.1)
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon === -1) return null;
  const potentialV4 = normalized.slice(lastColon + 1);
  if (potentialV4.includes(".")) {
    const parts = potentialV4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const g1 = (((parts[0]! << 8) | parts[1]!) >>> 0).toString(16);
    const g2 = (((parts[2]! << 8) | parts[3]!) >>> 0).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${g1}:${g2}`;
  }

  let groups: string[];
  if (normalized.includes("::")) {
    const halves = normalized.split("::");
    if (halves.length !== 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = normalized.split(":");
  }
  if (groups.length !== 8) return null;

  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    val = (val << 16n) | BigInt(parseInt(g, 16));
  }
  return val;
}

/** IPv6 range names from ipaddr.js that this policy blocks outright. */
const BLOCKED_IPV6_RANGES = new Set([
  "unspecified", // ::/128
  "loopback", // ::1/128
  "linkLocal", // fe80::/10
  "deprecatedSiteLocal", // fec0::/10
  "uniqueLocal", // fc00::/7
  "multicast", // ff00::/8
  "discard", // 100::/64 (RFC 6666)
  "teredo", // 2001::/32 (conservative block, per legacy policy)
  "deprecatedOrchid", // 2001:10::/28
  "orchid2", // 2001:20::/28
  "benchmarking", // 2001:2::/48 (conservative superset; see ADR note)
  "amt", // 2001:3::/32 (conservative superset; see ADR note)
  "as112v6", // 2001:4:112::/48, 2620:4f:8000::/48 (conservative superset)
  "droneRemoteIdProtocolEntityTags", // 2001:30::/28 (conservative superset)
  "segmentRouting", // 5f00::/16 (conservative superset)
  "reserved", // 2001::/23 (incl. 2001:db8::/32), 3fff::/20 (conservative superset)
]);

/**
 * Extract the embedded IPv4 octets for translation/tunnel addresses.
 * Returns null when the address does not carry an embedded IPv4 in the
 * expected position.
 */
function embeddedIpv4Octets(
  addr: ipaddr.IPv6,
  position: "mapped" | "6to4" | "rfc6052",
): [number, number, number, number] | null {
  if (position === "mapped") {
    try {
      return addr.toIPv4Address().octets as [number, number, number, number];
    } catch {
      return null;
    }
  }
  const p = addr.parts;
  if (position === "6to4") {
    // 2002::/16: embedded IPv4 occupies bits 16..47 (groups 1 and 2).
    return [(p[1]! >> 8) & 0xff, p[1]! & 0xff, (p[2]! >> 8) & 0xff, p[2]! & 0xff];
  }
  // rfc6052: only the strict 64:ff9b::/96 form (groups 0..5 fixed) carries a
  // well-defined embedded IPv4 in groups 6/7. ipaddr.js also labels the
  // RFC 8215 variant 64:ff9b:1::/48 as "rfc6052"; the legacy policy did not
  // treat that prefix as translation, so it is excluded here (allowed unless
  // another range matches — identical to legacy behavior).
  if (p[0] !== 0x64 || p[1] !== 0xff9b || p[2] !== 0 || p[3] !== 0 || p[4] !== 0 || p[5] !== 0) {
    return null;
  }
  return [(p[6]! >> 8) & 0xff, p[6]! & 0xff, (p[7]! >> 8) & 0xff, p[7]! & 0xff];
}

/**
 * Bounded CIDR classification for IPv6 addresses, delegated to ipaddr.js.
 * Rejects loopback, link-local (fe80::/10), unique-local (fc00::/7), multicast,
 * documentation/discard ranges, 6to4/Teredo with private embedded v4,
 * and IPv4-mapped/compatible addresses with forbidden IPv4 targets.
 */
export function isBlockedIpv6(ip: string): boolean {
  // Strip optional zone index (legacy behavior: classify the bare address).
  const zoneIndex = ip.indexOf("%");
  const cleanIp = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  if (!isIPv6(cleanIp)) return true; // unparsable => fail closed

  let addr: ipaddr.IPv6;
  try {
    const parsed = ipaddr.parse(cleanIp);
    if (parsed.kind() !== "ipv6") return true;
    addr = parsed as ipaddr.IPv6;
  } catch {
    return true; // unparsable => fail closed
  }

  const range = addr.range();

  // Embedded-IPv4 families: verdict follows the embedded IPv4 address.
  if (range === "ipv4Mapped" || range === "rfc6145") {
    const octets = embeddedIpv4Octets(addr, "mapped");
    if (octets === null) return true; // fail closed
    const v4 = `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
    return isBlockedIpv4(v4);
  }
  if (range === "6to4") {
    const octets = embeddedIpv4Octets(addr, "6to4");
    if (octets === null) return true; // fail closed
    const v4 = `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
    return isBlockedIpv4(v4);
  }
  if (range === "rfc6052") {
    const octets = embeddedIpv4Octets(addr, "rfc6052");
    if (octets === null) {
      // RFC 8215 /48 variant or malformed — falls through to standard checks.
      return isBlockedByStandardV6Range(range);
    }
    const v4 = `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
    return isBlockedIpv4(v4);
  }

  return isBlockedByStandardV6Range(range);
}

function isBlockedByStandardV6Range(range: string): boolean {
  return BLOCKED_IPV6_RANGES.has(range);
}

// ---------------------------------------------------------------------------
// URL-level validation (structure + DNS resolution) — unchanged semantics
// ---------------------------------------------------------------------------

export interface UrlSafetyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Structural URL validation (no DNS): protocol, credentials, IP-literal hosts.
 * Exported for tests; acquisition always combines this with DNS resolution.
 */
export function validateUrlStructure(rawUrl: string): UrlSafetyCheck {
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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "URL has no host." };
  // IP literals are checked immediately; hostnames need DNS (validateUrlResolved).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isBlockedIpv4(host)) {
    return { ok: false, reason: BLOCKED_HOST_MESSAGE };
  }
  if (host.includes(":") && isBlockedIpv6(host)) {
    return { ok: false, reason: BLOCKED_HOST_MESSAGE };
  }
  return { ok: true };
}

/**
 * Full validation: structural checks + DNS resolution of ALL A/AAAA records
 * for hostname URLs. Every resolved address must be public.
 */
export async function validateUrlResolved(
  rawUrl: string,
  lookupFn: typeof lookup = lookup,
  signal?: AbortSignal,
): Promise<UrlSafetyCheck> {
  const structural = validateUrlStructure(rawUrl);
  if (!structural.ok) return structural;

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return { ok: true }; // IP literal already validated structurally
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const lookupPromise = lookupFn(host, { all: true, verbatim: true });
    if (!signal) {
      addresses = await lookupPromise;
    } else {
      addresses = await Promise.race([
        lookupPromise,
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return { ok: false, reason: "DNS resolution failed." };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "DNS returned no addresses." };
  }
  for (const { address } of addresses) {
    if (address.includes(":")) {
      if (isBlockedIpv6(address)) return { ok: false, reason: BLOCKED_HOST_MESSAGE };
    } else if (isBlockedIpv4(address)) {
      return { ok: false, reason: BLOCKED_HOST_MESSAGE };
    }
  }
  return { ok: true };
}
