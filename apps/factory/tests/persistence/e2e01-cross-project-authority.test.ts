import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { computeClaimSetDigest } from "../../src/production/qa/trust.js";
import {
  type ClaimLineage,
  type ReviewAuthority,
} from "@factory/contracts";
import { intakeSourceRef } from "../e2e01-industrial-attribution.test.js";

/**
 * E2E-P1-04b — GENUINE cross-project source/authority ownership matrix
 * (two separate projects on a real migrated factory_test database).
 *
 * These are the XP-01..XP-08 acceptance cases: each scenario executes at the
 * ACTUAL Factory boundary (TrustGovernanceStore persistence + review
 * staleness + per-project scoping). All entities are fictional — two
 * industrial projects of different kinds, matching the pure-layer matrix.
 *
 * IMPORTANT honest summary this suite documents:
 *  - intake-class SourceRefs are convention strings, NOT persisted
 *    project-owned records; Factory's project ownership boundary lives at
 *    the trust-persistence seam (ClaimLineage rows, reviews, intents are
 *    project-scoped rows) and at digest-bound review staleness.
 *  - Project B can NEVER read Project A's persisted claim lineage rows as
 *    its own authority; A's review does not apply to B; and B must build
 *    its own accepted evidence under its own project id.
 */

const CONTRACTOR_ENGINEERING_SOURCE =
  "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025.";

const INVESTOR_INVESTMENT_SOURCE =
  "Investment Group funded 300 units of the Meridian Plant works program in 2026.";

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
  const projectA = await seedSutherlandProject(dbInst, `xp-a-${Math.random().toString(36).slice(2, 8)}`);
  const projectB = await seedSutherlandProject(dbInst, `xp-b-${Math.random().toString(36).slice(2, 8)}`);
  const trust = new TrustGovernanceStore(dbInst.db);
  return { dbInst, trust, projectA: projectA.projectId, projectB: projectB.projectId };
}

test("XP-01: correct Project A evidence flows inside A (positive control)", async () => {
  const { dbInst, trust, projectA } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    await trust.setPageIntentAuthority({
      projectId: projectA,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: projectA,
        pageIdentity: "vendor/homepage",
        primaryIntent: "Explain the contractor record",
        secondaryIntents: [],
        primaryQueryCluster: "contractor record",
        secondaryQueryClusters: [],
        contentGapPurpose: "Record explanation",
        siteRole: "Primary record page",
        targetAudience: "Researchers",
        mainUserTask: "Judge record",
        primaryConversionAction: "Request dossier",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });
    const rows = await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "xp-a-ok",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    assert.equal(rows.length, 1);
    const readBack = await trust.listClaimLineage(projectA, "vendor/homepage", digestA);
    assert.equal(readBack.length, 1);
  } finally {
    await dbInst.close();
  }
});

test("XP-02: Project A lineage rows are NOT readable/usable as Project B authority (per-project scoping)", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "xp-a-row",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    // Project B requesting A's rows under B's own project id: empty.
    const bView = await trust.listClaimLineage(projectB, "vendor/homepage", digestA);
    assert.equal(bView.length, 0);
  } finally {
    await dbInst.close();
  }
});

