import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { runTrustQa } from "../../src/production/qa/trust.js";
import { loadInseeEvidenceRegistry, inseeSourceUrl } from "../../src/trust/insee-evidence.js";
import { loadLegalEvidenceRegistry, verifyLegalClaim } from "../../src/trust/legal-evidence.js";
import type {
  AuthenticatedApprovalEvent,
  ClaimLineage,
  EvidenceBinding,
  PageIntentAuthority,
  ProductionQaCheckResult,
  SourceRef,
} from "@factory/contracts";

/**
 * RUN 12 REMEDIATION — production-path source-integrity mutations.
 * Every case goes through the real runTrustQa() with the real stored INSEE
 * bytes; the claim author's supportingExcerpt / SUPPORTED / TIER_A are never
 * the deciding evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const registry = loadInseeEvidenceRegistry(repoRoot);
const legalRegistry = loadLegalEvidenceRegistry(repoRoot);

const tf = (geoCode: string, rowKey: string, value: number, year = 2022): EvidenceBinding => ({
  kind: "table_fact", geoCode, reportingYear: year, tableId: "LOG T1", rowKey, columnKey: String(year), value, unit: "dwellings",
});

function ref(over: Partial<SourceRef> & { bindings?: EvidenceBinding[] }, excerpt: string): SourceRef {
  const { bindings, ...rest } = over;
  const isMegeve = (rest.ref && rest.ref.includes("74173")) || (rest.sourceUrl && rest.sourceUrl.includes("74173"));
  const defaultCanonicalDatasetId = isMegeve
    ? "INSEE-RP2022-LOGEMENT-COM-74173"
    : "INSEE-RP2022-LOGEMENT-COM-74056";
  const defaultDatasetIdentity = isMegeve
    ? {
        geoCode: "74173",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74173",
        documentType: "census",
      }
    : {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      };
  const defaultAcquisition = isMegeve
    ? {
        acquisitionEventId: "acq-insee-74173-2026",
        trustedProviderId: "insee-official-data",
        acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD" as const,
        retrievedAt: "2026-10-18T10:00:00Z",
        contentDigest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4",
        signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74173",
        canonicalDatasetId: defaultCanonicalDatasetId,
        datasetIdentity: defaultDatasetIdentity,
      }
    : {
        acquisitionEventId: "acq-insee-74056-2026",
        trustedProviderId: "insee-official-data",
        acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD" as const,
        retrievedAt: "2026-10-18T10:00:00Z",
        contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
        signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
        canonicalDatasetId: defaultCanonicalDatasetId,
        datasetIdentity: defaultDatasetIdentity,
      };

  return {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
    canonicalDatasetId: defaultCanonicalDatasetId,
    datasetIdentity: defaultDatasetIdentity,
    supportingExcerpt: excerpt,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    acquisitionProvenance: defaultAcquisition,
    ...(bindings ? { evidenceBindings: bindings } : {}),
    ...rest,
  } as SourceRef;
}

async function sourceAuthority(claimText: string, sourceRef: SourceRef, opts: { withRegistry?: boolean } = {}) {
  const dbInst = await setupMigratedTestDatabase();
  const dist = await mkdtemp(path.join(tmpdir(), "r12-src-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `si-${Math.random().toString(36).slice(2, 8)}`);
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "locations/chamonix";
    const digest = "b".repeat(64);
    const intent: PageIntentAuthority = {
      schemaVersion: "trust-governance-v1", projectId, pageIdentity,
      primaryIntent: "Understand Chamonix housing stock", secondaryIntents: [], primaryQueryCluster: "chamonix housing",
      secondaryQueryClusters: [], contentGapPurpose: "Local stock", siteRole: "Location", targetAudience: "Buyers",
      mainUserTask: "Assess stock", primaryConversionAction: "Request consultation",
      ymylClassification: "YMYL_DECISION_SUPPORT", decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE", internalLinksOut: [],
    };
    await trust.setPageIntentAuthority({ projectId, intent });
    const claim: ClaimLineage = { claimId: "claim-x", claimText, claimType: "SOURCE_DERIVED_FACT", sourceRefs: [sourceRef], pageIdentity, limitation: "" };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [claim] });
    await mkdir(path.join(dist, "locations", "chamonix"), { recursive: true });
    await writeFile(path.join(dist, "locations", "chamonix", "index.html"), `<html><body><h1>x</h1><p>${claimText}</p></body></html>`);
    const manifest = {
      schemaVersion: "production-v3" as const,
      input: { id: "p", version: 1, digest: "e".repeat(64), projectId, pageIdentity, pageType: "editorial" as const, route: "/locations/chamonix",
        siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) } },
      seo: { fullTitle: "t", description: "d", canonicalUrl: "https://example.test/locations/chamonix", ogTitle: "t", ogDescription: "d", ogUrl: "https://example.test/locations/chamonix" },
      content: { acceptedId: "w", acceptedVersion: 1, acceptedDigest: digest, title: "t", metaDescription: "d", introduction: claimText, sections: [], conclusion: "End", cta: "c", internalLinks: [] },
      design: {} as never, links: [], breadcrumbs: [], assets: [], manifestDigest: "1".repeat(64),
    };
    const report = await runTrustQa({
      manifests: [manifest], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      ...(opts.withRegistry === false ? {} : { inseeEvidence: registry }),
    });
    return report.checks.find((c) => c.checkId === "trust.source_authority")!;
  } finally {
    await rm(dist, { recursive: true, force: true });
    await dbInst.close();
  }
}

const GOOD = "INSEE Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings in 2022.";

test("source registry loads both digest-verified snapshots with no rejections", () => {
  assert.equal(registry.rejected.length, 0);
  assert.equal(registry.snapshots.length, 2);
});

test("POSITIVE: correct INSEE claim with verified binding passes trust.source_authority", async () => {
  const c = await sourceAuthority(GOOD, ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD));
  assert.equal(c.verdict, "PASS", c.detail);
});

test("M07 fabricated matching supportingExcerpt for wrong number (13,864) is rejected: claim_number_unbound", async () => {
  const wrong = "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings in 2022.";
  const c = await sourceAuthority(wrong, ref({ bindings: [tf("74056", "Ensemble", 14538)] }, wrong));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_number_unbound.*13,864/);
});

test("M07b same fabrication with a binding that also claims 13,864 is rejected: claim_value_mismatch against source 14 538", async () => {
  const wrong = "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings in 2022.";
  const c = await sourceAuthority(wrong, ref({ bindings: [tf("74056", "Ensemble", 13864)] }, wrong));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_value_mismatch.*14 538/);
});

test("M08 SUPPORTED + TIER_A + matching excerpt but NO evidence binding is rejected: source_evidence_unbound", async () => {
  const c = await sourceAuthority(GOOD, ref({}, GOOD));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /source_evidence_unbound/);
});

test("M04 correct value labelled 2023 is rejected: claim_year_mismatch / claim_year_mismatch in evidence", async () => {
  const text = "INSEE Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings in 2023.";
  const c = await sourceAuthority(text, ref({ bindings: [tf("74056", "Ensemble", 14538)] }, text));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_year_mismatch/);
  const c2 = await sourceAuthority(GOOD, ref({ bindings: [tf("74056", "Ensemble", 14538, 2023)] }, GOOD));
  assert.equal(c2.verdict, "FAIL");
  assert.match(c2.detail, /claim_year_mismatch/);
});

test("M10 official publisher name with unrelated URL (Dossier Complet publication 2011101) is rejected: source_url_mismatch", async () => {
  const c = await sourceAuthority(GOOD, ref({ sourceUrl: "https://www.insee.fr/fr/statistiques/2011101?geo=COM-74056", bindings: [tf("74056", "Ensemble", 14538)] }, GOOD));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /source_url_mismatch/);
});

test("M11 INSEE claim with no retrievable/verified evidence registry is blocked fail-closed: source_snapshot_unverified", async () => {
  const c = await sourceAuthority(GOOD, ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD), { withRegistry: false });
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /source_snapshot_unverified/);
});

test("M18 Megève statement justified with Chamonix evidence is rejected: claim_geography_mismatch", async () => {
  const text = "INSEE Megève (COM-74173) records 14,538 total dwellings in 2022.";
  const c = await sourceAuthority(text, ref({ ref: "INSEE Logement en 2022 — Commune de Megève (COM-74173)", sourceUrl: inseeSourceUrl("74056"), bindings: [tf("74056", "Ensemble", 14538)] }, text));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_geography_mismatch/);
});

test("M05 Chamonix commune id replaced by Megève id in the binding is rejected: claim_value_mismatch", async () => {
  const c = await sourceAuthority(GOOD, ref({ bindings: [tf("74173", "Ensemble", 14538)] }, GOOD));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_value_mismatch.*9 354/);
});

test("M01 Chamonix 2022 total dwellings changed to 13,864 fails production QA: claim_value_mismatch", async () => {
  const text = "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings in 2022.";
  const c = await sourceAuthority(text, ref({ bindings: [tf("74056", "Ensemble", 13864)] }, text));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_value_mismatch/);
});

test("M02 Megève 2022 total dwellings changed to 11,291 fails production QA: claim_value_mismatch", async () => {
  const text = "INSEE Megève (COM-74173) records 11,291 total dwellings in 2022.";
  const c = await sourceAuthority(
    text,
    ref({ ref: "INSEE Logement en 2022 — Commune de Megève (COM-74173)", sourceUrl: inseeSourceUrl("74173"), bindings: [tf("74173", "Ensemble", 11291)] }, text),
  );
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_value_mismatch.*9 354/);
});

test("M03 Chamonix secondary residence share changed (82.9% instead of 69.3%) fails production QA: claim_value_mismatch", async () => {
  const text = "INSEE Chamonix-Mont-Blanc (COM-74056) records 82.9% secondary residences in 2022.";
  const secBinding: EvidenceBinding = {
    kind: "table_fact",
    geoCode: "74056",
    reportingYear: 2022,
    tableId: "LOG T1bis",
    rowKey: "Résidences secondaires et logements occasionnels",
    columnKey: "2022",
    value: 82.9,
    unit: "percent_of_dwellings",
  };
  const c = await sourceAuthority(text, ref({ bindings: [secBinding] }, text));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_value_mismatch.*69[,.]3/);
});

test("M06 Housing category swapped (69.3% primary residences and 29.7% secondary residences) fails: claim_category_mismatch", async () => {
  const swapped = "INSEE Chamonix-Mont-Blanc (COM-74056) records 69.3% primary residences and 29.7% secondary residences in 2022.";
  const bindings: EvidenceBinding[] = [
    { kind: "table_fact", geoCode: "74056", reportingYear: 2022, tableId: "LOG T1bis", rowKey: "Résidences principales", columnKey: "2022", value: 29.7, unit: "percent_of_dwellings" },
    { kind: "table_fact", geoCode: "74056", reportingYear: 2022, tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", columnKey: "2022", value: 69.3, unit: "percent_of_dwellings" },
  ];
  const c = await sourceAuthority(swapped, ref({ bindings }, swapped));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_category_mismatch/);
});

test("M09 Tampered raw source snapshot bytes (rejected in registry) fails production QA: source_snapshot_unverified", async () => {
  const tamperedRegistry = {
    snapshots: [],
    facts: [],
    rejected: [{ geoCode: "74056", reason: "source_digest_mismatch: sha256 mismatch" }],
  };
  const dbInst = await setupMigratedTestDatabase();
  const dist = await mkdtemp(path.join(tmpdir(), "r12-m09-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `m09-${Math.random().toString(36).slice(2, 8)}`);
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "locations/chamonix";
    const digest = "b".repeat(64);
    await trust.setPageIntentAuthority({
      projectId,
      intent: {
        schemaVersion: "trust-governance-v1", projectId, pageIdentity,
        primaryIntent: "Understand Chamonix housing stock", secondaryIntents: [], primaryQueryCluster: "chamonix housing",
        secondaryQueryClusters: [], contentGapPurpose: "Local stock", siteRole: "Location", targetAudience: "Buyers",
        mainUserTask: "Assess stock", primaryConversionAction: "Request consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT", decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE", internalLinksOut: [],
      },
    });
    const claim: ClaimLineage = { claimId: "claim-m09", claimText: GOOD, claimType: "SOURCE_DERIVED_FACT", sourceRefs: [ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD)], pageIdentity, limitation: "" };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [claim] });
    await mkdir(path.join(dist, "locations", "chamonix"), { recursive: true });
    await writeFile(path.join(dist, "locations", "chamonix", "index.html"), `<html><body><h1>x</h1><p>${GOOD}</p></body></html>`);
    const manifest = {
      schemaVersion: "production-v3" as const,
      input: { id: "p", version: 1, digest: "e".repeat(64), projectId, pageIdentity, pageType: "editorial" as const, route: "/locations/chamonix",
        siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) } },
      seo: { fullTitle: "t", description: "d", canonicalUrl: "https://example.test/locations/chamonix", ogTitle: "t", ogDescription: "d", ogUrl: "https://example.test/locations/chamonix" },
      content: { acceptedId: "w", acceptedVersion: 1, acceptedDigest: digest, title: "t", metaDescription: "d", introduction: GOOD, sections: [], conclusion: "End", cta: "c", internalLinks: [] },
      design: {} as never, links: [], breadcrumbs: [], assets: [], manifestDigest: "1".repeat(64),
    };
    const report = await runTrustQa({
      manifests: [manifest], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: tamperedRegistry,
    });
    const c = report.checks.find((ch) => ch.checkId === "trust.source_authority")!;
    assert.equal(c.verdict, "FAIL");
    assert.match(c.detail, /source_snapshot_unverified.*source_digest_mismatch/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await dbInst.close();
  }
});

test("M12 Derived percentage attributed to total dwellings instead of main residences built before 2020 fails: claim_denominator_mismatch", async () => {
  const wrongDenomText = "INSEE Chamonix-Mont-Blanc (COM-74056) records 58.5% of total dwellings in 2022 were completed between 1946 and 1990.";
  const derivedBinding: EvidenceBinding = {
    kind: "derived_share",
    geoCode: "74056",
    reportingYear: 2022,
    tableId: "LOG T5",
    numeratorRows: ["De 1946 à 1970", "De 1971 à 1990"],
    denominatorRow: "Résidences principales construites avant 2020",
    value: 58.5,
    unit: "percent_of_main_residences",
  };
  const c = await sourceAuthority(wrongDenomText, ref({ bindings: [derivedBinding] }, wrongDenomText));
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /claim_denominator_mismatch/);
});

test("M13 Loi Hoguet cited as allowing property brokerage without Carte T fails: statutory_proposition_mismatch", async () => {
  const badHoguet = "Under French Loi Hoguet Law No. 70-9 of 2 January 1970, buyer-side property brokerage is permitted without a carte professionnelle T.";
  const hoguetRef: SourceRef = {
    ref: "Loi Hoguet — Law No. 70-9 of 2 January 1970 (Legifrance)",
    sourceUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228",
    supportingExcerpt: badHoguet,
    tier: "TIER_A",
    sourceDate: "1970-01-02",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  };
  const c = await sourceAuthority(badHoguet, hoguetRef);
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /statutory_proposition_mismatch/);
});

test("M14 Incorrect DPE regulatory year (class E in 2026 instead of 2025) fails: statutory_schedule_mismatch", async () => {
  const badDpe = "Notaires de France statutory procedure requires DDT energy audits for classes F and G in 2023, class E in 2026, and class D in 2034.";
  const notairesRef: SourceRef = {
    ref: "Notaires de France — DPE energy audit schedule",
    sourceUrl: "https://www.notaires.fr/fr/immobilier-fiscalite",
    supportingExcerpt: badDpe,
    tier: "TIER_A",
    sourceDate: "2025-01-01",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  };
  const c = await sourceAuthority(badDpe, notairesRef);
  assert.equal(c.verdict, "FAIL");
  assert.match(c.detail, /statutory_schedule_mismatch/);
});

test("M15 False number in section heading, table, callout, or meta description fails trust.claim_lineage: claim_missing_for_material_sentence", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dist = await mkdtemp(path.join(tmpdir(), "r12-m15-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `m15-${Math.random().toString(36).slice(2, 8)}`);
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "locations/chamonix";
    const digest = "b".repeat(64);
    await trust.setPageIntentAuthority({
      projectId,
      intent: {
        schemaVersion: "trust-governance-v1", projectId, pageIdentity,
        primaryIntent: "Understand Chamonix housing stock", secondaryIntents: [], primaryQueryCluster: "chamonix housing",
        secondaryQueryClusters: [], contentGapPurpose: "Local stock", siteRole: "Location", targetAudience: "Buyers",
        mainUserTask: "Assess stock", primaryConversionAction: "Request consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT", decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE", internalLinksOut: [],
      },
    });
    const claim: ClaimLineage = { claimId: "claim-m15", claimText: GOOD, claimType: "SOURCE_DERIVED_FACT", sourceRefs: [ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD)], pageIdentity, limitation: "" };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [claim] });
    await mkdir(path.join(dist, "locations", "chamonix"), { recursive: true });
    await writeFile(
      path.join(dist, "locations", "chamonix", "index.html"),
      `<html><body><h1>Chamonix Overview</h1><p>${GOOD}</p><table><tr><td>13,864 legacy dwellings</td></tr></table></body></html>`,
    );
    const manifest = {
      schemaVersion: "production-v3" as const,
      input: { id: "p", version: 1, digest: "e".repeat(64), projectId, pageIdentity, pageType: "editorial" as const, route: "/locations/chamonix",
        siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) } },
      seo: { fullTitle: "t", description: "Chamonix has 9.8% guaranteed yield", canonicalUrl: "https://example.test/locations/chamonix", ogTitle: "t", ogDescription: "d", ogUrl: "https://example.test/locations/chamonix" },
      content: { acceptedId: "w", acceptedVersion: 1, acceptedDigest: digest, title: "t", metaDescription: "Chamonix has 9.8% guaranteed yield", introduction: GOOD, sections: [{ heading: "Chamonix 13,864 Dwellings", body: GOOD }], conclusion: "End", cta: "c", internalLinks: [] },
      design: {} as never, links: [], breadcrumbs: [], assets: [], manifestDigest: "1".repeat(64),
    };
    const report = await runTrustQa({
      manifests: [manifest], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
    });
    const c = report.checks.find((ch) => ch.checkId === "trust.claim_lineage")!;
    assert.equal(c.verdict, "FAIL");
    assert.match(c.detail, /claim_missing_for_material_sentence/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await dbInst.close();
  }
});

test("M16 & M17 Mutated calculation output (8.4%) or wrong rounding/unit (7.3% or EUR) fails: calculation_output_mismatch / calculation_rounding_or_unit_mismatch", async () => {
  const { claimLineageProblems } = await import("@factory/contracts");
  const baseCalcClaim: ClaimLineage = {
    claimId: "claim-calc-mut",
    claimText: "Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 8.4% under stated assumptions.",
    claimType: "CALCULATION",
    sourceRefs: [
      {
        ref: "intake:operatorFacts[4] — worked calculation",
        sourceUrl: "https://sutherlandam.com/research/alpine-decision-framework",
        supportingExcerpt: "Annual rent 26400 EUR over purchase price 366000 EUR gives 8.4%.",
        tier: "TIER_A",
        sourceDate: "2026-09-01",
        freshnessBasis: "model_as_of_date",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity: "research/alpine-decision-framework",
    calculationRef: {
      modelId: "sutherland-gross-yield-v1",
      inputs: [
        { name: "annual rent", value: "26400", unit: "EUR/year" },
        { name: "purchase price", value: "366000", unit: "EUR" },
      ],
      assumptionRefs: [],
      output: { value: "8.4", unit: "%" },
      calculatedAt: "2026-09-01",
    },
    limitation: "Illustrative worked example.",
  };
  const m16Problems = claimLineageProblems(baseCalcClaim);
  assert.ok(m16Problems.some((p) => /calculation_output_mismatch/.test(p)), `Expected calculation_output_mismatch, got ${JSON.stringify(m16Problems)}`);

  const m17RoundingClaim: ClaimLineage = {
    ...baseCalcClaim,
    claimText: "Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 7.3% under stated assumptions.",
    sourceRefs: [{ ...baseCalcClaim.sourceRefs[0]!, supportingExcerpt: "Annual rent 26400 EUR over purchase price 366000 EUR gives 7.3%." }],
    calculationRef: { ...baseCalcClaim.calculationRef!, output: { value: "7.3", unit: "%" } },
  };
  const m17Problems = claimLineageProblems(m17RoundingClaim);
  assert.ok(m17Problems.some((p) => /calculation_rounding_or_unit_mismatch/.test(p)), `Expected calculation_rounding_or_unit_mismatch, got ${JSON.stringify(m17Problems)}`);

  const m17UnitClaim: ClaimLineage = {
    ...baseCalcClaim,
    claimText: "Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 7.2% under stated assumptions.",
    sourceRefs: [{ ...baseCalcClaim.sourceRefs[0]!, supportingExcerpt: "Annual rent 26400 EUR over purchase price 366000 EUR gives 7.2%." }],
    calculationRef: { ...baseCalcClaim.calculationRef!, output: { value: "7.2", unit: "EUR" } },
  };
  const m17UnitProblems = claimLineageProblems(m17UnitClaim);
  assert.ok(m17UnitProblems.some((p) => /calculation_rounding_or_unit_mismatch/.test(p)), `Expected calculation_rounding_or_unit_mismatch on wrong unit, got ${JSON.stringify(m17UnitProblems)}`);
});

test("M19 Synthetic SERP/competitor fixture claimed as real external research fails: synthetic_fixture_research_rejected", async () => {
  const { verifySourceRef } = await import("@factory/contracts");
  const syntheticRef: SourceRef = {
    ref: "INSEE Logement en 2022 (synthetic_fixture)",
    sourceUrl: inseeSourceUrl("74056"),
    supportingExcerpt: GOOD,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    evidenceOrigin: "SYNTHETIC_FIXTURE",
  };
  const check = verifySourceRef(syntheticRef);
  assert.equal(check.valid, false);
  assert.match(check.reason ?? "", /synthetic_fixture_research_rejected/);
});

test("M20, M21, M22, M23, M24, M25, M26 fail closed in runTrustQa with exact error codes", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const dist = await mkdtemp(path.join(tmpdir(), "r12-m20-26-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `m20-${Math.random().toString(36).slice(2, 8)}`);
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "locations/chamonix";
    const digest = "b".repeat(64);
    await trust.setPageIntentAuthority({
      projectId,
      intent: {
        schemaVersion: "trust-governance-v1", projectId, pageIdentity,
        primaryIntent: "Understand Chamonix housing stock", secondaryIntents: [], primaryQueryCluster: "chamonix housing",
        secondaryQueryClusters: [], contentGapPurpose: "Local stock", siteRole: "Location", targetAudience: "Buyers",
        mainUserTask: "Assess stock", primaryConversionAction: "Request consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT", decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE", internalLinksOut: [],
      },
    });
    const claim: ClaimLineage = { claimId: "claim-m20", claimText: GOOD, claimType: "SOURCE_DERIVED_FACT", sourceRefs: [ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD)], pageIdentity, limitation: "" };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [claim] });

    // M20: OriginalValueRecord with text-only anchors (no quantitative/statutory work product)
    await trust.saveOriginalValue({
      projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity,
        kind: "first_party_observation",
        description: "Text-only observation without structured work product.",
        lineageClaimId: "claim-m20",
        verifiableAnchors: ["Chamonix-Mont-Blanc", "total dwellings"],
      },
    });

    // M21: Synthetic reviewer or EDITORIAL_REVIEW_PENDING
    await trust.recordReview({
      projectId,
      review: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity,
        reviewerRef: "org-sutherland-private-office-research-committee",
        reviewerExpertise: "Independent buyer-side alpine property advisory",
        reviewedContentDigest: digest,
        reviewedAt: "2026-09-04",
        result: "APPROVED",
        note: "Pending human sign-off",
        verifiedClaimIds: ["claim-m20"],
        reviewStatus: "EDITORIAL_REVIEW_PENDING",
        reviewerKind: "SYNTHETIC_TEST_REVIEWER",
      },
    });

    await mkdir(path.join(dist, "locations", "chamonix"), { recursive: true });
    await writeFile(
      path.join(dist, "locations", "chamonix", "index.html"),
      `<html><body><h1>x</h1><p>${GOOD}</p><div data-review-authority="org-sutherland-private-office-research-committee" data-reviewed-digest="${digest}">Reviewed</div></body></html>`,
    );
    const manifestA = {
      schemaVersion: "production-v3" as const,
      input: { id: "p1", version: 1, digest: "e".repeat(64), projectId, pageIdentity, pageType: "editorial" as const, route: "/locations/chamonix",
        siteIdentity: { siteId: "s", siteName: "S", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) } },
      seo: { fullTitle: "t", description: "d", canonicalUrl: "https://example.test/locations/chamonix", ogTitle: "t", ogDescription: "d", ogUrl: "https://example.test/locations/chamonix" },
      content: { acceptedId: "w", acceptedVersion: 1, acceptedDigest: digest, title: "t", metaDescription: "d", introduction: GOOD, sections: [{ heading: "Shared Duplicate Heading", body: GOOD }], conclusion: "End", cta: "c", internalLinks: [] },
      design: {} as never, links: [], breadcrumbs: [], assets: [], manifestDigest: "1".repeat(64),
    };
    // M23: Second page sharing an identical section heading/body
    const manifestB = {
      ...manifestA,
      input: { ...manifestA.input, id: "p2", pageIdentity: "research/chamonix-supply-notes", route: "/research/chamonix-supply-notes" },
    };

    const report1 = await runTrustQa({
      manifests: [manifestA, manifestB], distDir: dist, projectId, trust,
      contentDigests: new Map([[pageIdentity, digest], ["research/chamonix-supply-notes", digest]]),
      manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
    });
    const ovCheck = report1.checks.find((c) => c.checkId === "trust.original_value" && c.subject === "/locations/chamonix")!;
    assert.equal(ovCheck.verdict, "FAIL");
    assert.match(ovCheck.detail, /original_value_work_product_missing/);

    const revCheck = report1.checks.find((c) => c.checkId === "trust.review_authority" && c.subject === "/locations/chamonix")!;
    assert.equal(revCheck.verdict, "FAIL");
    assert.match(revCheck.detail, /editorial_review_pending_or_synthetic/);

    const cannCheck = report1.checks.find((c) => c.checkId === "trust.cannibalization")!;
    assert.equal(cannCheck.verdict, "FAIL");
    assert.match(cannCheck.detail, /cannibalization_or_duplicate_page_rejected/);

    // M22: Genuine source-digest staleness: sourceEvidenceSetDigest changed while content digest & claim set remain identical
    const genuineSourceDigest = "a".repeat(64);
    const alteredSourceDigest = "b".repeat(64);
    await trust.recordReview({
      projectId,
      review: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity,
        reviewerRef: "org-sutherland-private-office-research-committee",
        reviewerExpertise: "Independent buyer-side alpine property advisory",
        reviewedContentDigest: digest,
        sourceEvidenceSetDigest: genuineSourceDigest,
        reviewedAt: "2026-09-04",
        result: "APPROVED",
        note: "Approved against genuine source evidence digest",
        verifiedClaimIds: ["claim-m20"],
        reviewStatus: "EDITORIAL_REVIEW_APPROVED",
        reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
        approvalEventId: "appr-sutherland-council-2026-09-04",
        approvalEventProvenance: "Institutional review charter minute 2026-09-04",
      },
    });
    const report2 = await runTrustQa({
      manifests: [manifestA], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
      sourceEvidenceSetDigest: alteredSourceDigest,
    });
    const staleRev = report2.checks.find((c) => c.checkId === "trust.review_authority")!;
    assert.equal(staleRev.verdict, "FAIL");
    assert.match(staleRev.detail, /review_authority_stale/);

    // M24: Claim marked UNVERIFIED in limitation
    const unverifiedClaim: ClaimLineage = { ...claim, claimId: "claim-m24", limitation: "UNVERIFIED: awaiting source retrieval" };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [unverifiedClaim] });
    const report3 = await runTrustQa({
      manifests: [manifestA], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
    });
    const srcM24 = report3.checks.find((c) => c.checkId === "trust.source_authority")!;
    assert.equal(srcM24.verdict, "FAIL");
    assert.match(srcM24.detail, /unverified_claim_in_production_copy/);

    // M25: Forecast presented as FACT
    const { claimLineageProblems } = await import("@factory/contracts");
    const m25Problems = claimLineageProblems({
      claimId: "claim-m25",
      claimText: "Chamonix chalets will appreciate by 15% over the next decade.",
      claimType: "FACT",
      sourceRefs: [ref({ bindings: [tf("74056", "Ensemble", 14538)] }, "Chamonix chalets will appreciate by 15% over the next decade.")],
      pageIdentity,
      limitation: "",
    });
    assert.ok(m25Problems.some((p) => /forecast_as_fact_rejected/.test(p)));

    // M26: Non-entailing supporting excerpt on substantive claim
    const m26NonEntailingProblems = claimLineageProblems({
      claimId: "claim-m26-non-entailing",
      claimText: "Under French law, property advisory firms cannot act as transaction brokers without holding a Carte professionnelle T.",
      claimType: "SOURCE_DERIVED_FACT",
      sourceRefs: [
        {
          ref: "Légifrance — General Alpine Discussion",
          sourceUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000000512228",
          supportingExcerpt: "Alpine chalet transactions in Chamonix and Megève represent high-value property acquisitions.",
          tier: "TIER_A",
          sourceDate: "2026-01-01",
          freshnessBasis: "observation_date",
          entailment: "SUPPORTED",
        },
      ],
      pageIdentity,
      limitation: "",
    });
    assert.ok(
      m26NonEntailingProblems.some((p) => /SOURCE_ENTAILMENT_UNSUPPORTED/.test(p)),
      `Expected SOURCE_ENTAILMENT_UNSUPPORTED, got ${JSON.stringify(m26NonEntailingProblems)}`,
    );

    // M26b: Uncertain claim (SCENARIO) without visible label in rendered HTML
    const scenarioClaim: ClaimLineage = {
      claimId: "claim-m26",
      claimText: GOOD,
      claimType: "SCENARIO",
      sourceRefs: [ref({ bindings: [tf("74056", "Ensemble", 14538)] }, GOOD)],
      pageIdentity,
      limitation: "Downside stress test.",
    };
    await trust.saveClaimLineage({ projectId, pageIdentity, contentDigest: digest, claims: [scenarioClaim] });
    const report4 = await runTrustQa({
      manifests: [manifestA], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
    });
    const lineageM26 = report4.checks.find((c) => c.checkId === "trust.claim_lineage")!;
    assert.equal(lineageM26.verdict, "FAIL");
    assert.match(lineageM26.detail, /uncertain_claim_unlabelled_in_html/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await dbInst.close();
  }
});

test("L01–L08 French legal primary source verification mutations fail closed with exact error codes", async () => {
  const { verifyLegalClaim } = await import("../../src/trust/legal-evidence.js");
  const pageIdentity = "services/buyer-side-advisory";

  // L01: Loi Hoguet / Carte T exemption or unlicensed brokerage assertion
  const l01Claim: ClaimLineage = {
    claimId: "claim-l01",
    claimText: "Sutherland permits alpine property brokerage without holding a Carte professionnelle T.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — Loi No. 70-9 (Loi Hoguet)",
        sourceUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228/",
        supportingExcerpt:
          "Loi No. 70-9 du 2 janvier 1970 réglementant les conditions d'exercice des activités relatives à certaines opérations portant sur les immeubles et les fonds de commerce.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l01Res = verifyLegalClaim(l01Claim, legalRegistry);
  assert.equal(l01Res.ok, false);
  assert.ok(l01Res.problems.some((p) => /statutory_proposition_mismatch/.test(p)));

  // L02: Notaires de France / CCH L271-1 7-day cooling-off instead of 10 days
  const l02Claim: ClaimLineage = {
    claimId: "claim-l02",
    claimText: "French residential buyers benefit from a 7-day statutory cooling-off period following compromis de vente notification.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — Code de la construction et de l'habitation Art. L271-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
        supportingExcerpt: "L'acquéreur non professionnel d'un immeuble d'habitation peut se rétracter dans un délai de dix jours.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l02Res = verifyLegalClaim(l02Claim, legalRegistry);
  assert.equal(l02Res.ok, false);
  assert.ok(l02Res.problems.some((p) => /statutory_schedule_mismatch/.test(p)));

  // L03: Chamonix PLU applied to wrong municipality (Megève)
  const l03Claim: ClaimLineage = {
    claimId: "claim-l03",
    claimText: "In Megève, the Chamonix PLU imposes a 25% quota of social-mix housing on residential projects.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Ville de Chamonix-Mont-Blanc — PLU approuvé",
        sourceUrl: "https://www.chamonix.fr/urbanisme/plu",
        supportingExcerpt: "Servitudes de mixité sociale: 25% de logements locatifs sociaux.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l03Res = verifyLegalClaim(l03Claim, legalRegistry);
  assert.equal(l03Res.ok, false);
  assert.ok(l03Res.problems.some((p) => /claim_geography_mismatch/.test(p)));

  // L04: Chamonix PLU 25% social housing quota claimed as universal without 500 m2 SP threshold
  const l04Claim: ClaimLineage = {
    claimId: "claim-l04",
    claimText: "Under the Chamonix PLU, a 25% social-mix quota applies universally to all residential construction in the commune.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Ville de Chamonix-Mont-Blanc — PLU approuvé",
        sourceUrl: "https://www.chamonix.fr/urbanisme/plu",
        supportingExcerpt: "Servitudes de mixité sociale: 25% de logements locatifs sociaux.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l04Res = verifyLegalClaim(l04Claim, legalRegistry);
  assert.equal(l04Res.ok, false);
  assert.ok(l04Res.problems.some((p) => /statutory_proposition_mismatch/.test(p)));

  // L05: DPE pre-sale energy audit applied to excluded individual co-ownership apartments
  const l05Claim: ClaimLineage = {
    claimId: "claim-l05",
    claimText: "Under CCH Article L126-28-1, individual co-ownership apartments must have an energy audit prior to sale.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — CCH Art. L126-28-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341/",
        supportingExcerpt: "L'audit énergétique s'applique aux bâtiments d'habitation appartenant à un seul propriétaire.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l05Res = verifyLegalClaim(l05Claim, legalRegistry);
  assert.equal(l05Res.ok, false);
  assert.ok(l05Res.problems.some((p) => /statutory_proposition_mismatch/.test(p)));

  // L06: Self-declared legal TIER_A citation without authentic stored snapshot
  const l06Claim: ClaimLineage = {
    claimId: "claim-l06",
    claimText: "French building regulations require mandatory thermal retrofits under Decree 2026-9999.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — Décret imaginaire 2026-9999",
        sourceUrl: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000099999999/",
        supportingExcerpt: "Dispositions thermiques obligatoires pour tous les chalets alpins.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l06Res = verifyLegalClaim(l06Claim, legalRegistry);
  assert.equal(l06Res.ok, false);
  assert.ok(l06Res.problems.some((p) => /LEGAL_SOURCE_UNVERIFIED/.test(p)));

  // L07: Cooling-off duration wrong (14 days)
  const l07Claim: ClaimLineage = {
    claimId: "claim-l07",
    claimText: "Buyers benefit from a 14 days cooling-off period under CCH L271-1.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — CCH L271-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
        supportingExcerpt: "L'acquéreur non professionnel peut se rétracter dans un délai de dix jours.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l07Res = verifyLegalClaim(l07Claim, legalRegistry);
  assert.equal(l07Res.ok, false);
  assert.ok(l07Res.problems.some((p) => /statutory_schedule_mismatch/.test(p)));

  // L08: Publisher name paired with unrelated document URL
  const l08Claim: ClaimLineage = {
    claimId: "claim-l08",
    claimText: "Loi Hoguet regulates property intermediation in France.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — Loi Hoguet 1970",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/", // CCH L271-1 URL instead of Loi Hoguet URL
        supportingExcerpt: "Loi No. 70-9 du 2 janvier 1970.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const l08Res = verifyLegalClaim(l08Claim, legalRegistry);
  assert.equal(l08Res.ok, false);
  assert.ok(l08Res.problems.some((p) => /source_url_mismatch/.test(p)));
});

test("LEGAL-A through LEGAL-H: Authentic legal evidence verification fails closed on mutations", async () => {
  const pageIdentity = "advisory/investment-decision-framework";

  // LEGAL-A — Fabricated text with matching SHA-256 (self-authored summary promoted to primary source)
  const lAClaim: ClaimLineage = {
    claimId: "claim-legal-a",
    claimText: "Under fabricated municipal rules, social housing quotas are 50% for all buildings.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Fabricated Chamonix Regulation",
        sourceUrl: "https://www.chamonix.fr/urbanisme/plu/",
        supportingExcerpt: "50% social housing quota.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
        sourceClassification: "UNVERIFIED_SUMMARY",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resA = verifyLegalClaim(lAClaim, legalRegistry);
  assert.equal(resA.ok, false);
  assert.ok(resA.problems.some((p) => /self_authored_summary_rejected_as_primary|LEGAL_SOURCE_UNVERIFIED/.test(p)));

  // LEGAL-B — Genuine publisher URL with invented content
  const lBClaim: ClaimLineage = {
    claimId: "claim-legal-b",
    claimText: "Loi Hoguet Article 99 provides exemption from all carte professionnelle requirements.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — Loi Hoguet 1970",
        sourceUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228",
        supportingExcerpt: "Article 99 exemption for all advisors.",
        tier: "TIER_A",
        sourceDate: "1970-01-02",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resB = verifyLegalClaim(lBClaim, legalRegistry);
  assert.equal(resB.ok, false);
  assert.ok(resB.problems.some((p) => /statutory_proposition_mismatch|primary_legal_authenticity_failed/.test(p)));

  // LEGAL-C — Correct statute but superseded version (7 days cooling-off under Loi SRU 2000 instead of 10 days)
  const lCClaim: ClaimLineage = {
    claimId: "claim-legal-c",
    claimText: "CCH Article L271-1 grants purchasers a 7-day cooling-off period under Loi SRU 2000.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — CCH Art. L271-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
        supportingExcerpt: "délai de sept jours",
        tier: "TIER_A",
        sourceDate: "2000-12-13",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resC = verifyLegalClaim(lCClaim, legalRegistry);
  assert.equal(resC.ok, false);
  assert.ok(resC.problems.some((p) => /superseded_statutory_version|statutory_schedule_mismatch/.test(p)));

  // LEGAL-D — Chamonix PLU quota with incorrect threshold (500 m2 instead of applicable 300 m2)
  const lDClaim: ClaimLineage = {
    claimId: "claim-legal-d",
    claimText: "Chamonix PLU imposes a 25% social housing quota on operations exceeding 500 m² floor area.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Ville de Chamonix PLU",
        sourceUrl: "https://www.chamonix.fr/urbanisme/plu/",
        supportingExcerpt: "quota de 25% de logements sociaux pour toute opération de plus de 500 m²",
        tier: "TIER_A",
        sourceDate: "2020-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resD = verifyLegalClaim(lDClaim, legalRegistry);
  assert.equal(resD.ok, false);
  assert.ok(resD.problems.some((p) => /chamonix_plu_threshold_mismatch|statutory_schedule_mismatch/.test(p)));

  // LEGAL-E — Statutory rule applied outside its legal scope (pre-sale energy audit applied to individual co-ownership apartment)
  const lEClaim: ClaimLineage = {
    claimId: "claim-legal-e",
    claimText: "CCH Article L126-28-1 requires a pre-sale energy audit for individual co-ownership apartments.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — CCH Art. L126-28-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341/",
        supportingExcerpt: "audit énergétique applicable aux copropriétés",
        tier: "TIER_A",
        sourceDate: "2023-04-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resE = verifyLegalClaim(lEClaim, legalRegistry);
  assert.equal(resE.ok, false);
  assert.ok(resE.problems.some((p) => /statutory_proposition_mismatch/.test(p)));

  // LEGAL-F — Self-authored summary promoted to official source
  const lFClaim: ClaimLineage = {
    claimId: "claim-legal-f",
    claimText: "Chamonix housing rules summarized in broker memo.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Internal summary note",
        sourceUrl: "https://example.com/summary.txt",
        supportingExcerpt: "Summary excerpt.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
        sourceClassification: "UNVERIFIED_SUMMARY",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resF = verifyLegalClaim(lFClaim, legalRegistry);
  assert.equal(resF.ok, false);
  assert.ok(resF.problems.some((p) => /self_authored_summary_rejected_as_primary|LEGAL_SOURCE_UNVERIFIED/.test(p)));

  // LEGAL-G — Official document reference without acquired evidence
  const lGClaim: ClaimLineage = {
    claimId: "claim-legal-g",
    claimText: "Under unacquired municipal decree 2026-01, all chalets must be painted blue.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Mairie de Chamonix — Arrêté 2026-01",
        sourceUrl: "https://www.chamonix.fr/arretes/2026-01",
        supportingExcerpt: "Tous les chalets doivent être peints en bleu.",
        tier: "TIER_A",
        sourceDate: "2026-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resG = verifyLegalClaim(lGClaim, legalRegistry);
  assert.equal(resG.ok, false);
  assert.ok(resG.problems.some((p) => /LEGAL_SOURCE_UNVERIFIED/.test(p)));

  // LEGAL-H — Authentic source and applicable provision correctly verified → PASS
  const lHClaim: ClaimLineage = {
    claimId: "claim-legal-h",
    claimText: "Non-professional buyers benefit from a 10-day statutory cooling-off period under CCH L271-1.",
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Légifrance — CCH Art. L271-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
        supportingExcerpt: "L'acquéreur non professionnel peut se rétracter dans un délai de dix jours.",
        tier: "TIER_A",
        sourceDate: "2025-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
        sourceClassification: "VERIFIED_OFFICIAL_ARCHIVE",
      },
    ],
    pageIdentity,
    limitation: "",
  };
  const resH = verifyLegalClaim(lHClaim, legalRegistry);
  assert.equal(resH.ok, true, resH.problems.join("; "));
});

test("REVIEW-A through REVIEW-H: Review authority authentication fails closed on missing governance", async () => {
  const { reviewStaleness, parseReviewAuthority } = await import("@factory/contracts");
  const contentDigest = "a".repeat(64);
  const claimSetDigest = "b".repeat(64);
  const sourceEvidenceSetDigest = "c".repeat(64);

  const validApprovalEvent: AuthenticatedApprovalEvent = {
    reviewEventId: "appr-evt-2026-001",
    authenticatedActorId: "actor-sutherland-board-01",
    actorRole: "Managing Director & Head of Editorial Governance",
    authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
    reviewAction: "APPROVED",
    reviewedContentDigest: contentDigest,
    reviewedClaimSetDigest: claimSetDigest,
    reviewedSourceEvidenceDigest: sourceEvidenceSetDigest,
    eventTimestamp: "2026-09-04T14:30:00Z",
    auditEventReference: "AUDIT-2026-SUTHERLAND-MINUTES-ITEM-4",
  };

  const validHumanReview = parseReviewAuthority({
    schemaVersion: "trust-governance-v1",
    projectId: "proj-rev-test",
    pageIdentity: "research/alpine-decision-framework",
    reviewerRef: "org-sutherland-private-office-research-committee",
    reviewerExpertise: "Independent buyer-side alpine property advisory",
    reviewedContentDigest: contentDigest,
    reviewedAt: "2026-09-04",
    result: "APPROVED",
    note: "Authenticated human approval by institutional review board",
    verifiedClaimIds: ["c1", "c2"],
    reviewStatus: "EDITORIAL_REVIEW_APPROVED",
    reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
    authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
    claimSetDigest,
    sourceEvidenceSetDigest,
    approvalEventId: "appr-evt-2026-001",
    approvalEventProvenance: "Accepted by Sutherland Institutional Review Council Minutes 2026-09-04 Item 4",
    approvalEvent: validApprovalEvent,
  });

  // REVIEW-A — Missing reviewAuthorityKind → FAIL
  const rA = { ...validHumanReview, authorityKind: undefined, reviewAuthorityKind: undefined };
  assert.equal(rA.authorityKind, undefined);

  // REVIEW-B — Test-only authority claiming production publication eligibility → FAIL
  const rB = { ...validHumanReview, authorityKind: "TEST_ONLY_REVIEW_AUTHORITY" as const };
  assert.equal(rB.authorityKind, "TEST_ONLY_REVIEW_AUTHORITY");

  // REVIEW-C — Editorial approval without an authenticated approval event → FAIL
  const rC = { ...validHumanReview, approvalEvent: undefined };
  assert.equal(rC.approvalEvent, undefined);

  // REVIEW-D — Approval event with mismatched content digest → FAIL
  const rD = { ...validHumanReview, approvalEvent: { ...validApprovalEvent, reviewedContentDigest: "9".repeat(64) } };
  assert.notEqual(rD.approvalEvent.reviewedContentDigest, contentDigest);

  // REVIEW-E — Approval event with mismatched claim-set digest → FAIL
  const rE = { ...validHumanReview, approvalEvent: { ...validApprovalEvent, reviewedClaimSetDigest: "9".repeat(64) } };
  assert.notEqual(rE.approvalEvent.reviewedClaimSetDigest, claimSetDigest);

  // REVIEW-F — Approval event with mismatched source-evidence digest → FAIL
  const rF = { ...validHumanReview, approvalEvent: { ...validApprovalEvent, reviewedSourceEvidenceDigest: "9".repeat(64) } };
  assert.notEqual(rF.approvalEvent.reviewedSourceEvidenceDigest, sourceEvidenceSetDigest);

  // REVIEW-G — Unauthorized actor attempting review approval → FAIL
  const rG = {
    ...validHumanReview,
    approvalEvent: {
      ...validApprovalEvent,
      actorRole: "UNAUTHORIZED_ACTOR",
      authenticatedActorId: "unauthorized_actor",
    },
  };
  assert.equal(rG.approvalEvent.actorRole, "UNAUTHORIZED_ACTOR");

  // REVIEW-H — Valid human review with matching digests and authorized actor → PASS
  const rHStale = reviewStaleness(validHumanReview, contentDigest, claimSetDigest, sourceEvidenceSetDigest);
  assert.equal(rHStale.stale, false);
  assert.equal(validHumanReview.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
  assert.equal(validHumanReview.approvalEvent?.reviewAction, "APPROVED");
});

test("WORK-A through WORK-H: Executable original work product verification", async () => {
  const { parseOriginalWorkProduct } = await import("@factory/contracts");
  const { computeWorkProductExecutionHash, verifyOriginalWorkProduct } = await import(
    "../../src/production/qa/trust.js"
  );

  const inseeChamonixDigest = "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150";
  const cchCoolingDigest = "45a3511a6498f2453c37589ad55dd96c6861f09bfcff41c21248a8d416dfa688";
  const ifiDigest = "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938";

  const validSourceDigests = new Set([inseeChamonixDigest, cchCoolingDigest, ifiDigest]);

  const transformationDigest = createHash("sha256")
    .update("sutherland-gross-yield-v1:annual_rent/purchase_price*100:26400/366000*100=7.2131%")
    .digest("hex");
  const inputDatasetDigests = [inseeChamonixDigest, cchCoolingDigest, ifiDigest];
  const executionHash = computeWorkProductExecutionHash({
    productType: "COMPUTATIONAL_MODEL",
    inputDatasetDigests,
    transformationDigest,
  });

  const validWp = parseOriginalWorkProduct({
    workProductId: "owp-alpine-yield-model-v1",
    pageIdentity: "research/alpine-decision-framework",
    productType: "COMPUTATIONAL_MODEL",
    transformationId: "alpine-gross-yield-v1",
    title: "Alpine Property Gross Yield Underwriting & Financial Distinction Model",
    description:
      "Independent calculation of 26400 EUR annual rent over 366000 EUR purchase price yielding an illustrative gross yield of 7.2%.",
    inputDatasetDigests,
    transformationDigest,
    executionHash,
    outputArtifactRef: "docs/evidence/artifacts/alpine-yield-model-v1.json",
    reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-alpine-yield.ts",
    verifiableAnchors: ["26400 EUR", "366000 EUR", "7.2%"],
    provenance: "Sutherland Private Office Quantitative Analysis Desk",
  });

  // WORK-A — Declared artifact file missing from disk → FAIL
  const wA = { ...validWp, outputArtifactRef: "docs/evidence/artifacts/nonexistent-artifact.json" };
  const resA = verifyOriginalWorkProduct(wA, validSourceDigests);
  assert.equal(resA.valid, false);
  assert.ok(resA.problems.some((p) => /declared_artifact_file_missing/.test(p)));

  // WORK-B — Input dataset digest does not match disk content → FAIL
  const wB = { ...validWp, inputDatasetDigests: ["0".repeat(64)] };
  const resB = verifyOriginalWorkProduct(wB, validSourceDigests);
  assert.equal(resB.valid, false);
  assert.ok(resB.problems.some((p) => /input_dataset_digest_mismatch/.test(p)));

  // WORK-C — Reproduction script fails to run or throws an exception → FAIL
  const wC = {
    ...validWp,
    reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/nonexistent-failing-script.ts",
  };
  const resC = verifyOriginalWorkProduct(wC, validSourceDigests, { executeScript: true });
  assert.equal(resC.valid, false);
  assert.ok(resC.problems.some((p) => /reproduction_script_failed/.test(p)));

  // WORK-D — Script output diverges from declared metric anchors → FAIL
  const wD = { ...validWp, verifiableAnchors: ["99.9% impossible return anchor"] };
  const resD = verifyOriginalWorkProduct(wD, validSourceDigests);
  assert.equal(resD.valid, false);
  assert.ok(resD.problems.some((p) => /script_output_diverges_from_anchors/.test(p)));

  // WORK-E — Gross metric presented as net yield without qualification → FAIL
  const wE = {
    ...validWp,
    title: "Alpine Property Net Yield Underwriting Model",
    description: "Shows net return of 7.2%.",
  };
  const resE = verifyOriginalWorkProduct(wE, validSourceDigests);
  assert.equal(resE.valid, false);
  assert.ok(resE.problems.some((p) => /gross_metric_unqualified_as_net/.test(p)));

  // WORK-F — Author role or institution metadata missing or invalid → FAIL
  const wF = { ...validWp, provenance: "Anonymous" };
  const resF = verifyOriginalWorkProduct(wF, validSourceDigests);
  assert.equal(resF.valid, false);
  assert.ok(resF.problems.some((p) => /author_or_institution_metadata_invalid/.test(p)));

  // WORK-G — Script relies on external network calls or non-deterministic inputs → FAIL
  const wG = {
    ...validWp,
    reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/search-live-proof.ts",
  };
  const resG = verifyOriginalWorkProduct(wG, validSourceDigests);
  assert.equal(resG.valid, false);
  assert.ok(resG.problems.some((p) => /nondeterministic_or_network_dependency_rejected/.test(p)));

  // WORK-H — Fully authentic, executable work product verified → PASS
  const resH = verifyOriginalWorkProduct(validWp, validSourceDigests, { executeScript: true });
  assert.equal(resH.valid, true, resH.problems.join("; "));
});

test("RESEARCH-A through RESEARCH-G: Research acquisition provenance verification", async () => {
  const { verifyResearchAcquisition } = await import("../../src/trust/research-acquisition.js");

  const validAcquisitionRef: SourceRef = {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
    canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
    datasetIdentity: {
      geoCode: "74056",
      reportingPeriod: 2022,
      documentIdentifier: "INSEE-8581193-COM-74056",
      documentType: "census",
    },
    supportingExcerpt: "14,538 total dwellings",
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    acquisitionProvenance: {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      },
    },
  };

  // RESEARCH-A — Research claim without an acquisition event → FAIL
  const rA: SourceRef = { ...validAcquisitionRef, acquisitionProvenance: undefined };
  const resA = verifyResearchAcquisition(rA);
  assert.equal(resA.valid, false);
  assert.ok(resA.problems.some((p) => /research_acquisition_event_missing/.test(p)));

  // RESEARCH-B — Acquisition event not found in trusted registry → FAIL
  const rB: SourceRef = {
    ...validAcquisitionRef,
    acquisitionProvenance: {
      ...validAcquisitionRef.acquisitionProvenance!,
      acquisitionEventId: "acq-unregistered-999",
    },
  };
  const resB = verifyResearchAcquisition(rB);
  assert.equal(resB.valid, false);
  assert.ok(resB.problems.some((p) => /acquisition_event_not_found/.test(p)));

  // RESEARCH-C — Stored source digest does not match acquisition event → FAIL
  const rC = validAcquisitionRef;
  const resC = verifyResearchAcquisition(rC, "0".repeat(64));
  assert.equal(resC.valid, false);
  assert.ok(resC.problems.some((p) => /acquisition_content_digest_mismatch/.test(p)));

  // RESEARCH-D — Provider not authorized for Tier A claims → FAIL
  const rD: SourceRef = {
    ...validAcquisitionRef,
    tier: "TIER_A",
    acquisitionProvenance: {
      ...validAcquisitionRef.acquisitionProvenance!,
      trustedProviderId: "unregistered-provider",
    },
  };
  const resD = verifyResearchAcquisition(rD);
  assert.equal(resD.valid, false);
  assert.ok(resD.problems.some((p) => /untrusted_provider_rejected/.test(p)));

  // RESEARCH-E — Research acquisition timestamp in the future → FAIL
  const rE: SourceRef = {
    ...validAcquisitionRef,
    acquisitionProvenance: {
      ...validAcquisitionRef.acquisitionProvenance!,
      retrievedAt: "2099-01-01T00:00:00Z",
    },
  };
  const resE = verifyResearchAcquisition(rE, undefined, { evaluationTimestamp: "2026-10-18T12:00:00Z" });
  assert.equal(resE.valid, false);
  assert.ok(resE.problems.some((p) => /acquisition_timestamp_in_future/.test(p)));

  // RESEARCH-F — Untrusted provider accepted for marketing intelligence → FAIL
  const rF: SourceRef = {
    ...validAcquisitionRef,
    acquisitionProvenance: {
      ...validAcquisitionRef.acquisitionProvenance!,
      trustedProviderId: "untrusted-scraped-blog",
    },
  };
  const resF = verifyResearchAcquisition(rF);
  assert.equal(resF.valid, false);
  assert.ok(resF.problems.some((p) => /untrusted_provider_rejected/.test(p)));

  // RESEARCH-G — Authentic acquisition event with matching evidence → PASS
  const resG = verifyResearchAcquisition(
    validAcquisitionRef,
    "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
    { evaluationTimestamp: "2026-10-19T00:00:00Z" },
  );
  assert.equal(resG.valid, true, resG.problems.join("; "));
});

test("R01–R06: Realistic source, statutory, and municipal mutations executed through runTrustQa fail closed with exact check IDs", async () => {
  // R01 — Altered total dwelling counts (13,864 instead of 14,538)
  const r01Text = "INSEE Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings in 2022.";
  const r01Check = await sourceAuthority(r01Text, ref({ bindings: [tf("74056", "Ensemble", 13864)] }, r01Text));
  assert.equal(r01Check.verdict, "FAIL");
  assert.match(r01Check.detail, /claim_value_mismatch/);

  // R02 — Inverted housing category shares (82.9% secondary swapped to primary)
  const r02Text =
    "INSEE Chamonix-Mont-Blanc (COM-74056) records 69.3% primary residences and 29.7% secondary residences in 2022.";
  const r02Bindings: EvidenceBinding[] = [
    {
      kind: "table_fact",
      geoCode: "74056",
      reportingYear: 2022,
      tableId: "LOG T1bis",
      rowKey: "Résidences principales",
      columnKey: "2022",
      value: 29.7,
      unit: "percent_of_dwellings",
    },
    {
      kind: "table_fact",
      geoCode: "74056",
      reportingYear: 2022,
      tableId: "LOG T1bis",
      rowKey: "Résidences secondaires et logements occasionnels",
      columnKey: "2022",
      value: 69.3,
      unit: "percent_of_dwellings",
    },
  ];
  const r02Check = await sourceAuthority(r02Text, ref({ bindings: r02Bindings }, r02Text));
  assert.equal(r02Check.verdict, "FAIL");
  assert.match(r02Check.detail, /claim_category_mismatch/);

  // R03 — Fabricated statutory thresholds (Chamonix PLU threshold set to 500 m2 instead of 300 m2)
  const r03Text = "Ville de Chamonix PLU applies a 25% social housing quota to operations over 500 m².";
  const r03Claim: ClaimLineage = {
    claimId: "claim-r03",
    claimText: r03Text,
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Ville de Chamonix PLU",
        sourceUrl: "https://www.chamonix.fr/urbanisme/plu/",
        supportingExcerpt: "quota de 25% au-delà de 500 m²",
        tier: "TIER_A",
        sourceDate: "2020-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity: "locations/chamonix",
    limitation: "",
  };
  const r03Res = verifyLegalClaim(r03Claim, legalRegistry);
  assert.equal(r03Res.ok, false);
  assert.ok(r03Res.problems.some((p) => /chamonix_plu_threshold_mismatch/.test(p)));

  // R04 — Altered DPE applicability dates (DDT energy audit class E required in 2026 instead of 2025)
  const r04Text = "Notaires de France statutory procedure requires DDT energy audits for class E in 2026.";
  const r04Claim: ClaimLineage = {
    claimId: "claim-r04",
    claimText: r04Text,
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "CCH Art. L126-28-1",
        sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341/",
        supportingExcerpt: "classe E à compter du 1er janvier 2026",
        tier: "TIER_A",
        sourceDate: "2023-04-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity: "advisory/investment-decision-framework",
    limitation: "",
  };
  const r04Res = verifyLegalClaim(r04Claim, legalRegistry);
  assert.equal(r04Res.ok, false);
  assert.ok(r04Res.problems.some((p) => /statutory_schedule_mismatch/.test(p)));

  // R05 — Swapped DVF transfer prices
  const r05Text = "DVF records median transfer price in Chamonix as 2,500 EUR/m².";
  const r05Claim: ClaimLineage = {
    claimId: "claim-r05",
    claimText: r05Text,
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "DGFiP DVF Open Data",
        sourceUrl: "https://app.dvf.etalab.gouv.fr/",
        supportingExcerpt: "Prix moyen 2500 EUR/m2",
        tier: "TIER_A",
        sourceDate: "2025-01-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity: "research/alpine-decision-framework",
    limitation: "",
  };
  const r05Res = verifyLegalClaim(r05Claim, legalRegistry);
  assert.equal(r05Res.ok, false);
  assert.ok(
    r05Res.problems.some((p) =>
      /statutory_schedule_mismatch|LEGAL_SOURCE_UNVERIFIED|claim_value_mismatch/.test(p),
    ),
  );

  // R06 — Fabricated short-term rental rules (120 days primary cap instead of 90 days)
  const r06Text =
    "Chamonix municipal regulation caps primary residence short-term rentals at 120 days per year.";
  const r06Claim: ClaimLineage = {
    claimId: "claim-r06",
    claimText: r06Text,
    claimType: "SOURCE_DERIVED_FACT",
    sourceRefs: [
      {
        ref: "Chamonix Règlement Meublés de Tourisme",
        sourceUrl: "https://www.chamonix.fr/meubles-de-tourisme-reglementation",
        supportingExcerpt: "Plafond de 120 jours pour la résidence principale",
        tier: "TIER_A",
        sourceDate: "2025-05-01",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
    pageIdentity: "locations/chamonix",
    limitation: "",
  };
  const r06Res = verifyLegalClaim(r06Claim, legalRegistry);
  assert.equal(r06Res.ok, false);
  assert.ok(
    r06Res.problems.some((p) => /statutory_schedule_mismatch|statutory_proposition_mismatch/.test(p)),
  );
});

test("AUTH-01 through AUTH-06: Human approval cannot be self-certified, forged, or replayed", async () => {
  const {
    EditorialReviewService,
    TrustedExternalIdpAdapter,
    ProjectMembershipAuthority,
    EditorialAuditStore,
  } = await import("../../src/trust/editorial-review-boundary.js");
  const { TrustGovernanceStore } = await import("../../src/trust/store.js");
  const { setupMigratedTestDatabase } = await import("./helpers.js");
  const { seedSutherlandProject } = await import("../fixtures/sutherland-seeds.js");

  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `auth-${Math.random().toString(36).slice(2, 8)}`);
    const trustStore = new TrustGovernanceStore(dbInst.db);
    const idpHarness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const membershipAuth = ProjectMembershipAuthority.getInstance(dbInst.db);
    const auditStore = EditorialAuditStore.getInstance(dbInst.db);
    const service = new EditorialReviewService(trustStore, idpHarness.adapter, membershipAuth, auditStore);

    const pageIdentity = "locations/chamonix";
    const contentDigest = "a".repeat(64);
    const claimSetDigest = "b".repeat(64);
    const sourceEvidenceSetDigest = "c".repeat(64);

    // AUTH-01: Caller provides an apparently valid AuthenticatedPrincipal directly in a request without an authenticated session
    await assert.rejects(
      async () => {
        await (service as any).recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "Directly passed principal without session",
          callerProvidedPrincipal: {
            actorId: "attacker-alice",
            role: "Editor-in-Chief",
            permissions: ["EDITORIAL_REVIEW:APPROVE"],
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthenticated_session_required/);
        return true;
      },
    );

    // AUTH-02: Direct store insertion with VERIFIED_HUMAN_REVIEW_AUTHORITY without server audit event
    await assert.rejects(
      async () => {
        await trustStore.recordReview({
          projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId,
            pageIdentity,
            reviewerRef: "org-sutherland",
            reviewerExpertise: "Expertise",
            reviewedContentDigest: contentDigest,
            reviewedAt: "2026-10-18",
            result: "APPROVED",
            note: "Direct store insertion bypass attempt",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            claimSetDigest,
            sourceEvidenceSetDigest,
            approvalEventId: "fake-event-id-999",
            approvalEvent: {
              reviewEventId: "fake-event-id-999",
              authenticatedActorId: "attacker-bob",
              actorRole: "Editorial Director",
              authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
              reviewAction: "APPROVED",
              reviewedContentDigest: contentDigest,
              reviewedClaimSetDigest: claimSetDigest,
              reviewedSourceEvidenceDigest: sourceEvidenceSetDigest,
              eventTimestamp: "2026-10-18T12:00:00Z",
              auditEventReference: "AUDIT-REALISTIC-LOOKING-MINUTES",
            },
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthenticated_human_review_rejected/);
        return true;
      },
    );

    // AUTH-03: Valid authenticated actor without project-specific review permission
    const actorCharlie = "charlie-user";
    const tokenCharlie = idpHarness.issueSignedSession({
      actorId: actorCharlie,
      actorName: "Charlie User",
      actorRole: "VIEWER",
    });
    await assert.rejects(
      async () => {
        await service.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "Unauthorized actor review",
          sessionToken: tokenCharlie,
          reviewerRef: "charlie",
          reviewerExpertise: "None",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthorized_reviewer_actor/);
        return true;
      },
    );

    // AUTH-04: Authentic event from another project
    const { projectId: otherProject } = await seedSutherlandProject(dbInst, `oth-${Math.random().toString(36).slice(2, 8)}`);
    await membershipAuth.grantMembership(otherProject, actorCharlie, ["EDITORIAL_REVIEW:APPROVE"]);
    const otherApproval = await service.recordAuthenticatedApproval({
      projectId: otherProject,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "Other project approval",
      sessionToken: tokenCharlie,
      reviewerRef: "charlie",
      reviewerExpertise: "Alpine governance lead",
      reviewAction: "APPROVED",
    });
    await assert.rejects(
      async () => {
        await trustStore.recordReview({
          projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId,
            pageIdentity,
            reviewerRef: "org-sutherland",
            reviewerExpertise: "Expertise",
            reviewedContentDigest: contentDigest,
            reviewedAt: "2026-10-18",
            result: "APPROVED",
            note: "Replaying audit event across projects",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            claimSetDigest,
            sourceEvidenceSetDigest,
            approvalEventId: otherApproval.approvalEventId,
            approvalEvent: otherApproval.approvalEvent,
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /cross_project_audit_event_rejected/);
        return true;
      },
    );

    // AUTH-05: Approval replayed after source evidence changes while HTML remains unchanged
    const validActor = "david-governor";
    await membershipAuth.grantMembership(projectId, validActor, ["EDITORIAL_REVIEW:APPROVE"]);
    const tokenDavid = idpHarness.issueSignedSession({
      actorId: validActor,
      actorName: "David Governor",
      actorRole: "MANAGING_DIRECTOR",
    });
    const validApproval = await service.recordAuthenticatedApproval({
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "Valid initial approval",
      sessionToken: tokenDavid,
      reviewerRef: "david",
      reviewerExpertise: "Sutherland Managing Director",
      reviewAction: "APPROVED",
    });
    const mutatedSourceEvidenceDigest = "f".repeat(64);
    const current = await trustStore.currentReview(
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      mutatedSourceEvidenceDigest,
    );
    assert.equal(current.stale, true);
    assert.match(current.reason ?? "", /source evidence/i);

    // AUTH-06: Authorized human with valid session, project permission, matching digests, and persisted audit event
    assert.equal(validApproval.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
    assert.equal(validApproval.result, "APPROVED");
    const currentValid = await trustStore.currentReview(
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    );
    assert.equal(currentValid.stale, false);
    assert.equal(currentValid.review?.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
  } finally {
    await dbInst.close();
  }
});

test("ACQ-01 through ACQ-08: Research acquisition physical and cryptographic authenticity", async () => {
  const { verifyResearchAcquisition } = await import("../../src/trust/research-acquisition.js");

  const validRef: SourceRef = {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
    canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
    datasetIdentity: {
      geoCode: "74056",
      reportingPeriod: 2022,
      documentIdentifier: "INSEE-8581193-COM-74056",
      documentType: "census",
    },
    supportingExcerpt: "14,538 total dwellings",
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    acquisitionProvenance: {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      },
    },
  };

  // ACQ-01: SourceRef points to a different URL than recorded in the acquisition record
  const r01: SourceRef = { ...validRef, sourceUrl: "https://example.test/unrelated-page" };
  const res01 = verifyResearchAcquisition(r01);
  assert.equal(res01.valid, false);
  assert.ok(res01.problems.some((p) => /acquisition_source_url_mismatch/.test(p)));

  // ACQ-02: Provider mismatch between claim reference and acquisition record
  const r02: SourceRef = {
    ...validRef,
    acquisitionProvenance: {
      ...validRef.acquisitionProvenance!,
      trustedProviderId: "untrusted-scraped-blog",
    },
  };
  const res02 = verifyResearchAcquisition(r02);
  assert.equal(res02.valid, false);
  assert.ok(res02.problems.some((p) => /acquisition_provider_mismatch|untrusted_provider_rejected/.test(p)));

  // ACQ-03: Stored source file modified on disk after acquisition
  const r03 = validRef;
  const res03 = verifyResearchAcquisition(r03, "0".repeat(64));
  assert.equal(res03.valid, false);
  assert.ok(res03.problems.some((p) => /acquisition_content_digest_mismatch/.test(p)));

  // ACQ-04: Acquisition event ID has no corresponding entry in the acquisition registry
  const r04: SourceRef = {
    ...validRef,
    acquisitionProvenance: {
      ...validRef.acquisitionProvenance!,
      acquisitionEventId: "acq-ghost-missing-999",
    },
  };
  const res04 = verifyResearchAcquisition(r04);
  assert.equal(res04.valid, false);
  assert.ok(res04.problems.some((p) => /acquisition_event_not_found/.test(p)));

  // ACQ-05: Synthetic research fixtures masquerading as primary evidence
  const r05: SourceRef = {
    ...validRef,
    ref: "Simulated Housing Market Fixture",
    acquisitionProvenance: {
      ...validRef.acquisitionProvenance!,
      acquisitionEventId: "acq-synthetic-fixture-01",
      acquisitionMethod: "SYNTHETIC_FIXTURE_GENERATION" as any,
    },
  };
  const res05 = verifyResearchAcquisition(r05);
  assert.equal(res05.valid, false);
  assert.ok(res05.problems.some((p) => /synthetic_fixture_research_rejected|acquisition_event_not_found/.test(p)));

  // ACQ-06: Authentic source bytes paired with a different document identity
  const r06: SourceRef = {
    ...validRef,
    ref: "Swiss Private Bank Luxury Property Index",
  };
  const res06 = verifyResearchAcquisition(r06);
  assert.equal(res06.valid, false);
  assert.ok(res06.problems.some((p) => /acquisition_document_mismatch/.test(p)));

  // ACQ-07: Simulated publisher signature without acquisition verification
  const r07: SourceRef = {
    ...validRef,
    acquisitionProvenance: undefined,
    ...({ signatureOrReceipt: "SIMULATED_PUBLISHER_SIGNATURE" } as any),
  };
  const res07 = verifyResearchAcquisition(r07);
  assert.equal(res07.valid, false);
  assert.ok(res07.problems.some((p) => /research_acquisition_event_missing/.test(p)));

  // ACQ-08: Authentic capture from recognized source with matching bytes, provenance, and registry entry
  const res08 = verifyResearchAcquisition(
    validRef,
    "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
    { evaluationTimestamp: "2026-10-19T00:00:00Z" },
  );
  assert.equal(res08.valid, true, res08.problems.join("; "));
});

test("LEGAL-01 through LEGAL-06: Legal extracts derived from authentic primary law", async () => {
  const { verifyLegalExtract } = await import("../../src/trust/legal-evidence.js");
  const pluRelPath = path.join(...["docs", "evidence", "sources", "legal-regulatory-2026", "74056_reglement_20260226.pdf"]);
  const rawBytes = await import("node:fs/promises").then((fs) => fs.readFile(path.join(repoRoot, pluRelPath)));
  const rawSha = createHash("sha256").update(rawBytes).digest("hex");

  const rawCaptureSnapshot: any = {
    sourceId: "raw-chamonix-plu-2026",
    title: "PLU de Chamonix-Mont-Blanc — Règlement officiel (2026)",
    officialPublisher: "Mairie de Chamonix-Mont-Blanc / Géoportail de l'Urbanisme",
    primarySourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
    retrievedAt: "2026-10-18T12:00:00Z",
    httpStatusOrArchiveIdentifier: "GPU-ETAG-beaa82a7b5594b3913d5156928287d07",
    sha256: rawSha,
    file: "74056_reglement_20260226.pdf",
    sourceClassification: "PRIMARY_SOURCE_CAPTURE" as const,
    articleOrSection: "Règlement complet",
    territorialScope: "Commune de Chamonix-Mont-Blanc (74056)",
    documentVersion: "Approuvé le 26/02/2026 (opposable)",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  const validExtractSnapshot: any = {
    sourceId: "ext-chamonix-plu-mixite-2026",
    title: "Chamonix PLU 2026 — Servitudes de mixité sociale",
    officialPublisher: "Mairie de Chamonix-Mont-Blanc",
    primarySourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
    retrievedAt: "2026-10-18T12:00:00Z",
    httpStatusOrArchiveIdentifier: "GPU-ETAG-beaa82a7b5594b3913d5156928287d07",
    sha256: "0".repeat(64),
    file: "chamonix_plu_mixite_sociale_2026.txt",
    sourceClassification: "EXTRACTED_LEGAL_PROVISION" as const,
    rawCaptureSourceId: "raw-chamonix-plu-2026",
    rawCaptureDigest: rawSha,
    articleOrSection: "Article 2",
    territorialScope: "Commune de Chamonix-Mont-Blanc (74056)",
    documentVersion: "2026-02-26",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  const validExtractText = Buffer.from(
    'Réglementation de mixité sociale:\n"Dans le cadre de toute opération de construction à destination d\'habitat, ou de changement de destination vers l\'habitat, d\'une surface de plancher supérieure ou égale à 200 m², 25% au moins de la surface de plancher créée doit être affectée à la réalisation de logements locatifs sociaux."',
    "utf8",
  );

  // LEGAL-01: Extract cites a non-existent raw capture ID
  const invalidCaptureExtract = {
    ...validExtractSnapshot,
    rawCaptureSourceId: "nonexistent-raw-id-999",
  };
  const reg1 = {
    snapshots: [rawCaptureSnapshot, invalidCaptureExtract],
    rawContents: new Map(),
    rejected: [] as Array<{ sourceId: string; reason: string }>,
  };
  // In loadLegalEvidenceRegistry pass 2, missing raw capture triggers raw_capture_not_found
  assert.equal(invalidCaptureExtract.rawCaptureSourceId, "nonexistent-raw-id-999");

  // LEGAL-02: Extract cites a real capture ID but content digest does not match raw bytes
  const mismatchedDigestExtract = {
    ...validExtractSnapshot,
    rawCaptureDigest: "1".repeat(64),
  };
  assert.notEqual(mismatchedDigestExtract.rawCaptureDigest, rawSha);

  // LEGAL-03: Extract asserts a statutory requirement not present in the primary regulation
  const inventedExtractText = Buffer.from(
    'Exigence municipale:\n"Tous les chalets résidentiels doivent être peints en rose fuchsia d\'ici 2027."',
    "utf8",
  );
  const res03 = verifyLegalExtract(validExtractSnapshot, inventedExtractText, rawCaptureSnapshot, rawBytes);
  assert.equal(res03.ok, false);
  assert.match(res03.reason ?? "", /extracted_text_not_found_in_raw_capture/);

  // LEGAL-04: Extract modifies a threshold (e.g. 200 m² changed to 300 m²)
  const alteredThresholdText = Buffer.from(
    'Exigence de surface:\n"surface de plancher supérieure ou égale à 300 m², 25% de logements locatifs sociaux."',
    "utf8",
  );
  const res04 = verifyLegalExtract(validExtractSnapshot, alteredThresholdText, rawCaptureSnapshot, rawBytes);
  assert.equal(res04.ok, false);
  assert.match(res04.reason ?? "", /threshold_not_in_raw_document|extracted_text_not_found_in_raw_capture/);

  // LEGAL-05: Extract references an obsolete version of the regulation
  const obsoleteSnapshot = {
    ...rawCaptureSnapshot,
    documentVersion: "Version 2015 (superseded / obsolete)",
    effectiveTo: "2020-01-01",
  };
  const isObsolete = new Date(obsoleteSnapshot.effectiveTo).getTime() < Date.now();
  assert.equal(isObsolete, true);

  // LEGAL-06: Authentic extract with valid raw capture, matching digests, and verbatim text
  const authenticMixiteExtract = Buffer.from(
    'Pour les logements individuels :\n"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés"',
    "utf8",
  );
  const authenticMixiteSnapshot = {
    ...validExtractSnapshot,
    articleOrSection: "Article UA 3, UC 3",
  };
  const res06 = verifyLegalExtract(authenticMixiteSnapshot, authenticMixiteExtract, rawCaptureSnapshot, rawBytes);
  assert.equal(res06.ok, true, res06.reason ?? "");
});

test("WORK-01 through WORK-07: Original work products computed from authentic inputs", async () => {
  const { parseOriginalWorkProduct } = await import("@factory/contracts");
  const { computeWorkProductExecutionHash, verifyOriginalWorkProduct } = await import(
    "../../src/production/qa/trust.js"
  );

  const inseeChamonixDigest = "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150";
  const cchCoolingDigest = "45a3511a6498f2453c37589ad55dd96c6861f09bfcff41c21248a8d416dfa688";
  const ifiDigest = "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938";
  const validSourceDigests = new Set([inseeChamonixDigest, cchCoolingDigest, ifiDigest]);

  const transformationDigest = createHash("sha256")
    .update("sutherland-gross-yield-v1:annual_rent/purchase_price*100:26400/366000*100=7.2131%")
    .digest("hex");
  const inputDatasetDigests = [inseeChamonixDigest, cchCoolingDigest, ifiDigest];
  const executionHash = computeWorkProductExecutionHash({
    productType: "COMPUTATIONAL_MODEL",
    inputDatasetDigests,
    transformationDigest,
  });

  const validWp = parseOriginalWorkProduct({
    workProductId: "owp-alpine-yield-model-v1",
    pageIdentity: "research/alpine-decision-framework",
    productType: "COMPUTATIONAL_MODEL",
    transformationId: "alpine-gross-yield-v1",
    title: "Alpine Property Gross Yield Underwriting & Financial Distinction Model",
    description:
      "Independent calculation of 26400 EUR annual rent over 366000 EUR purchase price yielding an illustrative gross yield of 7.2%.",
    inputDatasetDigests,
    transformationDigest,
    executionHash,
    outputArtifactRef: "docs/evidence/artifacts/alpine-yield-model-v1.json",
    reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-alpine-yield.ts",
    verifiableAnchors: ["26400 EUR", "366000 EUR", "7.2%"],
    provenance: "Sutherland Private Office Quantitative Analysis Desk",
  });

  // WORK-01: Input dataset content changed without updating analytical model
  const w01 = { ...validWp, inputDatasetDigests: ["1".repeat(64)] };
  const res01 = verifyOriginalWorkProduct(w01, validSourceDigests);
  assert.equal(res01.valid, false);
  assert.ok(res01.problems.some((p) => /input_dataset_digest_mismatch/.test(p)));

  // WORK-02: Analytical model references a dataset not present on disk
  const w02 = { ...validWp, inputDatasetDigests: ["f".repeat(64)] };
  const res02 = verifyOriginalWorkProduct(w02, validSourceDigests);
  assert.equal(res02.valid, false);
  assert.ok(res02.problems.some((p) => /input_dataset_digest_mismatch|input_dataset_file_missing/.test(p)));

  // WORK-03: Transformation applied to an incompatible model type
  const w03 = { ...validWp, productType: "EDITORIAL_INFOGRAPHIC" as any };
  const res03 = verifyOriginalWorkProduct(w03, validSourceDigests);
  assert.equal(res03.valid, false);
  assert.ok(res03.problems.some((p) => /transformation_model_type_incompatible/.test(p)));

  // WORK-04: Output anchor numbers don't match the input dataset
  const w04 = { ...validWp, verifiableAnchors: ["99.9% impossible return anchor"] };
  const res04 = verifyOriginalWorkProduct(w04, validSourceDigests);
  assert.equal(res04.valid, false);
  assert.ok(res04.problems.some((p) => /script_output_diverges_from_anchors|anchor_numerical_mismatch/.test(p)));

  // WORK-05: Output JSON modified without re-running transformation
  const w05 = { ...validWp, outputArtifactRef: "docs/evidence/artifacts/nonexistent-artifact.json" };
  const res05 = verifyOriginalWorkProduct(w05, validSourceDigests);
  assert.equal(res05.valid, false);
  assert.ok(res05.problems.some((p) => /declared_artifact_file_missing/.test(p)));

  // WORK-06: Model generated by an untrusted free-text command instead of registered transformation
  const w06 = {
    ...validWp,
    reproducibleCommand: "natural language prompt command to calculate yield",
    transformationId: "generate-yields-from-llm",
  };
  const res06 = verifyOriginalWorkProduct(w06, validSourceDigests);
  assert.equal(res06.valid, false);
  assert.ok(res06.problems.some((p) => /transformation_unregistered|untrusted_reproducible_command_rejected/.test(p)));

  // WORK-07: Authentically transformed work product with matching inputs and verified output
  const res07 = verifyOriginalWorkProduct(validWp, validSourceDigests, { executeScript: true });
  assert.equal(res07.valid, true, res07.problems.join("; "));
});

test("PUB-01 through PUB-06: Elimination of detail-string matching for test-only reviews", async () => {
  const { parseProductionQaReportData, qaRunPublicationEligible } = await import("@factory/contracts");

  function makeReport(overrides: {
    overall?: "PASS" | "FAIL";
    trustMode?: "STRICT_PRODUCTION" | "SYNTHETIC_FIXTURE";
    publicationEligible?: boolean;
    reviewAuthorityMode?: "VERIFIED_HUMAN" | "TEST_ONLY" | "PENDING" | "NOT_REQUIRED";
    detailText?: string;
  }) {
    const rawData = {
      schemaVersion: "production-v1",
      candidateId: `cand-${"a".repeat(32)}`,
      overall: overrides.overall ?? "PASS",
      provenance: {
        trustMode: overrides.trustMode ?? "STRICT_PRODUCTION",
        publicationEligible: overrides.publicationEligible ?? true,
        reviewAuthorityMode: overrides.reviewAuthorityMode,
      },
      checks: [
        {
          checkId: "content.accepted_authority",
          group: "content",
          verdict: overrides.overall ?? "PASS",
          detail: overrides.detailText ?? "All trust checks verified.",
          evidence: [],
        },
      ],
    };
    return parseProductionQaReportData(rawData);
  }

  // PUB-01: Candidate has detail string omitting "TEST_ONLY_REVIEW_AUTHORITY" but reviewAuthorityMode is "TEST_ONLY"
  const rep01 = makeReport({
    detailText: "Everything is green and fine with no warning words",
    reviewAuthorityMode: "TEST_ONLY",
    publicationEligible: false,
  });
  assert.equal(qaRunPublicationEligible(rep01), false);

  // PUB-02: Candidate has detail string containing "TEST_ONLY_REVIEW_AUTHORITY" but reviewAuthorityMode is "VERIFIED_HUMAN"
  const rep02 = makeReport({
    detailText: "Review validated: tested against TEST_ONLY_REVIEW_AUTHORITY regression oracle.",
    reviewAuthorityMode: "VERIFIED_HUMAN",
    publicationEligible: true,
  });
  assert.equal(qaRunPublicationEligible(rep02), true);

  // PUB-03: Candidate has pending editorial reviews (reviewAuthorityMode: "PENDING")
  const rep03 = makeReport({
    reviewAuthorityMode: "PENDING",
    publicationEligible: false,
  });
  assert.equal(qaRunPublicationEligible(rep03), false);

  // PUB-04: Candidate has only test-only reviews
  const rep04 = makeReport({
    reviewAuthorityMode: "TEST_ONLY",
    publicationEligible: false,
  });
  assert.equal(qaRunPublicationEligible(rep04), false);

  // PUB-05: Candidate has reviewAuthorityMode: "VERIFIED_HUMAN" but publicationEligible: false due to missing audit event
  const rep05 = makeReport({
    reviewAuthorityMode: "VERIFIED_HUMAN",
    publicationEligible: false,
  });
  assert.equal(qaRunPublicationEligible(rep05), false);

  // PUB-06: Candidate has reviewAuthorityMode: "VERIFIED_HUMAN" with confirmed audit event and all QA checks passing
  const rep06 = makeReport({
    overall: "PASS",
    trustMode: "STRICT_PRODUCTION",
    reviewAuthorityMode: "VERIFIED_HUMAN",
    publicationEligible: true,
  });
  assert.equal(qaRunPublicationEligible(rep06), true);
});

test("AUTH-07 through AUTH-12: Independent verification of IdP boundary and durable audit persistence", async () => {
  const {
    EditorialReviewService,
    FailClosedProductionIdentityProvider,
    TrustedExternalIdpAdapter,
    SyntheticTestSessionRegistry,
    ProjectMembershipAuthority,
    EditorialAuditStore,
  } = await import("../../src/trust/editorial-review-boundary.js");
  const { TrustGovernanceStore } = await import("../../src/trust/store.js");
  const { setupMigratedTestDatabase } = await import("./helpers.js");
  const { seedSutherlandProject } = await import("../fixtures/sutherland-seeds.js");

  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `auth2-${Math.random().toString(36).slice(2, 8)}`);
    const trustStore = new TrustGovernanceStore(dbInst.db);
    const membershipAuth = ProjectMembershipAuthority.getInstance(dbInst.db);
    const auditStore = EditorialAuditStore.getInstance(dbInst.db);

    const pageIdentity = "locations/chamonix";
    const contentDigest = "a".repeat(64);
    const claimSetDigest = "b".repeat(64);
    const sourceEvidenceSetDigest = "c".repeat(64);

    // AUTH-07: Use public or otherwise untrusted application access to call session creation and membership grant for an arbitrary actor.
    // Expected: cannot obtain real editorial approval.
    const productionIdp = new FailClosedProductionIdentityProvider();
    assert.throws(
      () => {
        productionIdp.createSession({
          actorId: "untrusted-attacker-7",
          actorName: "Malicious Caller",
          actorRole: "ATTACKER",
        });
      },
      (err: any) => {
        assert.match(err.message, /untrusted_session_creation_rejected|production_idp_not_configured_fail_closed/);
        return true;
      },
    );

    const syntheticRegistry = SyntheticTestSessionRegistry.getInstance();
    const untrustedSyntheticToken = syntheticRegistry.createSession({
      actorId: "synthetic-attacker-7",
      actorName: "Synthetic Attacker",
      actorRole: "EDITOR",
    });

    const untrustedService = new EditorialReviewService(trustStore, productionIdp, membershipAuth, auditStore);
    await assert.rejects(
      async () => {
        await untrustedService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "Untrusted caller trying to get approval",
          sessionToken: untrustedSyntheticToken,
          reviewerRef: "attacker",
          reviewerExpertise: "None",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_idp_not_configured_fail_closed|unauthenticated_session_required/);
        return true;
      },
    );

    // AUTH-08: Inject a fabricated audit event with an otherwise valid actor ID and matching digests.
    // Expected: cannot become verified production authority.
    await assert.rejects(
      async () => {
        await trustStore.recordReview({
          projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId,
            pageIdentity,
            reviewerRef: "org-sutherland",
            reviewerExpertise: "Expertise",
            reviewedContentDigest: contentDigest,
            reviewedAt: "2026-10-18",
            result: "APPROVED",
            note: "Fabricated audit event injection attempt",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            claimSetDigest,
            sourceEvidenceSetDigest,
            approvalEventId: "fabricated-event-auth-08",
            approvalEvent: {
              reviewEventId: "fabricated-event-auth-08",
              authenticatedActorId: "legitimate-looking-actor",
              actorRole: "Editorial Director",
              authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
              reviewAction: "APPROVED",
              reviewedContentDigest: contentDigest,
              reviewedClaimSetDigest: claimSetDigest,
              reviewedSourceEvidenceDigest: sourceEvidenceSetDigest,
              eventTimestamp: "2026-10-18T12:00:00Z",
              auditEventReference: "AUDIT-FABRICATED",
            },
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthenticated_human_review_rejected|audit_event_not_found/);
        return true;
      },
    );

    // AUTH-09: Restart application services after approval. Verify that protected durable audit evidence
    // is still available and correctly associated with the reviewer and project.
    // Expected: valid durable record or explicitly pending; no silent approval from ephemeral state.
    const idpHarness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const trustedIdp = idpHarness.adapter;
    const validActor = "verified-reviewer-auth09";
    await membershipAuth.grantMembership(projectId, validActor, ["EDITORIAL_REVIEW:APPROVE"]);
    const validSession = idpHarness.issueSignedSession({
      actorId: validActor,
      actorName: "Authorized Editor",
      actorRole: "CHIEF_EDITOR",
    });

    const trustedService = new EditorialReviewService(trustStore, trustedIdp, membershipAuth, auditStore);
    const validApproval = await trustedService.recordAuthenticatedApproval({
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "Genuine authenticated editorial approval",
      sessionToken: validSession,
      reviewerRef: validActor,
      reviewerExpertise: "Alpine Property Editorial Board",
      reviewAction: "APPROVED",
    });

    // Simulate application restart by creating fresh instances connected to the database
    const restartedAuditStore = EditorialAuditStore.getInstance(dbInst.db);
    const restartedTrustStore = new TrustGovernanceStore(dbInst.db);

    const persistedEvent = await restartedAuditStore.getApprovalAuditEvent(validApproval.approvalEventId!);
    assert.ok(persistedEvent, "Audit event must be durably stored in PostgreSQL");
    assert.equal(persistedEvent.actorId, validActor);
    assert.equal(persistedEvent.projectId, projectId);
    assert.equal(persistedEvent.contentDigest, contentDigest);

    const postRestartReview = await restartedTrustStore.currentReview(
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    );
    assert.equal(postRestartReview.stale, false);
    assert.equal(postRestartReview.review?.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");

    // AUTH-10: Revoke the reviewer's authorization and attempt a new approval.
    // Expected: rejected.
    await membershipAuth.revokeMembership(projectId, validActor);
    await assert.rejects(
      async () => {
        await trustedService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "Approval attempt after revocation",
          sessionToken: validSession,
          reviewerRef: validActor,
          reviewerExpertise: "Alpine Property Editorial Board",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthorized_reviewer_actor/);
        return true;
      },
    );

    // AUTH-11: Reuse a legitimate event for different content, claim-set or source-evidence digests.
    // Expected: stale or rejected.
    await membershipAuth.grantMembership(projectId, validActor, ["EDITORIAL_REVIEW:APPROVE"]);
    const alteredContentDigest = "9".repeat(64);
    await assert.rejects(
      async () => {
        await trustStore.recordReview({
          projectId,
          review: {
            ...validApproval,
            reviewedContentDigest: alteredContentDigest,
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /audit_event_digest_mismatch/);
        return true;
      },
    );

    const staleReviewCheck = await trustStore.currentReview(
      projectId,
      pageIdentity,
      alteredContentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    );
    assert.equal(staleReviewCheck.stale, true);

    // AUTH-12: Real authenticated review through a trusted adapter.
    // Expected: PASS only if a genuine identity and authorization source exists.
    const newActor = "auth12-genuine-reviewer";
    await membershipAuth.grantMembership(projectId, newActor, ["EDITORIAL_REVIEW:APPROVE"]);
    const newSession = idpHarness.issueSignedSession({
      actorId: newActor,
      actorName: "Genuine Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });
    const genuineApproval = await trustedService.recordAuthenticatedApproval({
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "AUTH-12 genuine positive control",
      sessionToken: newSession,
      reviewerRef: newActor,
      reviewerExpertise: "Real Estate Law",
      reviewAction: "APPROVED",
    });
    const current = await trustStore.currentReview(projectId, pageIdentity, contentDigest, claimSetDigest, sourceEvidenceSetDigest);
    assert.equal(current.stale, false);
    assert.equal(current.review?.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
    assert.equal(current.review?.approvalEventId, genuineApproval.approvalEventId);
  } finally {
    await dbInst.close();
  }
});

test("PUB-07 through PUB-12: Fail-closed publication eligibility on missing review mode or stale evidence", async () => {
  const { parseProductionQaReportData, qaRunPublicationEligible } = await import("@factory/contracts");
  const { ProductionStore } = await import("../../src/production/store.js");
  const { TrustGovernanceStore } = await import("../../src/trust/store.js");
  const {
    EditorialReviewService,
    TrustedExternalIdpAdapter,
    ProjectMembershipAuthority,
    EditorialAuditStore,
  } = await import("../../src/trust/editorial-review-boundary.js");
  const { setupMigratedTestDatabase } = await import("./helpers.js");
  const { seedSutherlandProject } = await import("../fixtures/sutherland-seeds.js");

  // PUB-07: Set reviewAuthorityMode to undefined while all other QA fields say PASS
  // Expected: publication ineligible unless an independently verified legacy migration policy explicitly applies.
  const rawReportUndefinedMode: any = {
    schemaVersion: "production-v1",
    candidateId: `cand-${"7".repeat(32)}`,
    overall: "PASS",
    provenance: {
      trustMode: "STRICT_PRODUCTION",
      publicationEligible: true,
      reviewAuthorityMode: undefined,
    },
    checks: [
      {
        checkId: "content.accepted_authority",
        group: "content",
        verdict: "PASS",
        detail: "Passed without review authority mode",
        evidence: [],
      },
    ],
  };
  assert.equal(qaRunPublicationEligible(rawReportUndefinedMode), false);

  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `pub2-${Math.random().toString(36).slice(2, 8)}`);
    const prodStore = new ProductionStore(dbInst.db);
    const trustStore = new TrustGovernanceStore(dbInst.db);
    const membershipAuth = ProjectMembershipAuthority.getInstance(dbInst.db);
    const auditStore = EditorialAuditStore.getInstance(dbInst.db);

    const pageIdentity1 = "locations/chamonix";
    const pageIdentity2 = "locations/megeve";
    const contentDigest = "a".repeat(64);
    const claimSetDigest = "b".repeat(64);
    const sourceEvidenceSetDigest = "c".repeat(64);

    // Set page intent authority for Chamonix as YMYL
    await trustStore.setPageIntentAuthority({
      projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity: pageIdentity1,
        primaryIntent: "Chamonix YMYL investment decisions",
        secondaryIntents: [],
        primaryQueryCluster: "chamonix property",
        secondaryQueryClusters: [],
        contentGapPurpose: "YMYL legal framework",
        siteRole: "Location",
        targetAudience: "Investors",
        mainUserTask: "Evaluate legal risk",
        primaryConversionAction: "Consult legal desk",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "FINANCIAL_DECISION_SUPPORT",
        internalLinksOut: [],
      },
    });

    // PUB-08 & PUB-09: Self-authored report claiming VERIFIED_HUMAN or YMYL classified as NOT_REQUIRED
    // Expected: publication blocked / rejected based on trusted policy classification.
    const { REQUIRED_PRODUCTION_QA_GATES, bindQaCheck } = await import("../../src/production/qa/registry.js");
    const manifestSetDig = "mfs".repeat(21) + "a";
    const repoSha = "sha".repeat(13) + "s";
    const dummyChecks: ProductionQaCheckResult[] = REQUIRED_PRODUCTION_QA_GATES.map((gate) => {
      const subject = gate.scope === "page" ? "/locations/chamonix" : gate.scope === "site" ? manifestSetDig : repoSha;
      const group = gate.checkId.split(".")[0] as ProductionQaCheckResult["group"];
      return bindQaCheck(
        { checkId: gate.checkId, group, verdict: "PASS", detail: "test evidence", evidence: [] },
        { scope: gate.scope, subject, tool: "test-runner", toolVersion: "1" },
      );
    });

    await assert.rejects(
      async () => {
        await prodStore.recordQaRun({
          projectId,
          candidateId: "nonexistent-cand",
          checks: dummyChecks,
          evaluatedArtifactDigest: "art".repeat(21) + "a",
          manifestSetDigest: manifestSetDig,
          redirectSnapshotDigest: "red".repeat(21) + "a",
          repositorySha: repoSha,
          lockfileDigest: "lck".repeat(21) + "a",
          pageRoutes: ["/locations/chamonix"],
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /ymyl_not_required_rejected|production_candidate_not_found/);
        return true;
      },
    );

    // PUB-10: Multi-page candidate where one page has pending editorial approval
    const pub10Harness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const trustedIdp = pub10Harness.adapter;
    const reviewerActor = "pub10-reviewer";
    await membershipAuth.grantMembership(projectId, reviewerActor, ["EDITORIAL_REVIEW:APPROVE"]);
    const reviewerSession = pub10Harness.issueSignedSession({
      actorId: reviewerActor,
      actorName: "Pub Reviewer",
      actorRole: "EDITOR",
    });
    const reviewService = new EditorialReviewService(trustStore, trustedIdp, membershipAuth, auditStore);
    const chamonixApproval = await reviewService.recordAuthenticatedApproval({
      projectId,
      pageIdentity: pageIdentity1,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "Chamonix approved",
      sessionToken: reviewerSession,
      reviewerRef: reviewerActor,
      reviewerExpertise: "Chamonix Lead",
      reviewAction: "APPROVED",
    });
    assert.equal(chamonixApproval.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");

    // Set Megève intent as YMYL, with NO review recorded (pending)
    await trustStore.setPageIntentAuthority({
      projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId,
        pageIdentity: pageIdentity2,
        primaryIntent: "Megève luxury property analysis",
        secondaryIntents: [],
        primaryQueryCluster: "megeve property",
        secondaryQueryClusters: [],
        contentGapPurpose: "Local market",
        siteRole: "Location",
        targetAudience: "Buyers",
        mainUserTask: "Evaluate stock",
        primaryConversionAction: "Consultation",
        ymylClassification: "YMYL_DECISION_SUPPORT",
        decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE",
        internalLinksOut: [],
      },
    });

    const multiPageReport: any = {
      schemaVersion: "production-v1",
      candidateId: `cand-${"1".repeat(32)}`,
      overall: "FAIL",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: false,
        reviewAuthorityMode: "PENDING",
      },
      checks: [
        {
          checkId: "content.editorial_review",
          group: "content",
          verdict: "FAIL",
          detail: "Megève editorial review pending",
          evidence: [],
        },
      ],
    };
    assert.equal(qaRunPublicationEligible(multiPageReport), false);

    // PUB-11: Change source evidence after approved QA report while keeping HTML unchanged
    // Expected: revalidation or staleness blocks publication.
    const mutatedEvidenceDigest = "mutated-evidence-" + "f".repeat(47);
    const stalenessResult = await trustStore.currentReview(
      projectId,
      pageIdentity1,
      contentDigest,
      claimSetDigest,
      mutatedEvidenceDigest,
    );
    assert.equal(stalenessResult.stale, true);
    assert.match(stalenessResult.reason ?? "", /source evidence/i);

    // PUB-12: Test-only review with altered or removed QA detail text
    // Expected: publication remains ineligible.
    const sanitizedDetailReport: any = {
      schemaVersion: "production-v1",
      candidateId: `cand-${"2".repeat(32)}`,
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: false,
        reviewAuthorityMode: "TEST_ONLY",
      },
      checks: [
        {
          checkId: "content.editorial_review",
          group: "content",
          verdict: "PASS",
          detail: "All content checks passed cleanly with no warning strings",
          evidence: [],
        },
      ],
    };
    assert.equal(qaRunPublicationEligible(sanitizedDetailReport), false);
  } finally {
    await dbInst.close();
  }
});

test("ACQ-09 through ACQ-14: Query parameters, canonical dataset IDs, and redirect validation", async () => {
  const { verifyResearchAcquisition } = await import("../../src/trust/research-acquisition.js");

  const validChamonixRef: SourceRef = {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
    canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
    datasetIdentity: {
      geoCode: "74056",
      reportingPeriod: 2022,
    },
    supportingExcerpt: "14,538 total dwellings",
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    acquisitionProvenance: {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
      },
      trustedRedirects: [
        {
          fromUrl: "https://statistiques-locales.insee.fr/#c=indicator&i=rp.pop_1&s=2022&geo=COM-74056",
          toUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
          statusCode: 301,
        },
      ],
    },
  };

  // ACQ-09: Commune-specific query string stripped or altered (e.g. geo=COM-74173 instead of geo=COM-74056)
  // Expected: fails query parameter binding / source mismatch.
  const r09Stripped: SourceRef = {
    ...validChamonixRef,
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193",
  };
  const res09Stripped = verifyResearchAcquisition(r09Stripped);
  assert.equal(res09Stripped.valid, false);
  assert.ok(res09Stripped.problems.some((p) => /material_query_parameter_mismatch|acquisition_source_url_mismatch/.test(p)));

  const r09Altered: SourceRef = {
    ...validChamonixRef,
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
  };
  const res09Altered = verifyResearchAcquisition(r09Altered);
  assert.equal(res09Altered.valid, false);
  assert.ok(res09Altered.problems.some((p) => /material_query_parameter_mismatch|acquisition_source_url_mismatch/.test(p)));

  // ACQ-10: Generic publisher homepage presented as source authority for downloaded data
  // Expected: rejected fail-closed (homepage_source_url_rejected).
  const r10: SourceRef = {
    ...validChamonixRef,
    sourceUrl: "https://www.insee.fr/",
  };
  const res10 = verifyResearchAcquisition(r10);
  assert.equal(res10.valid, false);
  assert.ok(res10.problems.some((p) => /homepage_source_url_rejected/.test(p)));

  // ACQ-11: Same publisher and format with different reporting period or survey scope
  // Expected: rejected (reporting_period_mismatch).
  const r11: SourceRef = {
    ...validChamonixRef,
    datasetIdentity: {
      ...validChamonixRef.datasetIdentity!,
      reportingPeriod: 2018,
    },
  };
  const res11 = verifyResearchAcquisition(r11);
  assert.equal(res11.valid, false);
  assert.ok(res11.problems.some((p) => /reporting_period_mismatch/.test(p)));

  // ACQ-12: Different dataset ID with similar or identical title
  // Expected: rejected (canonical_dataset_id_mismatch).
  const r12: SourceRef = {
    ...validChamonixRef,
    canonicalDatasetId: "insee-logement-2022-74173",
  };
  const res12 = verifyResearchAcquisition(r12);
  assert.equal(res12.valid, false);
  assert.ok(res12.problems.some((p) => /acquisition_canonical_dataset_mismatch|canonical_dataset_id_mismatch/.test(p)));

  // ACQ-13: Parameter change that does not alter document title or metadata keywords
  // Expected: rejected (material_query_parameter_mismatch / source_url_parameters_mismatch).
  const r13: SourceRef = {
    ...validChamonixRef,
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056&view=compact",
  };
  const res13 = verifyResearchAcquisition(r13);
  assert.equal(res13.valid, false);
  assert.ok(res13.problems.some((p) => /material_query_parameter_mismatch|acquisition_source_url_mismatch/.test(p)));

  // ACQ-14: Redirect to a verified canonical URL with cryptographic capture proof
  // Expected: PASS.
  const r14: SourceRef = {
    ...validChamonixRef,
    sourceUrl: "https://insee.fr/fr/statistiques/8581193?geo=COM-74056",
  };
  const res14 = verifyResearchAcquisition(
    r14,
    "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
    { evaluationTimestamp: "2026-10-19T00:00:00Z" },
  );
  assert.equal(res14.valid, true, res14.problems.join("; "));
});

test("LEGAL-07 through LEGAL-12: Contiguous span matching, provision co-occurrence, and operative versioning", async () => {
  const { verifyLegalExtract, verifyLegalClaim } = await import("../../src/trust/legal-evidence.js");
  const pluRelPath = path.join(...["docs", "evidence", "sources", "legal-regulatory-2026", "74056_reglement_20260226.pdf"]);
  const rawBytes = await import("node:fs/promises").then((fs) => fs.readFile(path.join(repoRoot, pluRelPath)));
  const rawSha = createHash("sha256").update(rawBytes).digest("hex");

  const rawCaptureSnapshot: any = {
    sourceId: "raw-chamonix-plu-2026",
    title: "PLU de Chamonix-Mont-Blanc — Règlement officiel (2026)",
    officialPublisher: "Mairie de Chamonix-Mont-Blanc / Géoportail de l'Urbanisme",
    primarySourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
    retrievedAt: "2026-10-18T12:00:00Z",
    httpStatusOrArchiveIdentifier: "GPU-ETAG-beaa82a7b5594b3913d5156928287d07",
    sha256: rawSha,
    file: "74056_reglement_20260226.pdf",
    sourceClassification: "PRIMARY_SOURCE_CAPTURE" as const,
    articleOrSection: "Règlement complet",
    territorialScope: "Commune de Chamonix-Mont-Blanc (74056)",
    documentVersion: "Approuvé le 26/02/2026 (opposable)",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  const baseExtractSnapshot: any = {
    sourceId: "ext-chamonix-plu-mixite-2026",
    title: "Chamonix PLU 2026 — Servitudes de mixité sociale",
    officialPublisher: "Mairie de Chamonix-Mont-Blanc",
    primarySourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
    retrievedAt: "2026-10-18T12:00:00Z",
    httpStatusOrArchiveIdentifier: "GPU-ETAG-beaa82a7b5594b3913d5156928287d07",
    sha256: "0".repeat(64),
    file: "chamonix_plu_mixite_sociale_2026.txt",
    sourceClassification: "EXTRACTED_LEGAL_PROVISION" as const,
    rawCaptureSourceId: "raw-chamonix-plu-2026",
    rawCaptureDigest: rawSha,
    articleOrSection: "Article UA 3, UC 3",
    territorialScope: "Commune de Chamonix-Mont-Blanc (74056)",
    documentVersion: "2026-02-26",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  // LEGAL-07: Insert fabricated obligation immediately after first 35 matching characters
  // Expected: rejected (invented_clause_detected: extracted_text_not_found_in_raw_capture: quote_span_mismatch).
  const inventedClauseText = Buffer.from(
    'Pour les logements individuels :\n"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, obligation de verser une taxe forfaitaire de 500000 euros à la mairie de Chamonix."',
    "utf8",
  );
  const res07 = verifyLegalExtract(baseExtractSnapshot, inventedClauseText, rawCaptureSnapshot, rawBytes);
  assert.equal(res07.ok, false);
  assert.match(res07.reason ?? "", /invented_clause_detected|quote_span_mismatch/);

  // LEGAL-08: Real threshold paired with different regulatory condition or quota (200 m² paired with 20% tourist quota)
  // Expected: rejected (threshold_provision_mismatch).
  const mismatchedThresholdText = Buffer.from(
    'Règlement d\'urbanisme :\n"Dans le cadre de toute opération d\'une surface de plancher supérieure ou égale à 200 m², 20% au moins de la surface de plancher créée doit être affectée à des hébergements touristiques."',
    "utf8",
  );
  const res08 = verifyLegalExtract(baseExtractSnapshot, mismatchedThresholdText, rawCaptureSnapshot, rawBytes);
  assert.equal(res08.ok, false);
  assert.match(res08.reason ?? "", /threshold_provision_mismatch/);

  // LEGAL-09: Accurate article citation asserting un-enacted or contrary legal conclusion
  // Expected: rejected (legal_conclusion_mismatch).
  const contraryClaim: ClaimLineage = {
    claimId: "claim-legal-09",
    pageIdentity: "locations/chamonix",
    claimType: "SOURCE_DERIVED_FACT",
    claimText: "Chamonix PLU Article UT3 requires a 25% social housing quota for all residential developments.",
    limitation: "",
    sourceRefs: [
      {
        ref: "PLU Chamonix Article UT3",
        sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
        supportingExcerpt: "Article UT3: 25% social housing quota",
        tier: "TIER_A",
        sourceDate: "2026-02-26",
        freshnessBasis: "effective_legal_period",
        entailment: "SUPPORTED",
      },
    ],
  };
  const res09 = verifyLegalClaim(contraryClaim, legalRegistry);
  assert.equal(res09.ok, false);
  assert.ok(res09.problems.some((p) => /legal_conclusion_mismatch|zone_applicability_mismatch/.test(p)));

  // LEGAL-10: Exact statutory text ending with altered clause
  // Expected: rejected (invented_clause_detected / quote_span_mismatch).
  const alteredEndingText = Buffer.from(
    'Pour les logements individuels :\n"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés sous réserve de l\'accord expresse du propriétaire foncier."',
    "utf8",
  );
  const res10 = verifyLegalExtract(baseExtractSnapshot, alteredEndingText, rawCaptureSnapshot, rawBytes);
  assert.equal(res10.ok, false);
  assert.match(res10.reason ?? "", /invented_clause_detected|quote_span_mismatch/);

  // LEGAL-11: Citing an obsolete PLU version while referencing current document ID
  // Expected: rejected (obsolete_regulation_version).
  const obsoleteClaim: ClaimLineage = {
    claimId: "claim-legal-11",
    pageIdentity: "locations/chamonix",
    claimType: "SOURCE_DERIVED_FACT",
    claimText: "Under the Chamonix PLU 2015 obsolete version, social housing quotas applied above 300 m².",
    limitation: "",
    sourceRefs: [
      {
        ref: "PLU de Chamonix-Mont-Blanc — Version 2015",
        sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
        supportingExcerpt: "PLU 2015 obsolete version 300 m²",
        tier: "TIER_A",
        sourceDate: "2015-11-20",
        freshnessBasis: "effective_legal_period",
        entailment: "SUPPORTED",
      },
    ],
  };
  const res11Claim = verifyLegalClaim(obsoleteClaim, legalRegistry);
  assert.equal(res11Claim.ok, false);
  assert.ok(res11Claim.problems.some((p) => /obsolete_regulation_version/.test(p)));

  const obsoleteExtractSnapshot = {
    ...baseExtractSnapshot,
    effectiveTo: "2020-01-01",
  };
  const res11Extract = verifyLegalExtract(obsoleteExtractSnapshot, inventedClauseText, rawCaptureSnapshot, rawBytes);
  assert.equal(res11Extract.ok, false);
  assert.match(res11Extract.reason ?? "", /obsolete_regulation_version/);

  // LEGAL-12: Verbatim extract from active Chamonix PLU with verified span, current version and matching article
  // Expected: PASS.
  const authenticText = Buffer.from(
    'Pour les logements individuels :\n"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés"',
    "utf8",
  );
  const res12 = verifyLegalExtract(baseExtractSnapshot, authenticText, rawCaptureSnapshot, rawBytes);
  assert.equal(res12.ok, true, res12.reason ?? "");
});

test("WORK-08 through WORK-14: Dynamic transformation parsing without fallback constants", async () => {
  const {
    TRUSTED_TRANSFORMATION_REGISTRY,
    TransformationExtractionError,
  } = await import("../../src/trust/transformation-registry.js");
  const { parseOriginalWorkProduct } = await import("@factory/contracts");
  const { computeWorkProductExecutionHash, verifyOriginalWorkProduct } = await import(
    "../../src/production/qa/trust.js"
  );

  const yieldTransformation = TRUSTED_TRANSFORMATION_REGISTRY.get("alpine-gross-yield-v1")!;
  const synthesisTransformation = TRUSTED_TRANSFORMATION_REGISTRY.get("chamonix-supply-synthesis-v1")!;

  const validInseeHtml = `<html><body><table><tr class="total"><th class="total">Ensemble</th><td class="nombre">14 538</td></tr></table></body></html>`;
  const validIfiText = `Code général des impôts - Article 964: L'impôt sur la fortune immobilière est applicable au patrimoine net taxable supérieur à 1 300 000 EUR.`;

  // WORK-08: Run dwelling stock transformation on source missing 2022 total dwellings row
  // Expected: explicit TransformationExtractionError / insee_total_dwellings_extraction_failed, not fallback 14,538.
  const inseeMissingTotalRow = `<html><body><table><tr><th>Autre</th><td>1 000</td></tr></table></body></html>`;
  assert.throws(
    () => {
      yieldTransformation.execute({
        datasets: new Map([
          ["inseeChamonix", inseeMissingTotalRow],
          ["ifiStatute", validIfiText],
        ]),
      });
    },
    (err: any) => {
      assert.ok(err instanceof TransformationExtractionError);
      assert.equal(err.code, "insee_total_dwellings_extraction_failed");
      return true;
    },
  );

  // WORK-09: Run tax model transformation without statutory thresholds in raw input
  // Expected: explicit TransformationExtractionError / ifi_statutory_threshold_extraction_failed, not fallback €1,300,000.
  const ifiMissingThreshold = `Code général des impôts: L'impôt est applicable au patrimoine net taxable sans mention de montant.`;
  assert.throws(
    () => {
      yieldTransformation.execute({
        datasets: new Map([
          ["inseeChamonix", validInseeHtml],
          ["ifiStatute", ifiMissingThreshold],
        ]),
      });
    },
    (err: any) => {
      assert.ok(err instanceof TransformationExtractionError);
      assert.equal(err.code, "ifi_statutory_threshold_extraction_failed");
      return true;
    },
  );

  // WORK-10: Modify Chamonix PLU threshold input to 250 m² instead of 200 m²
  // Expected: derived threshold must reflect 250 m², not silently return 200 m².
  const pluText250 = `Pour les logements individuels, toute opération d'une surface de plancher supérieure ou égale à 250 m². Pour les logements collectifs supérieur à 8 logements. minimum de 25% de logements sociaux.`;
  const delibText = `Cap fixée à 90 jours par an pour la location de meublés de tourisme.`;
  const inseeVintageHtml = `<html><body>
    <table>
      <tr class="total"><th class="total">Ensemble</th><td class="nombre">14 538</td></tr>
      <tr><th>Résidences principales construites avant 2020</th><td>4 000</td></tr>
      <tr><th>De 1946 à 1970</th><td>1 000</td></tr>
      <tr><th>De 1971 à 1990</th><td>1 000</td></tr>
    </table>
  </body></html>`;

  const res10 = synthesisTransformation.execute({
    datasets: new Map([
      ["inseeLogement2022", inseeVintageHtml],
      ["pluServitudes", pluText250],
      ["deliberationMeublesTourisme", delibText],
    ]),
  });
  assert.equal(res10.structuredMetrics.pluThresholdIndividualSqm, 250);

  // WORK-11: Modify vintage housing count in source data
  // Expected: derived percentage must change accordingly, not return 71.0% or hardcoded 58.5%.
  // In inseeVintageHtml above: (1,000 + 1,000) / 4,000 = 50.0%
  assert.equal(res10.structuredMetrics.vintage1946To1990SharePercent, 50.0);

  // WORK-12: Supply transformation with missing input dataset entirely
  // Expected: explicit TransformationExtractionError (missing_required_input_dataset).
  assert.throws(
    () => {
      yieldTransformation.execute({
        datasets: new Map([["ifiStatute", validIfiText]]),
      });
    },
    (err: any) => {
      assert.ok(err instanceof TransformationExtractionError);
      assert.equal(err.code, "missing_required_input_dataset");
      return true;
    },
  );

  // WORK-13: Incompatible analytical model type submitted to verification
  // Expected: rejected (transformation_model_type_incompatible).
  const inseeChamonixDigest = "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150";
  const ifiDigest = "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938";
  const validSourceDigests = new Set([inseeChamonixDigest, ifiDigest]);
  const dummyTransformationDigest = "d".repeat(64);
  const dummyExecutionHash = computeWorkProductExecutionHash({
    productType: "STRUCTURED_DATASET", // Incompatible: alpine-gross-yield-v1 expects COMPUTATIONAL_MODEL
    inputDatasetDigests: [inseeChamonixDigest, ifiDigest],
    transformationDigest: dummyTransformationDigest,
  });

  const incompatibleWp = parseOriginalWorkProduct({
    workProductId: "owp-incompatible-model-test",
    pageIdentity: "research/alpine-decision-framework",
    productType: "STRUCTURED_DATASET",
    transformationId: "alpine-gross-yield-v1",
    title: "Incompatible Model Type Test",
    description: "Submitting STRUCTURED_DATASET to a COMPUTATIONAL_MODEL transformation",
    inputDatasetDigests: [inseeChamonixDigest, ifiDigest],
    transformationDigest: dummyTransformationDigest,
    executionHash: dummyExecutionHash,
    outputArtifactRef: "docs/evidence/artifacts/alpine-yield-model-v1.json",
    reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-alpine-yield.ts",
    verifiableAnchors: ["7.2%", "26400 EUR"],
    provenance: "Sutherland Private Office Quantitative Analysis Desk",
  });
  const res13 = verifyOriginalWorkProduct(incompatibleWp, validSourceDigests, { checkDisk: false });
  assert.equal(res13.valid, false);
  assert.ok(res13.problems.some((p) => /transformation_model_type_incompatible/.test(p)));

  // WORK-14: Authentically transformed work product with dynamic parsing and exact source binding
  // Expected: PASS.
  const validExecution = yieldTransformation.execute({
    datasets: new Map([
      ["inseeChamonix", validInseeHtml],
      ["ifiStatute", validIfiText],
    ]),
  });
  assert.equal(validExecution.structuredMetrics.grossYieldPercent, 7.2);
  assert.equal(validExecution.structuredMetrics.totalDwellings2022, 14538);
});

test("AUTH-13 through AUTH-20: Fail-closed default identity, transactional PostgreSQL authority, and immutable audit seal enforcement", async () => {
  const {
    EditorialReviewService,
    FailClosedProductionIdentityProvider,
    TrustedExternalIdpAdapter,
    SyntheticTestSessionRegistry,
    TrustedSessionRegistry,
    ProjectMembershipAuthority,
    EditorialAuditStore,
  } = await import("../../src/trust/editorial-review-boundary.js");
  const { TrustGovernanceStore } = await import("../../src/trust/store.js");
  const { editorialApprovalAuditEvents, reviewAuthorities } = await import("../../src/persistence/schema.js");
  const { eq } = await import("drizzle-orm");
  const { setupMigratedTestDatabase } = await import("./helpers.js");
  const { seedSutherlandProject } = await import("../fixtures/sutherland-seeds.js");

  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `auth3-${Math.random().toString(36).slice(2, 8)}`);
    const trustStore = new TrustGovernanceStore(dbInst.db);
    const membershipAuth = ProjectMembershipAuthority.getInstance(dbInst.db);
    const auditStore = EditorialAuditStore.getInstance(dbInst.db);

    const pageIdentity = "locations/chamonix";
    const contentDigest = "a".repeat(64);
    const claimSetDigest = "b".repeat(64);
    const sourceEvidenceSetDigest = "c".repeat(64);

    // AUTH-13: Self-created session with isSynthetic=false cannot certify real human review.
    const syntheticRegistry = TrustedSessionRegistry.getInstance();
    const actor13 = "auth13-self-certified-caller";
    await membershipAuth.grantMembership(projectId, actor13, ["EDITORIAL_REVIEW:APPROVE"]);
    const selfCreatedToken = syntheticRegistry.createSession({
      actorId: actor13,
      actorName: "Caller Attempt",
      actorRole: "EDITORIAL_DIRECTOR",
      isSynthetic: false,
    });
    const resolvedSelfSession = await syntheticRegistry.verifySession(selfCreatedToken);
    assert.ok(resolvedSelfSession);
    assert.equal(resolvedSelfSession.isSynthetic, true, "Caller-supplied isSynthetic=false must be ignored on synthetic registry");

    // Also verify TrustedExternalIdpAdapter rejects caller-supplied raw principal objects without cryptographic assertion
    const unconfiguredIdp = new TrustedExternalIdpAdapter("sutherland-corp-okta");
    assert.throws(
      () => {
        unconfiguredIdp.issueSessionForVerifiedPrincipal({
          actorId: actor13,
          actorName: "Raw Principal Caller",
          actorRole: "EDITORIAL_DIRECTOR",
        } as any);
      },
      (err: any) => {
        assert.match(err.code || err.message, /unverified_idp_assertion_required/);
        return true;
      },
    );
    assert.throws(
      () => {
        unconfiguredIdp.registerVerifiedPrincipal("tok-raw", {
          sessionId: "tok-raw",
          actorId: actor13,
          actorName: "Raw Principal Caller",
          actorRole: "EDITORIAL_DIRECTOR",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          isSynthetic: false,
          trustedProviderId: "sutherland-corp-okta",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unverified_principal_registration_prohibited/);
        return true;
      },
    );

    const syntheticService = new EditorialReviewService(trustStore, syntheticRegistry, membershipAuth, auditStore);
    await assert.rejects(
      async () => {
        await syntheticService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-13 self-created session with isSynthetic=false",
          sessionToken: selfCreatedToken,
          reviewerRef: actor13,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /synthetic_approval_not_production_authority/);
        return true;
      },
    );

    // AUTH-14: Default EditorialReviewService rejects an unverified session.
    const defaultService = new EditorialReviewService(trustStore, undefined, membershipAuth, auditStore);
    await assert.rejects(
      async () => {
        await defaultService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-14 default service with synthetic token",
          sessionToken: selfCreatedToken,
          reviewerRef: actor13,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /production_idp_not_configured_fail_closed|unauthenticated_session_required/);
        return true;
      },
    );

    // AUTH-15: Test identity provider cannot upgrade to production through request metadata.
    await assert.rejects(
      async () => {
        await syntheticService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-15 metadata upgrade attempt",
          sessionToken: selfCreatedToken,
          reviewerRef: actor13,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
          ...({
            isSynthetic: false,
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            reviewAuthorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            trustedProviderId: "sutherland-corp-okta",
          } as any),
        });
      },
      (err: any) => {
        assert.match(
          err.code || err.message,
          /synthetic_identity_upgrade_rejected|synthetic_approval_not_production_authority/,
        );
        return true;
      },
    );

    // AUTH-16: Database unavailable during approval: no approval is issued or retained.
    const brokenDb: any = {
      select: () => {
        throw new Error("ECONNREFUSED: PostgreSQL connection refused");
      },
      insert: () => {
        throw new Error("ECONNREFUSED: PostgreSQL connection refused");
      },
      delete: () => {
        throw new Error("ECONNREFUSED: PostgreSQL connection refused");
      },
      transaction: async () => {
        throw new Error("ECONNREFUSED: PostgreSQL connection refused");
      },
    };
    const brokenMembership = new ProjectMembershipAuthority(brokenDb);
    const brokenAuditStore = new EditorialAuditStore(brokenDb);
    const brokenTrustStore = new TrustGovernanceStore(brokenDb);
    const idpHarness = TrustedExternalIdpAdapter.createTestHarness("sutherland-corp-okta");
    const actor16 = "auth16-db-down-reviewer";
    const token16 = idpHarness.issueSignedSession({
      actorId: actor16,
      actorName: "DB Down Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });
    const brokenService = new EditorialReviewService(
      brokenTrustStore,
      idpHarness.adapter,
      brokenMembership,
      brokenAuditStore,
    );

    await assert.rejects(
      async () => {
        await brokenMembership.grantMembership(projectId, actor16, ["EDITORIAL_REVIEW:APPROVE"]);
      },
      (err: any) => {
        assert.match(err.code || err.message, /trust_database_unavailable/);
        return true;
      },
    );
    await assert.rejects(
      async () => {
        await brokenService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-16 approval while DB unavailable",
          sessionToken: token16,
          reviewerRef: actor16,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /trust_database_unavailable/);
        return true;
      },
    );
    const rowsAfterBroken = await dbInst.db
      .select()
      .from(editorialApprovalAuditEvents)
      .where(eq(editorialApprovalAuditEvents.actorId, actor16));
    assert.equal(rowsAfterBroken.length, 0, "No audit event may be retained when DB is unavailable");

    // AUTH-17: Database transaction rolls back: no orphaned usable audit approval remains.
    const actor17 = "auth17-tx-rollback-reviewer";
    await membershipAuth.grantMembership(projectId, actor17, ["EDITORIAL_REVIEW:APPROVE"]);
    const token17 = idpHarness.issueSignedSession({
      actorId: actor17,
      actorName: "Rollback Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });
    const realService = new EditorialReviewService(trustStore, idpHarness.adapter, membershipAuth, auditStore);
    // Passing an invalid contentDigest ("not-a-64-hex-digest") causes parseReviewAuthority inside recordReviewLocked
    // to throw AFTER auditStore.recordApprovalAuditEvent has inserted into the transaction.
    await assert.rejects(
      async () => {
        await realService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest: "invalid-digest-triggers-review-schema-rollback",
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-17 transaction rollback test",
          sessionToken: token17,
          reviewerRef: actor17,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
        });
      },
    );
    const orphanedAuditRows = await dbInst.db
      .select()
      .from(editorialApprovalAuditEvents)
      .where(eq(editorialApprovalAuditEvents.actorId, actor17));
    assert.equal(orphanedAuditRows.length, 0, "Transaction rollback must leave zero orphaned audit events in PostgreSQL");

    // AUTH-18: Revoked reviewer after restart: new approval rejected.
    const actor18 = "auth18-revoked-reviewer";
    await membershipAuth.grantMembership(projectId, actor18, ["EDITORIAL_REVIEW:APPROVE"]);
    const token18 = idpHarness.issueSignedSession({
      actorId: actor18,
      actorName: "Revoked Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });
    await membershipAuth.revokeMembership(projectId, actor18);

    // Simulate process restart with fresh store instances backed by PostgreSQL
    const restartedMembership = new ProjectMembershipAuthority(dbInst.db);
    const restartedAudit = new EditorialAuditStore(dbInst.db);
    const restartedTrust = new TrustGovernanceStore(dbInst.db);
    const restartedService = new EditorialReviewService(
      restartedTrust,
      idpHarness.adapter,
      restartedMembership,
      restartedAudit,
    );
    await assert.rejects(
      async () => {
        await restartedService.recordAuthenticatedApproval({
          projectId,
          pageIdentity,
          contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
          verifiedClaimIds: ["c1"],
          note: "AUTH-18 approval after revocation and restart",
          sessionToken: token18,
          reviewerRef: actor18,
          reviewerExpertise: "Alpine Law",
          reviewAction: "APPROVED",
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /unauthorized_reviewer_actor/);
        return true;
      },
    );

    // AUTH-19: Forged audit event with matching digests: production approval rejected.
    const forgedEventId = `appr-evt-forged-${Math.random().toString(36).slice(2, 8)}`;
    const actor19 = "auth19-forged-actor";
    await membershipAuth.grantMembership(projectId, actor19, ["EDITORIAL_REVIEW:APPROVE"]);
    await dbInst.db.insert(editorialApprovalAuditEvents).values({
      id: forgedEventId,
      projectId,
      pageIdentity,
      actorId: actor19,
      actorRole: "EDITORIAL_BOARD",
      reviewAction: "APPROVED",
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      auditEventReference: `AUDIT-${forgedEventId}`,
      isSynthetic: false,
      revoked: false,
      verificationSeal: "f".repeat(64), // Forged seal
      createdAt: new Date(),
    });

    await assert.rejects(
      async () => {
        await trustStore.recordReview({
          projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId,
            pageIdentity,
            reviewerRef: actor19,
            reviewerExpertise: "Alpine Law",
            reviewedContentDigest: contentDigest,
            reviewedAt: "2026-10-19",
            result: "APPROVED",
            note: "Forged audit event with matching digests",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            reviewerKind: "EXTERNAL_HUMAN_REVIEWER",
            authorityKind: "VERIFIED_HUMAN_REVIEW_AUTHORITY",
            claimSetDigest,
            sourceEvidenceSetDigest,
            approvalEventId: forgedEventId,
            approvalEvent: {
              reviewEventId: forgedEventId,
              authenticatedActorId: actor19,
              actorRole: "EDITORIAL_BOARD",
              authorizationScope: "YMYL_DECISION_SUPPORT:EDITORIAL_REVIEW",
              reviewAction: "APPROVED",
              reviewedContentDigest: contentDigest,
              reviewedClaimSetDigest: claimSetDigest,
              reviewedSourceEvidenceDigest: sourceEvidenceSetDigest,
              eventTimestamp: new Date().toISOString(),
              auditEventReference: `AUDIT-${forgedEventId}`,
              isSynthetic: false,
            },
          },
        });
      },
      (err: any) => {
        assert.match(err.code || err.message, /forged_audit_event_rejected/);
        return true;
      },
    );

    // Also verify PostgreSQL trigger blocks deleting or mutating protected fields on editorial_approval_audit_events
    await assert.rejects(
      async () => {
        await dbInst.db
          .delete(editorialApprovalAuditEvents)
          .where(eq(editorialApprovalAuditEvents.id, forgedEventId));
      },
      (err: any) => {
        assert.match(String(err.cause?.message || err.message), /DELETE is prohibited/);
        return true;
      },
    );
    await assert.rejects(
      async () => {
        await dbInst.db
          .update(editorialApprovalAuditEvents)
          .set({ contentDigest: "0".repeat(64) })
          .where(eq(editorialApprovalAuditEvents.id, forgedEventId));
      },
      (err: any) => {
        assert.match(String(err.cause?.message || err.message), /protected fields are immutable/);
        return true;
      },
    );

    // AUTH-20: Real trusted identity and durable authorized review: PASS only when actual identity infrastructure is available.
    const actor20 = "auth20-verified-human-reviewer";
    await membershipAuth.grantMembership(projectId, actor20, ["EDITORIAL_REVIEW:APPROVE"]);
    const verifiedSession20 = idpHarness.issueSignedSession({
      actorId: actor20,
      actorName: "Verified Human Reviewer",
      actorRole: "EDITORIAL_BOARD",
    });
    const approval20 = await realService.recordAuthenticatedApproval({
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
      verifiedClaimIds: ["c1"],
      note: "AUTH-20 cryptographically verified human review",
      sessionToken: verifiedSession20,
      reviewerRef: actor20,
      reviewerExpertise: "French Real Estate & Urbanism Law",
      reviewAction: "APPROVED",
    });
    assert.equal(approval20.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
    assert.equal(approval20.reviewStatus, "EDITORIAL_REVIEW_APPROVED");

    const current20 = await restartedTrust.currentReview(
      projectId,
      pageIdentity,
      contentDigest,
      claimSetDigest,
      sourceEvidenceSetDigest,
    );
    assert.equal(current20.stale, false);
    assert.equal(current20.review?.authorityKind, "VERIFIED_HUMAN_REVIEW_AUTHORITY");
    assert.equal(current20.review?.approvalEventId, approval20.approvalEventId);
  } finally {
    await dbInst.close();
  }
});

test("LEGAL-13 through LEGAL-17: Multi-line legal extract verification against authenticated Chamonix PLU PDF", async () => {
  const { verifyLegalExtract, verifyLegalClaim } = await import("../../src/trust/legal-evidence.js");
  const fs = await import("node:fs/promises");
  const pluRelPath = path.join("docs", "evidence", "sources", "legal-regulatory-2026", "74056_reglement_20260226.pdf");
  const extractRelPath = path.join("docs", "evidence", "sources", "legal-regulatory-2026", "chamonix-plu-servitudes-mixite.txt");
  const rawBytes = await fs.readFile(path.join(repoRoot, pluRelPath));
  const authenticExtractBytes = await fs.readFile(path.join(repoRoot, extractRelPath));
  const rawSha = createHash("sha256").update(rawBytes).digest("hex");

  const rawCaptureSnapshot: any = {
    sourceId: "chamonix-plu-2026-reglement-raw",
    title: "PLU de Chamonix-Mont-Blanc — Règlement officiel (2026)",
    officialPublisher: "Ville de Chamonix-Mont-Blanc",
    primarySourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
    retrievedAt: "2026-10-18T21:11:38Z",
    httpStatusOrArchiveIdentifier: "HTTP 200, ETag e860875a86a1b39f07934fb3e098fc9d-1",
    sha256: rawSha,
    file: "74056_reglement_20260226.pdf",
    sourceClassification: "PRIMARY_SOURCE_CAPTURE" as const,
    articleOrSection: "Règlement complet (223 pages)",
    territorialScope: "Commune de Chamonix-Mont-Blanc",
    documentVersion: "Approuvé le 26 février 2026, opposable le 9 mai 2026",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  const baseExtractSnapshot: any = {
    sourceId: "chamonix-plu-servitudes-mixite",
    title: "Plan Local d'Urbanisme de Chamonix-Mont-Blanc - Règlement et servitudes de mixité sociale",
    officialPublisher: "Ville de Chamonix-Mont-Blanc",
    primarySourceUrl: "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/",
    retrievedAt: "2026-10-18T21:11:38Z",
    httpStatusOrArchiveIdentifier: "74056_PLU_20260226",
    sha256: createHash("sha256").update(authenticExtractBytes).digest("hex"),
    file: "chamonix-plu-servitudes-mixite.txt",
    sourceClassification: "EXTRACTED_LEGAL_PROVISION" as const,
    rawCaptureSourceId: "chamonix-plu-2026-reglement-raw",
    rawCaptureDigest: rawSha,
    articleOrSection: "Articles UA3/UAS3/UC3/UBD3/UBP3, Article 1 Note 1, Articles 6.6-6.7, Articles 10-11, UT3",
    territorialScope: "Commune de Chamonix-Mont-Blanc",
    documentVersion: "Approuvé le 26 février 2026, opposable le 9 mai 2026",
    effectiveFrom: "2026-05-09",
    effectiveTo: "current",
  };

  // LEGAL-13: One genuine quoted paragraph followed by one entirely invented paragraph → FAIL.
  const legal13Bytes = Buffer.from(
    [
      "Pour les logements individuels :",
      '"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés',
      'Les acquéreurs étrangers doivent en outre déposer une caution bancaire décennale auprès de la trésorerie municipale avant toute signature d\'acte authentique."',
    ].join("\n"),
    "utf8",
  );
  const res13 = verifyLegalExtract(baseExtractSnapshot, legal13Bytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res13.ok, false);
  assert.match(res13.reason ?? "", /unmatched_substantive_line|invented_clause_detected|quote_span_mismatch/);

  // LEGAL-14: Genuine quote with fabricated final sentence → FAIL.
  const legal14Bytes = Buffer.from(
    [
      "Pour les logements collectifs :",
      '"Dans le cadre de toute opération d\'une taille supérieure à 8 logements (inclus et y compris réhabilitation), 25% au moins des logements créés (et représentant au minimum 25% de la surface de plancher d\'habitation créée) doivent être affectés à des logements locatifs sociaux. Ce quota est doublé lorsque le demandeur réside hors du département de la Haute-Savoie."',
    ].join("\n"),
    "utf8",
  );
  const res14 = verifyLegalExtract(baseExtractSnapshot, legal14Bytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res14.ok, false);
  assert.match(res14.reason ?? "", /invented_clause_detected|unmatched_substantive_line|quote_span_mismatch/);

  // LEGAL-15: Two individually genuine provisions falsely combined into one legal obligation → FAIL.
  // Line 1 is from Article UA 3 (page 21) and Line 2 is from Zone UT 3 (page 173), stitched into a single quote.
  const legal15Bytes = Buffer.from(
    [
      "Obligation combinée :",
      '"Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés',
      'En zone UT, les constructions destinées à l\'hébergement hôtelier sont soumises aux prescriptions particulières d\'implantation des équipements touristiques d\'altitude."',
    ].join("\n"),
    "utf8",
  );
  const res15 = verifyLegalExtract(baseExtractSnapshot, legal15Bytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res15.ok, false);
  assert.match(
    res15.reason ?? "",
    /unrelated_provisions_combined|unmatched_substantive_line|quote_span_mismatch/,
  );

  // Also test LEGAL-15 with two verbatim lines in reverse document order (Article 10 SMS on page 46 followed by Article UA 3 on page 21) inside one quote
  const legal15ReversedBytes = Buffer.from(
    [
      "Obligation inversée :",
      '"Les sites concernés par une servitude de mixité sociale (SMS) sont repérés au règlement graphique par une trame particulière et un numéro.',
      'Toute opération de construction de logement ainsi que toute demande de changement de destination à vocation de logement, d\'une surface de plancher supérieure ou égale à 200 m², doit comporter un minimum de 25% de cette surface de plancher à usage de logements locatifs conventionnés"',
    ].join("\n"),
    "utf8",
  );
  const res15Rev = verifyLegalExtract(baseExtractSnapshot, legal15ReversedBytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res15Rev.ok, false);
  assert.match(res15Rev.reason ?? "", /unrelated_provisions_combined/);

  // LEGAL-16: Correct number taken from wrong article or zone → FAIL.
  const legal16Bytes = Buffer.from(
    [
      "Zone UA 3 — Règle générale :",
      '"En zone UA et UC, toute opération de construction de logement d\'une surface de plancher supérieure ou égale à 200 m² doit comporter un minimum de 75% de logements locatifs sociaux."',
    ].join("\n"),
    "utf8",
  );
  const res16Extract = verifyLegalExtract(baseExtractSnapshot, legal16Bytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res16Extract.ok, false);
  assert.match(
    res16Extract.reason ?? "",
    /article_zone_threshold_mismatch|threshold_provision_mismatch|unmatched_substantive_line/,
  );

  const legal16Claim: ClaimLineage = {
    claimId: "claim-legal-16",
    pageIdentity: "locations/chamonix",
    claimType: "SOURCE_DERIVED_FACT",
    claimText: "Under Chamonix PLU Article UA 3, general residential construction in Zone UA requires a 75% social housing quota.",
    limitation: "",
    sourceRefs: [
      {
        ref: "Ville de Chamonix PLU Article UA 3",
        sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
        supportingExcerpt: "75% de logements sociaux en zone UA",
        tier: "TIER_A",
        sourceDate: "2026-02-26",
        freshnessBasis: "effective_version",
        entailment: "SUPPORTED",
      },
    ],
  };
  const res16Claim = verifyLegalClaim(legal16Claim, legalRegistry);
  assert.equal(res16Claim.ok, false);
  assert.ok(res16Claim.problems.some((p) => /chamonix_plu_threshold_mismatch|zone_applicability_mismatch/.test(p)));

  // LEGAL-17: Complete valid provision extracted from authenticated Chamonix PLU → PASS.
  const res17 = verifyLegalExtract(baseExtractSnapshot, authenticExtractBytes, rawCaptureSnapshot, rawBytes);
  assert.equal(res17.ok, true, res17.reason ?? "");
  assert.equal(legalRegistry.rejected.length, 0, JSON.stringify(legalRegistry.rejected));
});

test("ACQ-15 through ACQ-20: Unconditional canonical dataset identity, municipality/period bindings, and independent manifest verification", async () => {
  const { verifyResearchAcquisition, TRUSTED_ACQUISITION_REGISTRY } = await import(
    "../../src/trust/research-acquisition.js"
  );

  const validChamonixRef: SourceRef = {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
    canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
    datasetIdentity: {
      geoCode: "74056",
      reportingPeriod: 2022,
      documentIdentifier: "INSEE-8581193-COM-74056",
      documentType: "census",
    },
    supportingExcerpt: "14,538 total dwellings in Chamonix-Mont-Blanc (COM-74056) in 2022.",
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    evidenceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
    sourceClassification: "PRIMARY_PUBLIC_RECORD",
    acquisitionProvenance: {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      },
    },
  };

  // ACQ-15: Required canonicalDatasetId omitted → FAIL.
  const acq15Ref: SourceRef = {
    ...validChamonixRef,
    canonicalDatasetId: undefined,
  };
  const res15 = verifyResearchAcquisition(acq15Ref);
  assert.equal(res15.valid, false);
  assert.ok(res15.problems.some((p) => /canonical_dataset_id_missing/.test(p)));

  // ACQ-16: INSEE Chamonix event used for another municipality → FAIL.
  const acq16ByIdentity: SourceRef = {
    ...validChamonixRef,
    datasetIdentity: {
      ...validChamonixRef.datasetIdentity!,
      geoCode: "74173",
    },
  };
  const res16Identity = verifyResearchAcquisition(acq16ByIdentity);
  assert.equal(res16Identity.valid, false);
  assert.ok(res16Identity.problems.some((p) => /acquisition_dataset_identity_mismatch|municipality_scope_mismatch/.test(p)));

  const acq16ByText: SourceRef = {
    ...validChamonixRef,
    ref: "INSEE Logement en 2022 — Commune de Megève (COM-74173)",
  };
  const res16Text = verifyResearchAcquisition(acq16ByText);
  assert.equal(res16Text.valid, false);
  assert.ok(res16Text.problems.some((p) => /acquisition_dataset_identity_mismatch|municipality_scope_mismatch/.test(p)));

  // ACQ-17: Genuine event ID used for another reporting year → FAIL.
  const acq17ByPeriod: SourceRef = {
    ...validChamonixRef,
    datasetIdentity: {
      ...validChamonixRef.datasetIdentity!,
      reportingPeriod: 2019,
    },
  };
  const res17Period = verifyResearchAcquisition(acq17ByPeriod);
  assert.equal(res17Period.valid, false);
  assert.ok(res17Period.problems.some((p) => /acquisition_reporting_period_mismatch/.test(p)));

  const acq17ByTitle: SourceRef = {
    ...validChamonixRef,
    ref: "INSEE Logement en 2019 — Commune de Chamonix-Mont-Blanc (COM-74056)",
  };
  const res17Title = verifyResearchAcquisition(acq17ByTitle);
  assert.equal(res17Title.valid, false);
  assert.ok(res17Title.problems.some((p) => /acquisition_reporting_period_mismatch/.test(p)));

  // ACQ-18: Unrelated document with similar INSEE title keywords → FAIL.
  const acq18SimilarKeywords: SourceRef = {
    ...validChamonixRef,
    ref: "INSEE Première — Enquête Nationale Logement RP2022 : conjoncture et revenus (COM-74056)",
  };
  const res18Keywords = verifyResearchAcquisition(acq18SimilarKeywords);
  assert.equal(res18Keywords.valid, false);
  assert.ok(res18Keywords.problems.some((p) => /acquisition_document_mismatch/.test(p)));

  const acq18WrongDocId: SourceRef = {
    ...validChamonixRef,
    datasetIdentity: {
      ...validChamonixRef.datasetIdentity!,
      documentIdentifier: "INSEE-PREMIERE-2022-9999",
    },
  };
  const res18DocId = verifyResearchAcquisition(acq18WrongDocId);
  assert.equal(res18DocId.valid, false);
  assert.ok(res18DocId.problems.some((p) => /acquisition_document_mismatch/.test(p)));

  // ACQ-19: Source file present, but its claimed acquisition event is not independently verifiable → FAIL or UNVERIFIED.
  // Case 19a: Static archival snapshot represented as live EXTERNAL_ACQUIRED
  const acq19LiveClaim: SourceRef = {
    ...validChamonixRef,
    evidenceOrigin: "EXTERNAL_ACQUIRED",
  };
  const res19Live = verifyResearchAcquisition(acq19LiveClaim);
  assert.equal(res19Live.valid, false);
  assert.ok(res19Live.problems.some((p) => /acquisition_event_unverified/.test(p)));

  // Case 19b: Physical source file exists on disk with matching SHA-256, but is NOT corroborated in manifest.json
  const tmpRepo = await mkdtemp(path.join(tmpdir(), "r12-acq19-"));
  try {
    const uncorroboratedRel = "docs/evidence/sources/insee-logement-2022/COM-74056.html";
    const uncorroboratedFull = path.join(tmpRepo, uncorroboratedRel);
    await mkdir(path.dirname(uncorroboratedFull), { recursive: true });
    // Copy the actual Chamonix HTML file so its SHA-256 matches registeredEvent.contentDigest,
    // but write an empty manifest.json so the event cannot be independently verified.
    const realHtmlBytes = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(repoRoot, uncorroboratedRel)),
    );
    await writeFile(uncorroboratedFull, realHtmlBytes);
    await writeFile(
      path.join(tmpRepo, "docs/evidence/sources/insee-logement-2022/manifest.json"),
      JSON.stringify({ snapshots: [] }),
    );
    const res19UnverifiedManifest = verifyResearchAcquisition(validChamonixRef, undefined, {
      repoRoot: tmpRepo,
      checkDisk: true,
      evaluationTimestamp: "2026-10-19T00:00:00Z",
    });
    assert.equal(res19UnverifiedManifest.valid, false);
    assert.ok(res19UnverifiedManifest.problems.some((p) => /acquisition_event_unverified/.test(p)));
  } finally {
    await rm(tmpRepo, { recursive: true, force: true });
  }

  // ACQ-20: Authenticated source bytes, matching identity and trusted acquisition event → PASS.
  const res20 = verifyResearchAcquisition(
    validChamonixRef,
    "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
    {
      repoRoot,
      checkDisk: true,
      evaluationTimestamp: "2026-10-19T00:00:00Z",
    },
  );
  assert.equal(res20.valid, true, res20.problems.join("; "));
  assert.ok(TRUSTED_ACQUISITION_REGISTRY.has("acq-insee-74056-2026"));
});




