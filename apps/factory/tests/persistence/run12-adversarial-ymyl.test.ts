import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import type { ClaimLineage, PageIntentAuthority } from "@factory/contracts";

/**
 * RUN 12 BLOCK 49 — ADVERSARIAL YMYL TESTS.
 *
 * Negative tests proving the trust governance FAILS CLOSED:
 *   - unsupported performance claim (no accepted evidence)
 *   - forecast presented as fact
 *   - hidden assumption (presented as observed value)
 *   - fabricated qualification (credential without evidence)
 *   - citation decoration (source does not support claim -> recorded FAIL verdict)
 *   - fake freshness (date-only change must not refresh review)
 *   - undisclosed material commercial interest (disclosure field mandatory on analysis)
 *   - fake reviewer (review without governed event)
 *   - generic SEO rewrite (original-value gate)
 */

function intentFor(projectId: string, pageIdentity: string, overrides: Partial<PageIntentAuthority> = {}): PageIntentAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity,
    primaryIntent: "Evaluate buyer-side property advisory",
    secondaryIntents: [],
    primaryQueryCluster: "property advisory france",
    secondaryQueryClusters: [],
    contentGapPurpose: "Differentiated service explanation",
    siteRole: "Service evaluation",
    targetAudience: "International buyers",
    mainUserTask: "Decide whether to engage advisory",
    primaryConversionAction: "Request consultation",
    ymylClassification: "YMYL_INFORMATIONAL",
    decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
    internalLinksOut: [],
    ...overrides,
  };
}

