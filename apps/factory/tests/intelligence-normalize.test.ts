import assert from "node:assert/strict";
import test from "node:test";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { normalizeResearchBundle, normalizeUrlForComparison } from "../src/intelligence/normalize.js";
import { deepClone, loadFixtureResearchJson } from "./intelligence-fixtures.js";

type AnyRecord = Record<string, unknown>;

test("normalization is stable and deterministic regardless of input order", async () => {
  const research = await loadFixtureResearchJson();
  const reordered = deepClone(research);
  (reordered.items as AnyRecord[]).reverse();

  const a = normalizeResearchBundle(research as never);
  const b = normalizeResearchBundle(reordered as never);
  assert.deepEqual(a, b);
  assert.equal(deterministicDigest(a), deterministicDigest(b));
});

test("sourceUrl is preserved exactly; normalizedUrl is additive", async () => {
  const research = await loadFixtureResearchJson();
  const normalized = normalizeResearchBundle(research as never);
  const originalByUrl = new Map(
    (research.items as AnyRecord[]).map((item) => [item.id as string, item.sourceUrl as string]),
  );
  for (const item of normalized.items) {
    const original = originalByUrl.get(item.id);
    if (original !== undefined) {
      assert.equal(item.sourceUrl, original, `sourceUrl must be preserved verbatim for ${item.id}`);
    }
    if (item.sourceUrl !== undefined) assert.equal(typeof item.normalizedUrl, "string");
  }
});

test("URL normalization is conservative and deterministic", () => {
  assert.equal(
    normalizeUrlForComparison("https://Example.COM:443/"),
    "https://example.com",
  );
  assert.equal(
    normalizeUrlForComparison("http://EXAMPLE.com:80/path?q=1"),
    "http://example.com/path?q=1",
  );
  assert.equal(
    normalizeUrlForComparison("https://example.com:8443/path"),
    "https://example.com:8443/path",
  );
  assert.equal(
    normalizeUrlForComparison("https://example.com/a/b?keep=1&also=2#frag"),
    "https://example.com/a/b?keep=1&also=2#frag",
  );
  assert.equal(
    normalizeUrlForComparison("https://example.com"),
    "https://example.com",
  );
});

test("duplicate evidence is marked, never deleted, and provenance resolves", async () => {
  const research = await loadFixtureResearchJson();
  const normalized = normalizeResearchBundle(research as never);
  const duplicates = normalized.items.filter((item) => item.duplicateOf !== undefined);
  assert.ok(duplicates.length >= 1, "fixture contains one URL-duplicate record");
  assert.equal(normalized.items.length, (research.items as AnyRecord[]).length);

  const ids = new Set(normalized.items.map((item) => item.id));
  for (const duplicate of duplicates) {
    assert.ok(ids.has(duplicate.duplicateOf!), "duplicateOf must reference an existing record");
    assert.notEqual(duplicate.duplicateOf, duplicate.id);
  }
  const mirror = duplicates.find((item) => item.id === "comp-peak-service-mirror");
  assert.ok(mirror, "the mirror competitor capture is the expected duplicate");
  assert.equal(mirror.duplicateOf, "comp-peak-service");
});

test("text content and metrics are never semantically rewritten", async () => {
  const research = await loadFixtureResearchJson();
  const normalized = normalizeResearchBundle(research as never);
  const originalById = new Map(
    (research.items as AnyRecord[]).map((item) => [item.id as string, item]),
  );
  for (const item of normalized.items) {
    const original = originalById.get(item.id)!;
    assert.equal(item.text, original.text);
    assert.equal(item.title, original.title);
    assert.deepEqual(item.metrics ?? undefined, original.metrics ?? undefined);
    assert.equal(item.query, original.query);
  }
});

test("same query on different URLs is NOT a duplicate", () => {
  const bundle = {
    version: "v0",
    collectedAt: "2026-08-01T09:00:00Z",
    items: [
      {
        id: "a",
        kind: "serp_observation",
        query: "roof repair denver",
        sourceUrl: "https://research.example/serps/roof-repair-denver",
      },
      {
        id: "b",
        kind: "serp_observation",
        query: "roof repair denver",
        sourceUrl: "https://other.example/serps/roof-repair-denver",
      },
    ],
  };
  const normalized = normalizeResearchBundle(bundle as never);
  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.items.find((item) => item.id === "b")?.duplicateOf, undefined);
});

test("identical normalized inputs produce identical digests", async () => {
  const research = await loadFixtureResearchJson();
  const a = deterministicDigest(normalizeResearchBundle(deepClone(research) as never));
  const b = deterministicDigest(normalizeResearchBundle(deepClone(research) as never));
  assert.equal(a, b);
});

test("changing any evidence content changes the research digest", async () => {
  const research = deepClone(await loadFixtureResearchJson());
  const before = deterministicDigest(normalizeResearchBundle(research as never));
  ((research.items as AnyRecord[])[0] as AnyRecord).text = "Changed observation text.";
  const after = deterministicDigest(normalizeResearchBundle(research as never));
  assert.notEqual(before, after);
});
