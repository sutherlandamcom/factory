import { lookup } from "node:dns/promises";
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

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToBigInt(ip);
  if (value === null) return true; // unparsable => treat as hostile
  return BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

/** IPv6 blocks: (lowercase prefix hex of expanded form, prefix bits). */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Fast path on compressed/expanded textual checks for well-known ranges.
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fec0:")) return true; // link-local / site-local (deprecated)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped / IPv4-compatible (::ffff:0:0/96 and ::/96) — check embedded v4.
  const v4Match = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (v4Match) return isBlockedIpv4(v4Match[1]!);
  // Metadata/reserved: 100::/64 discard-only, 2001:db8::/32 documentation,
  // 2002::/16 6to4 embedding v4 in bits 16-48.
  if (lower.startsWith("100:")) return true;
  if (lower.startsWith("2001:db8:")) return true;
  const sixToFour = /^2002:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})/.exec(lower);
  if (sixToFour) {
    const v4 = [
      parseInt(sixToFour[1]!, 16),
      parseInt(sixToFour[2]!, 16),
      parseInt(sixToFour[3]!, 16),
      parseInt(sixToFour[4]!, 16),
    ].join(".");
    return isBlockedIpv4(v4);
  }
  // Teredo 2001::/32 embeds obfuscated v4; treat whole range as blocked for v0 conservatism.
  if (lower.startsWith("2001:0000:") || lower.startsWith("2001:0:")) return true;
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
