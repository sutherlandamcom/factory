import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyProjectIntakePayload,
  parseProjectIntakePayload,
  projectIntakePayloadSchema,
} from "@factory/contracts";

/**
 * Project Intake contract acceptance: schema and boundary rules for the
 * canonical intake payload (packages/contracts/src/project-intake.ts).
 *
 * Presence is deliberately permissive (operators fill drafts progressively)
 * while bounds are strict: a half-filled draft can always be SAVED but
 * never ACCEPTED (readiness gates that).
 */

test("contract: the canonical empty template parses and contains no business facts", () => {
  const empty = emptyProjectIntakePayload();
  const parsed = parseProjectIntakePayload(empty);
  assert.deepEqual(parsed, empty);
  assert.equal(parsed.schemaVersion, "v1");
  assert.equal(parsed.business.name, "");
  assert.equal(parsed.business.description, "");
  assert.equal(parsed.contentConstitution.customWriterInstructions, "");
  assert.equal(parsed.assetAvailability.hasLogo, false);
});

test("contract: schemaVersion is locked to v1 (unknown versions fail closed)", () => {
  const bad = { ...emptyProjectIntakePayload(), schemaVersion: "v2" };
  assert.throws(() => parseProjectIntakePayload(bad));
});

test("contract: unknown top-level fields are rejected (strict schema)", () => {
  const extra: any = emptyProjectIntakePayload();
  extra.unknownField = "x";
  assert.throws(() => parseProjectIntakePayload(extra));
});

test("contract: unknown nested fields are rejected (strict schema)", () => {
  const extra = emptyProjectIntakePayload();
  (extra.business as any).unknownField = "x";
  assert.throws(() => parseProjectIntakePayload(extra));
});

test("contract: credential-shaped values are rejected anywhere in the payload", () => {
  const secret = emptyProjectIntakePayload();
  secret.evidence.operatorFacts = ["note with OPENROUTER_API_KEY=sk-abc inside"];
  assert.throws(() => parseProjectIntakePayload(secret), /secrets are forbidden/);

  const secret2 = emptyProjectIntakePayload();
  secret2.business.description = "config: DATABASE_URL=postgres://u:p@h/db";
  assert.throws(() => parseProjectIntakePayload(secret2), /secrets are forbidden/);
});

test("contract: text bounds are enforced per field", () => {
  // business.name max 200
  const overName = emptyProjectIntakePayload();
  overName.business.name = "N".repeat(201);
  assert.throws(() => parseProjectIntakePayload(overName));

  const exactName = emptyProjectIntakePayload();
  exactName.business.name = "N".repeat(200);
  assert.ok(parseProjectIntakePayload(exactName));

  // contentConstitution.customWriterInstructions max 8000
  const overCustom = emptyProjectIntakePayload();
  overCustom.contentConstitution.customWriterInstructions = "C".repeat(8001);
  assert.throws(() => parseProjectIntakePayload(overCustom));

  const exactCustom = emptyProjectIntakePayload();
  exactCustom.contentConstitution.customWriterInstructions = "C".repeat(8000);
  assert.ok(parseProjectIntakePayload(exactCustom));
});

test("contract: array bounds are enforced", () => {
  // business.offerings max 20
  const over = emptyProjectIntakePayload();
  over.business.offerings = Array.from({ length: 21 }, (_, i) => `o${i}`);
  assert.throws(() => parseProjectIntakePayload(over));

  const exact = emptyProjectIntakePayload();
  exact.business.offerings = Array.from({ length: 20 }, (_, i) => `o${i}`);
  assert.ok(parseProjectIntakePayload(exact));

  // evidence.prohibitedClaims max 20
  const overClaims = emptyProjectIntakePayload();
  overClaims.evidence.prohibitedClaims = Array.from({ length: 21 }, (_, i) => `c${i}`);
  assert.throws(() => parseProjectIntakePayload(overClaims));
});

test("contract: conversion.verificationState accepts only the defined enum", () => {
  const valid = emptyProjectIntakePayload();
  valid.conversion.verificationState = "UNVERIFIED";
  assert.ok(parseProjectIntakePayload(valid));

  const invalid = emptyProjectIntakePayload();
  (invalid.conversion as any).verificationState = "MAYBE";
  assert.throws(() => parseProjectIntakePayload(invalid));
});

test("contract: ctaDestinationType accepts only the defined enum", () => {
  const valid = emptyProjectIntakePayload();
  valid.conversion.ctaDestinationType = "phone";
  assert.ok(parseProjectIntakePayload(valid));

  const invalid = emptyProjectIntakePayload();
  (invalid.conversion as any).ctaDestinationType = "fax";
  assert.throws(() => parseProjectIntakePayload(invalid));
});

test("contract: design reference URLs must be absolute http(s) without credentials", () => {
  const valid = emptyProjectIntakePayload();
  valid.designReferences.referenceUrls = ["https://example.com/inspiration"];
  assert.ok(parseProjectIntakePayload(valid));

  const ftp = emptyProjectIntakePayload();
  ftp.designReferences.referenceUrls = ["ftp://example.com/x"];
  assert.throws(() => parseProjectIntakePayload(ftp));

  const credentialed = emptyProjectIntakePayload();
  credentialed.designReferences.referenceUrls = ["https://user:pass@example.com/x"];
  assert.throws(() => parseProjectIntakePayload(credentialed));
});

test("contract: candidateDomain accepts a bare domain or absolute origin, rejects junk", () => {
  const domain = emptyProjectIntakePayload();
  domain.siteIdentity.candidateDomain = "example.com";
  assert.ok(parseProjectIntakePayload(domain));

  const origin = emptyProjectIntakePayload();
  origin.siteIdentity.candidateDomain = "https://example.com";
  assert.ok(parseProjectIntakePayload(origin));

  const junk = emptyProjectIntakePayload();
  junk.siteIdentity.candidateDomain = "not a domain!";
  assert.throws(() => parseProjectIntakePayload(junk));
});

test("contract: whitespace-only strings are trimmed by bounded text", () => {
  const payload = emptyProjectIntakePayload();
  payload.business.name = "   padded name   ";
  const parsed = parseProjectIntakePayload(payload);
  assert.equal(parsed.business.name, "padded name");
});

test("contract: digest is independent of key insertion order (canonical JSON)", async () => {
  const { deterministicDigest } = await import("../src/intelligence/digest.js");
  const a = emptyProjectIntakePayload();
  const b = JSON.parse(JSON.stringify(a));
  const reordered: Record<string, unknown> = {};
  for (const k of Object.keys(b).reverse()) reordered[k] = b[k];
  assert.equal(deterministicDigest(a), deterministicDigest(reordered));
});
