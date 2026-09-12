import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedIpv6, parseIpv6ToBigInt, validateUrlStructure } from "../src/competitors/ssrf-guard.js";

/**
 * Run 4.1 W1 — frozen SSRF classification vectors.
 *
 * These vectors were executed against the LEGACY hand-rolled BigInt range
 * implementation BEFORE the ipaddr.js port; the old output was captured and
 * the port was required to reproduce it. Every classification below is
 * policy: blocked ranges stay blocked, public controls stay allowed,
 * unparsable input fails closed.
 *
 * Known intentional conservative delta (documented in the Run 4.1 ADR): the
 * legacy "test-net-2" constant 0xc6120000–0xc613ffff actually encoded
 * 198.18.0.0/15 (RFC 2544 benchmarking) instead of the intended
 * 198.51.100.0/24 — a hex transcription bug. The ported implementation blocks
 * BOTH ranges (ipaddr.js classifies 198.18.0.0/15 as "reserved" and
 * 198.51.100.0/24 as "reserved"), so the three test-net-2 vectors below are
 * asserted BLOCKED even though the legacy implementation let them through.
 * No legacy-blocked address became allowed.
 */

interface VectorExpectation {
  /** IPv4: expect validateUrlStructure("http://<ip>/") to be blocked. */
  readonly v4Blocked?: boolean;
  /** IPv6: expect isBlockedIpv6(ip) === true. */
  readonly v6Blocked?: boolean;
  /** IPv6: expect parseIpv6ToBigInt(ip) === null (unparsable). */
  readonly v6Unparsable?: boolean;
}

const VECTORS: Readonly<Record<string, VectorExpectation>> = {
  // --- IPv4: this-network 0.0.0.0/8 (legacy policy blocked 0.0.0.0/24; ipaddr
  // "unspecified" covers 0.0.0.0/8 — conservative superset, see ADR) ---
  "0.0.0.0": { v4Blocked: true },
  "0.0.0.1": { v4Blocked: true },
  "0.255.255.255": { v4Blocked: true },
  "1.0.0.0": { v4Blocked: false },
  // --- private 10/8 ---
  "10.0.0.0": { v4Blocked: true },
  "10.255.255.255": { v4Blocked: true },
  "11.0.0.0": { v4Blocked: false },
  // --- loopback 127/8 ---
  "127.0.0.0": { v4Blocked: true },
  "127.0.0.1": { v4Blocked: true },
  "127.255.255.255": { v4Blocked: true },
  "128.0.0.0": { v4Blocked: false },
  // --- link-local 169.254/16 (incl. cloud metadata) ---
  "169.254.0.0": { v4Blocked: true },
  "169.254.169.254": { v4Blocked: true },
  "169.254.255.255": { v4Blocked: true },
  "169.255.0.0": { v4Blocked: false },
  // --- private 172.16/12 ---
  "172.16.0.0": { v4Blocked: true },
  "172.31.255.255": { v4Blocked: true },
  "172.32.0.0": { v4Blocked: false },
  // --- reserved 192.0.0/24 ---
  "192.0.0.0": { v4Blocked: true },
  "192.0.0.255": { v4Blocked: true },
  "192.0.1.0": { v4Blocked: false },
  // --- test-net-1 192.0.2/24 ---
  "192.0.2.0": { v4Blocked: true },
  "192.0.2.1": { v4Blocked: true },
  "192.0.2.255": { v4Blocked: true },
  "192.0.3.0": { v4Blocked: false },
  // --- 6to4 relay 192.88.99/24 ---
  "192.88.99.0": { v4Blocked: true },
  "192.88.99.255": { v4Blocked: true },
  "192.88.100.0": { v4Blocked: false },
  // --- private 192.168/16 ---
  "192.168.0.0": { v4Blocked: true },
  "192.168.255.255": { v4Blocked: true },
  "192.169.0.0": { v4Blocked: false },
  // --- RFC 2544 benchmarking 198.18/15 (legacy blocked via its test-net-2
  // constant, which encoded this range; port preserves the block) ---
  "198.18.0.0": { v4Blocked: true },
  "198.19.255.255": { v4Blocked: true },
  "198.20.0.0": { v4Blocked: false },
  // --- test-net-2 198.51.100/24 (spec policy; legacy missed it — see header) ---
  "198.51.100.0": { v4Blocked: true },
  "198.51.100.128": { v4Blocked: true },
  "198.51.100.255": { v4Blocked: true },
  "198.51.101.0": { v4Blocked: false },
  // --- test-net-3 203.0.113/24 ---
  "203.0.113.0": { v4Blocked: true },
  "203.0.113.255": { v4Blocked: true },
  "203.0.114.0": { v4Blocked: false },
  // --- multicast 224/4 ---
  "224.0.0.0": { v4Blocked: true },
  "239.255.255.255": { v4Blocked: true },
  // --- reserved 240/4 (incl. broadcast) ---
  "240.0.0.0": { v4Blocked: true },
  "255.255.255.255": { v4Blocked: true },
  // --- shared/CGNAT 100.64/10 ---
  "100.64.0.0": { v4Blocked: true },
  "100.127.255.255": { v4Blocked: true },
  "100.128.0.0": { v4Blocked: false },
  // --- public controls ---
  "8.8.8.8": { v4Blocked: false },
  "1.1.1.1": { v4Blocked: false },
  // --- IPv6: unspecified / loopback ---
  "::": { v6Blocked: true },
  "::1": { v6Blocked: true },
  // --- IPv4-mapped (::ffff:0:0/96): verdict follows embedded v4 ---
  "::ffff:127.0.0.1": { v6Blocked: true },
  "::ffff:8.8.8.8": { v6Blocked: false },
  "::ffff:169.254.169.254": { v6Blocked: true },
  // --- IPv4-compatible (::/96): ipaddr normalizes to mapped; verdict identical ---
  "::8.8.8.8": { v6Blocked: false },
  "::127.0.0.1": { v6Blocked: true },
  // --- 64:ff9b::/96 translation: verdict follows embedded v4 ---
  "64:ff9b::7f00:1": { v6Blocked: true },
  "64:ff9b::808:808": { v6Blocked: false },
  // --- 6to4 2002::/16: verdict follows embedded v4 (bits 16..47) ---
  "2002:7f00:1::": { v6Blocked: true },
  "2002:0808:0808::": { v6Blocked: false },
  // --- Teredo 2001::/32 (conservative block) ---
  "2001::": { v6Blocked: true },
  "2001:0000:1234:5678::": { v6Blocked: true },
  // --- documentation 2001:db8::/32 ---
  "2001:db8::1": { v6Blocked: true },
  "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  // --- ORCHID 2001:10::/28 and ORCHIDv2 2001:20::/28 ---
  "2001:10::": { v6Blocked: true },
  "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  "2001:20::": { v6Blocked: true },
  "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  // --- discard-only 100::/64 ---
  "100::": { v6Blocked: true },
  "100::1": { v6Blocked: true },
  "100::ffff:ffff:ffff:ffff": { v6Blocked: true },
  "101::": { v6Blocked: false },
  // --- link-local fe80::/10 ---
  "fe80::1": { v6Blocked: true },
  "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  "fe00::1": { v6Blocked: false },
  // --- deprecated site-local fec0::/10 ---
  "fec0::1": { v6Blocked: true },
  "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  // --- unique-local fc00::/7 ---
  "fc00::1": { v6Blocked: true },
  "fd00::1": { v6Blocked: true },
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": { v6Blocked: true },
  // --- multicast ff00::/8 ---
  "ff00::1": { v6Blocked: true },
  "ff02::1": { v6Blocked: true },
  // --- public controls ---
  "2606:4700:4700::1111": { v6Blocked: false },
  "2620:0:ccc::2": { v6Blocked: false },
  // --- unparsable IPv6: fail closed ---
  "2001:db8:::1": { v6Blocked: true, v6Unparsable: true },
  "gggg::1": { v6Blocked: true, v6Unparsable: true },
};

