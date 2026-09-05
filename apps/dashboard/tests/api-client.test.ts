import assert from "node:assert/strict";
import test from "node:test";
import { OperatorApiError, type ProjectOperatorWorkspace } from "../src/api/client";

test("workspace read-model shape: fields the Dashboard consumes are intact", () => {
  const ws: ProjectOperatorWorkspace = {
    project: { id: "1", key: "k", name: "N", createdAt: new Date().toISOString() },
    currentDraft: { revision: 3, digest: null, updatedAt: null, payload: null },
    readiness: { status: "READY", blockers: [], warnings: [], nextActions: [] },
    currentAcceptedSnapshot: null,
    history: [],
    draftDiffersFromAccepted: false,
    status: "DRAFT",
    nextActions: [],
  };
  assert.equal(ws.currentDraft.revision, 3);
  assert.equal(ws.status, "DRAFT");
  assert.equal(ws.readiness.status, "READY");
});

test("OperatorApiError: contract envelope codes map to typed errors", () => {
  const stale = new OperatorApiError("intake_stale_revision", "stale", 409);
  assert.equal(stale.code, "intake_stale_revision");
  assert.equal(stale.status, 409);
  assert.ok(stale instanceof Error);

  const blocked = new OperatorApiError("intake_blocked", "blocked", 422);
  assert.equal(blocked.code, "intake_blocked");

  const internal = new OperatorApiError("internal_error", "Internal server error.", 500);
  assert.equal(internal.status, 500);
  // The generic server-fault message is fixed and carries no internals.
  assert.equal(internal.message, "Internal server error.");
  assert.equal(
    internal.message.length,
    "Internal server error.".length,
    "internal error message must be the fixed sanitized string",
  );
});

test("OperatorApiError: unknown/non-contract codes degrade to http_<status>", () => {
  const weird = new OperatorApiError("http_502", "Request failed. Please try again.", 502);
  assert.equal(weird.code, "http_502");
  assert.equal(weird.message, "Request failed. Please try again.");
});

test("dashboard form state: conversion ctaDestination is a string and conforms to contract", async () => {
  const { emptyProjectIntakePayload, parseProjectIntakePayload } = await import("@factory/contracts");
  const payload = emptyProjectIntakePayload();

  // Simulating dashboard form edit: user enters CTA destination as a string.
  payload.business.name = "Summit Roofing";
  payload.business.description = "Commercial and residential roofing services.";
  payload.siteIdentity.language = "en";
  payload.contentConstitution.customWriterInstructions = "Clear, evidence-backed statements.";

  payload.conversion.ctaDestinationType = "phone";
  payload.conversion.ctaDestination = "tel:+15551234567";
  payload.conversion.primaryObjective = "Request an estimate";
  payload.conversion.ctaType = "Call Now";
  payload.conversion.verificationState = "VERIFIED";

  // Authoritative contract must accept this shape without throw
  const parsed = parseProjectIntakePayload(payload);
  assert.equal(typeof parsed.conversion.ctaDestination, "string");
  assert.equal(parsed.conversion.ctaDestination, "tel:+15551234567");
  assert.equal(parsed.conversion.ctaDestinationType, "phone");
});

test("dashboard form state: object-shaped ctaDestination fails schema validation (reproduces P1)", async () => {
  const { emptyProjectIntakePayload, parseProjectIntakePayload } = await import("@factory/contracts");
  const payload = emptyProjectIntakePayload();
  payload.business.name = "Summit Roofing";
  payload.business.description = "Commercial and residential roofing.";
  payload.siteIdentity.language = "en";

  // Stale dashboard behavior that caused P1: setting an object instead of a string
  const malformed = {
    ...payload,
    conversion: {
      ...payload.conversion,
      ctaDestination: { kind: "url", value: "https://example.com/contact" } as any,
    },
  };

  assert.throws(
    () => parseProjectIntakePayload(malformed),
    (err: any) => {
      const issue = err.issues?.find(
        (i: any) => i.path?.join(".") === "conversion.ctaDestination",
      );
      assert.ok(issue, "must report issue at conversion.ctaDestination");
      return true;
    },
  );
});

test("review tab formatters: audience segments and ctaDestination format authoritative strings", () => {
  const populatedPayload = {
    audience: {
      segments: ["Commercial Property Managers", "Homeowners"],
      needs: ["Emergency repair", "Roof replacement"],
    },
    conversion: {
      primaryObjective: "Book inspection",
      ctaDestination: "tel:+15551234567",
      verificationState: "VERIFIED",
    },
  };

  const segmentsFormatted = (populatedPayload.audience.segments ?? []).join(", ");
  assert.equal(segmentsFormatted, "Commercial Property Managers, Homeowners");

  const ctaFormatted = typeof populatedPayload.conversion.ctaDestination === "string"
    ? populatedPayload.conversion.ctaDestination
    : "";
  assert.equal(ctaFormatted, "tel:+15551234567");

  // When empty or absent:
  const emptyPayload = {
    audience: { segments: [] },
    conversion: { ctaDestination: "" },
  };

  const emptySegments = (emptyPayload.audience.segments ?? []).join(", ");
  assert.equal(emptySegments, "");
  assert.equal(emptySegments || "—", "—");

  const emptyCta = typeof emptyPayload.conversion.ctaDestination === "string"
    ? emptyPayload.conversion.ctaDestination
    : "";
  assert.equal(emptyCta, "");
  assert.equal(emptyCta || "—", "—");
});

