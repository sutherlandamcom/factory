import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProductionCandidateRecord,
  ProductionCandidateInputRecord,
  ProductionQaRunRecord,
} from "../src/persistence/schema.js";
import { assertCandidateReleaseQaProof, type CandidateReleaseProof } from "../src/delivery/release-preflight.js";

const digest = (s: string) => s.repeat(64);
function proof(): CandidateReleaseProof {
  const candidate = {
    id: "pcand-a", projectId: "project-a", productionInputId: "input-a",
    productionInputVersion: 1, productionInputDigest: digest("a"),
    pageIdentity: "home", route: "/home", canonicalUrl: "https://example.test/home",
    state: "qa_passed", artifactDigest: digest("b"), artifactRef: "/immutable/dist",
    manifestSetDigest: digest("c"), redirectSnapshotDigest: digest("d"),
    siteProfileDigest: digest("e"), rendererVersion: "7.0.0",
    repositorySha: "a".repeat(40), lockfileDigest: digest("f"),
    assetReferences: [], createdAt: new Date(),
  } as unknown as ProductionCandidateRecord;
  const latestQa = {
    id: "pqa-a", projectId: "project-a", candidateId: "pcand-a",
    candidateArtifactDigest: candidate.artifactDigest, overall: "PASS",
    createdAt: new Date(), data: {
      schemaVersion: "production-v1", candidateId: "pcand-a", overall: "PASS",
      checks: [],
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  } as ProductionQaRunRecord;
  const bind = {
    projectId: "project-a", candidateId: "pcand-a", productionInputId: "input-a",
    productionInputVersion: 1, productionInputDigest: digest("a"),
    pageIdentity: "home", route: "/home", manifestDigest: digest("c"),
  } as ProductionCandidateInputRecord;
  return {
    projectId: "project-a", candidate, latestQa,
    candidateInputs: [bind], currentPageInputIds: ["input-a"],
    canonicalOrigin: "https://example.test",
    buildIdentity: {
      repositorySha: "a".repeat(40), lockfileDigest: digest("f"),
      rendererVersion: "7.0.0", siteIdentity: { profileDigest: digest("e") },
    },
  };
}

test("exact candidate with strict production QA proof passes structural release preflight", () => {
  assert.doesNotThrow(() => assertCandidateReleaseQaProof(proof()));
});

test("QA and candidate must be same project, identity, and artifact", () => {
  const a = proof();
  assert.throws(() => assertCandidateReleaseQaProof({ ...a, projectId: "project-b" }), /another project/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, latestQa: { ...a.latestQa!, candidateArtifactDigest: digest("9") },
  }), /publication-eligible QA/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, latestQa: { ...a.latestQa!, candidateId: "other" },
  }), /publication-eligible QA/);
});

test("synthetic or missing review provenance is never publication eligible", () => {
  const a = proof();
  for (const provenance of [
    { trustMode: "SYNTHETIC_FIXTURE", publicationEligible: true, reviewAuthorityMode: "VERIFIED_HUMAN" },
    { trustMode: "STRICT_PRODUCTION", publicationEligible: true, reviewAuthorityMode: "TEST_ONLY" },
    { trustMode: "STRICT_PRODUCTION", publicationEligible: false, reviewAuthorityMode: "VERIFIED_HUMAN" },
    undefined,
  ]) {
    const data = { ...(a.latestQa!.data as Record<string, unknown>), provenance };
    assert.throws(() => assertCandidateReleaseQaProof({
      ...a, latestQa: { ...a.latestQa!, data },
    }), /publication-eligible QA/);
  }
});

test("stale build identities, failed QA, and unverified candidates cannot release", () => {
  const a = proof();
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, buildIdentity: { ...a.buildIdentity, lockfileDigest: digest("0") },
  }), /Lockfile digest changed/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, candidate: { ...a.candidate, state: "qa_failed" },
  }), /QA-passed build/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, latestQa: { ...a.latestQa!, overall: "FAIL" },
  }), /publication-eligible QA/);
});

test("site set is exact: missing, duplicated, or foreign project input blocks release", () => {
  const a = proof();
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, currentPageInputIds: ["input-a", "input-b"],
  }), /current site input/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, candidateInputs: [...a.candidateInputs, a.candidateInputs[0]!],
    currentPageInputIds: ["input-a", "input-a"],
  }), /current site input/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, candidateInputs: [{ ...a.candidateInputs[0]!, projectId: "foreign" }],
  }), /another project/);
});

test("wrong production canonical domain blocks release", () => {
  const a = proof();
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, canonicalOrigin: "https://attacker.example",
  }), /canonical origin/);
  assert.throws(() => assertCandidateReleaseQaProof({
    ...a, canonicalOrigin: "http://example.test",
  }), /canonical origin/);
});
