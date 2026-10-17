import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import type { PageIntentAuthority, ClaimLineage } from "@factory/contracts";

/**
 * RUN 12 TRUST GOVERNANCE — persistence integration (real PostgreSQL).
 *
 * Proves:
 *   - intent authority is durable, versioned, idempotent (no fake bumps)
 *   - claim lineage persists only when it passes the deterministic verdict
 *   - review authority staleness binds to the exact content digest
 *   - cannibalization verdict is computed over stored authority
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

test("PG run12 trust: intent authority durable, idempotent, versioned on change", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "trust-1");
    const store = new TrustGovernanceStore(dbInst.db);

    const first = await store.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "services/advisory") });
    assert.equal(first.version, 1);

    // Idempotent: same data -> same version, no fake bump.
    const repeat = await store.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "/services/advisory/") });
    assert.equal(repeat.version, 1);
    assert.equal(repeat.id, first.id);

    // Change -> version 2.
    const changed = await store.setPageIntentAuthority({
      projectId,
      intent: intentFor(projectId, "services/advisory", { ymylClassification: "YMYL_DECISION_SUPPORT" }),
    });
    assert.equal(changed.version, 2);

    // Pure read returns the latest.
    const current = await store.getIntentAuthority(projectId, "services/advisory");
    assert.equal(current!.ymylClassification, "YMYL_DECISION_SUPPORT");
    assert.equal(current!.pageIdentity, "services/advisory");
  } finally {
    await dbInst.close();
  }
});

test("PG run12 trust: claim lineage fails closed on invalid records; valid records bind to digest", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "trust-2");
    const store = new TrustGovernanceStore(dbInst.db);
    const digest = "a".repeat(64);

    // Invalid: CALCULATION without provenance must be rejected.
    const badClaim: ClaimLineage = {
      claimId: "c-bad",
      claimText: "Yield of 14.2%.",
      claimType: "CALCULATION",
      sourceRefs: [],
      pageIdentity: "research/report",
      limitation: "",
    };
    await assert.rejects(
      store.saveClaimLineage({ projectId, pageIdentity: "research/report", contentDigest: digest, claims: [badClaim] }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );

    // Invalid: omitted entailment must be rejected by persistence gate.
    const omittedEntailmentClaim: ClaimLineage = {
      claimId: "c-no-entailment",
      claimText: "INSEE Chamonix-Mont-Blanc records 13,864 total dwellings.",
      claimType: "SOURCE_DERIVED_FACT",
      sourceRefs: [
        {
          ref: "INSEE Dossier complet Commune de Chamonix-Mont-Blanc (74056)",
          sourceUrl: "https://www.insee.fr/fr/statistiques/2011101?geo=COM-74056",
          supportingExcerpt: "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings.",
          tier: "TIER_A",
          sourceDate: "2026-01-15",
          freshnessBasis: "observation_date",
        },
      ],
      pageIdentity: "research/report",
      limitation: "",
    };
    await assert.rejects(
      store.saveClaimLineage({ projectId, pageIdentity: "research/report", contentDigest: digest, claims: [omittedEntailmentClaim] }),
      (err: { code?: string }) => err.code === "trust_claim_lineage_invalid",
    );

    // Valid: calculation with provenance and verified source excerpt persists.
    const goodClaim: ClaimLineage = {
      claimId: "c-good",
      claimText: "Illustrative gross yield of 7.2% under stated assumptions.",
      claimType: "CALCULATION",
      sourceRefs: [
        {
          ref: "Notaires de France fee schedule and first-party worked example",
          sourceUrl: "https://www.immobilier.notaires.fr/en/property-market-statistics",
          supportingExcerpt: "Illustrative gross yield of 7.2% under stated assumptions from annual rent 26,400 EUR and purchase price 366,000 EUR.",
          tier: "TIER_B",
          sourceDate: "2026-01-15",
          freshnessBasis: "effective_version",
          entailment: "SUPPORTED",
        },
      ],
      pageIdentity: "research/report",
      calculationRef: {
        modelId: "gross-yield-v1",
        inputs: [
          { name: "annual rent", value: "26400", unit: "EUR" },
          { name: "purchase price", value: "366000", unit: "EUR" },
        ],
        assumptionRefs: [],
        output: { value: "7.2", unit: "%" },
        calculatedAt: "2026-09-01",
      },
      limitation: "Illustrative calculation under stated assumptions; not a forecast.",
    };
    await store.saveClaimLineage({ projectId, pageIdentity: "research/report", contentDigest: digest, claims: [goodClaim] });
    const stored = await store.listClaimLineage(projectId, "research/report", digest);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.claimId, "c-good");

    // Bound to a different digest -> empty (digest binding works).
    const other = await store.listClaimLineage(projectId, "research/report", "b".repeat(64));
    assert.equal(other.length, 0);
  } finally {
    await dbInst.close();
  }
});

test("PG run12 trust: review authority staleness follows content digest", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "trust-3");
    const store = new TrustGovernanceStore(dbInst.db);
    const digestA = "a".repeat(64);
    await store.recordReview({
      projectId,
      review: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity: "research/report",
        reviewerRef: "org-sutherland",
        reviewerExpertise: "Buyer-side alpine property advisory",
        reviewedContentDigest: digestA,
        reviewedAt: "2026-09-20",
        result: "APPROVED",
        note: "Methodology and sources verified.",
      },
    });
    const currentA = await store.currentReview(projectId, "research/report", digestA);
    assert.equal(currentA.stale, false);
    assert.equal(currentA.review!.result, "APPROVED");

    // Content changed -> review becomes stale.
    const currentB = await store.currentReview(projectId, "research/report", "b".repeat(64));
    assert.equal(currentB.stale, true);
    assert.match(currentB.reason!, /stale/);
  } finally {
    await dbInst.close();
  }
});

test("PG run12 trust: cannibalization verdict over stored authorities", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "trust-4");
    const store = new TrustGovernanceStore(dbInst.db);

    await store.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "services/advisory") });
    await store.setPageIntentAuthority({
      projectId,
      intent: intentFor(projectId, "advisory/valuation", { primaryIntent: "Understand valuation methodology", decisionRole: "FINANCIAL_DECISION_SUPPORT", ymylClassification: "YMYL_DECISION_SUPPORT" }),
    });
    const ok = await store.cannibalizationVerdict(projectId);
    assert.equal(ok.verdict, "PASS");

    // Now add a page duplicating the service intent+cluster+role -> FAIL.
    await store.setPageIntentAuthority({ projectId, intent: intentFor(projectId, "services/duplicate") });
    const bad = await store.cannibalizationVerdict(projectId);
    assert.equal(bad.verdict, "FAIL");
    assert.ok(bad.findings.length >= 1);
  } finally {
    await dbInst.close();
  }
});
