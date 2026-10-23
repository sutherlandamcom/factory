import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchContext } from "../src/search/context.js";
const payload = { siteIdentity: { siteName: "Stark", candidateDomain: "stark.example.test", language: "ru-RU", locale: "ru-RU" }, markets: { geographies: ["Russia"], priorityLocations: [] as string[] } };
test("E2E-P1-01: exact accepted market, explicit override and source classification", () => {
  assert.deepEqual(resolveSearchContext(payload, {}), { policyVersion: "search-context-v1", language: "ru", location: "Russia", languageSource: "accepted_input", locationSource: "accepted_input" });
  const override = resolveSearchContext(payload, { language: "en-GB", location: "United Kingdom" });
  assert.equal(override.language, "en"); assert.equal(override.location, "United Kingdom");
  assert.equal(override.languageSource, "operator_override"); assert.equal(override.locationSource, "operator_override");
});
test("E2E-P1-01: missing, ambiguous and unsupported markets/languages require clarification", () => {
  for (const markets of [{ geographies: [], priorityLocations: [] }, { geographies: ["Russia", "France"], priorityLocations: [] }, { geographies: ["Imaginary Republic"], priorityLocations: [] }]) {
    assert.throws(() => resolveSearchContext({ ...payload, markets }, {}), /location|market/i);
  }
  for (const language of ["xx-ZZ", "not_a_locale", ""]) assert.throws(() => resolveSearchContext({ ...payload, siteIdentity: { ...payload.siteIdentity, language } }, {}));
});

test("E2E-P1-01: country suffixes normalize consistently for provider adapters", () => {
  for (const [location, expected] of [["Moscow,RU", "Moscow,Russia"], ["Paris,FR", "Paris,France"], ["Austin,Texas,US", "Austin,Texas,United States"]]) {
    assert.equal(resolveSearchContext(payload, { location }).location, expected);
  }
});
test("E2E-P1-01: conflicting accepted geography and priority target require clarification", () => {
  const conflict = { ...payload, markets: { geographies: ["France"], priorityLocations: ["Moscow,Russia"] } };
  assert.throws(() => resolveSearchContext(conflict, {}), /conflict/i);
  assert.equal(resolveSearchContext(conflict, { location: "Russia" }).location, "Russia");
});