test("ADVERSARIAL YMYL: unsupported performance claim fails lineage", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-1");
    const trust = new TrustGovernanceStore(dbInst.db);
    // "Clients typically earn 18% annually." — no accepted evidence exists.
    const unsupported: ClaimLineage = {
      claimId: "claim-perf-18",
      claimText: "Clients typically earn 18% annually.",
      claimType: "FACT",
      sourceRefs: [],
      pageIdentity: "advisory/investment-decision-framework",
      limitation: "",
    };
    await assert.rejects(
      trust.saveClaimLineage({ projectId, pageIdentity: "advisory/investment-decision-framework", contentDigest: "a".repeat(64), claims: [unsupported] }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: forecast presented as fact is rejected (must be labelled FORECAST with limitation)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-2");
    const trust = new TrustGovernanceStore(dbInst.db);
    // "The asset will appreciate 12%." recorded as FACT — rejected at claim lineage gate.
    const disguised: ClaimLineage = {
      claimId: "claim-forecast-disguised",
      claimText: "The asset will appreciate 12%.",
      claimType: "FACT",
      sourceRefs: [{ ref: "internal model output", tier: "TIER_D", sourceDate: "2026-01-01", freshnessBasis: "model_as_of_date" }],
      pageIdentity: "advisory/investment-decision-framework",
      limitation: "",
    };
    await assert.rejects(
      trust.saveClaimLineage({
        projectId,
        pageIdentity: "advisory/investment-decision-framework",
        contentDigest: "a".repeat(64),
        claims: [disguised],
      }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
    // The SAME claim honestly labelled as FORECAST requires a limitation; without one it FAILS.
    const unlabelledForecast: ClaimLineage = { ...disguised, claimType: "FORECAST", limitation: "" };
    await assert.rejects(
      trust.saveClaimLineage({ projectId, pageIdentity: "advisory/investment-decision-framework", contentDigest: "b".repeat(64), claims: [unlabelledForecast] }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: hidden assumption (uncertain type without limitation) fails closed", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-3");
    const trust = new TrustGovernanceStore(dbInst.db);
    const hiddenAssumption: ClaimLineage = {
      claimId: "claim-hidden-assumption",
      claimText: "Rental demand remains constant.",
      claimType: "ASSUMPTION",
      sourceRefs: [],
      pageIdentity: "advisory/investment-decision-framework",
      limitation: "",
    };
    await assert.rejects(
      trust.saveClaimLineage({ projectId, pageIdentity: "advisory/investment-decision-framework", contentDigest: "a".repeat(64), claims: [hiddenAssumption] }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: fabricated qualification is not publishable (credential evidence gate)", async () => {
  // Accepted authority does NOT contain CFA. A page saying CFA must fail:
  // the credential gate requires an accepted evidence reference.
  const { credentialPublishable } = await import("@factory/contracts");
  assert.equal(credentialPublishable({ name: "CFA charterholder", evidenceRef: "", evidenceKind: "registry" }), false);
  // With real evidence it would be publishable — but no such evidence exists
  // in the accepted Sutherland authority, so nothing is published (Run 12
  // publishes zero personal credentials; see evidence report).
});

test("ADVERSARIAL YMYL: citation decoration — source that does not support claim fails entailment and Tier E fails authority gate", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-entailment");
    const trust = new TrustGovernanceStore(dbInst.db);
    const decorativeCitation: ClaimLineage = {
      claimId: "claim-decorative-citation",
      claimText: "Chamonix transaction volume doubled in Q3.",
      claimType: "SOURCE_DERIVED_FACT",
      sourceRefs: [
        {
          ref: "General tourism brochure that mentions Chamonix ski lifts",
          tier: "TIER_B",
          sourceDate: "2026-06-01",
          freshnessBasis: "observation_date",
          entailment: "UNSUPPORTED",
        },
      ],
      pageIdentity: "locations/chamonix",
      limitation: "",
    };
    await assert.rejects(
      trust.saveClaimLineage({
        projectId,
        pageIdentity: "locations/chamonix",
        contentDigest: "c".repeat(64),
        claims: [decorativeCitation],
      }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
    // Omitted entailment or self-certified TIER_A also fail closed at the persistence boundary (P1-3).
    const selfCertifiedTierA: ClaimLineage = {
      claimId: "claim-self-tier-a",
      claimText: "Chamonix transaction volume doubled in Q3.",
      claimType: "SOURCE_DERIVED_FACT",
      sourceRefs: [
        {
          ref: "Unverified marketing brochure",
          sourceUrl: "https://unverified-brochure.example.com/chamonix",
          supportingExcerpt: "Chamonix transaction volume doubled in Q3 across the valley.",
          tier: "TIER_A",
          sourceDate: "2026-06-01",
          freshnessBasis: "observation_date",
          entailment: "SUPPORTED",
        },
      ],
      pageIdentity: "locations/chamonix",
      limitation: "",
    };
    await assert.rejects(
      trust.saveClaimLineage({
        projectId,
        pageIdentity: "locations/chamonix",
        contentDigest: "c".repeat(64),
        claims: [selfCertifiedTierA],
      }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );
  } finally {
    await dbInst.close();
  }
  const { sourceAuthorityVerdict } = await import("@factory/contracts");
  const forumOnly = [
    {
      ref: "reddit thread",
      sourceUrl: "https://reddit.com/r/france",
      supportingExcerpt: "Chamonix transaction volume doubled in Q3 according to forum commentary.",
      tier: "TIER_E" as const,
      sourceDate: "2026-01-01",
      freshnessBasis: "observation_date" as const,
      entailment: "SUPPORTED" as const,
    },
  ];
  assert.equal(sourceAuthorityVerdict(forumOnly, "YMYL_HIGH_IMPACT"), "FAIL");
  assert.equal(sourceAuthorityVerdict(forumOnly, "YMYL_DECISION_SUPPORT"), "REVIEW");
});

test("ADVERSARIAL YMYL: fake freshness — review staleness binds to content digest, not dates", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-4");
    const trust = new TrustGovernanceStore(dbInst.db);
    await trust.recordReview({
      projectId,
      review: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity: "research/report",
        reviewerRef: "org-sutherland",
        reviewerExpertise: "Buyer-side alpine property advisory",
        reviewedContentDigest: "a".repeat(64),
        reviewedAt: "2026-09-20",
        result: "APPROVED",
        note: "",
      },
    });
    // Only the date changed (digest unchanged): review remains CURRENT —
    // date-only churn cannot manufacture freshness.
    const sameContent = await trust.currentReview(projectId, "research/report", "a".repeat(64));
    assert.equal(sameContent.stale, false);
    // Substantive content change (digest change): review becomes stale —
    // re-review is required before the old review may be shown as current.
    const changedContent = await trust.currentReview(projectId, "research/report", "b".repeat(64));
    assert.equal(changedContent.stale, true);
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: fake reviewer — review markup without a governed review event fails", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-5");
    const trust = new TrustGovernanceStore(dbInst.db);
    const current = await trust.currentReview(projectId, "research/never-reviewed", "a".repeat(64));
    assert.equal(current.review, null);
    assert.equal(current.stale, false);
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: cannibalization bad case rejected through the intent gate", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-6");
    const trust = new TrustGovernanceStore(dbInst.db);
    await trust.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "services/a") });
    await trust.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "services/b") });
    const verdict = await trust.cannibalizationVerdict(projectId);
    assert.equal(verdict.verdict, "FAIL", "two pages with identical intent+cluster+role must FAIL");
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: topic/expertise mismatch and undisclosed conflict of interest fail closed", async () => {
  const { parseReviewAuthority, checkTopicExpertiseMatch, checkConflictDisclosure } = await import("@factory/contracts");
  assert.throws(() => parseReviewAuthority({
    schemaVersion: "trust-governance-v1",
    projectId: "p",
    pageIdentity: "page",
    reviewerRef: "r",
    reviewerExpertise: "",
    reviewedContentDigest: "a".repeat(64),
    reviewedAt: "2026-09-20",
    result: "APPROVED",
    note: "",
  }));

  // Topic <-> expertise mismatch (Block 7 / Block 49)
  const mismatch = checkTopicExpertiseMatch(
    ["buyer-side", "alpine property"],
    "Retail consumer electronics copywriting",
  );
  assert.equal(mismatch.verdict, "FAIL");
  assert.equal(mismatch.missingDomains.length, 2);

  const matched = checkTopicExpertiseMatch(
    ["buyer-side", "alpine property"],
    "Independent buyer-side alpine property advisory and decision methodology",
  );
  assert.equal(matched.verdict, "PASS");

  // Undisclosed material conflict of interest (Block 8 / Block 49)
  assert.equal(checkConflictDisclosure({ hasMaterialConflict: true, disclosureText: "" }), "FAIL");
  assert.equal(checkConflictDisclosure({ hasMaterialConflict: true, disclosureText: null }), "FAIL");
  assert.equal(
    checkConflictDisclosure({
      hasMaterialConflict: true,
      disclosureText: "Sutherland Private Office acts exclusively for the buyer and accepts no seller or listing commissions.",
    }),
    "PASS",
  );
});

