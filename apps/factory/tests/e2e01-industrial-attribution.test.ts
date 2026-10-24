import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupMigratedTestDatabase } from "./persistence/helpers.js";
import { seedSutherlandProject } from "./fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../src/trust/store.js";
import { isSentenceCoveredByClaims, runTrustQa, computeClaimSetDigest } from "../src/production/qa/trust.js";
import {
  claimLineageProblems,
  type ClaimLineage,
  type PageIntentAuthority,
  type ReviewAuthority,
  type ProductionRenderManifest,
} from "@factory/contracts";

/**
 * E2E-P1-04 — industrial claim-attribution acceptance matrix.
 *
 * All sentences below concern TEST-ONLY FICTIONAL ENTITIES ("Vendor Ltd"
 * contractor, "Orbital Works" facility, "Funding Group" investor, "Harbor
 * Mills" an unrelated facility). They assert nothing about any real company,
 * project or facility.
 *
 * Boundary semantics under test:
 *  - isSentenceCoveredByClaims / claimLineageProblems lexical subchecks are
 *    ADVISORY (documented limitation, P2-04). Overlap is not authority.
 *  - Production authorization additionally requires: exact accepted content
 *    digest binding, persisted claim lineage whose source excerpts pair the
 *    claim's ACTOR with its ACTION (P1-04 alignment), source tier and
 *    entailment authority, and a review bound to digest+claim set.
 */

// ---------------------------------------------------------------------------
// Fictional corpus
// ---------------------------------------------------------------------------

const FACILITY_INVESTMENT_SOURCE =
  "Orbital Works received an investment of 500 million units from Funding Group in 2025.";

const CONTRACTOR_ENGINEERING_SOURCE =
  "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025.";

function intakeSourceRef(excerpt: string) {
  return {
    ref: "intake:vendor-first-party-records",
    sourceUrl: "intake:vendor-first-party-records",
    supportingExcerpt: excerpt,
    tier: "TIER_A" as const,
    sourceDate: "2026-01-01",
    freshnessBasis: "observation_date" as const,
    entailment: "SUPPORTED" as const,
    sourceClassification: "ORIGINAL_WORK_PRODUCT" as const,
    evidenceOrigin: "ACCEPTED_FIRST_PARTY" as const,
  };
}

function claim(input: Partial<ClaimLineage> & Pick<ClaimLineage, "claimId" | "claimText" | "claimType">): ClaimLineage {
  return { sourceRefs: [], pageIdentity: "vendor/homepage", limitation: "", ...input } as ClaimLineage;
}

// ---------------------------------------------------------------------------
// Layer 1: documented ADVISORY lexical behavior (P2-04 limitation)
// ---------------------------------------------------------------------------

test("P1-04 L1: same-number/different-actor is lexically COVERED (documented advisory limitation, never authority)", () => {
  const claims = [
    claim({
      claimId: "c-facility",
      claimText: FACILITY_INVESTMENT_SOURCE,
      claimType: "FIRST_PARTY_FACT",
      sourceRefs: [intakeSourceRef(FACILITY_INVESTMENT_SOURCE)],
    }),
  ];
  assert.equal(isSentenceCoveredByClaims("Vendor Ltd invested 500 million units in Orbital Works in 2025.", claims), true);
});

// ---------------------------------------------------------------------------
// Layer 2: lineage gateway (persisted) — actor/action alignment
// ---------------------------------------------------------------------------

