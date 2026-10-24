import assert from "node:assert/strict";
import test from "node:test";
import type { ClaimLineage } from "@factory/contracts";
import { productionConversionAuthoritySchema } from "@factory/contracts";
import { verifiedConversionHref } from "../src/production/conversion.js";
import { isSentenceCoveredByClaims } from "../src/production/qa/trust.js";

test("E2E-P1-04: a matching clause cannot authorize additional quantitative assertions", () => {
  for (const [sentence, claim] of [
    ["Компания выполнила проекты стоимостью 500 миллионов рублей.", "Компания выполнила проекты"],
    ["The company completed projects worth 500 million dollars.", "The company completed projects"],
  ]) assert.equal(isSentenceCoveredByClaims(sentence!, [{ claimText: claim } as ClaimLineage]), false);
});
test("E2E-P1-03: URI-reserved mailbox characters preserve the accepted recipient", () => {
  const href = verifiedConversionHref({ primaryObjective: "Contact", ctaType: "email", ctaDestinationType: "email", ctaDestination: "sales#eu@example.com", verificationState: "VERIFIED" });
  assert.equal(href, "mailto:sales%23eu@example.com");
  assert.equal(decodeURIComponent(new URL(href).pathname), "sales#eu@example.com");
  assert.equal(new URL(href).hash, "");
});

test("E2E-P1-03: malformed email atoms/domains fail closed and encoded mailto preserves its recipient", () => {
  const input = { primaryObjective: "Contact", ctaType: "email", ctaDestinationType: "email" as const, verificationState: "VERIFIED" as const };
  for (const ctaDestination of [".sales@example.com", "sales.@example.com", "sales..eu@example.com", "sales@-example.com", "sales@example-.com", "mailto:sales@example.com?subject=unapproved", "mailto:sales#eu@example.com", "mailto://ignored.example/sales@example.com", "MAILTO://ignored.example/sales@example.com"]) {
    assert.throws(() => verifiedConversionHref({ ...input, ctaDestination }), /CTA destination/, ctaDestination);
  }
  assert.equal(verifiedConversionHref({ ...input, ctaDestination: "mailto:sales%23eu@example.com" }), "mailto:sales%23eu@example.com");
  const authority = { projectId: "project", acceptedInput: { id: "input", version: 1, digest: "a".repeat(64) }, acceptedContentDigest: "b".repeat(64), ctaText: "Contact", mode: "action" as const };
  for (const href of ["mailto:.sales@example.com", "mailto:sales..eu@example.com", "mailto:sales@-example.com"]) {
    assert.equal(productionConversionAuthoritySchema.safeParse({ ...authority, href }).success, false);
  }
  assert.equal(productionConversionAuthoritySchema.safeParse({ ...authority, href: "mailto:sales%23eu@example.com" }).success, true);
});
