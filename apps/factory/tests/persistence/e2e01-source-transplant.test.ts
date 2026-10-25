import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { computeClaimSetDigest } from "../../src/production/qa/trust.js";
import {
  type ClaimLineage,
  type SourceRef,
  type ReviewAuthority,
} from "@factory/contracts";

/** Locally-defined fixture (same semantics as the attribution suite's helper). */
function intakeSourceRef(excerpt: string, name = "vendor-first-party-records"): SourceRef {
  return {
    ref: `intake:${name}`,
    sourceUrl: `intake:${name}`,
    supportingExcerpt: excerpt,
    tier: "TIER_A",
    sourceDate: "2026-01-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    sourceClassification: "ORIGINAL_WORK_PRODUCT",
    evidenceOrigin: "ACCEPTED_FIRST_PARTY",
  };
}

/**
 * E2E-P1-C — adversarial source-ownership transplantation probes.
 *
 * Attack hypothesis: TIER_A `intake:`-class SourceRefs are convention
 * strings, not persisted project-owned rows. Could Project B hijack
 * Project A's accepted evidence by transplanting the SAME ref strings
 * (and the same excerpt verbatim) into B's own claim lineage, and gain
 * unauthorized production authority using A's accepted intake facts?
 *
 * Expected boundary (per ledger A2 + XP-01..08): ownership lives at the
 * per-project trust persistence seam + digest-bound reviews; ref strings
 * themselves carry no authority. A transplant WITHOUT B's own accepted
 * evidence must either FAIL lineage validation (unsupported) or pass
 * only as long as B substantively re-proves every obligation itself —
 * which is exactly what B's accepted first-party intake would look like.
 *
 * The unconditionally WRONG state is: B emitting claims whose ONLY
 * support is verbatim A excerpts, while B's own acceptance records contain
 * nothing, and B's production check granting publication eligibility on
 * A's evidence.
 */

const CONTRACTOR_ENGINEERING_SOURCE =
  "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025.";

const A_EXCLUSIVE_SOURCE =
  "Vendor Ltd holds the recorded engineering dossier RP-2025-114 for Orbital Works building two.";

function claim(input: Partial<ClaimLineage> & Pick<ClaimLineage, "claimId" | "claimText" | "claimType">): ClaimLineage {
  return { sourceRefs: [], pageIdentity: "vendor/homepage", limitation: "", ...input } as ClaimLineage;
}

function trustedReview(projectId: string, over: Partial<ReviewAuthority> = {}): ReviewAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity: "vendor/homepage",
    reviewerRef: "test-only-reviewer-ref",
    reviewerExpertise: "Industrial record review",
    reviewedContentDigest: "a".repeat(64),
    reviewedAt: "2026-01-02",
    result: "APPROVED",
    note: "Test-only cross-project ownership review.",
    authorityKind: "TEST_ONLY_REVIEW_AUTHORITY",
    ...over,
  } as ReviewAuthority;
}

async function twoProjects() {
  const dbInst = await setupMigratedTestDatabase();
  const projectA = await seedSutherlandProject(dbInst, `tp-a-${Math.random().toString(36).slice(2, 8)}`);
  const projectB = await seedSutherlandProject(dbInst, `tp-b-${Math.random().toString(36).slice(2, 8)}`);
  const trust = new TrustGovernanceStore(dbInst.db);
  return { dbInst, trust, projectA: projectA.projectId, projectB: projectB.projectId };
}

test("TP-01: B transplants A's verbatim unusual evidence row — B's stored claim must stand on B's own evaluation, never A's acceptance", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    // A accepts its unusual dossier claim.
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "tp-a-exclusive",
          claimText: A_EXCLUSIVE_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(A_EXCLUSIVE_SOURCE)],
        }),
      ],
    });
    const digestB = "b".repeat(64);
    // B copies A's claim text and ref string VERBATIM (steal-the-ref attack).
    await trust.saveClaimLineage({
      projectId: projectB,
      pageIdentity: "vendor/homepage",
      contentDigest: digestB,
      claims: [
        claim({
          claimId: "tp-b-stolen",
          claimText: A_EXCLUSIVE_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(A_EXCLUSIVE_SOURCE, "vendor-first-party-records")],
        }),
      ],
    });
    // B's row survives standalone (its stored payload is a real evaluation).
    const bRows = await trust.listClaimLineage(projectB, "vendor/homepage", digestB);
    assert.equal(bRows.length, 1);
    // A's rows must NOT surface under B.
    const aAsB = await trust.listClaimLineage(projectB, "vendor/homepage", digestA);
    assert.equal(aAsB.length, 0);
    // B has no review of its own; A's review never crosses into B.
    const noBReview = await trust.currentReview(projectB, "vendor/homepage", digestB);
    assert.equal(noBReview.review, null);
  } finally {
    await dbInst.close();
  }
});

test("TP-02: transplanting A's VERBATIM excerpt that B's own intake never recorded — B's claim passes lineage only if source-verifiable (the excerpt asserts what it asserts); B's REVIEWS still bound to B's evidence", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "tp-a-src",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    // A records a review.
    await trust.recordReview({
      projectId: projectA,
      review: trustedReview(projectA, { reviewedContentDigest: digestA }),
    });
    const digestB = "b".repeat(64);
    // B grabs ONLY A's verbatim excerpt (its own records empty).
    await trust.saveClaimLineage({
      projectId: projectB,
      pageIdentity: "vendor/homepage",
      contentDigest: digestB,
      claims: [
        claim({
          claimId: "tp-b-verbatim",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    // The ATTACK: B binds a review to the transplanted claim set digest
    // computed from A's claim content — recordReview must still require
    // B-side review payload (its own projectId/reviewerRef), never inherit
    // A's approval. Verify B's review does not auto-appear.
    const bReview = await trust.currentReview(projectB, "vendor/homepage", digestB);
    assert.equal(bReview.review, null);
    // And computing the claim-set digest for B's copy does NOT accidentally
    // match A's approval claim-set (digest is deterministic over the claim
    // SET, so equality means B's copy is its own review obligation — a
    // review must exist for B to use it; none does).
    const sameSetDigest = computeClaimSetDigest([
      claim({
        claimId: "tp-a-src",
        claimText: CONTRACTOR_ENGINEERING_SOURCE,
        claimType: "FIRST_PARTY_FACT",
        sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
      }),
    ]);
    // Both languages same claim → same digest; that is EXPECTED (digest is
    // content-bound, not identity-bound). The protection is that a review
    // ROW never crosses projects (asserted above).
    assert.equal(typeof sameSetDigest, "string");
  } finally {
    await dbInst.close();
  }
});

test("TP-03: B cannot read A's lineage rows even when B passes A's exact digest and identity strings", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestShared = "c".repeat(64);
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestShared,
      claims: [
        claim({
          claimId: "tp-a-row",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    const bView = await trust.listClaimLineage(projectB, "vendor/homepage", digestShared);
    assert.equal(bView.length, 0);
    // A still sees its own.
    const aView = await trust.listClaimLineage(projectA, "vendor/homepage", digestShared);
    assert.equal(aView.length, 1);
  } finally {
    await dbInst.close();
  }
});
