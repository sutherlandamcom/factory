import assert from "node:assert/strict";
import test from "node:test";
import {
  requireDeliveryTarget,
  validateProductionUrl,
  validateWorkerName,
} from "../src/delivery/config.js";

test("missing delivery configuration fails closed before workflow construction", () => {
  assert.throws(
    () => requireDeliveryTarget({ cloudflareWorkerName: null, productionUrl: null }),
    (error: unknown) => (error as { code?: string }).code === "deployment_target_unconfigured",
  );
});

test("delivery configuration accepts only bounded worker names and HTTPS origins", () => {
  assert.equal(validateWorkerName("factory-site"), "factory-site");
  assert.equal(validateProductionUrl("https://example.com/"), "https://example.com");
  assert.throws(() => validateWorkerName("Factory_Site"));
  assert.throws(() => validateProductionUrl("http://example.com"));
  assert.throws(() => validateProductionUrl("https://example.com/path"));
  assert.throws(() => validateProductionUrl("https://user:pass@example.com"));
});
