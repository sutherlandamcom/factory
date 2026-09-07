import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
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
 */

export class SsrfBlockedError extends FactoryError {
  constructor(message: string) {
    super("competitor_page_failed", message);
  }
}

const BLOCKED_HOST_MESSAGE = "URL host resolves to a forbidden network range.";

/** IPv4 ranges blocked as source of SSRF (start, end) in numeric form. */
const BLOCKED_IPV4_RANGES: Array<[bigint, bigint, string]> = [
  [0n, 0x00ffffffn, "this-network"],
  [0x0a000000n, 0x0affffffn, "private 10/8"],
  [0x7f000000n, 0x7fffffffn, "loopback 127/8"],
  [0xa9fe0000n, 0xa9feffffn, "link-local 169.254/16 (incl. metadata 169.254.169.254)"],
  [0xac100000n, 0xac1fffffn, "private 172.16/12"],
  [0xc0a80000n, 0xc0a8ffffn, "private 192.168/16"],
  [0xc0000000n, 0xc00000ffn, "reserved 192.0.0/24"],
  [0xc0000200n, 0xc00002ffn, "test-net-1 192.0.2/24"],
  [0xc6120000n, 0xc613ffffn, "test-net-2 198.51.100/24"],
  [0xcb007100n, 0xcb0071ffn, "test-net-3 203.0.113/24"],
  [0xc0586300n, 0xc05863ffn, "6to4 relay 192.88.99/24"],
  [0xe0000000n, 0xefffffffn, "multicast 224/4"],
  [0xf0000000n, 0xffffffffn, "reserved 240/4 (incl. broadcast)"],
  [0x64400a00n, 0x64400affn, "shared 100.64/10 (CGNAT start)"],
  [0x64400000n, 0x647fffffn, "shared 100.64/10"],
];

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function isBlockedIpv4Value(value: bigint): boolean {
  return BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToBigInt(ip);
  if (value === null) return true; // unparsable => treat as hostile
  return isBlockedIpv4Value(value);
}

/**
 * Robust IPv6 parser converting any valid IPv6 textual representation
 * (including compressed :: and embedded IPv4) into a 128-bit unsigned BigInt.
 * Returns null if the representation is invalid.
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

/**
 * Bounded CIDR classification for IPv6 addresses.
 * Rejects loopback, link-local (fe80::/10), unique-local (fc00::/7), multicast,
 * documentation/discard ranges, 6to4/Teredo with private embedded v4,
 * and IPv4-mapped/compatible addresses with forbidden IPv4 targets.
 */
export function isBlockedIpv6(ip: string): boolean {
  const val = parseIpv6ToBigInt(ip);
  if (val === null) return true; // unparsable => fail closed

  // ::/128 (unspecified) and ::1/128 (loopback)
  if (val === 0n || val === 1n) return true;

  // IPv4-mapped (::ffff:0:0/96)
  if ((val >> 32n) === 0xffffn) {
    return isBlockedIpv4Value(val & 0xffffffffn);
  }

  // IPv4-compatible (::/96)
  if ((val >> 32n) === 0n) {
    return isBlockedIpv4Value(val & 0xffffffffn);
  }

  // 6to4 (2002::/16) embeds IPv4 in bits 16..47
  if ((val >> 112n) === 0x2002n) {
    return isBlockedIpv4Value((val >> 80n) & 0xffffffffn);
  }

  // IPv4/IPv6 translation (64:ff9b::/96)
  if ((val >> 32n) === 0x0064ff9b0000000000000000n) {
    return isBlockedIpv4Value(val & 0xffffffffn);
  }

  // fe80::/10 (link-local unicast: fe80:: to febf:ffff:...)
  if ((val >> 118n) === 0x3fan) return true;

  // fec0::/10 (deprecated site-local unicast: fec0:: to feff:ffff:...)
  if ((val >> 118n) === 0x3fbn) return true;

  // fc00::/7 (unique local address: fc00:: to fdff:ffff:...)
  if ((val >> 121n) === 0x7en) return true;

  // ff00::/8 (multicast)
  if ((val >> 120n) === 0xffn) return true;

  // 2001:db8::/32 (documentation)
  if ((val >> 96n) === 0x20010db8n) return true;

  // 2001::/32 (Teredo prefix - conservative block)
  if ((val >> 96n) === 0x20010000n) return true;

  // 100::/64 (discard-only RFC 6666)
  if ((val >> 64n) === (0x0100n << 48n)) return true;

  // 2001:10::/28 (ORCHID)
  if ((val >> 100n) === 0x2001001n) return true;

  // 2001:20::/28 (ORCHIDv2)
  if ((val >> 100n) === 0x2001002n) return true;

  return false;
}

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