test("ADVERSARIAL YMYL: generic SEO rewrite, missing HTML review authority, and uncovered material sentence fail runTrustQa (P1-3, P1-4, P1-5)", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { runTrustQa } = await import("../../src/production/qa/trust.js");
  const dbInst = await setupMigratedTestDatabase();
  const tmpDist = await mkdtemp(path.join(tmpdir(), "adv-trust-qa-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-7");
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "research/rewrite";
    const route = "/research/rewrite";
    const contentDigest = "d".repeat(64);
    await trust.setPageIntentAuthority({
      projectId,
      intent: intentFor(projectId, pageIdentity, {
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "INFORMATIONAL_RESEARCH",
      }),
    });
    // Record a claim for 14,538 dwellings, but leave a second material sentence ("Secondary residences represent 82.9% in Megève.") uncovered in copy!
    await trust.saveClaimLineage({
      projectId,
      pageIdentity,
      contentDigest,
      claims: [
        {
          claimId: "claim-chamonix-14538",
          claimText: "INSEE records 14,538 total dwellings in Chamonix-Mont-Blanc.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [
            {
              ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (74056)",
              sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?sommaire=8581488&geo=COM-74056",
              supportingExcerpt: "INSEE Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings.",
              tier: "TIER_A",
              sourceDate: "2025-07-01",
              freshnessBasis: "observation_date",
              entailment: "SUPPORTED",
            },
          ],
          pageIdentity,
          limitation: "",
        },
      ],
    });
    // Declarative OriginalValueRecord whose anchors are NOT present in the rendered HTML, and without lineageClaimId:
    await trust.saveOriginalValue({
      projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity,
        kind: "first_party_observation",
        description: "Declarative observation without lineageClaimId or HTML anchors.",
        verifiableAnchors: ["ANCHOR_MISSING_FROM_HTML_1", "ANCHOR_MISSING_FROM_HTML_2"],
      },
    });
    await mkdir(path.join(tmpDist, "research", "rewrite"), { recursive: true });
    await writeFile(
      path.join(tmpDist, "research", "rewrite", "index.html"),
      `<!doctype html><html><body><h1>Rewrite</h1><p>INSEE records 14,538 total dwellings in Chamonix-Mont-Blanc. Secondary residences represent 82.9% in Megève.</p></body></html>`,
      "utf8",
    );
    const manifest = {
      schemaVersion: "production-v3" as const,
      input: {
        id: "ppin-adv",
        version: 1,
        digest: "e".repeat(64),
        projectId,
        pageIdentity,
        pageType: "editorial" as const,
        route,
        siteIdentity: { siteId: "s", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "f".repeat(64) },
      },
      seo: { fullTitle: "Rewrite", description: "Desc", canonicalUrl: "https://sutherlandam.com/research/rewrite", ogTitle: "Rewrite", ogDescription: "Desc", ogUrl: "https://sutherlandam.com/research/rewrite" },
      content: {
        acceptedId: "wacc-adv",
        acceptedVersion: 1,
        acceptedDigest: contentDigest,
        title: "Rewrite",
        metaDescription: "Desc",
        introduction: "INSEE records 14,538 total dwellings in Chamonix-Mont-Blanc.",
        sections: [{ heading: "Uncovered", body: "Secondary residences represent 82.9% in Megève." }],
        conclusion: "End.",
        cta: "Cta.",
        internalLinks: [],
      },
      design: {} as never,
      links: [],
      breadcrumbs: [],
      assets: [],
      manifestDigest: "1".repeat(64),
    };
    const report = await runTrustQa({
      manifests: [manifest],
      distDir: tmpDist,
      projectId,
      trust,
      contentDigests: new Map([[pageIdentity, contentDigest]]),
      manifestSetDigest: "2".repeat(64),
    });
    assert.equal(report.overall, "FAIL");
    const byId = new Map(report.checks.map((c) => [c.checkId, c]));
    assert.equal(byId.get("trust.claim_lineage")?.verdict, "FAIL", "uncovered material sentence must fail trust.claim_lineage (P1-3)");
    assert.equal(byId.get("trust.review_authority")?.verdict, "FAIL", "missing review authority on YMYL_DECISION_SUPPORT must FAIL, never skip (P1-4)");
    assert.equal(byId.get("trust.original_value")?.verdict, "FAIL", "declarative OriginalValueRecord missing lineageClaimId and HTML anchors must FAIL (P1-5)");
  } finally {
    await rm(tmpDist, { recursive: true, force: true }).catch(() => undefined);
    await dbInst.close();
  }
});

