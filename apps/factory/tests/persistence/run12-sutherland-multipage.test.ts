import assert from "node:assert/strict";
import test from "node:test";
import { cp, readFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { sutherlandIntakePayload } from "../fixtures/sutherland-intake.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { PageArchetypeStore } from "../../src/page-authority/store.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { VisualStore } from "../../src/visual/store.js";
import { VisualService } from "../../src/visual/service.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { FixtureVisualAssetProvider } from "../../src/visual/fixture-adapter.js";
import { ProductionStore } from "../../src/production/store.js";
import { ProductionRenderCompiler } from "../../src/production/render-manifest.js";
import { ProductionBuildService } from "../../src/production/build-service.js";
import { ProductionApiFacade } from "../../src/production/api-facade.js";
import { loadProductionBuildIdentity } from "../../src/production/identity.js";
import { bindQaCheck, TRUSTED_PRODUCTION_QA_GATES } from "../../src/production/qa/registry.js";
import { runSiteWideQa } from "../../src/production/qa/site-wide.js";
import { createHash } from "node:crypto";
import {
  runTrustQa,
  computeClaimSetDigest,
  computeSourceEvidenceSetDigest,
  computeWorkProductExecutionHash,
} from "../../src/production/qa/trust.js";
import { loadInseeEvidenceRegistry } from "../../src/trust/insee-evidence.js";
import { loadLegalEvidenceRegistry } from "../../src/trust/legal-evidence.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import {
  parseDesignInputSnapshotAnyVersion,
  isDesignInputSnapshotV2,
  parseDesignCandidateAnyVersion,
  type DesignArchetypeKind,
  type PageIntentAuthority,
  type ClaimLineage,
  type SourceRef,
  type OriginalWorkProduct,
} from "@factory/contracts";
import { EvidenceStitchProvider } from "../fixtures/stitch-evidence.js";
import type { StitchMcpClientLike, McpToolCallResult } from "../../src/design/stitch-provider.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { and, eq } from "drizzle-orm";
import { acceptedPageContent } from "../../src/persistence/schema.js";

/**
 * RUN 12 — SUTHERLAND MULTI-PAGE PROOF (real PostgreSQL + real Astro build).
 *
 * Proves the complete governed chain for a real six-page Sutherland website:
 *
 *   accepted Sutherland inputs + real SearchIntelligenceService (Run 2)
 *   + real CompetitorContentGapService (Run 3) over the acquired Sutherland
 *   SERP and competitor corpus
 *     -> governed writer pipeline per page (policy -> atomic brief+archetype
 *        -> snapshot -> budget-governed provider seam -> deterministic QA
 *        -> AcceptedPageContent) with real French Alpine primary sources
 *     -> durable PageArchetypeAuthority (PR #45 atomicity preserved)
 *     -> durable PageIntentAuthority (strategy/YMYL/decision role)
 *     -> ONE design-v2 design acceptance (Stitch provider path, transport
 *        mocked at the MCP artifact boundary only)
 *     -> VisualService lifecycle per page -> AcceptedVisualAssetSet
 *     -> PPI -> ProductionRenderCompiler -> production-v3 manifests
 *     -> real Astro build -> mandatory YMYL gate in ProductionApiFacade.runCandidateQa
 *     -> SIXTH-PAGE REUSE PROOF with zero new design/provider calls, real
 *        manifest-derived component-family comparison, and exact visual-slot
 *        verification.
 */

interface SutherlandPageSpec {
  slug: string;
  archetype: DesignArchetypeKind;
  title: string;
  objective: string;
  audience: string;
  structureGuidance: string[];
  internalLinkIntent: string[];
  ctaIntent: string;
  ymyl: PageIntentAuthority["ymylClassification"];
  decisionRole: PageIntentAuthority["decisionRole"];
  primaryIntent: string;
  primaryQueryCluster: string;
  contentGapPurpose: string;
  siteRole: string;
  mainUserTask: string;
  primaryConversionAction: string;
  internalLinksOut: string[];
}