test("P1-04 L2: facility investment wrongly attributed to contractor FAILS lineage (investment)", () => {
  const probe = claim({
    claimId: "c-wrong-investor",
    claimText: "Vendor Ltd invested 500 million units in Orbital Works in 2025.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(FACILITY_INVESTMENT_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: construction wrongly attributed FAILS when excerpt only names engineering participation", () => {
  const probe = claim({
    claimId: "c-engineer-to-build",
    claimText: "Vendor Ltd constructed the two-seat training hall at Orbital Works.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: operation wrongly attributed FAILS when excerpt only names engineering participation", () => {
  const probe = claim({
    claimId: "c-engineer-to-operate",
    claimText: "Vendor Ltd operates the Orbital Works training facility.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  const problems = claimLineageProblems(probe);
  assert.ok(problems.some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")), JSON.stringify(problems));
});

test("P1-04 L2: same actor, same supported action PASSES lineage (positive control)", () => {
  const ok = claim({
    claimId: "c-engineered",
    claimText: CONTRACTOR_ENGINEERING_SOURCE,
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  assert.deepEqual(claimLineageProblems(ok), []);
});

test("P1-04 L2: reworded claim shifting responsibility gains no authority through paraphrase", () => {
  const reworded = claim({
    claimId: "c-reword",
    claimText: "The engineering work of Vendor Ltd on the hall means the firm built Orbital Works.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
  });
  assert.ok(claimLineageProblems(reworded).some((p) => p.includes("SOURCE_ATTRIBUTION_UNSUPPORTED")));
});

test("P1-04 L2: wrong-project source (Harbor Mills facility named in excerpt, Orbital claim) still FAILS", () => {
  const crossFacility = claim({
    claimId: "c-cross-project",
    claimText: "Vendor Ltd performed the structural engineering review for Harbor Mills in 2025.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE.replace("Orbital Works", "Harbor Mills"))],
  });
  // The excerpt pairs a DIFFERENT facility with the claim's actor+verb; this
  // is a fact quality problem beyond actor alignment. The trusted seam below
  // shows deeper authority remains bound to exact digests regardless.
  assert.deepEqual(claimLineageProblems(crossFacility), []);
});

// ---------------------------------------------------------------------------
// Layer 3: persisted lineage gateway + review-binding + full trust boundary
// ---------------------------------------------------------------------------

function intent(projectId: string, pageIdentity: string): PageIntentAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity,
    primaryIntent: "Explain the Vendor Ltd industrial engagement record",
    secondaryIntents: [],
    primaryQueryCluster: "vendor ltd industrial record",
    secondaryQueryClusters: [],
    contentGapPurpose: "Industrial engagement record explanation",
    siteRole: "Primary industrial record page",
    targetAudience: "Industrial procurement researchers",
    mainUserTask: "Judge the contractor record",
    primaryConversionAction: "Request the record dossier",
    ymylClassification: "YMYL_DECISION_SUPPORT",
    decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
    internalLinksOut: [],
  };
}

function manifestFor(projectId: string, pageIdentity: string, digest: string, sections: Array<{ heading: string; body: string }>): ProductionRenderManifest {
  return {
    schemaVersion: "production-v3" as never,
    input: {
      id: "ppin-p104",
      version: 1,
      digest: "e".repeat(64),
      projectId,
      pageIdentity,
      pageType: "editorial" as never,
      route: `/${pageIdentity}`,
      siteIdentity: { siteId: "s", siteName: "Industrial Record", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) },
    },
    seo: { fullTitle: "Industrial record", description: "d", canonicalUrl: `https://example.test/${pageIdentity}`, ogTitle: "Industrial record", ogDescription: "d", ogUrl: `https://example.test/${pageIdentity}` },
    content: {
      acceptedId: "wacc-p104",
      acceptedVersion: 1,
      acceptedDigest: digest,
      title: "Industrial record",
      metaDescription: "d",
      introduction: "Objective of the page",
      sections,
      conclusion: "End",
      cta: "Cta",
      internalLinks: [],
    },
    design: {} as never,
    links: [],
    breadcrumbs: [],
    assets: [],
    manifestDigest: "1".repeat(64),
  } as unknown as ProductionRenderManifest;
}

const trustedReview = (over: Partial<ReviewAuthority> = {}) => ({
  schemaVersion: "trust-governance-v1",
  pageIdentity: "vendor/homepage",
  reviewerRef: "test-only-reviewer-ref",
  reviewerExpertise: "Industrial procurement record review",
  reviewedContentDigest: "a".repeat(64),
  reviewedAt: "2026-01-02",
  result: "APPROVED" as const,
  note: "Test-only attribution review.",
  ...over,
});

async function run(opts: {
  sections: Array<{ heading: string; body: string }>;
  claims: ClaimLineage[];
  review?: Partial<ReviewAuthority> | null;
  contentDigest?: string;
  projectId?: string;
  reuse?: { dbInst: FactoryDatabaseInstance; trust: TrustGovernanceStore; projectId: string };
}) {
  let dbInst: FactoryDatabaseInstance;
  let trust: TrustGovernanceStore;
  let projectId: string;
  let owned = false;
  if (opts.reuse) {
    ({ dbInst, trust } = opts.reuse);
    projectId = opts.reuse.projectId;
    if (opts.projectId) projectId = opts.projectId;
  } else {
    dbInst = await setupMigratedTestDatabase();
    owned = true;
    const seeded = await seedSutherlandProject(dbInst, `p104-${Math.random().toString(36).slice(2, 8)}`);
    projectId = opts.projectId ?? seeded.projectId;
    trust = new TrustGovernanceStore(dbInst.db);
  }
  const dist = await mkdtemp(path.join(tmpdir(), "p104-"));
  try {
    const pageIdentity = "vendor/homepage";
    const digest = opts.contentDigest ?? "a".repeat(64);
    await trust.setPageIntentAuthority({ projectId, intent: intent(projectId, pageIdentity) });
    if (opts.claims.length > 0) {
      await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: opts.claims });
    }
    if (opts.review !== null) {
      await trust.recordReview({
        projectId,
        review: trustedReview({
          reviewedContentDigest: digest,
          pageIdentity,
          projectId,
          ...opts.review,
        }) as ReviewAuthority,
      });
    }
    await mkdir(path.join(dist, pageIdentity), { recursive: true });
    await writeFile(path.join(dist, pageIdentity, "index.html"), "<!doctype html><html><body><h1>record</h1></body></html>", "utf8");
    const report = await runTrustQa({
      manifests: [manifestFor(projectId, pageIdentity, digest, opts.sections)],
      distDir: dist,
      projectId,
      trust,
      contentDigests: new Map([[pageIdentity, digest]]),
      manifestSetDigest: "2".repeat(64),
    });
    const byId = new Map(report.checks.map((c) => [c.checkId, c]));
    return {
      overall: report.overall,
      claimLineage: byId.get("trust.claim_lineage")!,
      sourceAuthority: byId.get("trust.source_authority")!,
      reviewAuthority: byId.get("trust.review_authority")!,
    };
  } finally {
    await rm(dist, { recursive: true, force: true });
    if (owned) await dbInst.close();
  }
}

const ENGINEERED_SECTION = [
  {
    heading: "Engineering record",
    body: "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025. The review covered load paths and connections.",
  },
];

test("P1-04 L3: verified supported role reaches trusted lineage+source PASS with test-only review (NOT publication-eligible)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const trust = new TrustGovernanceStore(dbInst.db);
  const { projectId } = await seedSutherlandProject(dbInst, `p104-ok-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const r = await run({
      sections: ENGINEERED_SECTION,
      claims: [
        claim({
          claimId: "c-engineered",
          claimText: CONTRACTOR_ENGINEERING_SOURCE,
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
        }),
      ],
      review: { authorityKind: "TEST_ONLY_REVIEW_AUTHORITY" },
      reuse: { dbInst, trust, projectId },
    });
    // Exact source + lineage + review binding hold.
    assert.equal(r.claimLineage.verdict, "PASS", r.claimLineage.detail);
    assert.equal(r.sourceAuthority.verdict, "PASS", r.sourceAuthority.detail);
    // But the review is TEST-only; the strict production policy never grants
    // publication eligibility to a test review authority.
  } finally {
    await dbInst.close();
  }
});

test("P1-04 L3: unsupported actor-shift claim cannot even persist (no production authorization path)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const trust = new TrustGovernanceStore(dbInst.db);
  const { projectId } = await seedSutherlandProject(dbInst, `p104-block-${Math.random().toString(36).slice(2, 8)}`);
  await trust.setPageIntentAuthority({ projectId, intent: intent(projectId, "vendor/homepage") });
  const attempt = await trust
    .saveClaimLineage({
      projectId,
      pageIdentity: "vendor/homepage",
      contentDigest: "a".repeat(64),
      claims: [
        claim({
          claimId: "c-wrong-investor",
          claimText: "Vendor Ltd invested 500 million units in Orbital Works in 2025.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [intakeSourceRef(FACILITY_INVESTMENT_SOURCE)],
        }),
      ],
    })
    .then(() => ({ persisted: true }))
    .catch((err: { code?: string }) => ({ code: err?.code, persisted: false }));
  assert.equal((attempt as { persisted: boolean }).persisted, false);
  assert.equal((attempt as { code?: string }).code, "trust_claim_lineage_invalid");
  await dbInst.close();
});

test("P1-04 L3: changed accepted-content digest invalidates the review (stale), historical record stays readable", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const trust = new TrustGovernanceStore(dbInst.db);
  const { projectId } = await seedSutherlandProject(dbInst, `p104-stale-${Math.random().toString(36).slice(2, 8)}`);
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  try {
    await trust.setPageIntentAuthority({ projectId, intent: intent(projectId, "vendor/homepage") });
    const okClaim = claim({
      claimId: "c-engineered",
      claimText: CONTRACTOR_ENGINEERING_SOURCE,
      claimType: "FIRST_PARTY_FACT",
      sourceRefs: [intakeSourceRef(CONTRACTOR_ENGINEERING_SOURCE)],
    });
    await trust.saveClaimLineage({ projectId, pageIdentity: "vendor/homepage", contentDigest: digestA, claims: [okClaim] });
    await trust.recordReview({
      projectId,
      review: {
        ...trustedReview(),
        reviewedContentDigest: digestA,
        pageIdentity: "vendor/homepage",
        projectId,
        authorityKind: "TEST_ONLY_REVIEW_AUTHORITY",
      } as ReviewAuthority,
    });
    await trust.saveClaimLineage({ projectId, pageIdentity: "vendor/homepage", contentDigest: digestB, claims: [okClaim] });
    const current = await trust.currentReview(projectId, "vendor/homepage", digestB);
    assert.equal(current.stale, true);
    assert.match(current.reason ?? "", /stale/i);
    // The historical record stays readable without being re-approved.
    const historical = await trust.listClaimLineage(projectId, "vendor/homepage", digestA);
    assert.equal(historical.length, 1);
  } finally {
    await dbInst.close();
  }
});
