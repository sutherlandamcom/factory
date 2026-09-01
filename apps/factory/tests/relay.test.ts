import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  startModelRelay,
  validateRelayModel,
  RELAY_DUMMY_TOKEN,
} from "../src/executor/relay.js";
import { CODE_WORKER_POLICY } from "../src/models/policy.js";

test("validateRelayModel strictly enforces exact model per tier", () => {
  const primaryAllowed = CODE_WORKER_POLICY.primary.model;
  const seniorAllowed = CODE_WORKER_POLICY.senior.model;

  assert.equal(validateRelayModel({ model: primaryAllowed }, primaryAllowed).valid, true);
  assert.equal(validateRelayModel({ model: seniorAllowed }, seniorAllowed).valid, true);

  // Mismatched models
  const invalidPrimary = validateRelayModel({ model: "openai/gpt-5" }, primaryAllowed);
  assert.equal(invalidPrimary.valid, false);
  assert.match(invalidPrimary.error!, /Unauthorized model/);

  const invalidSenior = validateRelayModel({ model: "anthropic/claude-3-haiku" }, seniorAllowed);
  assert.equal(invalidSenior.valid, false);
  assert.match(invalidSenior.error!, /Unauthorized model/);

  // Missing model
  assert.equal(validateRelayModel({}, primaryAllowed).valid, false);
  assert.equal(validateRelayModel(null, primaryAllowed).valid, false);
});

test("startModelRelay starts HTTP server, enforces health check and model rejection", async () => {
  const relay = await startModelRelay({
    tier: "primary",
    apiKey: "sk-or-real-secret-key-12345",
  });

  try {
    assert.ok(relay.port > 0);
    assert.equal(relay.allowedModel, "moonshotai/kimi-k3");
    assert.equal(relay.tier, "primary");

    // 1. Health check
    const healthRes = await fetch(`${relay.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string; tier: string; allowedModel: string };
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.tier, "primary");
    assert.equal(healthJson.allowedModel, "moonshotai/kimi-k3");

    // 2. Reject unauthorized model
    const rejectRes = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_DUMMY_TOKEN}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(rejectRes.status, 403);
    const rejectJson = (await rejectRes.json()) as { error: { code: string; message: string } };
    assert.equal(rejectJson.error.code, "unauthorized_model");
    assert.match(rejectJson.error.message, /Unauthorized model/);

    // 3. Reject invalid JSON
    const badJsonRes = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    assert.equal(badJsonRes.status, 400);
  } finally {
    await relay.close();
  }
});