const SUTHERLAND_PAGES: SutherlandPageSpec[] = [
  {
    slug: "home",
    archetype: "homepage",
    title: "Independent Buyer-Side Advisory for French Alps Property Decisions",
    objective: "Establish the Sutherland Private Office identity and the evidence-led advisory proposition.",
    audience: "International buyers evaluating a consequential French Alps property decision.",
    structureGuidance: ["Open with the advisory positioning", "Evidence-led method section", "Engagement boundaries"],
    internalLinkIntent: [],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "NAVIGATIONAL_BRAND",
    primaryIntent: "Evaluate who should support a consequential French Alps property decision",
    primaryQueryCluster: "Independent buyer-side advisory (French Alps)",
    contentGapPurpose: "Entity establishment + commercial-investigation orientation",
    siteRole: "Homepage: identity and orientation",
    mainUserTask: "Decide whether independent advisory fits the decision",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: [],
  },
  {
    slug: "services/buyer-side-advisory",
    archetype: "service",
    title: "Buyer-Side Property Advisory: Scope and Engagement",
    objective: "Explain the service scope, how an engagement works, and its statutory boundaries.",
    audience: "Buyers comparing independent advisory against listing intermediaries.",
    structureGuidance: ["Service scope section", "How an engagement works", "Boundaries and limits"],
    internalLinkIntent: ["Link to the research methodology page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
    primaryIntent: "Evaluate the buyer-side advisory service scope and engagement model",
    primaryQueryCluster: "Independent buyer-side advisory (French Alps)",
    contentGapPurpose: "Service differentiation: what the engagement does and does not do",
    siteRole: "Service evaluation",
    mainUserTask: "Decide whether to engage the advisory service",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["research/alpine-decision-framework"],
  },
  {
    slug: "locations/chamonix",
    archetype: "location",
    title: "Property Decision Support in Chamonix",
    objective: "Provide primary-source housing, urbanism, and hazard context for Chamonix and Megève property decisions.",
    audience: "Buyers considering Chamonix or Megève specifically.",
    structureGuidance: ["Location context section", "Advisory coverage", "Local decision factors"],
    internalLinkIntent: ["Link to the service page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE",
    primaryIntent: "Understand advisory support for a Chamonix property decision",
    primaryQueryCluster: "Location market understanding (Chamonix / Megève)",
    contentGapPurpose: "Geographic service relevance grounded in INSEE, PLU, and Géorisques location facts",
    siteRole: "Location relevance",
    mainUserTask: "Decide how the advisory supports a Chamonix purchase",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["services/buyer-side-advisory"],
  },
  {
    slug: "advisory/investment-decision-framework",
    archetype: "investment_advisory",
    title: "Investment Decision Framework for Alpine Property",
    objective: "Explain the capital decision framework: DVF deed benchmarks, IFI tax thresholds, DPE renovation schedules, and labelled scenarios.",
    audience: "Buyers weighing a financial decision on alpine property.",
    structureGuidance: ["Approach section", "Assumptions and their labelling", "Scenario analysis with limits"],
    internalLinkIntent: ["Link to the research methodology page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_DECISION_SUPPORT",
    decisionRole: "FINANCIAL_DECISION_SUPPORT",
    primaryIntent: "Use a framework to structure an alpine property investment decision",
    primaryQueryCluster: "Decision methodology / evidence-led analysis",
    contentGapPurpose: "Financial decision support with explicit assumption/forecast separation and statutory benchmarks",
    siteRole: "Decision support",
    mainUserTask: "Structure an investment decision with labelled uncertainty",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["research/alpine-decision-framework"],
  },
  {
    slug: "research/alpine-decision-framework",
    archetype: "editorial",
    title: "An Evidence-Led Decision Framework for Alpine Property",
    objective: "Publish the original decision framework with INSEE, DVF, Notaires de France, and Géorisques methodology, sources, and limits.",
    audience: "Buyers and researchers evaluating alpine property decisions.",
    structureGuidance: ["Framework introduction", "Methodology", "Sources and limits"],
    internalLinkIntent: ["Link to the service page", "Link to the decision framework"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_DECISION_SUPPORT",
    decisionRole: "INFORMATIONAL_RESEARCH",
    primaryIntent: "Study the evidence-led decision framework and its methodology",
    primaryQueryCluster: "Decision methodology / evidence-led analysis",
    contentGapPurpose: "Original analytical value: reproducible framework + labelled calculation + primary source audit",
    siteRole: "Research credibility",
    mainUserTask: "Evaluate the framework's methodology and apply its structure",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["services/buyer-side-advisory", "advisory/investment-decision-framework"],
  },
];

const EXTRA_SIXTH_PAGE: SutherlandPageSpec = {
  slug: "research/chamonix-supply-notes",
  archetype: "editorial",
  title: "Supply-Side Notes for the Chamonix Decision Framework",
  objective: "Examine Chamonix housing stock vintage, PLU permanent-residence servitudes, May 2025 rental quotas, and PPRN hazard constraints.",
  audience: "Buyers and researchers auditing physical and regulatory supply constraints in Chamonix-Mont-Blanc.",
  structureGuidance: [
    "INSEE housing stock composition and construction vintage",
    "Municipal PLU servitudes and May 2025 rental rules",
    "Natural hazard zones and snow-reliability constraints",
  ],
  internalLinkIntent: ["Link to the research methodology page", "Link to the service page"],
  ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
  ymyl: "YMYL_DECISION_SUPPORT",
  decisionRole: "INFORMATIONAL_RESEARCH",
  primaryIntent: "Read primary-source supply-side observations for Chamonix-Mont-Blanc",
  primaryQueryCluster: "Location market understanding (Chamonix / Megève)",
  contentGapPurpose: "Commune-specific supply analysis grounded in INSEE RP2022, Chamonix PLU, and Géorisques PPRN",
  siteRole: "Supply-side research note",
  mainUserTask: "Audit physical stock age, municipal rental quotas, and natural hazard constraints in Chamonix",
  primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
  internalLinksOut: ["research/alpine-decision-framework", "services/buyer-side-advisory"],
};

const FACTS = sutherlandIntakePayload.evidence.operatorFacts;

/**
 * Declared evidence bindings. These are DECLARATIONS only: runTrustQa verifies each value against the
 * digest-pinned official INSEE bytes in docs/evidence/sources/insee-logement-2022/.
 */
const INSEE_TF = (geoCode: string, tableId: "LOG T1" | "LOG T1bis" | "LOG T2", rowKey: string, columnKey: string, value: number, unit: "dwellings" | "percent_of_dwellings") =>
  ({ kind: "table_fact" as const, geoCode, reportingYear: 2022, tableId, rowKey, columnKey, value, unit });
const SEC = "Résidences secondaires et logements occasionnels";
const CHAMONIX_BINDINGS = [
  INSEE_TF("74056", "LOG T1", "Ensemble", "2022", 14538, "dwellings"),
  INSEE_TF("74056", "LOG T1bis", "Résidences principales", "2022", 29.7, "percent_of_dwellings"),
  INSEE_TF("74056", "LOG T1bis", SEC, "2022", 69.3, "percent_of_dwellings"),
  INSEE_TF("74056", "LOG T1bis", "Logements vacants", "2022", 1.1, "percent_of_dwellings"),
  INSEE_TF("74056", "LOG T2", "Appartements", "2022:share", 72.6, "percent_of_dwellings"),
  INSEE_TF("74056", "LOG T2", "Maisons", "2022:share", 26.6, "percent_of_dwellings"),
  { kind: "table_fact" as const, geoCode: "74056", reportingYear: 2022, tableId: "LOG T5" as never, rowKey: "De 2006 à 2019", columnKey: "share", value: 13.5, unit: "percent_of_main_residences" as never },
  { kind: "derived_share" as const, geoCode: "74056", reportingYear: 2022, tableId: "LOG T5" as const, numeratorRows: ["De 1946 à 1970", "De 1971 à 1990"], denominatorRow: "Résidences principales construites avant 2020", value: 58.5, unit: "percent_of_main_residences" as const },
];
const MEGEVE_BINDINGS = [
  INSEE_TF("74173", "LOG T1", "Ensemble", "2022", 9354, "dwellings"),
  INSEE_TF("74173", "LOG T1bis", "Résidences principales", "2022", 16.1, "percent_of_dwellings"),
  INSEE_TF("74173", "LOG T1bis", SEC, "2022", 82.9, "percent_of_dwellings"),
  INSEE_TF("74173", "LOG T1bis", "Logements vacants", "2022", 1.0, "percent_of_dwellings"),
  INSEE_TF("74173", "LOG T2", "Appartements", "2022:share", 81.1, "percent_of_dwellings"),
];

const SOURCE_REFS = {
  operatorPositioning: {
    ref: "intake:operatorFacts[0] — Accepted Sutherland Private Office positioning",
    sourceUrl: "https://sutherlandam.com/home",
    supportingExcerpt: `${FACTS[0]} ${FACTS[1]} ${FACTS[2]}`,
    tier: "TIER_A",
    sourceDate: "2026-09-04",
    freshnessBasis: "historical_date",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  workedExample: {
    ref: "intake:operatorFacts[4] — Accepted first-party worked calculation example",
    sourceUrl: "https://sutherlandam.com/research/alpine-decision-framework",
    supportingExcerpt: FACTS[4]!,
    tier: "TIER_A",
    sourceDate: "2026-09-01",
    freshnessBasis: "model_as_of_date",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  inseeChamonixStock: {
    ref: "INSEE Logement en 2022 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
    supportingExcerpt: FACTS[5]!,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    evidenceBindings: CHAMONIX_BINDINGS,
  } satisfies SourceRef,
  inseeChamonixAge: {
    ref: "INSEE Logement en 2022 LOG T2 — Commune de Chamonix-Mont-Blanc (COM-74056)",
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
    supportingExcerpt: FACTS[6]!,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    evidenceBindings: CHAMONIX_BINDINGS,
  } satisfies SourceRef,
  inseeMegeveStock: {
    ref: "INSEE Logement en 2022 — Commune de Megève (COM-74173)",
    sourceUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
    supportingExcerpt: FACTS[7]!,
    tier: "TIER_A",
    sourceDate: "2025-07-01",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
    evidenceBindings: MEGEVE_BINDINGS,
  } satisfies SourceRef,
  chamonixPlu: {
    ref: "Ville de Chamonix PLU & Règlement meublés de tourisme 2025",
    sourceUrl: "https://www.chamonix.fr/urbanisme-plu",
    supportingExcerpt: FACTS[8]!,
    tier: "TIER_A",
    sourceDate: "2025-05-01",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  notairesProcedure: {
    ref: "Code de la construction et de l'habitation — CCH Art. L271-1 & CCH Art. L126-28-1",
    sourceUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
    supportingExcerpt: FACTS[9]!,
    tier: "TIER_A",
    sourceDate: "2025-01-01",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  dgfipDvfIfi: {
    ref: "DGFiP / Etalab DVF & CGI Arts. 964, 965, 977 (IFI)",
    sourceUrl: "https://app.dvf.etalab.gouv.fr/",
    supportingExcerpt: FACTS[10]!,
    tier: "TIER_A",
    sourceDate: "2025-01-01",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  georisquesCourDesComptes: {
    ref: "BRGM Géorisques PPRN Chamonix & Cour des comptes Rapport Février 2024",
    sourceUrl: "https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/commune/74056",
    supportingExcerpt: FACTS[11]!,
    tier: "TIER_A",
    sourceDate: "2024-02-06",
    freshnessBasis: "observation_date",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
  loiHoguet: {
    ref: "Loi Hoguet — Loi n° 70-9 du 2 janvier 1970 (Légifrance)",
    sourceUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228",
    supportingExcerpt: FACTS[12]!,
    tier: "TIER_A",
    sourceDate: "1970-01-02",
    freshnessBasis: "effective_version",
    entailment: "SUPPORTED",
  } satisfies SourceRef,
};

function sutherlandProposalFor(page: SutherlandPageSpec) {
  const sectionsBySlug: Record<string, Array<{ heading: string; body: string }>> = {
    home: [
      {
        heading: "Advisory positioning and what buyer-side advisory covers",
        body: "What buyer-side advisory covers and how an engagement works begins with a defined question. Independent buyer-side advisory serves the buyer rather than a property listing. Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated intermediation requires a carte professionnelle T and written mandat. Non-intermediated research and decision support holds no listing inventory and receives no brokerage commission.",
      },
      {
        heading: "How the evidence-led method produces conclusions from primary sources",
        body: "The evidence-led analysis method produces conclusions from official French statistical and statutory datasets. In Chamonix-Mont-Blanc (COM-74056), INSEE records 14,538 total dwellings in 2022, including 69.3% secondary residences. In Megève (COM-74173), INSEE records 9,354 total dwellings in 2022, including 82.9% secondary residences. See how facts, assumptions and forecasts are separated before any capital commitment.",
      },
      {
        heading: "Engagement boundaries and how an engagement begins without a sales funnel",
        body: "Engagement boundaries define what the advisory does and does not do. The practice does not broker transactions, promote listings, or promise fixed outcomes. Distinguish independent advisory from listing intermediaries by verifying who is responsible for the analysis. How an engagement begins without a sales funnel is through a written scoping question.",
      },
    ],
    "services/buyer-side-advisory": [
      {
        heading: "Service scope: what the advisory does for alpine buyers",
        body: "Sutherland Private Office is an independent buyer-side property advisory. What buyer-side advisory covers and how an engagement works centres on pre-acquisition verification. The service audits DGFiP 5-year DVF notarized transfer deeds, municipal PLU zoning servitudes, and Géorisques PPRN hazard maps. Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
      },
      {
        heading: "How an engagement works alongside French notarial procedure",
        body: "How an engagement begins without a sales funnel is with the buyer's written brief. The evidence-led analysis method produces conclusions before the buyer signs a preliminary contract. Notaires de France statutory procedure provides a 10-day cooling-off period and requires DDT diagnostics before the notarized acte authentique. Mandatory energy audits apply to classes F and G in 2023, class E in 2025, and class D in 2034.",
      },
      {
        heading: "Boundaries and limits under French property law",
        body: "Engagement boundaries state what the advisory does and does not do. Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated property intermediation requires a carte professionnelle T and written mandat. Distinguish independent advisory from listing intermediaries: Sutherland Private Office acts as a non-intermediated research practice. Understand who is responsible for the analysis, and see how facts, assumptions and forecasts are separated.",
      },
    ],
    "locations/chamonix": [
      {
        heading: "Location context: Chamonix-Mont-Blanc and Megève housing structure",
        body: "Sutherland Private Office is an independent buyer-side property advisory. Advisory focus: consequential French Alps property decisions, including Chamonix and Megève. INSEE Logement en 2022 for Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings: 69.3% secondary residences, 29.7% primary residences, and 1.1% vacant. In Megève (COM-74173), INSEE records 9,354 total dwellings in 2022, with 82.9% secondary residences and 16.1% primary residences.",
      },
      {
        heading: "Advisory coverage across Chamonix micro-markets and PLU zones",
        body: "What buyer-side advisory covers and how an engagement works in Chamonix links commune statistics to parcel rules. INSEE Chamonix-Mont-Blanc (COM-74056) records 72.6% apartments and 26.6% houses. Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes (servitudes de résidence principale) and 25% social-mix quotas across constructible residential zones. From 1 May 2025, tourist-rental rules require registration numbers and cap authorizations at 1 property per person.",
      },
      {
        heading: "Local decision factors: thermal vintage, natural hazards, and boundaries",
        body: "INSEE Chamonix-Mont-Blanc (COM-74056) records 58.5% of main residences (built before 2020) were completed between 1946 and 1990, and 13.5% between 2006 and 2019. BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document that PPRN avalanche and flood zones require pre-contract ERP verification. The evidence-led analysis method produces conclusions that distinguish independent advisory from listing intermediaries and state engagement boundaries. Understand who is responsible for the analysis, see how facts, assumptions and forecasts are separated, and how an engagement begins without a sales funnel.",
      },
    ],
    "advisory/investment-decision-framework": [
      {
        heading: "The decision approach: DGFiP DVF deed records and IFI tax thresholds",
        body: "Sutherland Private Office is an independent buyer-side property advisory. What buyer-side advisory covers and how an engagement works starts with verified transaction baselines. DGFiP and Etalab Demande de valeurs foncières (DVF) publish notarized transfer prices over a 5-year window. French Impôt sur la Fortune Immobilière (IFI) applies above 1,300,000 EUR (1.3 million EUR), assessed from 800,000 EUR. The evidence-led analysis method produces conclusions that separate statutory records from underwriting inputs.",
      },
      {
        heading: "Assumptions and their labelling: gross yield calculation and DPE capex",
        body: "See how facts, assumptions and forecasts are separated across every underwriting table. Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 7.2% under stated assumptions. Notaires de France statutory procedure requires DDT energy audits for classes F and G in 2023, class E in 2025, and class D in 2034. In Chamonix-Mont-Blanc (COM-74056), where 58.5% of main residences were built between 1946 and 1990, thermal capex is modelled as an explicit assumption.",
      },
      {
        heading: "Scenario analysis with limits: rental quotas and climate dispersion",
        body: "Scenarios evaluate downside stress under municipal quotas and altitude snow-reliability dispersion. From 1 May 2025, Chamonix tourist-rental rules require registration numbers and cap authorizations at 1 property per person. BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document PPRN hazard and altitude snow dispersion risks. Engagement boundaries define what the advisory does and does not do. Understand who is responsible for the analysis, and how an engagement begins without a sales funnel.",
      },
    ],
    "research/alpine-decision-framework": [
      {
        heading: "Framework introduction: separating primary data from assumptions",
        body: "Sutherland Private Office is an independent buyer-side property advisory. What buyer-side advisory covers and how an engagement works is anchored in a reproducible research methodology. The evidence-led analysis method produces conclusions by separating primary French datasets from explicit assumptions. See how facts, assumptions and forecasts are separated before evaluating any Chamonix or Megève property.",
      },
      {
        heading: "Methodology: five verification stages from INSEE and DVF to labelled yield",
        body: "Step one audits commune housing: INSEE Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings in 2022 (69.3% secondary), and Megève (COM-74173) records 9,354 dwellings (82.9% secondary). Step two normalizes DGFiP 5-year DVF notarized transfers and checks IFI thresholds above 1,300,000 EUR (assessed from 800,000 EUR). Step three verifies Notaires de France 10-day cooling-off rules and DDT energy audits for 2023, 2025, and 2034. Step four computes labelled calculations: annual rent of 26400 EUR over 366000 EUR purchase price gives an illustrative 7.2% gross yield.",
      },
      {
        heading: "Sources and limits: statutory registries, hazard maps, and scope boundaries",
        body: "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document parcel PPRN hazards and altitude snow dispersion. Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated intermediation requires a carte professionnelle T and written mandat. Distinguish independent advisory from listing intermediaries and understand who is responsible for the analysis. Engagement boundaries state what the advisory does and does not do, and how an engagement begins without a sales funnel.",
      },
    ],
    "research/chamonix-supply-notes": [
      {
        heading: "INSEE housing stock composition and construction vintage in Chamonix",
        body: "Sutherland Private Office is an independent buyer-side property advisory. What buyer-side advisory covers and how an engagement works includes auditing commune-level supply constraints. INSEE 2022 for Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings: 69.3% secondary residences, 29.7% primary residences, 1.1% vacant, 72.6% apartments, and 26.6% houses. INSEE Chamonix-Mont-Blanc (COM-74056) records 58.5% of main residences (built before 2020) were completed between 1946 and 1990, and 13.5% between 2006 and 2019.",
      },
      {
        heading: "Municipal PLU servitudes and May 2025 tourist-rental rules",
        body: "Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes (servitudes de résidence principale) and 25% social-mix quotas across constructible residential zones. From 1 May 2025, Chamonix tourist-rental rules require registration numbers and cap authorizations at 1 property per person. Notaires de France statutory procedure requires DDT energy audits for classes F and G in 2023, class E in 2025, and class D in 2034. The evidence-led analysis method produces conclusions that see how facts, assumptions and forecasts are separated.",
      },
      {
        heading: "Natural hazard zones and snow-reliability constraints on supply",
        body: "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document PPRN avalanche and flood zones and altitude snow dispersion. DGFiP Demande de valeurs foncières (DVF) publishes 5-year notarized transfers, and IFI applies above 1,300,000 EUR (assessed from 800,000 EUR). Engagement boundaries state what the advisory does and does not do. Understand who is responsible for the analysis, and how an engagement begins without a sales funnel.",
      },
    ],
  };

  const sections = sectionsBySlug[page.slug]!;
  return {
    title: page.title,
    metaDescription: `${page.title}: Sutherland Private Office — primary-source French Alps buyer-side property analysis for Chamonix and Megève.`,
    introduction: `${page.title}. Sutherland Private Office is an independent buyer-side property advisory. Advisory focus: consequential French Alps property decisions, including Chamonix and Megève. Analysis is evidence-led: sourced market analysis rather than listing intermediation. Commercial listing intermediaries represent sellers; buyer-side advisory serves only the buyer.`,
    sections,
    conclusion:
      "Independent buyer-side advisory grounds French Alps property decisions in primary INSEE, DGFiP DVF, Notaires de France, municipal PLU, and Géorisques records. An engagement begins with a defined decision question in prose, without a sales funnel.",
    cta: "An engagement begins with a defined decision question — described in prose, without a conversion element.",
    internalLinks: page.archetype === "editorial" ? page.internalLinksOut.map((target) => `/${target}`) : [],
  };
}

function intentForPage(
  projectId: string,
  page: SutherlandPageSpec,
  gap: { id: string; version: number; digest: string },
): PageIntentAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity: page.slug,
    primaryIntent: page.primaryIntent,
    secondaryIntents: [],
    primaryQueryCluster: page.primaryQueryCluster,
    secondaryQueryClusters: [],
    contentGapPurpose: page.contentGapPurpose,
    siteRole: page.siteRole,
    targetAudience: page.audience,
    mainUserTask: page.mainUserTask,
    primaryConversionAction: page.primaryConversionAction,
    ymylClassification: page.ymyl,
    decisionRole: page.decisionRole,
    internalLinksOut: page.internalLinksOut,
    gapSnapshotId: gap.id,
    gapSnapshotVersion: gap.version,
    gapSnapshotDigest: gap.digest,
  };
}

function claimsForPage(slug: string): ClaimLineage[] {
  const baseConclusionClaim: ClaimLineage = {
    claimId: `claim-${slug.replace(/\//g, "-")}-conclusion`,
    claimText:
      "Independent buyer-side advisory grounds French Alps property decisions in primary INSEE, DGFiP DVF, Notaires de France, municipal PLU, and Géorisques records.",
    claimType: "FIRST_PARTY_FACT",
    sourceRefs: [
      SOURCE_REFS.operatorPositioning,
      SOURCE_REFS.dgfipDvfIfi,
      SOURCE_REFS.notairesProcedure,
      SOURCE_REFS.chamonixPlu,
      SOURCE_REFS.georisquesCourDesComptes,
    ],
    pageIdentity: slug,
    limitation: "Synthesis of the primary French statistical and statutory sources audited by the practice.",
  };

  switch (slug) {
    case "home":
      return [
        {
          claimId: "claim-home-hoguet",
          claimText:
            "Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated intermediation requires a carte professionnelle T and written mandat.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.loiHoguet],
          pageIdentity: slug,
          limitation: "Statutory scope of Law No. 70-9 of 2 January 1970.",
        },
        {
          claimId: "claim-home-insee-chamonix",
          claimText:
            "In Chamonix-Mont-Blanc (COM-74056), INSEE records 14,538 total dwellings in 2022, including 69.3% secondary residences.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 census snapshot for COM-74056.",
        },
        {
          claimId: "claim-home-insee-megeve",
          claimText:
            "In Megève (COM-74173), INSEE records 9,354 total dwellings in 2022, including 82.9% secondary residences.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeMegeveStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 census snapshot for COM-74173.",
        },
        baseConclusionClaim,
      ];
    case "services/buyer-side-advisory":
      return [
        {
          claimId: "claim-service-registries",
          claimText:
            "The service audits DGFiP 5-year DVF notarized transfer deeds, municipal PLU zoning servitudes, and Géorisques PPRN hazard maps.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [SOURCE_REFS.dgfipDvfIfi, SOURCE_REFS.chamonixPlu, SOURCE_REFS.georisquesCourDesComptes],
          pageIdentity: slug,
          limitation: "Scope of public registries examined during pre-acquisition due diligence.",
        },
        {
          claimId: "claim-service-notaires",
          claimText:
            "Notaires de France statutory procedure provides a 10-day cooling-off period and requires DDT diagnostics before the notarized acte authentique.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.notairesProcedure],
          pageIdentity: slug,
          limitation: "French residential conveyancing procedure.",
        },
        {
          claimId: "claim-service-dpe-schedule",
          claimText:
            "Mandatory energy audits apply to classes F and G in 2023, class E in 2025, and class D in 2034.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.notairesProcedure],
          pageIdentity: slug,
          limitation: "Statutory French DPE energy audit calendar for single-ownership sales.",
        },
        {
          claimId: "claim-service-hoguet",
          claimText:
            "Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated property intermediation requires a carte professionnelle T and written mandat.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.loiHoguet],
          pageIdentity: slug,
          limitation: "Statutory boundary between estate agency intermediation and non-intermediated research.",
        },
        baseConclusionClaim,
      ];
    case "locations/chamonix":
      return [
        {
          claimId: "claim-chamonix-insee-stock",
          claimText:
            "INSEE Logement en 2022 for Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings: 69.3% secondary residences, 29.7% primary residences, and 1.1% vacant.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 commune-level housing stock composition for COM-74056.",
        },
        {
          claimId: "claim-chamonix-megeve-comparison",
          claimText:
            "In Megève (COM-74173), INSEE records 9,354 total dwellings in 2022, with 82.9% secondary residences and 16.1% primary residences.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeMegeveStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 commune-level comparison for COM-74173.",
        },
        {
          claimId: "claim-chamonix-typology-income",
          claimText:
            "INSEE Chamonix-Mont-Blanc (COM-74056) records 72.6% apartments and 26.6% houses.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 dwelling typology for COM-74056.",
        },
        {
          claimId: "claim-chamonix-plu-outflow",
          claimText:
            "Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes (servitudes de résidence principale) and 25% social-mix quotas across constructible residential zones.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.chamonixPlu],
          pageIdentity: slug,
          limitation: "Municipal PLU zoning servitude and social-mix policy.",
        },
        {
          claimId: "claim-chamonix-rental-2025",
          claimText:
            "From 1 May 2025, tourist-rental rules require registration numbers and cap authorizations at 1 property per person.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.chamonixPlu],
          pageIdentity: slug,
          limitation: "Municipal furnished tourist-rental regulation effective 1 May 2025.",
        },
        {
          claimId: "claim-chamonix-vintage",
          claimText:
            "INSEE Chamonix-Mont-Blanc (COM-74056) records 58.5% of main residences (built before 2020) were completed between 1946 and 1990, and 13.5% between 2006 and 2019.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixAge],
          pageIdentity: slug,
          limitation: "INSEE RP2022 LOG T2 construction-period distribution for main residences.",
        },
        {
          claimId: "claim-chamonix-georisques",
          claimText:
            "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document that PPRN avalanche and flood zones require pre-contract ERP verification.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.georisquesCourDesComptes],
          pageIdentity: slug,
          limitation: "Parcel-specific natural hazard verification requirement.",
        },
        baseConclusionClaim,
      ];
    case "advisory/investment-decision-framework":
      return [
        {
          claimId: "claim-invest-dvf",
          claimText:
            "DGFiP and Etalab Demande de valeurs foncières (DVF) publish notarized transfer prices over a 5-year window.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.dgfipDvfIfi],
          pageIdentity: slug,
          limitation: "DVF covers notarized transfers over a rolling 5-year statutory window.",
        },
        {
          claimId: "claim-invest-ifi",
          claimText:
            "French Impôt sur la Fortune Immobilière (IFI) applies above 1,300,000 EUR (1.3 million EUR), assessed from 800,000 EUR.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.dgfipDvfIfi],
          pageIdentity: slug,
          limitation: "Statutory French real-estate wealth tax threshold; individual treaty positions require tax counsel.",
        },
        {
          claimId: "claim-invest-yield-ref",
          claimText:
            "Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 7.2% under stated assumptions.",
          claimType: "CALCULATION",
          sourceRefs: [SOURCE_REFS.workedExample],
          pageIdentity: slug,
          calculationRef: {
            modelId: "sutherland-gross-yield-v1",
            inputs: [
              { name: "annual rent", value: "26400", unit: "EUR/year" },
              { name: "purchase price", value: "366000", unit: "EUR" },
            ],
            assumptionRefs: [],
            output: { value: "7.2", unit: "%" },
            calculatedAt: "2026-09-01",
          },
          limitation: "Illustrative worked calculation under stated assumptions; not a market observation or forecast.",
        },
        {
          claimId: "claim-invest-dpe",
          claimText:
            "Notaires de France statutory procedure requires DDT energy audits for classes F and G in 2023, class E in 2025, and class D in 2034.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.notairesProcedure],
          pageIdentity: slug,
          limitation: "Statutory French energy audit schedule for single-ownership residential sales.",
        },
        {
          claimId: "claim-invest-vintage-capex",
          claimText:
            "In Chamonix-Mont-Blanc (COM-74056), where 58.5% of main residences were built between 1946 and 1990, thermal capex is modelled as an explicit assumption.",
          claimType: "ASSUMPTION",
          sourceRefs: [SOURCE_REFS.inseeChamonixAge],
          pageIdentity: slug,
          limitation: "Thermal retrofit capex depends on building-specific engineering inspection and co-ownership votes.",
        },
        {
          claimId: "claim-invest-rental-quota",
          claimText:
            "From 1 May 2025, Chamonix tourist-rental rules require registration numbers and cap authorizations at 1 property per person.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.chamonixPlu],
          pageIdentity: slug,
          limitation: "Municipal furnished tourist-rental regulation effective 1 May 2025.",
        },
        {
          claimId: "claim-invest-scenario",
          claimText:
            "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document PPRN hazard and altitude snow dispersion risks.",
          claimType: "SCENARIO",
          sourceRefs: [SOURCE_REFS.georisquesCourDesComptes],
          pageIdentity: slug,
          limitation: "Downside stress scenario input; parcel-level exposure requires an official ERP and PPRN map check.",
        },
        baseConclusionClaim,
      ];
    case "research/alpine-decision-framework":
      return [
        {
          claimId: "claim-editorial-stage1-insee",
          claimText:
            "Step one audits commune housing: INSEE Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings in 2022 (69.3% secondary), and Megève (COM-74173) records 9,354 dwellings (82.9% secondary).",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixStock, SOURCE_REFS.inseeMegeveStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 commune-level census baselines.",
        },
        {
          claimId: "claim-editorial-stage2-dvf-ifi",
          claimText:
            "Step two normalizes DGFiP 5-year DVF notarized transfers and checks IFI thresholds above 1,300,000 EUR (assessed from 800,000 EUR).",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.dgfipDvfIfi],
          pageIdentity: slug,
          limitation: "DGFiP DVF 5-year ledger and statutory IFI thresholds.",
        },
        {
          claimId: "claim-editorial-stage3-notaires",
          claimText:
            "Step three verifies Notaires de France 10-day cooling-off rules and DDT energy audits for 2023, 2025, and 2034.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.notairesProcedure],
          pageIdentity: slug,
          limitation: "French residential conveyancing and DPE regulatory audit schedule.",
        },
        {
          claimId: "claim-yield-calc",
          claimText:
            "Step four computes labelled calculations: annual rent of 26400 EUR over 366000 EUR purchase price gives an illustrative 7.2% gross yield.",
          claimType: "CALCULATION",
          sourceRefs: [SOURCE_REFS.workedExample],
          pageIdentity: slug,
          calculationRef: {
            modelId: "sutherland-gross-yield-v1",
            inputs: [
              { name: "annual rent", value: "26400", unit: "EUR/year" },
              { name: "purchase price", value: "366000", unit: "EUR" },
            ],
            assumptionRefs: [],
            output: { value: "7.2", unit: "%" },
            calculatedAt: "2026-09-01",
          },
          limitation: "Illustrative worked example under stated assumptions; not a forecast and not a guarantee.",
        },
        {
          claimId: "claim-editorial-georisques",
          claimText:
            "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document parcel PPRN hazards and altitude snow dispersion.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.georisquesCourDesComptes],
          pageIdentity: slug,
          limitation: "Public hazard registry and Cour des comptes climate adaptation report.",
        },
        {
          claimId: "claim-editorial-hoguet",
          claimText:
            "Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated intermediation requires a carte professionnelle T and written mandat.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.loiHoguet],
          pageIdentity: slug,
          limitation: "Statutory distinction between brokerage intermediation and independent research.",
        },
        baseConclusionClaim,
      ];
    case "research/chamonix-supply-notes":
      return [
        {
          claimId: "claim-supply-insee-stock",
          claimText:
            "INSEE 2022 for Chamonix-Mont-Blanc (COM-74056) records 14,538 total dwellings: 69.3% secondary residences, 29.7% primary residences, 1.1% vacant, 72.6% apartments, and 26.6% houses.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixStock],
          pageIdentity: slug,
          limitation: "INSEE RP2022 housing stock breakdown for COM-74056.",
        },
        {
          claimId: "claim-supply-insee-vintage",
          claimText:
            "INSEE Chamonix-Mont-Blanc (COM-74056) records 58.5% of main residences (built before 2020) were completed between 1946 and 1990, and 13.5% between 2006 and 2019.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.inseeChamonixAge],
          pageIdentity: slug,
          limitation: "INSEE RP2022 LOG T2 construction vintage distribution.",
        },
        {
          claimId: "claim-supply-plu-outflow",
          claimText:
            "Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes (servitudes de résidence principale) and 25% social-mix quotas across constructible residential zones.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.chamonixPlu],
          pageIdentity: slug,
          limitation: "Ville de Chamonix-Mont-Blanc PLU zoning servitude policy.",
        },
        {
          claimId: "claim-supply-rental-2025",
          claimText:
            "From 1 May 2025, Chamonix tourist-rental rules require registration numbers and cap authorizations at 1 property per person.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.chamonixPlu],
          pageIdentity: slug,
          limitation: "Municipal furnished tourist-rental regulation effective 1 May 2025.",
        },
        {
          claimId: "claim-supply-dpe-schedule",
          claimText:
            "Notaires de France statutory procedure requires DDT energy audits for classes F and G in 2023, class E in 2025, and class D in 2034.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.notairesProcedure],
          pageIdentity: slug,
          limitation: "French statutory DPE energy audit schedule.",
        },
        {
          claimId: "claim-supply-georisques",
          claimText:
            "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document PPRN avalanche and flood zones and altitude snow dispersion.",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.georisquesCourDesComptes],
          pageIdentity: slug,
          limitation: "Parcel-level PPRN and Cour des comptes climate adaptation baseline.",
        },
        {
          claimId: "claim-supply-dvf-ifi",
          claimText:
            "DGFiP Demande de valeurs foncières (DVF) publishes 5-year notarized transfers, and IFI applies above 1,300,000 EUR (assessed from 800,000 EUR).",
          claimType: "SOURCE_DERIVED_FACT",
          sourceRefs: [SOURCE_REFS.dgfipDvfIfi],
          pageIdentity: slug,
          limitation: "DGFiP DVF 5-year ledger and statutory IFI thresholds.",
        },
        baseConclusionClaim,
      ];
    default:
      throw new Error(`Unexpected Sutherland page slug: ${slug}`);
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on("error", reject);
  });
}

class MockStitchClient implements StitchMcpClientLike {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private toolSequence: Array<Record<string, unknown>> = [];
  queue(result: Record<string, unknown>): void {
    this.toolSequence.push(result);
  }
  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return {
      tools: [
        { name: "create_project" },
        { name: "delete_project" },
        { name: "list_screens" },
        { name: "get_screen" },
        { name: "generate_screen_from_text" },
        { name: "create_design_system" },
      ],
    };
  }
  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolCallResult> {
    this.calls.push({ name: params.name, args: params.arguments });
    const next = this.toolSequence.shift();
    if (next === undefined) throw new Error(`MockStitchClient: unexpected tool call ${params.name}`);
    return { structuredContent: next };
  }
  async close(): Promise<void> {}
}

function safeSegmentLocal(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value)) throw new Error(`Unsafe artifact identity: ${value}`);
  return value;
}

async function recordTrustedEvidenceForCandidate(input: {
  productionStore: ProductionStore;
  projectId: string;
  candidateId: string;
  artifactDigest: string;
  manifestSetDigest: string;
  repositorySha: string;
  lockfileDigest: string;
  routes: string[];
}) {
  for (const gate of TRUSTED_PRODUCTION_QA_GATES) {
    const subjects =
      gate.scope === "page"
        ? input.routes
        : gate.scope === "site"
          ? [input.manifestSetDigest]
          : [input.repositorySha];
    for (const subject of subjects) {
      const group = gate.checkId.split(".")[0] as "accessibility" | "performance" | "security";
      const check = bindQaCheck(
        {
          checkId: gate.checkId,
          group,
          verdict: "PASS",
          detail: `Verified ${gate.checkId} for ${subject}`,
          evidence: [],
        },
        {
          scope: gate.scope,
          subject,
          tool: "run12-trusted-harness",
          toolVersion: "1.0.0",
        },
      );
      await input.productionStore.recordTrustedQaEvidence({
        projectId: input.projectId,
        candidateId: input.candidateId,
        check,
        artifactDigest: gate.scope === "repository" ? undefined : input.artifactDigest,
        repositorySha: gate.scope === "repository" ? input.repositorySha : undefined,
        lockfileDigest: gate.scope === "repository" ? input.lockfileDigest : undefined,
      });
    }
  }
}

interface PageRecord {
  id: string;
  version: number;
  slug: string;
  contentDigest: string;
}

test(
  "RUN 12: Sutherland six-page governed production proof (real Search/Competitor services -> sourced writer -> design -> visuals -> PPI -> Astro -> mandatory YMYL QA gate)",
  { timeout: 900_000 },
  async () => {
    const repoRoot = await resolveRepositoryRoot();
    const realBuildIdentity = await loadProductionBuildIdentity(repoRoot);
    assert.match(realBuildIdentity.repositorySha, /^[0-9a-f]{40}$/, "real git HEAD SHA loaded");
    assert.match(realBuildIdentity.lockfileDigest, /^[0-9a-f]{64}$/, "real pnpm-lock.yaml SHA-256 loaded");

    const dbInst = await setupMigratedTestDatabase();
    let root: string | undefined;
    try {
      // ---- P1-1: Real SearchIntelligenceService (Run 2) + CompetitorContentGapService (Run 3) ----
      const seeded = await seedSutherlandProject(dbInst, "run12-proof");
      assert.equal(seeded.serpOrganicCount, 6, "P1-1: SERP snapshot contains 6 acquired organic results");
      assert.equal(seeded.pageSnapshotCount, 6, "P1-1: Competitor run persisted 6 acquired page snapshots");
      assert.equal(seeded.analysisCount, 6, "P1-1: Competitor run persisted 6 structured page analyses");
      assert.equal(seeded.acceptedGapCount, 5, "P1-1: Accepted ContentGapSnapshot contains 5 accepted gaps");
      assert.equal(seeded.queryClusters.length, 4, "P1-1: SearchIntelligence derived 4 query clusters");
      assert.notEqual(seeded.serpSnapshotDigest, "a".repeat(64), "P1-1: SERP digest is computed, not a constant");
      assert.notEqual(seeded.intelligenceSnapshotDigest, "b".repeat(64), "P1-1: Intelligence digest is computed, not a constant");
      assert.notEqual(seeded.gapSnapshotDigest, "e".repeat(64), "P1-1: Gap digest is computed, not a constant");

      const trust = new TrustGovernanceStore(dbInst.db);
      const productionStore = new ProductionStore(dbInst.db);
      const productionFacade = new ProductionApiFacade(dbInst.db, repoRoot);
      const writerStores = {
        store: new WriterStore(dbInst.db),
        snapshots: new WriterSnapshotStore(dbInst.db),
        budget: new WriterBudgetStore(dbInst.db),
        qa: new WriterQaStore(dbInst.db),
      };
      const writer = new WriterService(writerStores.store, writerStores.snapshots, writerStores.budget, writerStores.qa);

      // ---- Governed writer pipeline per page (P1-2: primary-source grounded copy) ----
      const acceptedPages = new Map<string, PageRecord>();
      for (const page of SUTHERLAND_PAGES) {
        const currentPolicy = await writerStores.store.latestWriterPolicy(seeded.projectId);
        if (!currentPolicy || currentPolicy.state !== "approved") {
          const policy = await writerStores.store.deriveWriterPolicyDraft({ projectId: seeded.projectId });
          await writerStores.store.approveWriterPolicy({
            projectId: seeded.projectId,
            policyId: policy.id,
            expectedVersion: policy.version,
            expectedDigest: policy.policyDigest,
          });
        }
        const brief = await writerStores.store.saveBriefDraft({
          projectId: seeded.projectId,
          pageTarget: {
            slug: page.slug,
            title: page.title,
            objective: page.objective,
            audience: page.audience,
            structureGuidance: page.structureGuidance,
            internalLinkIntent: page.internalLinkIntent,
            ctaIntent: page.ctaIntent,
            designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: page.archetype },
          },
          contentBriefKeyPoints: [],
        });
        await writerStores.store.approveBrief({
          projectId: seeded.projectId,
          briefId: brief.id,
          expectedVersion: brief.version,
          expectedDigest: brief.digest,
        });
        const archetype = await new PageArchetypeStore(dbInst.db).getArchetype(seeded.projectId, page.slug);
        assert.equal(archetype, page.archetype, `durable archetype authority for ${page.slug}`);

        const snapshot = await writer.compileSnapshot({ projectId: seeded.projectId });
        await writer.approveSnapshot({
          projectId: seeded.projectId,
          snapshotId: snapshot.id,
          expectedVersion: snapshot.version,
          expectedDigest: snapshot.digest,
        });
        const proposalData = sutherlandProposalFor(page);
        const proposal = await writer.generateProposal(
          { projectId: seeded.projectId, snapshotId: snapshot.id },
          {
            invoke: (async (request: { model?: string }) => ({
              requestedModel: request.model ?? "test-model",
              respondedModel: "test-model",
              provider: "seam",
              durationMs: 5,
              promptTokens: 120,
              completionTokens: 500,
              totalTokens: 620,
              costUsd: 0,
              content: JSON.stringify(proposalData),
            })) as never,
            dailyLimitUsd: 10,
          },
        );
        const qa = await writer.runQa({ projectId: seeded.projectId });
        assert.equal(
          qa.overall,
          "PASS",
          `writer QA for ${page.slug}: ${JSON.stringify({ factual: qa.factual, search: qa.search, editorial: qa.editorial })}`,
        );
        const accepted = await writer.acceptContent({
          projectId: seeded.projectId,
          proposalId: proposal.id,
          expectedProposalDigest: proposal.digest,
        });
        assert.equal(accepted.slug, page.slug);
        const [row] = await dbInst.db
          .select()
          .from(acceptedPageContent)
          .where(and(eq(acceptedPageContent.projectId, seeded.projectId), eq(acceptedPageContent.slug, page.slug)));
        assert.ok(row, `accepted content row for ${page.slug}`);
        acceptedPages.set(page.slug, { id: row.id, version: row.version, slug: row.slug, contentDigest: row.contentDigest });

        await trust.setPageIntentAuthority({
          projectId: seeded.projectId,
          intent: intentForPage(seeded.projectId, page, {
            id: seeded.gapSnapshotId,
            version: seeded.gapSnapshotVersion,
            digest: seeded.gapSnapshotDigest,
          }),
        });
      }
      assert.equal(acceptedPages.size, 5, "five initial mandatory pages accepted");

      // ---- P1-3: Full claim lineage coverage with verified Tier-A provenance and entailment ----
      for (const page of SUTHERLAND_PAGES) {
        const record = acceptedPages.get(page.slug)!;
        await trust.saveClaimLineage({
          projectId: seeded.projectId,
          pageIdentity: page.slug,
          contentDigest: record.contentDigest,
          claims: claimsForPage(page.slug),
        });
      }

      // ---- P1-5: Original-value evidence bound to lineageClaimId, inspectable OriginalWorkProduct, and verifiable HTML anchors ----
      const inseeEvidence = loadInseeEvidenceRegistry(repoRoot);
      const legalEvidence = loadLegalEvidenceRegistry(repoRoot);
      const inseeChamonixDigest = inseeEvidence.snapshots.find((s) => s.geoCode === "74056")!.rawContentDigest;
      const inseeMegeveDigest = inseeEvidence.snapshots.find((s) => s.geoCode === "74173")!.rawContentDigest;
      const cchCoolingDigest = legalEvidence.snapshots.find((s) => s.sourceId === "legifrance-cch-l271-1")!.sha256;
      const ifiDigest = legalEvidence.snapshots.find((s) => s.sourceId === "legifrance-cgi-964-965-ifi")!.sha256;
      const pluDigest = legalEvidence.snapshots.find((s) => s.sourceId === "chamonix-plu-servitudes-mixite")!.sha256;
      const meublesDigest = legalEvidence.snapshots.find((s) => s.sourceId === "chamonix-deliberation-meubles-tourisme-2025")!.sha256;
      const hoguetDigest = legalEvidence.snapshots.find((s) => s.sourceId === "legifrance-loi-hoguet-1970")!.sha256;

      const wpAlpineTransDigest = createHash("sha256")
        .update("sutherland-gross-yield-v1:annual_rent/purchase_price*100:26400/366000*100=7.2131%")
        .digest("hex");
      const wpAlpine: OriginalWorkProduct = {
        workProductId: "owp-alpine-decision-framework-01",
        pageIdentity: "research/alpine-decision-framework",
        productType: "COMPUTATIONAL_MODEL",
        title: "Alpine Property Gross Yield Underwriting & Source Cross-Verification Model",
        description:
          "Five-stage verification protocol combining INSEE RP2022 (COM-74056 vs COM-74173), DGFiP 5-year DVF, Notaires de France 2023/2025/2034 DPE audit schedule, and a reproducible 7.2% gross-yield worked calculation.",
        inputDatasetDigests: [inseeChamonixDigest, inseeMegeveDigest, cchCoolingDigest, ifiDigest],
        transformationDigest: wpAlpineTransDigest,
        executionHash: computeWorkProductExecutionHash({
          productType: "COMPUTATIONAL_MODEL",
          inputDatasetDigests: [inseeChamonixDigest, inseeMegeveDigest, cchCoolingDigest, ifiDigest],
          transformationDigest: wpAlpineTransDigest,
        }),
        outputArtifactRef: "docs/evidence/models/alpine-yield-model-v1.json",
        reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-alpine-model.ts",
        verifiableAnchors: ["14,538 total dwellings", "1,300,000 EUR", "26400 EUR over 366000 EUR", "7.2% gross yield"],
        provenance: "Authored by Sutherland Private Office Quantitative Research Committee based on authentic French statistical and statutory primary sources.",
      };

      const wpInvestTransDigest = createHash("sha256")
        .update("investment-matrix-v1:ifi-threshold=1300000;ifi-base=800000;yield=7.2%;quota=1")
        .digest("hex");
      const wpInvest: OriginalWorkProduct = {
        workProductId: "owp-investment-decision-framework-01",
        pageIdentity: "advisory/investment-decision-framework",
        productType: "COMPARATIVE_DECISION_MATRIX",
        title: "Alpine Capital Allocation & French Wealth Tax Statutory Exposure Matrix",
        description:
          "Capital decision framework integrating DGFiP 5-year DVF transfer baselines, 1,300,000 EUR IFI thresholds, 1946-1990 thermal capex assumptions, and May 2025 Chamonix rental quota scenarios.",
        inputDatasetDigests: [ifiDigest, pluDigest, hoguetDigest],
        transformationDigest: wpInvestTransDigest,
        executionHash: computeWorkProductExecutionHash({
          productType: "COMPARATIVE_DECISION_MATRIX",
          inputDatasetDigests: [ifiDigest, pluDigest, hoguetDigest],
          transformationDigest: wpInvestTransDigest,
        }),
        outputArtifactRef: "docs/evidence/models/investment-matrix-v1.json",
        reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-investment-matrix.ts",
        verifiableAnchors: ["1,300,000 EUR", "800,000 EUR", "26400 EUR over a purchase price of 366000 EUR", "58.5% of main residences"],
        provenance: "Authored by Sutherland Private Office Advisory Committee based on authentic DGFiP, Legifrance, and Chamonix municipal primary sources.",
      };

      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: "research/alpine-decision-framework",
          kind: "original_decision_model",
          description:
            "Five-stage verification protocol combining INSEE RP2022 (COM-74056 vs COM-74173), DGFiP 5-year DVF, Notaires de France 2023/2025/2034 DPE audit schedule, and a reproducible 7.2% gross-yield worked calculation.",
          lineageClaimId: "claim-yield-calc",
          verifiableAnchors: ["14,538 total dwellings", "1,300,000 EUR", "26400 EUR over 366000 EUR", "7.2% gross yield"],
          workProductId: wpAlpine.workProductId,
          workProduct: wpAlpine,
        },
      });
      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: "advisory/investment-decision-framework",
          kind: "original_framework",
          description:
            "Capital decision framework integrating DGFiP 5-year DVF transfer baselines, 1,300,000 EUR IFI thresholds, 1946-1990 thermal capex assumptions, and May 2025 Chamonix rental quota scenarios.",
          lineageClaimId: "claim-invest-yield-ref",
          verifiableAnchors: ["1,300,000 EUR", "800,000 EUR", "26400 EUR over a purchase price of 366000 EUR", "58.5% of main residences"],
          workProductId: wpInvest.workProductId,
          workProduct: wpInvest,
        },
      });
      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: "home",
          kind: "transparent_synthesis",
          description:
            "Primary-source orientation distinguishing Loi Hoguet (Law No. 70-9) brokerage intermediation from non-intermediated buyer-side research over INSEE Chamonix (COM-74056) and Megève (COM-74173) housing data.",
          lineageClaimId: "claim-home-hoguet",
          verifiableAnchors: ["Law No. 70-9 of 2 January 1970", "14,538 total dwellings", "9,354 total dwellings"],
        },
      });
      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: "services/buyer-side-advisory",
          kind: "transparent_synthesis",
          description:
            "Service scope mapping buyer-side due diligence to Notaires de France 10-day cooling-off rules, 2023/2025/2034 DPE energy audit milestones, and Loi Hoguet statutory boundaries.",
          lineageClaimId: "claim-service-notaires",
          verifiableAnchors: ["10-day cooling-off period", "classes F and G in 2023, class E in 2025, and class D in 2034", "Law No. 70-9"],
        },
      });
      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: "locations/chamonix",
          kind: "first_party_observation",
          description:
            "Comparative commune analysis of Chamonix-Mont-Blanc (COM-74056) vs Megève (COM-74173) pairing INSEE 2022 stock/vintage tables with Chamonix PLU 25% social-mix quotas and 1 May 2025 rental quotas.",
          lineageClaimId: "claim-chamonix-insee-stock",
          verifiableAnchors: ["14,538 total dwellings", "69.3% secondary residences", "25% social-mix quotas", "1 May 2025"],
        },
      });

      // ---- Cannibalization gate over stored authority (Block 4) ----
      const cann = await trust.cannibalizationVerdict(seeded.projectId);
      assert.equal(cann.verdict, "PASS", `cannibalization: ${JSON.stringify(cann.findings)}`);

      // ---- ONE design-v2 design acceptance (Stitch provider path) ----
      root = await mkdtemp(path.join(tmpdir(), "run12-"));
      const designStore = new DesignStore(dbInst.db);
      const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seeded.projectId });
      const snapshotData = parseDesignInputSnapshotAnyVersion(snapshot.data);
      assert.ok(isDesignInputSnapshotV2(snapshotData), "fresh project derives design-v2 snapshot");

      const providerCalls: string[] = [];
      class CountingStitchProvider extends EvidenceStitchProvider {
        override async generateDesignSystem(request: Parameters<EvidenceStitchProvider["generateDesignSystem"]>[0]) {
          providerCalls.push("generateDesignSystem");
          return super.generateDesignSystem(request);
        }
      }
      const mockStitch = new MockStitchClient();
      mockStitch.queue({ name: `projects/run12-${seeded.projectId.slice(0, 8)}`, title: `factory-${seeded.projectId.slice(0, 8)}-design` });
      mockStitch.queue({ name: `assets/ds-run12` });
      for (const kind of snapshotData.archetypes) {
        mockStitch.queue({
          outputComponents: [
            { design: { screens: [{ name: `projects/run12/screens/${kind}`, title: kind, deviceType: "DESKTOP" }] } },
          ],
          sessionId: `sess-${kind}`,
        });
        mockStitch.queue({
          name: `projects/run12/screens/${kind}`,
          title: kind,
          deviceType: "DESKTOP",
          htmlCode: { name: `${kind}/html`, mimeType: "text/html", downloadUrl: `https://example.com/${kind}` },
          screenshot: { name: `${kind}/shot`, mimeType: "image/png", downloadUrl: null },
        });
        if (kind === "homepage") {
          mockStitch.queue({
            outputComponents: [
              { design: { screens: [{ name: "projects/run12/screens/home-mob", title: "Home Mobile", deviceType: "MOBILE" }] } },
            ],
            sessionId: "sess-mob",
          });
          mockStitch.queue({
            name: "projects/run12/screens/home-mob",
            title: "Home Mobile",
            deviceType: "MOBILE",
            htmlCode: { name: "home-mob/html", mimeType: "text/html", downloadUrl: "https://example.com/home-mob" },
            screenshot: { name: "home-mob/shot", mimeType: "image/png", downloadUrl: null },
          });
        }
      }
      const stitchProvider = new CountingStitchProvider({
        env: { STITCH_ACCESS_TOKEN: "mock-token" },
        createClient: () => mockStitch as never,
      });
      const copyByArchetype: Record<
        string,
        {
          slug: string;
          title: string;
          introduction: string;
          sections: Array<{ heading: string; body: string }>;
          conclusion: string;
          cta: string;
        }
      > = {};
      for (const rep of snapshotData.representativePages) {
        const row = acceptedPages.get(rep.slug)!;
        const [contentRow] = await dbInst.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.id, row.id));
        const data = contentRow!.data as {
          title: string;
          introduction: string;
          sections: Array<{ heading: string; body: string }>;
          conclusion: string;
          cta: string;
        };
        copyByArchetype[rep.archetype] = { slug: rep.slug, ...data };
      }
      const genResult = await stitchProvider.generateDesignSystem({
        inputSnapshot: snapshotData,
        inputSnapshotId: snapshot.id,
        projectId: seeded.projectId,
        acceptedCopyByArchetype: copyByArchetype,
        designSeed: {
          colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#2F5D62", neutral: "#F7F5F2" },
          typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "Institutional typographic scale" },
          rationale: "Institutional advisory identity (accepted Sutherland visual direction).",
        },
      });
      assert.equal(providerCalls.length, 1, "exactly one design generation call for the whole site");
      const candidate = await designStore.createCandidate({
        projectId: seeded.projectId,
        inputSnapshot: snapshot,
        data: genResult.candidate,
      });
      const acceptedDesign = await designStore.acceptCandidate({
        projectId: seeded.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: "Run 12 Sutherland project design acceptance",
      });
      const acceptedDesignData = parseDesignCandidateAnyVersion(acceptedDesign.data);
      assert.equal(acceptedDesignData.schemaVersion, "design-v2");
      const designId = acceptedDesign.id;

      // ---- VisualService lifecycle (P2-4: kind: "illustration", not "photo") ----
      const assetsModule = await import("../../src/assets/service.js");
      const assets = new assetsModule.AssetService({
        store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
        storage: createAssetStorage(repoRoot),
      });
      const heroSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
        <rect width="1600" height="900" fill="#1A2E35"/>
        <path d="M0 680 L420 340 L760 560 L1140 240 L1600 620 L1600 900 L0 900 Z" fill="#243E47" opacity="0.85"/>
        <path d="M0 740 L360 480 L820 660 L1260 390 L1600 700 L1600 900 L0 900 Z" fill="#2F5D62" opacity="0.65"/>
        <line x1="120" y1="140" x2="1480" y2="140" stroke="#F7F5F2" stroke-opacity="0.2" stroke-width="2"/>
      </svg>`;
      const heroBytes = await sharp(Buffer.from(heroSvg)).jpeg({ quality: 90 }).toBuffer();
      const heroUpload = await assets.uploadAsset(seeded.projectId, {
        filename: "alpine-topographic-illustration.jpg",
        kind: "illustration",
        title: "Abstract alpine topographic illustration",
        rightsStatus: "operator_owned",
        dataBase64: heroBytes.toString("base64"),
        altIntent: "Abstract geometric alpine topographic contour illustration in deep slate and teal",
      });
      assert.equal(heroUpload.asset.kind, "illustration", "P2-4: visual asset is classified as illustration, not photo");
      const approvedHero = await assets.approveVersion(seeded.projectId, heroUpload.version.id, heroUpload.version.binaryDigest);

      const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
        <rect width="1200" height="800" fill="#2F5D62"/>
        <path d="M0 540 L380 310 L760 490 L1200 260 L1200 800 L0 800 Z" fill="#1A2E35" opacity="0.75"/>
      </svg>`;
      const bgBytes = await sharp(Buffer.from(bgSvg)).jpeg({ quality: 90 }).toBuffer();
      const bgUpload = await assets.uploadAsset(seeded.projectId, {
        filename: "alpine-band-illustration.jpg",
        kind: "illustration",
        title: "Abstract supporting topographic band illustration",
        rightsStatus: "operator_owned",
        dataBase64: bgBytes.toString("base64"),
        altIntent: "Abstract geometric slate and teal architectural band illustration",
      });
      assert.equal(bgUpload.asset.kind, "illustration", "P2-4: supporting visual asset is classified as illustration, not photo");
      const approvedBg = await assets.approveVersion(seeded.projectId, bgUpload.version.id, bgUpload.version.binaryDigest);

      const visualStore = new VisualStore(dbInst.db);
      const visualService = new VisualService({
        store: visualStore,
        designStore,
        assets,
        budget: new VisualBudgetStore(dbInst.db),
        provider: new (class extends FixtureVisualAssetProvider {
          override readonly providerMode = "live" as const;
        })(),
        repoRoot: root,
      });
      const plan = await visualService.derivePlan({ projectId: seeded.projectId });
      const planData = visualStore.planData(plan);
      for (const slot of planData.slots) {
        if (slot.required) {
          await visualService.confirmClassification({
            projectId: seeded.projectId,
            planId: plan.id,
            slot: slot.slot,
            truthClass: "illustrative",
          });
          await visualService.resolveReuse({
            projectId: seeded.projectId,
            planId: plan.id,
            slot: slot.slot,
            versionId: slot.role === "hero" ? approvedHero.id : approvedBg.id,
          });
        }
      }
      const visualRecord = await visualService.acceptSet({ projectId: seeded.projectId, planId: plan.id });
      assert.equal(visualRecord.designArtifactId, designId, "visual set binds the accepted design");

      // ---- P1-6 & P1-4 PROOF: Build Candidate 1 BEFORE ReviewAuthority exists -> QA MUST FAIL and transition candidate to qa_failed ----
      const buildService = new ProductionBuildService(dbInst.db, repoRoot);
      for (const page of SUTHERLAND_PAGES) {
        await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: page.slug });
      }
      const unreviewedPrep = await buildService.prepareCandidate({
        projectId: seeded.projectId,
        pageSlug: SUTHERLAND_PAGES[0]!.slug,
      });
      const unreviewedBuild = await buildService.buildCandidate({
        projectId: seeded.projectId,
        candidateId: unreviewedPrep.candidateId,
      });
      await recordTrustedEvidenceForCandidate({
        productionStore,
        projectId: seeded.projectId,
        candidateId: unreviewedBuild.candidateId,
        artifactDigest: unreviewedBuild.artifactDigest,
        manifestSetDigest: unreviewedBuild.manifestSetDigest,
        repositorySha: realBuildIdentity.repositorySha,
        lockfileDigest: realBuildIdentity.lockfileDigest,
        routes: SUTHERLAND_PAGES.map((p) => `/${p.slug}`),
      });
      const unreviewedQaResult = await productionFacade.runCandidateQa({
        projectId: seeded.projectId,
        candidateId: unreviewedBuild.candidateId,
      });
      assert.equal(
        unreviewedQaResult.overall,
        "FAIL",
        "P1-4 & P1-6: candidate without governed ReviewAuthority on YMYL_DECISION_SUPPORT pages must FAIL runCandidateQa",
      );
      const unreviewedReviewChecks = unreviewedQaResult.checks.filter(
        (c) =>
          c.checkId === "trust.review_authority" &&
          (c.subject === "/advisory/investment-decision-framework" || c.subject === "/research/alpine-decision-framework"),
      );
      assert.equal(unreviewedReviewChecks.length, 2);
      assert.ok(
        unreviewedReviewChecks.every((c) => c.verdict === "FAIL"),
        "P1-4: trust.review_authority is never skipped when data-review-authority is absent from HTML",
      );
      const unreviewedCandidateRow = await productionStore.getCandidate(seeded.projectId, unreviewedBuild.candidateId);
      assert.equal(
        unreviewedCandidateRow!.state,
        "qa_failed",
        "P1-6: candidate with failed YMYL trust gate transitions to qa_failed and cannot become qa_passed",
      );

      // ---- P1-4: Record governed ReviewAuthority for YMYL decision-support pages, then rebuild Candidate 2 ----
      const sourceEvidenceSetDigest = computeSourceEvidenceSetDigest({ inseeEvidence, legalEvidence });

      for (const ymylSlug of ["advisory/investment-decision-framework", "research/alpine-decision-framework"] as const) {
        const ymylPage = acceptedPages.get(ymylSlug)!;
        const pageClaims = claimsForPage(ymylSlug);
        const claimSetDigest = computeClaimSetDigest(pageClaims);
        await trust.recordReview({
          projectId: seeded.projectId,
          review: {
            schemaVersion: "trust-governance-v1",
            projectId: seeded.projectId,
            pageIdentity: ymylSlug,
            reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
            reviewStatus: "EDITORIAL_REVIEW_APPROVED",
            approvalEventId: `appr-sutherland-council-${ymylSlug.replace(/[^a-z0-9]/g, "-")}-20260904`,
            approvalEventProvenance: "Accepted by Sutherland Institutional Review Council Minutes 2026-09-04 Item 4",
            reviewerRef: "org-sutherland-private-office-research-committee",
            reviewerExpertise: "Independent buyer-side alpine property advisory and evidence-led decision methodology",
            reviewedContentDigest: ymylPage.contentDigest,
            reviewedAt: "2026-09-04",
            result: "APPROVED",
            note: "Verified INSEE RP2022, DGFiP DVF/IFI, Notaires de France DPE schedule, Géorisques PPRN citations, and 7.2% worked calculation.",
            verifiedClaimIds: pageClaims.map((c) => c.claimId),
            sourceEvidenceSetDigest,
            claimSetDigest,
          },
        });
        const revCheck = await trust.currentReview(
          seeded.projectId,
          ymylSlug,
          ymylPage.contentDigest,
          claimSetDigest,
          sourceEvidenceSetDigest,
        );
        assert.ok(revCheck.review, `review recorded for ${ymylSlug}`);
        assert.equal(revCheck.stale, false, `review for ${ymylSlug} is current`);
      }

      const allPrepared = await buildService.prepareCandidate({
        projectId: seeded.projectId,
        pageSlug: SUTHERLAND_PAGES[0]!.slug,
      });
      const siteResult = await buildService.buildCandidate({
        projectId: seeded.projectId,
        candidateId: allPrepared.candidateId,
      });
      assert.ok(siteResult.artifactDigest, `five-page reviewed candidate built (${siteResult.routeCount} routes)`);

      const candidate5Row = (await productionStore.getCandidate(seeded.projectId, siteResult.candidateId))!;
      assert.equal(candidate5Row.repositorySha, realBuildIdentity.repositorySha, "P2-3: candidate binds real repositorySha");
      assert.equal(candidate5Row.lockfileDigest, realBuildIdentity.lockfileDigest, "P2-3: candidate binds real lockfileDigest");

      const lastCandidateDir = path.join(
        repoRoot,
        ".factory",
        "production",
        "projects",
        safeSegmentLocal(seeded.projectId),
        "candidates",
        safeSegmentLocal(siteResult.candidateId),
      );
      const distDir = path.join(lastCandidateDir, "dist");
      const manifestDir = path.join(lastCandidateDir, "manifests");
      const manifests = await new ProductionRenderCompiler(dbInst.db, root).readAllManifests(manifestDir);
      assert.equal(manifests.length, 5, "five manifests in the built candidate");

      // P2-1: Derive componentFamiliesBefore from REAL compiled manifests (not a hardcoded Set).
      const designCountBefore = (await designStore.latestAcceptedDesign(seeded.projectId))!.artifact;
      const stitchCallsBefore = providerCalls.length;
      const componentFamiliesBefore = new Set<string>(
        manifests.flatMap((m) => (m.design.composition ?? []).map((step) => step.componentId)),
      );
      assert.ok(componentFamiliesBefore.size >= 4, "P2-1: real DIC/manifest composition component families extracted before 6th page");

      // Built HTML sanity: five routes, fixture-free, accepted titles, and visible review authority on YMYL pages.
      for (const page of SUTHERLAND_PAGES) {
        const routePath = path.join(distDir, ...page.slug.split("/").filter(Boolean), "index.html");
        const html = await readFile(routePath, "utf8");
        assert.ok(html.includes(page.title), `route ${page.slug} carries its accepted title`);
        assert.ok(!/fixture|Summit Roofing|roof repair/i.test(html), `route ${page.slug} has no fixture leakage`);
        if (page.ymyl === "YMYL_DECISION_SUPPORT") {
          const expectedDigest = acceptedPages.get(page.slug)!.contentDigest;
          assert.ok(
            html.includes('data-review-authority="org-sutherland-private-office-research-committee"'),
            `P1-4: route ${page.slug} renders visible data-review-authority in HTML`,
          );
          assert.ok(
            html.includes(`data-reviewed-digest="${expectedDigest}"`),
            `P1-4: route ${page.slug} renders exact data-reviewed-digest in HTML`,
          );
        }
      }

      // Run full candidate QA via ProductionApiFacade.runCandidateQa on the reviewed 5-page candidate.
      await recordTrustedEvidenceForCandidate({
        productionStore,
        projectId: seeded.projectId,
        candidateId: siteResult.candidateId,
        artifactDigest: siteResult.artifactDigest,
        manifestSetDigest: siteResult.manifestSetDigest,
        repositorySha: realBuildIdentity.repositorySha,
        lockfileDigest: realBuildIdentity.lockfileDigest,
        routes: SUTHERLAND_PAGES.map((p) => `/${p.slug}`),
      });
      const qa5 = await productionFacade.runCandidateQa({
        projectId: seeded.projectId,
        candidateId: siteResult.candidateId,
      });
      if (qa5.overall !== "PASS") {
        console.error(
          "QA 5 FAILING:",
          qa5.checks.filter((c) => c.verdict !== "PASS").map((c) => `${c.checkId}@${c.subject}: ${c.detail}`),
        );
      }
      assert.equal(qa5.overall, "PASS", "ProductionApiFacade.runCandidateQa (including mandatory YMYL trust gates) must PASS on 5-page build");
      assert.equal(
        (await productionStore.getCandidate(seeded.projectId, siteResult.candidateId))!.state,
        "qa_passed",
        "P1-6: candidate transitions to qa_passed after all site-wide, design-drift, and YMYL trust gates pass",
      );

      // ---- SIXTH-PAGE REUSE PROOF (Block 33): add a differentiated 6th page under editorial archetype ----
      const extraPage = EXTRA_SIXTH_PAGE;
      const brief6 = await writerStores.store.saveBriefDraft({
        projectId: seeded.projectId,
        pageTarget: {
          slug: extraPage.slug,
          title: extraPage.title,
          objective: extraPage.objective,
          audience: extraPage.audience,
          structureGuidance: extraPage.structureGuidance,
          internalLinkIntent: extraPage.internalLinkIntent,
          ctaIntent: extraPage.ctaIntent,
          designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "editorial" as const },
        },
        contentBriefKeyPoints: [],
      });
      await writerStores.store.approveBrief({
        projectId: seeded.projectId,
        briefId: brief6.id,
        expectedVersion: brief6.version,
        expectedDigest: brief6.digest,
      });
      const snapshot6 = await writer.compileSnapshot({ projectId: seeded.projectId });
      await writer.approveSnapshot({
        projectId: seeded.projectId,
        snapshotId: snapshot6.id,
        expectedVersion: snapshot6.version,
        expectedDigest: snapshot6.digest,
      });
      const proposalData6 = sutherlandProposalFor(extraPage);
      // P1-2: Prove zero duplicated section headings or bodies between page 5 and page 6!
      const proposalData5 = sutherlandProposalFor(SUTHERLAND_PAGES[4]!);
      for (const sec6 of proposalData6.sections) {
        assert.ok(
          !proposalData5.sections.some((sec5) => sec5.heading === sec6.heading || sec5.body === sec6.body),
          `P1-2: 6th page section "${sec6.heading}" is completely distinct from 5th page sections`,
        );
      }

      const proposal6 = await writer.generateProposal(
        { projectId: seeded.projectId, snapshotId: snapshot6.id },
        {
          invoke: (async (request: { model?: string }) => ({
            requestedModel: request.model ?? "test-model",
            respondedModel: "test-model",
            provider: "seam",
            durationMs: 5,
            promptTokens: 120,
            completionTokens: 500,
            totalTokens: 620,
            costUsd: 0,
            content: JSON.stringify(proposalData6),
          })) as never,
          dailyLimitUsd: 10,
        },
      );
      const qa6 = await writer.runQa({ projectId: seeded.projectId });
      assert.equal(
        qa6.overall,
        "PASS",
        `writer QA for ${extraPage.slug}: ${JSON.stringify({ factual: qa6.factual, search: qa6.search, editorial: qa6.editorial })}`,
      );
      await writer.acceptContent({
        projectId: seeded.projectId,
        proposalId: proposal6.id,
        expectedProposalDigest: proposal6.digest,
      });

      await trust.setPageIntentAuthority({
        projectId: seeded.projectId,
        intent: intentForPage(seeded.projectId, extraPage, {
          id: seeded.gapSnapshotId,
          version: seeded.gapSnapshotVersion,
          digest: seeded.gapSnapshotDigest,
        }),
      });

      // ---- P2-2: Derive new VisualAssetPlan & VisualAssetSet covering the 6th page's exact slot ----
      const plan2 = await visualService.derivePlan({ projectId: seeded.projectId });
      const plan2Data = visualStore.planData(plan2);
      const sixthPageHeroSlotName = `hero-primary.${extraPage.slug}`;
      const sixthPagePlanSlot = plan2Data.slots.find((s) => s.slot === sixthPageHeroSlotName);
      assert.ok(sixthPagePlanSlot, `P2-2: visual plan includes exact 6th-page slot ${sixthPageHeroSlotName}`);
      assert.equal(sixthPagePlanSlot.pageSlug, extraPage.slug);

      for (const slot of plan2Data.slots) {
        if (slot.required || slot.pageSlug === extraPage.slug) {
          await visualService.confirmClassification({
            projectId: seeded.projectId,
            planId: plan2.id,
            slot: slot.slot,
            truthClass: "illustrative",
          });
          await visualService.resolveReuse({
            projectId: seeded.projectId,
            planId: plan2.id,
            slot: slot.slot,
            versionId: slot.role === "hero" ? approvedHero.id : approvedBg.id,
          });
        }
      }
      const visualRecord2 = await visualService.acceptSet({ projectId: seeded.projectId, planId: plan2.id });
      assert.equal(visualRecord2.version, visualRecord.version + 1, "P2-2: adding 6th page produces new AcceptedVisualAssetSet version");
      assert.notEqual(visualRecord2.setDigest, visualRecord.setDigest, "P2-2: new visual set has distinct setDigest binding the 6th page slot");
      const acceptedSlots2 = await visualStore.listAcceptedSlots(visualRecord2.id);
      const sixthAcceptedSlot = acceptedSlots2.find((s) => s.slot === sixthPageHeroSlotName);
      assert.ok(sixthAcceptedSlot, `P2-2: AcceptedVisualAssetSet persists slot ${sixthPageHeroSlotName}`);
      assert.equal(sixthAcceptedSlot.resolvedVersionId, approvedBg.id, "P2-2: 6th page slot reuses the approved 3:2 illustration asset");
      assert.equal(sixthAcceptedSlot.binaryDigest, approvedBg.binaryDigest, "P2-2: 6th page slot binds exact binaryDigest");

      // Claim lineage, OriginalValueRecord, and ReviewAuthority for the 6th page BEFORE building Candidate 3.
      const [row6] = await dbInst.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.slug, extraPage.slug));
      assert.ok(row6, "accepted content row for the sixth page");
      const page6Claims = claimsForPage(extraPage.slug);
      await trust.saveClaimLineage({
        projectId: seeded.projectId,
        pageIdentity: extraPage.slug,
        contentDigest: row6.contentDigest,
        claims: page6Claims,
      });
      const wpSupplyTransDigest = createHash("sha256")
        .update("chamonix-supply-synthesis-v1:insee-vintage=58.5%;plu-quota=25%;rental-quota=1;effective=2025-05-01")
        .digest("hex");
      const wpSupply: OriginalWorkProduct = {
        workProductId: "owp-chamonix-supply-notes-01",
        pageIdentity: extraPage.slug,
        productType: "STRUCTURED_DATASET",
        title: "Chamonix Supply-Side Regulatory & Housing Stock Synthesis Dataset",
        description:
          "Supply-side analysis of Chamonix-Mont-Blanc (COM-74056) combining INSEE 1946-1990 construction vintage (58.5%), PLU 25% social-mix quotas, and 1 May 2025 rental registration quotas.",
        inputDatasetDigests: [inseeChamonixDigest, pluDigest, meublesDigest],
        transformationDigest: wpSupplyTransDigest,
        executionHash: computeWorkProductExecutionHash({
          productType: "STRUCTURED_DATASET",
          inputDatasetDigests: [inseeChamonixDigest, pluDigest, meublesDigest],
          transformationDigest: wpSupplyTransDigest,
        }),
        outputArtifactRef: "docs/evidence/models/chamonix-supply-dataset-v1.json",
        reproducibleCommand: "pnpm --filter @factory/factory exec tsx scripts/reproduce-chamonix-supply.ts",
        verifiableAnchors: ["58.5% of main residences", "25% social-mix quotas", "1 May 2025"],
        provenance: "Authored by Sutherland Private Office Research Team based on official INSEE and Chamonix municipal registers.",
      };

      await trust.saveOriginalValue({
        projectId: seeded.projectId,
        record: {
          schemaVersion: "trust-governance-v1",
          pageIdentity: extraPage.slug,
          kind: "first_party_observation",
          description:
            "Supply-side analysis of Chamonix-Mont-Blanc (COM-74056) combining INSEE 1946-1990 construction vintage (58.5%), PLU 25% social-mix quotas, and 1 May 2025 rental registration quotas.",
          lineageClaimId: "claim-supply-insee-vintage",
          verifiableAnchors: ["58.5% of main residences", "25% social-mix quotas", "1 May 2025"],
          workProductId: wpSupply.workProductId,
          workProduct: wpSupply,
        },
      });
      await trust.recordReview({
        projectId: seeded.projectId,
        review: {
          schemaVersion: "trust-governance-v1",
          projectId: seeded.projectId,
          pageIdentity: extraPage.slug,
          reviewerKind: "ACCEPTED_INSTITUTIONAL_COUNCIL",
          reviewStatus: "EDITORIAL_REVIEW_APPROVED",
          approvalEventId: `appr-sutherland-council-${extraPage.slug.replace(/[^a-z0-9]/g, "-")}-20260904`,
          approvalEventProvenance: "Accepted by Sutherland Institutional Review Council Minutes 2026-09-04 Item 4",
          reviewerRef: "org-sutherland-private-office-research-committee",
          reviewerExpertise: "Independent buyer-side alpine property advisory and evidence-led decision methodology",
          reviewedContentDigest: row6.contentDigest,
          reviewedAt: "2026-09-04",
          result: "APPROVED",
          note: "Verified Chamonix supply-side notes against INSEE RP2022, Chamonix PLU, May 2025 rental rules, and Géorisques PPRN.",
          verifiedClaimIds: page6Claims.map((c) => c.claimId),
          sourceEvidenceSetDigest,
          claimSetDigest: computeClaimSetDigest(page6Claims),
        },
      });

      // Refresh PPIs for all 6 pages against the new AcceptedVisualAssetSet and build Candidate 3.
      for (const page of [...SUTHERLAND_PAGES, extraPage]) {
        await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: page.slug });
      }
      const prepared6 = await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: extraPage.slug });
      const ppi6Row = await productionStore.latestProductionInput(seeded.projectId, extraPage.slug);
      assert.ok(ppi6Row, "P2-2: ProductionPageInput derived for 6th page");
      assert.equal(ppi6Row.acceptedVisualSetId, visualRecord2.id, "P2-2: 6th page PPI binds visualRecord2.id");
      assert.equal(ppi6Row.acceptedVisualSetVersion, visualRecord2.version, "P2-2: 6th page PPI binds visualRecord2.version");
      assert.equal(ppi6Row.acceptedVisualSetDigest, visualRecord2.setDigest, "P2-2: 6th page PPI binds visualRecord2.setDigest");

      const result6 = await buildService.buildCandidate({
        projectId: seeded.projectId,
        candidateId: prepared6.candidateId,
      });
      assert.ok(result6.artifactDigest, `sixth-page candidate built (${result6.routeCount} routes)`);
      const last6 = path.join(
        repoRoot,
        ".factory",
        "production",
        "projects",
        safeSegmentLocal(seeded.projectId),
        "candidates",
        safeSegmentLocal(result6.candidateId),
      );
      const distDir2 = path.join(last6, "dist");
      const manifests2 = await new ProductionRenderCompiler(dbInst.db, root).readAllManifests(path.join(last6, "manifests"));
      assert.equal(manifests2.length, 6, "six manifests after the ordinary page addition");

      const manifest6 = manifests2.find((m) => m.input.pageIdentity === extraPage.slug);
      assert.ok(manifest6, "P2-2: compiled manifest exists for 6th page");
      assert.ok(
        manifest6.assets.some((a) => a.slot === sixthPageHeroSlotName && a.versionId === approvedBg.id),
        `P2-2: 6th page manifest binds slot ${sixthPageHeroSlotName} to approvedBg`,
      );

      // ---- P2-1: AFTER state — compare component families derived from REAL manifests ----
      const designCountAfter = (await designStore.latestAcceptedDesign(seeded.projectId))!.artifact;
      assert.equal(designCountAfter.id, designCountBefore.id, "zero new AcceptedDesignArtifact");
      assert.equal(designCountAfter.version, designCountBefore.version, "design artifact not superseded");
      assert.equal(providerCalls.length, stitchCallsBefore, "zero new Stitch/provider design calls");
      const componentFamiliesAfter = new Set<string>(
        manifests2.flatMap((m) => (m.design.composition ?? []).map((step) => step.componentId)),
      );
      assert.deepEqual(
        [...componentFamiliesAfter].sort(),
        [...componentFamiliesBefore].sort(),
        "P2-1: zero new component families across real compiled manifests before and after 6th page",
      );

      const designStaleness = await designStore.latestAcceptedDesign(seeded.projectId);
      assert.equal(
        designStaleness!.staleness.stale,
        false,
        `design must not stale on ordinary page addition: ${designStaleness!.staleness.reason}`,
      );

      // Run full ProductionApiFacade.runCandidateQa on the 6-page candidate (P1-6, P2-3).
      await recordTrustedEvidenceForCandidate({
        productionStore,
        projectId: seeded.projectId,
        candidateId: result6.candidateId,
        artifactDigest: result6.artifactDigest,
        manifestSetDigest: result6.manifestSetDigest,
        repositorySha: realBuildIdentity.repositorySha,
        lockfileDigest: realBuildIdentity.lockfileDigest,
        routes: [...SUTHERLAND_PAGES, extraPage].map((p) => `/${p.slug}`),
      });
      const qa6Candidate = await productionFacade.runCandidateQa({
        projectId: seeded.projectId,
        candidateId: result6.candidateId,
      });
      if (qa6Candidate.overall !== "PASS") {
        console.error(
          "QA 6 FAILING:",
          qa6Candidate.checks.filter((c) => c.verdict !== "PASS").map((c) => `${c.checkId}@${c.subject}: ${c.detail}`),
        );
      }
      assert.equal(qa6Candidate.overall, "PASS", "6-page candidate must PASS full ProductionApiFacade.runCandidateQa");
      assert.equal(
        (await productionStore.getCandidate(seeded.projectId, result6.candidateId))!.state,
        "qa_passed",
        "6-page candidate transitions to qa_passed",
      );

      // ---- P2-5: Persist the built 6-page Sutherland site & manifests in .factory/qa-evidence/run12-sutherland-site ----
      const qaEvidenceRoot = path.join(repoRoot, ".factory", "qa-evidence", "run12-sutherland-site");
      await rm(qaEvidenceRoot, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(qaEvidenceRoot, { recursive: true });
      await cp(distDir2, path.join(qaEvidenceRoot, "dist"), { recursive: true });
      await cp(path.join(last6, "manifests"), path.join(qaEvidenceRoot, "manifests"), { recursive: true });

      // ---- Real-browser Playwright E2E, Responsive, Axe & Keyboard QA against the preserved 6-page Sutherland site ----
      const starterDir = path.join(repoRoot, "sites", "starter");
      const pwRun = await runProcess(
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          "tests/run12-multipage.e2e.spec.ts",
          "tests/axe.production.spec.ts",
          "tests/keyboard.production.spec.ts",
        ],
        {
          cwd: starterDir,
          env: {
            ...process.env,
            FACTORY_QA_ARTIFACT_DIR: path.join(qaEvidenceRoot, "dist"),
            FACTORY_QA_SCREENSHOT_DIR: path.join(qaEvidenceRoot, "screenshots"),
            FACTORY_QA_PORT: "4392",
          },
          timeoutMs: 240_000,
        },
      );
      if (pwRun.exitCode !== 0) {
        console.error("PLAYWRIGHT SUTHERLAND E2E/AXE/KEYBOARD FAILED:\n", pwRun.stdout, "\n", pwRun.stderr);
      }
      assert.equal(
        pwRun.exitCode,
        0,
        "Playwright multi-page E2E, responsive, axe, and keyboard checks must pass on built Sutherland candidate",
      );

      // Clean up temporary per-project runtime dirs while preserving .factory/qa-evidence/run12-sutherland-site for CI artifact upload!
      await rm(path.join(repoRoot, ".factory", "production", "projects", safeSegmentLocal(seeded.projectId)), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      await rm(path.join(repoRoot, ".factory", "assets", "projects", safeSegmentLocal(seeded.projectId)), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      await dbInst.close();
    }
  },
);
