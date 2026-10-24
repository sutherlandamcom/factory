import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { runTrustQa } from "../../src/production/qa/trust.js";
import {
  claimLineageProblems,
  type ClaimLineage,
  type PageIntentAuthority,
  type ReviewAuthority,
} from "@factory/contracts";
import type { ProductionRenderManifest } from "../../src/production/render-manifest.js";
import { intakeSourceRef } from "../e2e01-industrial-attribution.test.js";

/**
 * E2E-P1-04 — industrial claim-attribution acceptance matrix
 * (persistence/trust-boundary layer).
 *
 * Pure lexical lineage scenarios live in
 * tests/e2e01-industrial-attribution.test.ts (unit batch, no database).
 *
 * All sentences concern TEST-ONLY FICTIONAL ENTITIES ("Vendor Ltd"
 * contractor, "Orbital Works" facility, "Funding Group" investor). No real
 * company, project or facility is asserted.
 */

const FACILITY_INVESTMENT_SOURCE =
  "Orbital Works received an investment of 500 million units from Funding Group in 2025.";

const CONTRACTOR_ENGINEERING_SOURCE =
  "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025.";

function claim(input: Partial<ClaimLineage> & Pick<ClaimLineage, "claimId" | "claimText" | "claimType">): ClaimLineage {
  return { sourceRefs: [], pageIdentity: "vendor/homepage", limitation: "", ...input } as ClaimLineage;
}

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

function manifestFor(pageIdentity: string, digest: string, sections: Array<{ heading: string; body: string }>, projectId: string): ProductionRenderManifest {
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

const ENGINEERED_SECTION = [
  {
    heading: "Engineering record",
    body: "Vendor Ltd performed the structural engineering review for Orbital Works building two in 2025. The review covered load paths and connections.",
  },
];

async function runTrustBoundary(opts: {
  trust: TrustGovernanceStore;
  projectId: string;
  sections: Array<{ heading: string; body: string }>;
  claims: ClaimLineage[];
  review?: Partial<ReviewAuthority> | null;
  contentDigest?: string;
}) {
  const dist = await mkdtemp(path.join(tmpdir(), "p104-"));
  try {
    const projectId = opts.projectId;
    const pageIdentity = "vendor/homepage";
    const digest = opts.contentDigest ?? "a".repeat(64);
    const trust = opts.trust;
    await trust.setPageIntentAuthority({ projectId, intent: intent(projectId, pageIdentity) });
    if (opts.claims.length > 0) {
      await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: opts.claims });
    }
    if (opts.review !== null) {
      await trust.recordReview({
        projectId,
        review: trustedReview({ reviewedContentDigest: digest, pageIdentity, projectId, ...opts.review }) as ReviewAuthority,
      });
    }
    await mkdir(path.join(dist, pageIdentity), { recursive: true });
    await writeFile(path.join(dist, pageIdentity, "index.html"), "<!doctype html><html><body><h1>record</h1></body></html>", "utf8");
    const report = await runTrustQa({
      manifests: [manifestFor(pageIdentity, digest, opts.sections, projectId)],
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
  }
}

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

test("P1-04 L3: supported role with exact source + test-only review passes trust seam but is NOT publication-eligible", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `p104-ok-${Math.random().toString(36).slice(2, 8)}`);
    const r = await runTrustBoundary({
      trust: new TrustGovernanceStore(dbInst.db),
      projectId,
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
    });
    // Exact source + lineage + review binding hold at the trust seam...
    assert.equal(r.claimLineage.verdict, "PASS", r.claimLineage.detail);
    assert.equal(r.sourceAuthority.verdict, "PASS", r.sourceAuthority.detail);
    // ...but a TEST_ONLY review authority never grants production
    // publication eligibility (strict production policy floor).
    assert.equal(r.reviewAuthority.verdict, "FAIL");
    assert.match(r.reviewAuthority.detail, /TEST_ONLY|test-only|review/i);
  } finally {
    await dbInst.close();
  }
});

test("P1-04 L3: changed accepted-content digest invalidates the review (stale); historical record stays readable", async () => {
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