test("XP-03: Project A review bound to A's digest does not authorize B with same claim text (no cross-project review inheritance)", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    await trust.setPageIntentAuthority({
      projectId: projectA,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: projectA,
        pageIdentity: "vendor/homepage",
        primaryIntent: "Contractor record",
        secondaryIntents: [],
        primaryQueryCluster: "contractor record",
        secondaryQueryClusters: [],
        contentGapPurpose: "Record",
        siteRole: "Primary",
        targetAudience: "Researchers",
        mainUserTask: "Judge",
        primaryConversionAction: "Request dossier",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "xp-a-review-src",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    await trust.recordReview({ projectId: projectA, review: trustedReview(projectA, { reviewedContentDigest: digestA }) });
    // B creates the SAME claim text under B's project with its own digest.
    await trust.setPageIntentAuthority({
      projectId: projectB,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: projectB,
        pageIdentity: "vendor/homepage",
        primaryIntent: "Contractor record (B copy)",
        secondaryIntents: [],
        primaryQueryCluster: "contractor record b",
        secondaryQueryClusters: [],
        contentGapPurpose: "Record b",
        siteRole: "Primary b",
        targetAudience: "Researchers",
        mainUserTask: "Judge b",
        primaryConversionAction: "Request dossier b",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });
    await trust.saveClaimLineage({
      projectId: projectB,
      pageIdentity: "vendor/homepage",
      contentDigest: digestB,
      claims: [
        claim({
          claimId: "xp-b-copied",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    // B has NO review of its own; A's review must not surface for B.
    const bReview = await trust.currentReview(projectB, "vendor/homepage", digestB);
    assert.equal(bReview.review, null);
    // A's review remains valid for A (unchanged).
    const aReview = await trust.currentReview(
      projectA,
      "vendor/homepage",
      digestA,
      computeClaimSetDigest([
        claim({
          claimId: "xp-a-review-src",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ]),
    );
    assert.equal(aReview.review?.result, "APPROVED");
  } finally {
    await dbInst.close();
  }
});

test("XP-05: copied claim text under B does NOT inherit A's accepted evidence rows (copies are evaluated under B's own authority only)", async () => {
  const { dbInst, trust, projectA, projectB } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    await trust.saveClaimLineage({
      projectId: projectA,
      pageIdentity: "vendor/homepage",
      contentDigest: digestA,
      claims: [
        claim({
          claimId: "xp-a-src",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    await trust.saveClaimLineage({
      projectId: projectB,
      pageIdentity: "vendor/homepage",
      contentDigest: digestB,
      claims: [
        claim({
          claimId: "xp-b-copy",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
    });
    // B's copy is persisted ONLY in B's project scope (its own claimId row);
    // A's rows are neither merged nor deduped into B.
    const aRows = await trust.listClaimLineage(projectA, "vendor/homepage", digestA);
    const bRows = await trust.listClaimLineage(projectB, "vendor/homepage", digestB);
    assert.equal(aRows.length, 1);
    assert.equal(bRows.length, 1);
    assert.equal((aRows[0] as { claimId: string }).claimId, "xp-a-src");
    assert.equal((bRows[0] as { claimId: string }).claimId, "xp-b-copy");
  } finally {
    await dbInst.close();
  }
});

test("XP-06: changed accepted-content digest of A invalidates A review; B authority was never coupled (XP-08 positive control follows)", async () => {
  const { dbInst, trust, projectA } = await twoProjects();
  try {
    const digestA = "a".repeat(64);
    const digestA2 = "c".repeat(64);
    await trust.setPageIntentAuthority({
      projectId: projectA,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: projectA,
        pageIdentity: "vendor/homepage",
        primaryIntent: "Contractor record",
        secondaryIntents: [],
        primaryQueryCluster: "contractor record",
        secondaryQueryClusters: [],
        contentGapPurpose: "Record",
        siteRole: "Primary",
        targetAudience: "Researchers",
        mainUserTask: "Judge",
        primaryConversionAction: "Request dossier",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });
    const srcClaim = claim({
      claimId: "xp-a-src",
      claimText: CONTRACTOR_ENGINEERING_SOURCE,
      claimType: "FIRST_PARTY_FACT",
      sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
    });
    await trust.saveClaimLineage({ projectId: projectA, pageIdentity: "vendor/homepage", contentDigest: digestA, claims: [srcClaim] });
    await trust.recordReview({ projectId: projectA, review: trustedReview(projectA, { reviewedContentDigest: digestA }) });
    await trust.saveClaimLineage({ projectId: projectA, pageIdentity: "vendor/homepage", contentDigest: digestA2, claims: [srcClaim] });
    const stale = await trust.currentReview(projectA, "vendor/homepage", digestA2);
    assert.equal(stale.stale, true);
    // XP-07: the historical A record under digestA stays readable, not newly approved.
    const historical = await trust.listClaimLineage(projectA, "vendor/homepage", digestA);
    assert.equal(historical.length, 1);
  } finally {
    await dbInst.close();
  }
});

test("XP-08: independently accepted Project B evidence (its own lineage + own review bound under B) is valid inside B", async () => {
  const { dbInst, trust, projectB } = await twoProjects();
  try {
    const digestB = "b".repeat(64);
    await trust.setPageIntentAuthority({
      projectId: projectB,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: projectB,
        pageIdentity: "vendor/homepage",
        primaryIntent: "Investor record",
        secondaryIntents: [],
        primaryQueryCluster: "investor record",
        secondaryQueryClusters: [],
        contentGapPurpose: "Investor record",
        siteRole: "Primary investor page",
        targetAudience: "Analysts",
        mainUserTask: "Judge investment",
        primaryConversionAction: "Request program dossier",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
        internalLinksOut: [],
      },
    });
    await trust.saveClaimLineage({
      projectId: projectB,
      pageIdentity: "vendor/homepage",
      contentDigest: digestB,
      claims: [
        claim({
          claimId: "xp-b-own",
          claimText: INVESTOR_INVESTMENT_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(INVESTOR_INVESTMENT_SOURCE)],
        }),
      ],
    });
    await trust.recordReview({ projectId: projectB, review: trustedReview(projectB, { reviewedContentDigest: digestB }) });
    const bReview = await trust.currentReview(
      projectB,
      "vendor/homepage",
      digestB,
      computeClaimSetDigest([
        claim({
          claimId: "xp-b-own",
          claimText: INVESTOR_INVESTMENT_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(INVESTOR_INVESTMENT_SOURCE)],
        }),
      ]),
    );
    assert.equal(bReview.review?.result, "APPROVED");
    assert.equal(bReview.stale, false);
  } finally {
    await dbInst.close();
  }
});
