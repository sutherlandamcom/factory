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
  const defaultAcquisition = isMegeve
    ? {
        acquisitionEventId: "acq-insee-74173-2026",
        trustedProviderId: "insee-official-data",
        acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD" as const,
        retrievedAt: "2026-10-18T10:00:00Z",
        contentDigest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4",
        signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74173",
      }
    : {
        acquisitionEventId: "acq-insee-74056-2026",
        trustedProviderId: "insee-official-data",
        acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD" as const,
        retrievedAt: "2026-10-18T10:00:00Z",
        contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
        signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      };

  return {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
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
    TrustedSessionRegistry,
    ProjectMembershipAuthority,
    EditorialAuditStore,
  } = await import("../../src/trust/editorial-review-boundary.js");
  const { TrustGovernanceStore } = await import("../../src/trust/store.js");
  const { setupMigratedTestDatabase } = await import("./helpers.js");
  const { seedSutherlandProject } = await import("../fixtures/sutherland-seeds.js");

  const dbInst = await setupMigratedTestDatabase();
  const { projectId } = await seedSutherlandProject(dbInst, `auth-${Math.random().toString(36).slice(2, 8)}`);
  const trustStore = new TrustGovernanceStore(dbInst.db);
  const sessionRegistry = TrustedSessionRegistry.getInstance();
  const membershipAuth = ProjectMembershipAuthority.getInstance();
  const auditStore = EditorialAuditStore.getInstance();
  const service = new EditorialReviewService(trustStore, sessionRegistry, membershipAuth, auditStore);

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
  const tokenCharlie = sessionRegistry.createSession({
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
  membershipAuth.grantMembership(otherProject, actorCharlie, ["EDITORIAL_REVIEW:APPROVE"]);
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
  membershipAuth.grantMembership(projectId, validActor, ["EDITORIAL_REVIEW:APPROVE"]);
  const tokenDavid = sessionRegistry.createSession({
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
});

test("ACQ-01 through ACQ-08: Research acquisition physical and cryptographic authenticity", async () => {
  const { verifyResearchAcquisition } = await import("../../src/trust/research-acquisition.js");

  const validRef: SourceRef = {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: inseeSourceUrl("74056"),
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


