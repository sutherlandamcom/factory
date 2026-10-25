import assert from "node:assert/strict";
import test from "node:test";
import type { Conversion } from "@factory/contracts";
import { verifiedConversionHref, deriveConversionAuthority } from "../src/production/conversion.js";
const conversion: Conversion = { primaryObjective: "Discuss an industrial project", ctaType: "contact", ctaDestinationType: "url", ctaDestination: "https://contact.example.test/", verificationState: "VERIFIED" };
test("E2E-P1-03: only verified supported destination types produce actionable authority", () => {
  for (const [kind, value, expected] of [
    ["url", "https://contact.example.test/", "https://contact.example.test/"],
    ["url", "/contact", "/contact"],
    ["email", "operator@example.test", "mailto:operator@example.test"],
    ["phone", "+15550100100", "tel:+15550100100"],
  ] as const) assert.equal(verifiedConversionHref({ ...conversion, ctaDestinationType: kind, ctaDestination: value }), expected);
  for (const value of ["javascript:alert(1)", "data:text/html,x", "//evil.example.test", "https://user:pass@evil.example.test/", "https://safe.example.test/\n", "http://contact.example.test/", "", "/../admin", "https:\\evil.example.test"]) {
    assert.throws(() => verifiedConversionHref({ ...conversion, ctaDestination: value }));
  }
  assert.throws(() => verifiedConversionHref({ ...conversion, verificationState: "UNVERIFIED" }));
  assert.throws(() => verifiedConversionHref({ ...conversion, ctaDestinationType: "form" }));
  assert.throws(() => verifiedConversionHref({ ...conversion, ctaDestinationType: "form", ctaDestination: "/contact" }), /governed form|supported/i);
});
test("E2E-P1-03: informational approval must bind the exact accepted snapshot", () => {
  const input = { projectId: "stark", snapshot: { id: "intake", version: 1, digest: "a".repeat(64) }, conversion: { ...conversion, verificationState: "UNVERIFIED" as const }, acceptedContentDigest: "b".repeat(64), ctaText: "Обсудить производственную задачу" };
  assert.throws(() => deriveConversionAuthority(input));
  const informational = deriveConversionAuthority({ ...input, informationalApproval: { acceptedInputDigest: input.snapshot.digest, reason: "Approved informational test page" } });
  assert.equal(informational.mode, "informational");
  assert.equal(informational.href, null);
  assert.throws(() => deriveConversionAuthority({ ...input, snapshot: { ...input.snapshot, digest: "c".repeat(64) }, informationalApproval: { acceptedInputDigest: input.snapshot.digest, reason: "Old approval" } }));
});
