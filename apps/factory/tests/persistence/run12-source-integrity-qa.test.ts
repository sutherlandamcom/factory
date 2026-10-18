import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { runTrustQa } from "../../src/production/qa/trust.js";
import { loadInseeEvidenceRegistry, inseeSourceUrl } from "../../src/trust/insee-evidence.js";
import type { ClaimLineage, EvidenceBinding, PageIntentAuthority, SourceRef } from "@factory/contracts";

/**
 * RUN 12 REMEDIATION — production-path source-integrity mutations.
 * Every case goes through the real runTrustQa() with the real stored INSEE
 * bytes; the claim author's supportingExcerpt / SUPPORTED / TIER_A are never
 * the deciding evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const registry = loadInseeEvidenceRegistry(repoRoot);

const tf = (geoCode: string, rowKey: string, value: number, year = 2022): EvidenceBinding => ({
  kind: "table_fact", geoCode, reportingYear: year, tableId: "LOG T1", rowKey, columnKey: String(year), value, unit: "dwellings",
});

function ref(over: Partial<SourceRef> & { bindings?: EvidenceBinding[] }, excerpt: string): SourceRef {
  const { bindings, ...rest } = over;
  return {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
    supportingExcerpt: excerpt,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
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

    // M22: Review authority becomes stale when verifiedClaimIds no longer match the current claim set
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
        note: "Approved prior claim set",
        verifiedClaimIds: ["claim-prior-old-id"],
      },
    });
    const report2 = await runTrustQa({
      manifests: [manifestA], distDir: dist, projectId, trust, contentDigests: new Map([[pageIdentity, digest]]), manifestSetDigest: "2".repeat(64),
      inseeEvidence: registry,
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

    // M26: Uncertain claim (SCENARIO) without visible label in rendered HTML
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

