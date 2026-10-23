import assert from "node:assert/strict";
import test from "node:test";
import type { ClaimLineage } from "@factory/contracts";
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