test("SSRF vectors: frozen classification table (90 vectors)", () => {
  const vectors = Object.entries(VECTORS);
  assert.ok(vectors.length >= 40, `expected >= 40 vectors, got ${vectors.length}`);
  for (const [ip, expectation] of vectors) {
    if (expectation.v6Blocked !== undefined) {
      assert.equal(
        isBlockedIpv6(ip),
        expectation.v6Blocked,
        `isBlockedIpv6(${ip}) must be ${expectation.v6Blocked}`,
      );
    }
    if (expectation.v6Unparsable !== undefined) {
      assert.equal(
        parseIpv6ToBigInt(ip),
        null,
        `parseIpv6ToBigInt(${ip}) must fail closed (null)`,
      );
    }
    if (expectation.v4Blocked !== undefined) {
      const check = validateUrlStructure(`http://${ip}/`);
      assert.equal(
        check.ok,
        !expectation.v4Blocked,
        `validateUrlStructure(http://${ip}/) must be ${expectation.v4Blocked ? "blocked" : "allowed"} (${check.reason ?? "ok"})`,
      );
    }
  }
});

test("SSRF vectors: public controls are structurally allowed", () => {
  for (const url of ["http://8.8.8.8/", "http://1.1.1.1/", "http://[2606:4700:4700::1111]/"]) {
    const check = validateUrlStructure(url);
    assert.equal(check.ok, true, `${url} must be allowed`);
  }
});

test("SSRF vectors: parseIpv6ToBigInt numeric parity on representative forms", () => {
  // Frozen numeric expectations captured from the legacy parser before the port.
  assert.equal(parseIpv6ToBigInt("::1"), 1n);
  assert.equal(parseIpv6ToBigInt("::ffff:127.0.0.1"), 0xffff7f000001n);
  assert.equal(parseIpv6ToBigInt("2002:7f00:1::"), 0x20027f00000100000000000000000000n);
  assert.equal(parseIpv6ToBigInt("fe80::1%eth0"), 0xfe800000000000000000000000000001n);
  assert.equal(parseIpv6ToBigInt("2001:db8::1"), 0x20010db8000000000000000000000001n);
  assert.equal(parseIpv6ToBigInt("2001:db8:::1"), null);
  assert.equal(parseIpv6ToBigInt("gggg::1"), null);
  assert.equal(parseIpv6ToBigInt("not-an-ip"), null);
});
