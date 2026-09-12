# ADR: Run 4.1 closed-runs hardening — SSRF classifier port and canonical-JSON determinism proof

Date: 2026-09-12
Scope: Run 4.1 hardening window (closed-runs items W1 + W2)
Status: Proposed (merge gate: operator after independent QA)

## Decision A — SSRF range classification delegated to `ipaddr.js@2.5.0`

### Context

`apps/factory/src/competitors/ssrf-guard.ts` contained ~130 lines of hand-rolled
BigInt IPv4/IPv6 range arithmetic implementing the Run 3 fetcher security
control. Hand-rolled range classification is exactly the code class that
produced CVE-graded SSRF-classification bugs in peer libraries (`ip`,
`ip-address`) in 2026. The repository policy ("use maintained libraries instead
of unmaintained hand-rolled equivalents") sanctions replacing such code with a
maintained dependency.

### Decision

Range classification is delegated to `ipaddr.js@2.5.0` (pinned exact version,
new runtime dependency in `apps/factory/package.json`, lockfile committed).
Standard categories (loopback, private, link-local, unique-local, multicast,
carrier-grade NAT, broadcast, reserved, unspecified) come from
`ipaddr.js` `parse().range()`; policy-only ranges that `ipaddr.js` classifies
as ordinary unicast remain explicit policy (none currently needed for IPv4
beyond `reserved`, which already covers all legacy policy entries).

### Policy equivalence method

The blocked-set policy is proven byte-identical by a self-calibrating
equivalence harness:

1. A fixed vector table of **90** IP addresses was written BEFORE the port —
   one sample plus boundary samples for every blocked range in the legacy
   policy (test-nets, 192.0.0.0/24, 192.88.99.0/24, CGNAT, 240/4, 2001:db8::/32,
   Teredo, ORCHID v1/v2, discard, translation/tunnel families with forbidden
   and public embedded IPv4, plus public controls and unparsable inputs).
2. The legacy implementation's classifications over all vectors were captured
   (frozen) before any edit.
3. The ported implementation was run over the identical vectors and required
   to reproduce the frozen output.

### Result and one intentional conservative delta

Every legacy-blocked classification is reproduced. Three vectors changed in
the conservative direction only (allowed → blocked): the legacy "test-net-2"
constant `0xc6120000n–0xc613ffffn` is a hex transcription bug — it encodes
**198.18.0.0/15** (RFC 2544 benchmarking), not the intended 198.51.100.0/24.
The ported implementation blocks BOTH ranges (`ipaddr.js` classifies both as
`reserved`), so the documented test-net-2 policy is now actually enforced and
nothing previously blocked became allowed. The frozen vectors are committed as
`apps/factory/tests/competitor-ssrf-vectors.test.ts`.

Parse semantics are unchanged: the strict pre-existing gates (dotted-quad
regex + octet bounds for IPv4, `node:net` `isIPv6` + explicit BigInt expansion
for IPv6) are preserved and unparsable input still fails closed. The exported
API (`SsrfBlockedError`, `validateUrlStructure`, `validateUrlResolved`,
`parseIpv6ToBigInt`, `isBlockedIpv6`) is signature-identical.

### Conservative-superset note

`ipaddr.js` labels a few narrow reserved ranges (`benchmarking` 2001:2::/48,
`amt` 2001:3::/32, `as112v6`, `droneRemoteIdProtocolEntityTags` 2001:30::/28,
`segmentRouting` 5f00::/16, `reserved` 2001::/23 + 3fff::/20) as blocked here
where the legacy table was silent. All are non-routable or special-purpose;
blocking them is the fail-closed direction for an SSRF guard.

## Decision B — canonical JSON stays in-house; determinism proven against RFC 8785

### Context

`canonicalJsonStringify` (`apps/factory/src/intelligence/digest.ts`) binds
every human approval to a SHA-256 digest. The project's adoption policy
forbids replacing this serializer: historical digests are bound to its exact
output and a replacement would invalidate them.

### Decision

The serializer is NOT modified (zero production changes in W2). Its
determinism is instead proven test-only against RFC 8785 (JCS): the Section
3.2.2/3.2.3/3.2.4 sample, the §3.2.3 Unicode property-sorting sample, all 24
Appendix B IEEE 754 number vectors (encoded as exact bit patterns), the
Appendix E subtype sample, and the six official corpus files referenced by
Appendix I (arrays, french, structures, unicode, values, weird). All vectors
pass. A future divergence would surface as a red test, not a silent digest
drift.

### Consequences

- Historical digests remain valid (no serializer change).
- The RFC 8785 vector test (`apps/factory/tests/canonical-rfc8785.test.ts`)
  pins the serializer's compatibility with the JCS standard; any future edit
  that breaks canonicalization is caught by CI.

## Verification summary

- Factory unit lane: 868 tests / 0 fail (859 baseline + 3 new W1 tests + 6 new
  W2 tests), existing competitor/acquisition tests unchanged and green.
- Typecheck (`pnpm -r run check`): green.
- New dependency: `ipaddr.js@2.5.0` only (lockfile committed).