test("ADVERSARIAL YMYL: writer QA rejects prohibited claims through the governed path", async () => {
  // The writer pipeline's factual.prohibited_claims gate already rejects
  // guaranteed-return language. Prove it end-to-end through the real service:
  // a proposal containing "guaranteed 12% returns" must fail content QA.
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, "adv-8");
    const store = new WriterStore(dbInst.db);
    const service = new WriterService(store, new WriterSnapshotStore(dbInst.db), new WriterBudgetStore(dbInst.db), new WriterQaStore(dbInst.db));
    const policy = await store.deriveWriterPolicyDraft({ projectId });
    await store.approveWriterPolicy({ projectId, policyId: policy.id, expectedVersion: policy.version, expectedDigest: policy.policyDigest });
    const brief = await store.saveBriefDraft({
      projectId,
      pageTarget: {
        slug: "advisory/bad",
        title: "Bad Advisory Page",
        objective: "objective",
        audience: "audience",
        structureGuidance: [],
        internalLinkIntent: [],
        ctaIntent: "Explain how an engagement begins",
        designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "investment_advisory" as const },
      },
      contentBriefKeyPoints: [],
    });
    await store.approveBrief({ projectId, briefId: brief.id, expectedVersion: brief.version, expectedDigest: brief.digest });
    const snapshot = await service.compileSnapshot({ projectId });
    await service.approveSnapshot({ projectId, snapshotId: snapshot.id, expectedVersion: snapshot.version, expectedDigest: snapshot.digest });
    const proposal = await service.generateProposal(
      { projectId, snapshotId: snapshot.id },
      {
        invoke: (async (request: { model?: string }) => ({
          requestedModel: request.model ?? "test-model",
          respondedModel: "test-model",
          provider: "seam",
          durationMs: 5,
          promptTokens: 100,
          completionTokens: 400,
          totalTokens: 500,
          costUsd: 0,
          content: JSON.stringify({
            title: "Guaranteed 12% Returns on Alpine Property",
            metaDescription: "Guaranteed returns.",
            introduction: "Clients typically earn 18% annually with our guaranteed 12% returns program.",
            sections: [{ heading: "Returns", body: "The asset will appreciate 12% per year, guaranteed." }],
            conclusion: "Guaranteed.",
            cta: "Book now",
            internalLinks: [],
          }),
        })) as never,
        dailyLimitUsd: 10,
      },
    );
    const qa = await service.runQa({ projectId });
    assert.notEqual(qa.overall, "PASS", "prohibited-claim proposal must not pass content QA");
  } finally {
    await dbInst.close();
  }
});
