import test from "node:test";
import assert from "node:assert/strict";
import {
  visualSetDigest,
  canonicalVisualSetSlot,
  type CanonicalVisualSetSlot,
} from "../src/visual/store.js";
import { deterministicDigest } from "../src/intelligence/digest.js";

test("unit: visualSetDigest normalizes slot rows to canonical authority projection (P1-1)", () => {
  const authorityA: CanonicalVisualSetSlot = {
    slot: "hero.primary",
    pageSlug: "home",
    role: "hero",
    resolvedVersionId: "asv-100",
    binaryDigest: "a".repeat(64),
    governanceDigest: "b".repeat(64),
    resolutionMode: "reuse_real",
    truthClass: "illustrative",
  };

  const runtimeB = {
    ...authorityA,
    visualProviderConsumedSourceAsset: false,
    visualProviderProducedAsset: false,
    promptSnapshotId: null,
    generationRequestId: null,
    candidateId: null,
  };

  const runtimeC = {
    ...authorityA,
    visualProviderConsumedSourceAsset: true,
    visualProviderProducedAsset: true,
    promptSnapshotId: "ps-12345",
    generationRequestId: "gr-67890",
    candidateId: "vcand-54321",
    extraArbitraryRuntimeKey: "should-be-ignored",
  };

  // 1. Equivalence under visualSetDigest
  assert.equal(
    visualSetDigest([authorityA]),
    visualSetDigest([runtimeB]),
    "visualSetDigest must be identical when runtime provenance fields are null/false",
  );
  assert.equal(
    visualSetDigest([authorityA]),
    visualSetDigest([runtimeC]),
    "visualSetDigest must be identical when runtime provenance fields are populated",
  );

  // 2. Negative proof: raw deterministicDigest on un-normalized objects WOULD have diverged
  assert.notEqual(
    deterministicDigest(authorityA),
    deterministicDigest(runtimeB),
    "deterministicDigest on raw objects diverges because extra keys are hashed",
  );
  assert.notEqual(
    deterministicDigest(authorityA),
    deterministicDigest(runtimeC),
    "deterministicDigest on raw objects diverges because extra keys are hashed",
  );

  // 3. canonicalVisualSetSlot projects strictly to the 8 authority keys
  const projected = canonicalVisualSetSlot(runtimeC);
  assert.deepEqual(Object.keys(projected).sort(), [
    "binaryDigest",
    "governanceDigest",
    "pageSlug",
    "resolutionMode",
    "resolvedVersionId",
    "role",
    "slot",
    "truthClass",
  ]);
  assert.deepEqual(projected, authorityA);
});

test("unit: visualSetDigest changes when any canonical authority field changes", () => {
  const base: CanonicalVisualSetSlot = {
    slot: "hero.primary",
    pageSlug: "home",
    role: "hero",
    resolvedVersionId: "asv-100",
    binaryDigest: "a".repeat(64),
    governanceDigest: "b".repeat(64),
    resolutionMode: "reuse_real",
    truthClass: "illustrative",
  };

  const baseDigest = visualSetDigest([base]);

  // binaryDigest change
  assert.notEqual(
    visualSetDigest([{ ...base, binaryDigest: "9".repeat(64) }]),
    baseDigest,
    "binaryDigest mutation must change digest",
  );

  // governanceDigest change
  assert.notEqual(
    visualSetDigest([{ ...base, governanceDigest: "8".repeat(64) }]),
    baseDigest,
    "governanceDigest mutation must change digest",
  );

  // resolvedVersionId change
  assert.notEqual(
    visualSetDigest([{ ...base, resolvedVersionId: "asv-999" }]),
    baseDigest,
    "resolvedVersionId mutation must change digest",
  );

  // slot change
  assert.notEqual(
    visualSetDigest([{ ...base, slot: "hero.secondary" }]),
    baseDigest,
    "slot mutation must change digest",
  );

  // role change
  assert.notEqual(
    visualSetDigest([{ ...base, role: "featured" }]),
    baseDigest,
    "role mutation must change digest",
  );

  // pageSlug change
  assert.notEqual(
    visualSetDigest([{ ...base, pageSlug: "about" }]),
    baseDigest,
    "pageSlug mutation must change digest",
  );

  // resolutionMode change
  assert.notEqual(
    visualSetDigest([{ ...base, resolutionMode: "ai_generate" }]),
    baseDigest,
    "resolutionMode mutation must change digest",
  );

  // truthClass change
  assert.notEqual(
    visualSetDigest([{ ...base, truthClass: "documentary" }]),
    baseDigest,
    "truthClass mutation must change digest",
  );
});

test("unit: visualSetDigest is order-stable across slot permutations", () => {
  const slot1: CanonicalVisualSetSlot = {
    slot: "a.slot",
    pageSlug: "home",
    role: "hero",
    resolvedVersionId: "asv-1",
    binaryDigest: "1".repeat(64),
    governanceDigest: "2".repeat(64),
    resolutionMode: "reuse_real",
    truthClass: "documentary",
  };
  const slot2: CanonicalVisualSetSlot = {
    slot: "b.slot",
    pageSlug: "home",
    role: "body",
    resolvedVersionId: "asv-2",
    binaryDigest: "3".repeat(64),
    governanceDigest: "4".repeat(64),
    resolutionMode: "ai_generate",
    truthClass: "illustrative",
  };

  assert.equal(
    visualSetDigest([slot1, slot2]),
    visualSetDigest([slot2, slot1]),
  );
});
