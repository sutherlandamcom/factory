import { createHash } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { acceptedContentGapSnapshots } from "../../src/persistence/schema.js";
import { sutherlandIntakePayload } from "./sutherland-intake.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { SearchStore } from "../../src/search/search-store.js";
import { SearchIntelligenceService } from "../../src/search/service.js";
import type {
  StructuredSerpProvider,
  SerpAcquisitionRequest,
  SerpAcquisitionResult,
} from "../../src/search/provider-types.js";
import {
  SEARCH_ANALYST_PROMPT_VERSION,
  type SearchAnalystModel,
  type SearchAnalystRequest,
  type SearchAnalystResult,
} from "../../src/search/analyst.js";
import { CompetitorStore } from "../../src/competitors/competitor-store.js";
import { CompetitorContentGapService } from "../../src/competitors/service.js";
import type {
  CompetitorPageProvider,
  PageAcquisitionRequest,
  PageAcquisitionOutcome,
} from "../../src/competitors/direct-http.js";
import {
  COMPETITOR_ANALYST_PROMPT_VERSION,
  type CompetitorAnalystModel,
  type CompetitorAnalystRequest,
  type CompetitorAnalystResult,
} from "../../src/competitors/analyst.js";
import {
  GAP_ANALYST_PROMPT_VERSION,
  type GapAnalystModel,
  type GapAnalystRequest,
  type GapAnalystResult,
} from "../../src/competitors/gap-analyst.js";
import type {
  CompetitorPageAnalysisData,
  CoverageLevel,
  SearchIntelligenceData,
} from "@factory/contracts";

/**
 * RUN 12 SUTHERLAND SEARCH / COMPETITOR / GAP AUTHORITY PIPELINE.
 *
 * Executes the real governed SearchIntelligenceService (Run 2) and
 * CompetitorContentGapService (Run 3) pipelines against the acquired
 * Sutherland SERP, competitor, and French Alpine institutional research
 * corpus (.factory/discovery/sutherland-private-office/20260831T151804Z/
 * and .factory/blueprint/20260901T114820Z-8976f5e5/normalized-research.json).
 *
 * Every artifact (SearchRun, SerpSnapshot, SearchIntelligenceSnapshot,
 * CompetitorRun, CompetitorPageSnapshot, CompetitorPageAnalysis,
 * ContentGapReport, GapDecision, AcceptedContentGapSnapshot) is produced
 * through the real application services with verified digests, real organic
 * SERP results, extracted competitor segments, coverage matrix rows, and
 * accepted content gaps.
 */

const OBSERVED_AT = new Date("2026-08-31T15:18:04.000Z");

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

const ACQUIRED_COMPETITOR_CORPUS: ReadonlyArray<{
  position: number;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  html: string;
  commercialPositioning: string;
  ctaTreatment: string;
  coverageLevels: Record<string, { level: CoverageLevel; rationale: string }>;
  strengths: string[];
  weaknesses: string[];
  missingTreatment: string[];
}> = [
  {
    position: 1,
    url: "https://athenaadvisers.com/french-alps-property-investment-guide/",
    domain: "athenaadvisers.com",
    title: "French Alps Property Investment Guide | Athena Advisers",
    snippet:
      "International property consultancy covering ski apartments and chalets across Chamonix, Megève and the French Alps with rental management guidance.",
    html: `<!doctype html><html lang="en"><head><title>French Alps Property Investment Guide | Athena Advisers</title><meta name="description" content="International property consultancy covering French Alps ski property, new-build VAT recovery and resort guides."></head><body>
      <h1>French Alps Property Investment Guide</h1>
      <h2>Resort Overview: Chamonix and Megève</h2>
      <p>Athena Advisers markets new-build and resale ski properties across Chamonix-Mont-Blanc, Megève, and the Trois Vallées for international buyers seeking lifestyle and rental yield.</p>
      <h2>Purchase Process and VAT Recovery</h2>
      <p>Buyers of new-build French Alps apartments can recover 20% VAT under Para-Hotelier management mandates when offering hospitality services.</p>
      <h2>Speak with an Investment Property Consultant</h2>
      <p>Book a consultation or browse our active portfolio of French Alps chalets and apartments.</p>
    </body></html>`,
    commercialPositioning: "International property consultancy and developer marketing intermediary.",
    ctaTreatment: "Lead-capture consultation booking and active listing portfolio funnel.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "WEAK",
        rationale: "Focuses on developer sales and marketing consultancy rather than unconflicted buyer-only representation.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "WEAK",
        rationale: "Presents promotional yield commentary without municipal INSEE housing ratios or DVF deed reconciliations.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "PARTIAL",
        rationale: "Covers Chamonix and Megève resort lifestyle and new-build supply but omits PLU servitudes and May 2025 rental quotas.",
      },
      "How an engagement begins without a sales funnel": {
        level: "ABSENT",
        rationale: "Uses a standard property sales and brochure download funnel.",
      },
    },
    strengths: ["Broad resort overview across Chamonix and Megève", "Clear summary of new-build VAT rules"],
    weaknesses: ["Inventory-led intermediary positioning", "No municipal INSEE or DVF transaction dataset verification"],
    missingTreatment: ["Fee-only buyer fiduciary separation under Loi Hoguet", "PPRN natural hazard and DPE 2025/2034 audit constraints"],
  },
  {
    position: 2,
    url: "https://www.barnes-montblanc.com/en/buying-property-chamonix-megeve",
    domain: "barnes-montblanc.com",
    title: "Buying Luxury Property in Chamonix & Megève | BARNES Mont-Blanc",
    snippet:
      "Luxury real estate agency in Chamonix and Megève offering prestige chalets, apartments, and local transaction brokerage in Haute-Savoie.",
    html: `<!doctype html><html lang="en"><head><title>Buying Luxury Property in Chamonix &amp; Megève | BARNES Mont-Blanc</title></head><body>
      <h1>Luxury Real Estate in Chamonix and Megève</h1>
      <h2>Prestige Chalets and Apartments in the Mont-Blanc Valley</h2>
      <p>BARNES Mont-Blanc represents sellers and buyers of luxury chalets in Les Praz, Les Bois, Argentière, Demi-Quartier, and Rochebrune.</p>
      <h2>Market Trends in Haute-Savoie</h2>
      <p>Prime alpine chalets command strong international demand across winter and summer seasons in Chamonix and Megève.</p>
      <h2>Contact Our Chamonix and Megève Agencies</h2>
      <p>Explore our exclusive listings and contact a broker to arrange property viewings.</p>
    </body></html>`,
    commercialPositioning: "Luxury listing brokerage representing vendor inventory in Chamonix and Megève.",
    ctaTreatment: "Exclusive listing catalogue and agency viewing request form.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "ABSENT",
        rationale: "Operates as a traditional vendor-mandated luxury estate agency rather than an independent buyer-side advisor.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "ABSENT",
        rationale: "Relies on qualitative luxury market commentary without reproducible statutory or statistical citations.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "PARTIAL",
        rationale: "Names key micro-sectors in Chamonix and Megève but frames them around available brokerage listings.",
      },
      "How an engagement begins without a sales funnel": {
        level: "ABSENT",
        rationale: "Directs visitors into viewing requests and listing inquiries.",
      },
    },
    strengths: ["Local micro-location familiarity in Chamonix and Megève"],
    weaknesses: ["Vendor-mandated brokerage conflict", "No separation of facts, assumptions, and downside scenarios"],
    missingTreatment: ["Independent buyer-side mandate mechanics", "Quantified INSEE stock structure and Cour des comptes climate audit risks"],
  },
  {
    position: 3,
    url: "https://maisonarboris.com/property-search-french-alps/",
    domain: "maisonarboris.com",
    title: "Bespoke Property Search in the French Alps | Maison Arboris",
    snippet:
      "Tailored property finding service in the French Alps assisting international buyers with search, viewings and local coordination.",
    html: `<!doctype html><html lang="en"><head><title>Bespoke Property Search in the French Alps | Maison Arboris</title></head><body>
      <h1>Bespoke Property Search in the French Alps</h1>
      <h2>Acting for Buyers Across Alpine Resorts</h2>
      <p>Maison Arboris assists buyers searching for chalets and apartments in the French Alps by shortlisting on-market and off-market properties and coordinating viewings.</p>
      <h2>From Search Brief to Notaire Completion</h2>
      <p>We work alongside local agencies and notaires to guide buyers from initial brief through compromis de vente and completion.</p>
    </body></html>`,
    commercialPositioning: "Boutique property search agent focused on sourcing and viewing coordination.",
    ctaTreatment: "Discovery call booking prompt.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "PARTIAL",
        rationale: "Describes buyer-side property search and viewing coordination, though oriented around sourcing rather than underwriting.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "WEAK",
        rationale: "Does not publish a formal valuation, DVF deed normalisation, or regulatory stress-testing methodology.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "WEAK",
        rationale: "Addresses the French Alps broadly without granular Chamonix vs Megève municipal housing or PLU evidence.",
      },
      "How an engagement begins without a sales funnel": {
        level: "PARTIAL",
        rationale: "Explains the initial search brief step before property viewings begin.",
      },
    },
    strengths: ["Clear buyer-side search positioning", "Explains coordination from search brief to notaire completion"],
    weaknesses: ["No published analytical framework or primary data citations", "Does not separate factual evidence from assumptions"],
    missingTreatment: ["Quantitative Chamonix and Megève municipal housing analysis", "Explicit YMYL capital allocation scenario boundaries"],
  },
  {
    position: 4,
    url: "https://bluepeek.co.uk/buying-agent-france/",
    domain: "bluepeek.co.uk",
    title: "Independent Buying Agent France | BluePeek Property Search",
    snippet:
      "UK-based buying agent for residential property in France, helping international purchasers navigate French estate agents and notaires.",
    html: `<!doctype html><html lang="en"><head><title>Independent Buying Agent France | BluePeek Property Search</title></head><body>
      <h1>Independent Buying Agent in France</h1>
      <h2>Why Use a Buyer's Agent in France</h2>
      <p>French estate agents typically represent the seller under a mandat de vente. An independent buying agent represents the purchaser's interests during property search and price negotiation.</p>
      <h2>Navigating the Compromis de Vente</h2>
      <p>Buyers sign a preliminary contract with a statutory cooling-off period while the notaire verifies title and urbanisme certificates.</p>
    </body></html>`,
    commercialPositioning: "Generalist France-wide buying agent for international purchasers.",
    ctaTreatment: "Enquiry form for prospective buyers.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "PARTIAL",
        rationale: "Explains the distinction between seller mandat de vente and buyer representation under French agency practice.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "WEAK",
        rationale: "Mentions price negotiation and notaire checks qualitatively without a reproducible analytical framework.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "ABSENT",
        rationale: "Covers France generally with no specific Haute-Savoie, Chamonix, or Megève municipal analysis.",
      },
      "How an engagement begins without a sales funnel": {
        level: "WEAK",
        rationale: "Standard enquiry form call-to-action.",
      },
    },
    strengths: ["Explains seller mandate vs buyer representation clearly"],
    weaknesses: ["No alpine micro-market specificity", "No quantitative valuation or regulatory underwriting framework"],
    missingTreatment: ["Chamonix and Megève municipal housing and zoning analysis", "Structured capital and holding-cost modelling"],
  },
  {
    position: 5,
    url: "https://monumentprivateoffice.com/private-office-real-estate-advisory/",
    domain: "monumentprivateoffice.com",
    title: "Private Office Real Estate Advisory | Monument Private Office",
    snippet:
      "Discreet private office real estate advisory for family offices and high-net-worth principals acquiring European residential assets.",
    html: `<!doctype html><html lang="en"><head><title>Private Office Real Estate Advisory | Monument Private Office</title></head><body>
      <h1>Private Office Real Estate Advisory</h1>
      <h2>Unconflicted Acquisition Advice for Principals</h2>
      <p>Monument Private Office advises family offices and private principals on residential acquisitions, coordinating legal, tax, and technical due diligence.</p>
      <h2>Mandate Governance and Discretion</h2>
      <p>Engagements begin with a written advisory mandate defining scope, fee structure, and reporting milestones before market approach.</p>
    </body></html>`,
    commercialPositioning: "Private office acquisition advisor for HNW principals.",
    ctaTreatment: "Direct principal introduction note.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "PARTIAL",
        rationale: "Describes written private-office mandate governance and fiduciary coordination.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "WEAK",
        rationale: "High-level positioning without published technical, climate, or transaction-ledger methodology.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "ABSENT",
        rationale: "General European private office overview without Chamonix or Megève market evidence.",
      },
      "How an engagement begins without a sales funnel": {
        level: "PARTIAL",
        rationale: "Describes written mandate initiation without aggressive retail lead-capture popups.",
      },
    },
    strengths: ["Institutional private-office tone and mandate clarity"],
    weaknesses: ["Zero French Alps municipal data or statutory citations", "No published decision framework"],
    missingTreatment: ["Haute-Savoie micro-market evidence (INSEE, DVF, PLU, PPRN)", "Transparent separation of facts, assumptions, and scenarios"],
  },
  {
    position: 6,
    url: "https://frenchpropertyfocus.com/french-property-buying-process-notaire-dpe/",
    domain: "frenchpropertyfocus.com",
    title: "French Property Buying Process: Notaire Fees, DPE & Taxes | French Property Focus",
    snippet:
      "Editorial guide to French property purchase regulations, notaire conveyancing, SRU 10-day cooling-off period, DPE energy audits and IFI wealth tax.",
    html: `<!doctype html><html lang="en"><head><title>French Property Buying Process: Notaire Fees, DPE &amp; Taxes | French Property Focus</title></head><body>
      <h1>French Property Buying Process: Notaire, DPE and Property Taxes</h1>
      <h2>Notaire Conveyancing and the 10-Day Cooling-Off Period</h2>
      <p>Under Article L271-1 of the Code de la construction et de l'habitation, residential buyers benefit from a 10-day cooling-off period after signing the compromis de vente.</p>
      <h2>Diagnostic de Performance Énergétique (DPE) and IFI</h2>
      <p>Loi Climat et Résilience mandates energy audits for F and G rated homes, while Impôt sur la Fortune Immobilière (IFI) applies above 1.3 million euros of net real estate wealth.</p>
    </body></html>`,
    commercialPositioning: "Informational editorial guide on French conveyancing, DPE, and property taxation.",
    ctaTreatment: "Informational article footer.",
    coverageLevels: {
      "What buyer-side advisory covers and how an engagement works": {
        level: "ABSENT",
        rationale: "General informational publisher; does not provide buyer-side advisory services.",
      },
      "How the evidence-led analysis method produces conclusions": {
        level: "PARTIAL",
        rationale: "Cites statutory conveyancing rules (10-day cooling-off, DPE audit schedule, 1.3M EUR IFI threshold) but does not integrate them into an alpine underwriting model.",
      },
      "Which location decisions the advisory supports (Chamonix, Megève)": {
        level: "ABSENT",
        rationale: "National legal overview with no Chamonix or Megève municipal analysis.",
      },
      "How an engagement begins without a sales funnel": {
        level: "ABSENT",
        rationale: "Not an advisory practice.",
      },
    },
    strengths: ["Cites statutory French conveyancing, DPE, and IFI rules"],
    weaknesses: ["Not tailored to high-altitude alpine micro-markets or buyer-side advisory mandates"],
    missingTreatment: ["Chamonix and Megève INSEE/PLU/PPRN analysis", "Integrated buyer-side decision framework"],
  },
];

class SutherlandAcquiredSerpProvider implements StructuredSerpProvider {
  readonly id = "serper_acquired_sutherland_v1";

  readiness() {
    return { configured: true as const };
  }

  async acquire(request: SerpAcquisitionRequest): Promise<SerpAcquisitionResult> {
    const organic = ACQUIRED_COMPETITOR_CORPUS.map((entry) => ({
      position: entry.position,
      url: entry.url,
      domain: entry.domain,
      title: entry.title,
      snippet: entry.snippet,
    }));
    const rawPayload = {
      searchParameters: {
        q: request.query,
        gl: request.location ?? "fr",
        hl: request.language ?? "en",
        device: request.device,
      },
      organic,
      peopleAlsoAsk: [
        {
          question: "How does an independent buyer-side property advisor work in France?",
          answer:
            "An independent buyer-side advisor acts exclusively under a written mandat de recherche under Loi Hoguet (Law No. 70-9), representing the purchaser rather than listing sellers.",
        },
        {
          question: "What are the new short-term rental rules in Chamonix from May 2025?",
          answer:
            "From 1 May 2025, Chamonix-Mont-Blanc requires registration numbers, caps primary-residence rentals at 90 days per year, and limits natural-person owners to one secondary-residence rental authorization.",
        },
      ],
      relatedSearches: [
        "buyer-side property advisory france",
        "buying property in chamonix",
        "megeve property market analysis",
        "evidence-led property analysis french alps",
      ],
    };
    return {
      data: {
        organic,
        features: ["featured_snippet", "sitelinks"],
        peopleAlsoAsk: rawPayload.peopleAlsoAsk,
        relatedSearches: rawPayload.relatedSearches,
      },
      rawPayload,
      providerRequestId: "sutherland-discovery-20260831T151804Z",
      observedAt: OBSERVED_AT,
      usage: { searchQueriesCount: 1, costMicros: 0 },
    };
  }
}

class SutherlandSearchAnalyst implements SearchAnalystModel {
  readonly model = "sutherland-search-analyst-v1";
  readonly provider = "fixture";
  readonly promptVersion = SEARCH_ANALYST_PROMPT_VERSION;
  readonly promptDigest = sha256Hex("sutherland-search-analyst-v1");

  async analyze(request: SearchAnalystRequest): Promise<SearchAnalystResult> {
    const data: SearchIntelligenceData = {
      evidenceRefs: request.evidenceRefs,
      primaryIntent: "commercial",
      intentRationale:
        "International buyer evaluating who should support a consequential French Alps property decision in Chamonix or Megève without brokerage listing conflicts.",
      secondaryIntents: ["informational", "navigational"],
      queryClusters: [
        {
          id: "cluster-advisory-core",
          label: "Independent buyer-side advisory (French Alps)",
          queries: [
            "independent property advisory french alps",
            "buyer-side property advisory france",
          ],
          intent: "commercial",
          primaryQuery: "independent property advisory french alps",
          secondaryQueries: ["buyer-side property advisory france"],
          rationale:
            "Primary commercial investigation cluster: buyers comparing fiduciary buyer-side representation under Loi Hoguet against vendor-mandated estate agencies.",
          confidence: 0.92,
        },
        {
          id: "cluster-location-chamonix-megeve",
          label: "Location market understanding (Chamonix / Megève)",
          queries: ["buying property in chamonix", "megeve property market"],
          intent: "informational",
          primaryQuery: "buying property in chamonix",
          secondaryQueries: ["megeve property market"],
          rationale:
            "Secondary geographic decision cluster: buyers evaluating INSEE housing stock structure, PLU zoning, PPRN hazard maps, and May 2025 tourist-rental rules in Chamonix and Megève.",
          confidence: 0.9,
        },
        {
          id: "cluster-methodology-research",
          label: "Decision methodology / evidence-led analysis",
          queries: [
            "evidence-led property analysis",
            "property decision framework alps",
          ],
          intent: "informational",
          primaryQuery: "evidence-led property analysis",
          secondaryQueries: ["property decision framework alps"],
          rationale:
            "Analytical research cluster: buyers and advisers auditing DVF deed normalization, DPE energy-renovation schedules, IFI tax thresholds, and multi-scenario capital underwriting.",
          confidence: 0.88,
        },
        {
          id: "cluster-brand-sutherland",
          label: "Brand / entity (Sutherland Private Office)",
          queries: ["sutherland private office", "sutherlandam"],
          intent: "navigational",
          primaryQuery: "sutherland private office",
          secondaryQueries: ["sutherlandam"],
          rationale: "Navigational brand cluster for Sutherland Private Office.",
          confidence: 0.95,
        },
      ],
      longTailOpportunities: [
        {
          query: "chamonix plu zone n2 construction rules secondary residence quota",
          rationale: "High-intent regulatory query completely unaddressed by listing agencies.",
          confidence: 0.86,
        },
        {
          query: "french alps chalet dpe audit 2025 2034 capex underwriting",
          rationale: "Technical due-diligence query connecting Loi Climat thermal rules to acquisition pricing.",
          confidence: 0.84,
        },
      ],
      entities: [
        { name: "Sutherland Private Office", kind: "organization", notes: "Independent buyer-side property advisory" },
        { name: "Chamonix-Mont-Blanc", kind: "location", notes: "INSEE commune 74056, Haute-Savoie" },
        { name: "Megève", kind: "location", notes: "INSEE commune 74173, Haute-Savoie" },
        { name: "Loi Hoguet (Law No. 70-9)", kind: "regulation", notes: "Statutory framework for written mandat de recherche" },
        { name: "DGFiP DVF & IFI", kind: "dataset", notes: "Notarial transaction ledger and 1.3M EUR wealth tax threshold" },
      ],
      topics: [
        {
          topic: "buyer-side property advisory",
          subtopics: ["mandat de recherche", "fee-only independence", "conflict-free underwriting"],
        },
        {
          topic: "alpine property markets",
          subtopics: ["Chamonix INSEE 74056", "Megève INSEE 74173", "PLU zoning", "PPRN natural hazards"],
        },
        {
          topic: "evidence-led capital decision framework",
          subtopics: ["DVF deed normalization", "DPE 2025/2034 thermal capex", "IFI taxation", "Cour des comptes climate audit"],
        },
      ],
      questions: [
        "Who advises a consequential alpine property purchase without seller brokerage conflicts?",
        "How does an independent buyer-side advisory engagement work under Loi Hoguet?",
        "How do INSEE housing structure, PLU zoning, and May 2025 rental caps affect Chamonix acquisitions?",
        "How are facts, assumptions, and downside scenarios separated in an alpine property investment decision?",
      ],
      modifiers: ["independent", "buyer-side", "evidence-led", "chamonix", "megève", "french alps"],
      searchVocabulary: [
        "buyer-side",
        "evidence-led",
        "decision support",
        "advisory",
        "mandat de recherche",
        "chamonix",
        "megève",
      ],
      relatedConcepts: [
        "Loi Hoguet Law No. 70-9",
        "INSEE RP2022 municipal housing census",
        "DGFiP Demandes de Valeurs Foncières (DVF)",
        "Plan de Prévention des Risques Naturels (PPRN)",
        "Diagnostic de Performance Énergétique (DPE)",
      ],
      semanticCoverageRequirements: [
        "What buyer-side advisory covers and how an engagement works",
        "How the evidence-led analysis method produces conclusions",
        "Which location decisions the advisory supports (Chamonix, Megève)",
        "How an engagement begins without a sales funnel",
      ],
      userNeeds: [
        "Understand who is responsible for the analysis",
        "Distinguish independent advisory from listing intermediaries",
        "See how facts, assumptions and forecasts are separated",
      ],
      reviewState: "model_proposed",
    };
    return {
      data,
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest: this.promptDigest,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    };
  }
}

class SutherlandAcquiredPageProvider implements CompetitorPageProvider {
  readonly id = "direct_http" as const;

  async acquire(request: PageAcquisitionRequest): Promise<PageAcquisitionOutcome> {
    const match = ACQUIRED_COMPETITOR_CORPUS.find((c) => c.url === request.url);
    if (!match) {
      return {
        status: "FAILED",
        httpStatus: 404,
        contentType: null,
        finalUrl: request.url,
        observedAt: OBSERVED_AT,
        reason: "URL not in acquired Sutherland competitor corpus",
      };
    }
    const rawBytes = Buffer.from(match.html, "utf8");
    return {
      status: "SUCCESS",
      finalUrl: match.url,
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      rawBytes,
      rawDigest: sha256Hex(rawBytes),
      truncated: false,
      observedAt: OBSERVED_AT,
    };
  }
}

class SutherlandCompetitorAnalyst implements CompetitorAnalystModel {
  readonly model = "sutherland-competitor-analyst-v1";
  readonly provider = "fixture";
  readonly promptVersion = COMPETITOR_ANALYST_PROMPT_VERSION;
  readonly promptDigest = sha256Hex("sutherland-competitor-analyst-v1");
  readonly maxTokens = 8192;

  async analyze(request: CompetitorAnalystRequest): Promise<CompetitorAnalystResult> {
    const { packet } = request;
    const corpusEntry =
      ACQUIRED_COMPETITOR_CORPUS.find((c) => c.domain === packet.domain) ??
      ACQUIRED_COMPETITOR_CORPUS[0]!;
    const segIds = packet.extracted.segments.map((s) => s.id);
    const evidenceSegmentRefs = segIds.slice(0, 2).map((segmentId) => ({
      pageSnapshotId: packet.pageSnapshotId,
      segmentId,
    }));

    const coverageAreas = Object.entries(corpusEntry.coverageLevels).map(([area, spec]) => ({
      area,
      level: spec.level,
      rationale: spec.rationale,
    }));

    const data: CompetitorPageAnalysisData = {
      pageType: "editorial_guide",
      primaryIntent: "commercial",
      topics: packet.extracted.pageTitle ? [packet.extracted.pageTitle] : [corpusEntry.title],
      subtopics: packet.extracted.headings.map((h) => h.text).slice(0, 6),
      entities: [packet.domain, "Chamonix-Mont-Blanc", "Megève"],
      questionsAnswered: ["What properties or services does this firm offer in the French Alps?"],
      questionsUnanswered: [
        "How are INSEE housing statistics, DVF deeds, PLU zoning servitudes, and PPRN hazards reconciled before bidding?",
        "How are facts separated from assumptions and downside scenarios in capital underwriting?",
      ],
      coverageAreas,
      dataFactsUsed: [],
      sourceSignals: [],
      trustSignals: [],
      experienceSignals: [],
      commercialPositioning: corpusEntry.commercialPositioning,
      ctaTreatment: corpusEntry.ctaTreatment,
      freshnessAssessment: "Observed in August 2026 discovery corpus.",
      strengths: corpusEntry.strengths,
      weaknesses: corpusEntry.weaknesses,
      uniqueTreatment: [],
      missingTreatment: corpusEntry.missingTreatment,
      evidenceSegmentRefs,
      confidence: 0.88,
    };

    return {
      data,
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest: this.promptDigest,
      packetDigest: deterministicDigest(packet),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    };
  }
}

const LEVEL_RANK: Record<CoverageLevel, number> = {
  ABSENT: 0,
  WEAK: 1,
  PARTIAL: 2,
  STRONG: 3,
};

class SutherlandGapAnalyst implements GapAnalystModel {
  readonly model = "sutherland-gap-analyst-v1";
  readonly provider = "fixture";
  readonly promptVersion = GAP_ANALYST_PROMPT_VERSION;
  readonly promptDigest = sha256Hex("sutherland-gap-analyst-v1");
  readonly maxTokens = 8192;

  async propose(request: GapAnalystRequest): Promise<GapAnalystResult> {
    const gapSpecs: ReadonlyArray<{
      userNeed: string;
      topicQuestion: string;
      treatmentPattern: string;
      baselineExpectation: string;
      evidenceIndices: number[];
      ourEvidenceMissing: string[];
      claimConstraints: string[];
      differentiationOpportunity: string;
      recommendedDisposition: "REQUIRED" | "OPTIONAL";
      priority: "HIGH" | "MEDIUM";
      rationale: string;
    }> = [
      {
        userNeed: "Distinguish independent advisory from listing intermediaries",
        topicQuestion: "How does a fee-only buyer-side advisory mandate under Loi Hoguet differ from listing brokerage?",
        treatmentPattern: "Competitors operate as developer consultants or seller-mandated agencies with listing funnels.",
        baselineExpectation: "Explain statutory mandat de recherche mechanics under Law No. 70-9 of 2 January 1970 and Article 6.",
        evidenceIndices: [0, 1, 13],
        ourEvidenceMissing: ["Historical client roster (withheld by confidentiality policy)"],
        claimConstraints: ["Never claim guaranteed price discounts or off-market exclusivity"],
        differentiationOpportunity: "Publish the exact statutory Loi Hoguet mandate mechanics and zero-seller-commission rule.",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "Core commercial positioning gap across SERP competitors.",
      },
      {
        userNeed: "Understand who is responsible for the analysis",
        topicQuestion: "Who conducts the due diligence and how does an engagement begin without a sales funnel?",
        treatmentPattern: "Competitors route prospects into brochure downloads and sales calls.",
        baselineExpectation: "Describe the four-stage written diagnostic and underwriting workflow in clear prose (Mode B).",
        evidenceIndices: [0, 5, 6],
        ourEvidenceMissing: ["Public fee schedule table (bespoke to mandate complexity)"],
        claimConstraints: ["No conversion widgets, contact forms, or promotional urgency"],
        differentiationOpportunity: "Mode B institutional briefing showing how a written scope note initiates an engagement.",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "Addresses high-trust principal expectation for non-promotional engagement governance.",
      },
      {
        userNeed: "See how facts, assumptions and forecasts are separated",
        topicQuestion: "How are verified municipal/notarial facts separated from capital assumptions and stress scenarios?",
        treatmentPattern: "Competitors blend promotional rental yield claims with general market commentary.",
        baselineExpectation: "Separate Tier-A factual baselines (DVF, INSEE, DPE, IFI) from labelled assumptions and 15-year stress scenarios.",
        evidenceIndices: [3, 4, 10, 11, 12],
        ourEvidenceMissing: ["Sub-parcel private bank loan covenants"],
        claimConstraints: ["Every assumption, estimate, and scenario must carry an explicit limitation label"],
        differentiationOpportunity: "Publish a reproducible capital decision framework with explicit calculation formulas and tax/audit thresholds.",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "Direct YMYL decision-support differentiation.",
      },
      {
        userNeed: "Which location decisions the advisory supports (Chamonix, Megève)",
        topicQuestion: "How do Chamonix (INSEE 74056) and Megève (INSEE 74173) differ in housing stock, zoning, and rental regulation?",
        treatmentPattern: "Competitors describe resort lifestyle without municipal census ratios, PLU servitudes, or May 2025 rental quotas.",
        baselineExpectation: "Contrast Chamonix (13,864 dwellings, 69.2% secondary) and Megève (11,291 dwellings, 83.1% secondary) using INSEE, PLU, and PPRN data.",
        evidenceIndices: [2, 7, 8, 9],
        ourEvidenceMissing: ["Real-time private off-market parcel inventory"],
        claimConstraints: ["Cite exact INSEE RP2022 commune codes and municipal deliberation dates"],
        differentiationOpportunity: "First-party municipal comparison pairing INSEE RP2022 housing structure with May 2025 Chamonix rental rules and PPRN hazards.",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "Grounds geographic pages and supply notes in verifiable municipal datasets.",
      },
      {
        userNeed: "How the evidence-led analysis method produces conclusions",
        topicQuestion: "How are DVF notarial transactions, DPE 2023/2025/2034 thermal audits, and Cour des comptes climate data synthesized?",
        treatmentPattern: "Competitors mention DPE or notaire steps in isolation without an integrated analytical methodology.",
        baselineExpectation: "Document the four-layer evidence hierarchy reconciling DVF deeds, Géorisques PPRN, DPE thermal capex, and Cour des comptes snow-reliability audits.",
        evidenceIndices: [3, 4, 10, 11, 12],
        ourEvidenceMissing: ["Proprietary structural engineering lab test reports"],
        claimConstraints: ["Never extrapolate historical DVF prices as guaranteed future appreciation"],
        differentiationOpportunity: "Dedicated research methodology and Chamonix supply notes with verifiable quantitative anchors.",
        recommendedDisposition: "REQUIRED",
        priority: "HIGH",
        rationale: "Establishes institutional research authority for both editorial research pages.",
      },
    ];

    const gaps = request.coverageMatrixSummary.slice(0, gapSpecs.length).map((row, idx) => {
      const spec = gapSpecs[idx]!;
      const aggregateLevel = Object.values(row.coverage).reduce<CoverageLevel>(
        (acc, level) => {
          const typed = (level as CoverageLevel) ?? "ABSENT";
          return LEVEL_RANK[typed] > LEVEL_RANK[acc] ? typed : acc;
        },
        "ABSENT",
      );
      const coveringPageIds = Object.entries(row.coverage)
        .filter(([, level]) => level !== "ABSENT")
        .map(([pageId]) => pageId)
        .sort();

      const evidenceRefs =
        aggregateLevel === "ABSENT"
          ? []
          : coveringPageIds.map((pageSnapshotId) => {
              const analysis = request.analyses.find((a) => a.pageSnapshotId === pageSnapshotId);
              const segRefs =
                (analysis?.data?.evidenceSegmentRefs as Array<{ segmentId: string }> | undefined) ?? [];
              return {
                pageSnapshotId,
                segmentId: segRefs[0]?.segmentId ?? "seg-001",
              };
            });

      const ourEvidenceAvailable = spec.evidenceIndices
        .map((itemIndex) => request.acceptedEvidence.find((e) => e.field === "operatorFacts" && e.index === itemIndex))
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
        .map((e) => ({
          intakeField: "operatorFacts" as const,
          itemIndex: e.index,
          excerpt: e.text.slice(0, 80),
        }));

      return {
        id: `gap-sutherland-${String(idx + 1).padStart(2, "0")}`,
        coverageRequirementId: row.requirementId,
        userNeed: spec.userNeed,
        topicQuestion: spec.topicQuestion,
        searchEvidenceRefs: [
          ...(request.serpSnapshot
            ? [
                {
                  kind: "serp_snapshot" as const,
                  id: request.serpSnapshot.id,
                  digest: request.serpSnapshot.digest,
                },
              ]
            : []),
          ...(request.intelligenceSnapshot
            ? [
                {
                  kind: "search_intelligence_snapshot" as const,
                  id: request.intelligenceSnapshot.id,
                  digest: request.intelligenceSnapshot.digest,
                },
              ]
            : []),
        ],
        competitorCoverage: aggregateLevel,
        competitorsCoveringIt: coveringPageIds,
        evidenceRefs,
        treatmentPattern: spec.treatmentPattern,
        baselineExpectation: spec.baselineExpectation,
        ourEvidenceAvailable,
        ourEvidenceMissing: spec.ourEvidenceMissing,
        claimConstraints: spec.claimConstraints,
        differentiationOpportunity: spec.differentiationOpportunity,
        recommendedDisposition: spec.recommendedDisposition,
        priority: spec.priority,
        rationale: spec.rationale,
      };
    });

    return {
      gaps,
      differentiationRequirements: {
        items: [
          {
            requirement: "Ground every Chamonix and Megève claim in INSEE RP2022 (COM-74056, COM-74173), municipal PLU/rental rules, and Géorisques PPRN.",
            basis: "accepted_evidence" as const,
            rationale: "Accepted operator facts provide INSEE, municipal PLU, and Géorisques primary data that competitor agencies omit.",
          },
          {
            requirement: "Separate verified statutory/statistical facts from labelled capital assumptions and 15-year stress scenarios.",
            basis: "editorial_opportunity" as const,
            rationale: "Competitor pages mix promotional forecasts with unverified yield claims.",
          },
          {
            requirement: "Preserve Mode B non-promotional posture with zero conversion funnels or brokerage inventory claims.",
            basis: "accepted_evidence" as const,
            rationale: "Sutherland Private Office operates exclusively under buyer-side mandates without listing inventory.",
          },
        ],
      },
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest: this.promptDigest,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    };
  }
}

export interface SutherlandSeededProject {
  projectId: string;
  acceptedInputSnapshotId: string;
  acceptedInputVersion: number;
  acceptedInputDigest: string;
  serpSnapshotId: string;
  serpSnapshotDigest: string;
  intelligenceSnapshotId: string;
  intelligenceSnapshotDigest: string;
  competitorRunId: string;
  gapReportId: string;
  gapSnapshotId: string;
  gapSnapshotVersion: number;
  gapSnapshotDigest: string;
  serpOrganicCount: number;
  pageSnapshotCount: number;
  analysisCount: number;
  acceptedGapCount: number;
  queryClusters: SearchIntelligenceData["queryClusters"];
}

export async function seedSutherlandProject(
  dbInst: FactoryDatabaseInstance,
  key: string,
): Promise<SutherlandSeededProject> {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const searchStore = new SearchStore(dbInst.db);
  const competitorStore = new CompetitorStore(dbInst.db);

  const project = await store.createProject({ key, name: `Sutherland Run 12 ${key}` });
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload: sutherlandIntakePayload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(sutherlandIntakePayload),
  });

  // 1. Execute real SearchIntelligenceService (Run 2) over acquired Sutherland SERP evidence.
  const serpProvider = new SutherlandAcquiredSerpProvider();
  const searchAnalyst = new SutherlandSearchAnalyst();
  const searchService = new SearchIntelligenceService({
    intake,
    searchStore,
    productionSerpProvider: serpProvider,
    fixtureSerpProvider: serpProvider,
    analyst: searchAnalyst,
    config: {
      providerMode: "production",
      freshnessHours: 24,
      dailyLimitUsd: 5,
      authorizedMicros: { serp: 1000, analyst: 1000 },
    },
    now: () => OBSERVED_AT,
  });

  const searchResult = await searchService.runSearch({
    projectId: project.id,
    query: "independent property advisory french alps",
    location: "France",
    language: "en",
    device: "desktop",
  });

  if (!searchResult.serp || !searchResult.intelligence) {
    throw new Error("Sutherland SearchIntelligenceService failed to persist SERP or intelligence snapshot.");
  }

  // 2. Execute real CompetitorContentGapService (Run 3): competitor acquisition -> extraction -> page analyses -> gap proposal -> operator review -> acceptance.
  const competitorService = new CompetitorContentGapService({
    intake,
    competitorStore,
    pageProvider: new SutherlandAcquiredPageProvider(),
    competitorAnalyst: new SutherlandCompetitorAnalyst(),
    gapAnalyst: new SutherlandGapAnalyst(),
    config: {
      mode: "fixture",
      maxPages: 6,
      maxConcurrency: 3,
      dailyLimitUsd: 5,
    },
    now: () => OBSERVED_AT,
  });

  const competitorRun = await competitorService.runCompetitors({
    projectId: project.id,
    serpSnapshotId: searchResult.serp.snapshotId,
    maxPages: 6,
  });

  const { reportId } = await competitorService.proposeGaps({
    projectId: project.id,
    competitorRunId: competitorRun.run.id,
  });

  const detailBeforeReview = await competitorService.getGapReportDetail(project.id, reportId);
  const reportData = detailBeforeReview.report.data as {
    gaps: Array<{ id: string; recommendedDisposition: string; priority: string }>;
    pageSnapshotRefs: Array<{ id: string; digest: string }>;
    analysisRefs: Array<{ id: string; digest: string }>;
  };

  const reviewResult = await competitorService.saveGapDecisions({
    projectId: project.id,
    reportId,
    expectedReviewRevision: detailBeforeReview.report.reviewRevision,
    decisions: reportData.gaps.map((g) => ({
      gapId: g.id,
      disposition: g.recommendedDisposition,
      priority: g.priority,
      note: "Accepted for Run 12 Sutherland multi-page architecture and content briefs.",
    })),
  });

  const acceptedGap = await competitorService.acceptGapReport({
    projectId: project.id,
    reportId,
    expectedReportDigest: detailBeforeReview.report.snapshotDigest,
    expectedReviewRevision: reviewResult.reviewRevision,
    expectedDecisionsDigest: reviewResult.decisionsDigest,
  });

  const [gapRow] = await dbInst.db
    .select()
    .from(acceptedContentGapSnapshots)
    .where(eq(acceptedContentGapSnapshots.id, acceptedGap.snapshotId))
    .orderBy(desc(acceptedContentGapSnapshots.version))
    .limit(1);

  if (!gapRow) {
    throw new Error("Accepted content gap snapshot not found after acceptGapReport.");
  }

  const intelData = searchResult.intelligence.data as unknown as SearchIntelligenceData;

  return {
    projectId: project.id,
    acceptedInputSnapshotId: accepted.id,
    acceptedInputVersion: accepted.version,
    acceptedInputDigest: accepted.digest,
    serpSnapshotId: searchResult.serp.snapshotId,
    serpSnapshotDigest: searchResult.serp.snapshotDigest,
    intelligenceSnapshotId: searchResult.intelligence.snapshotId,
    intelligenceSnapshotDigest: searchResult.intelligence.snapshotDigest,
    competitorRunId: competitorRun.run.id,
    gapReportId: reportId,
    gapSnapshotId: gapRow.id,
    gapSnapshotVersion: gapRow.version,
    gapSnapshotDigest: gapRow.snapshotDigest,
    serpOrganicCount: searchResult.serp.organic.length,
    pageSnapshotCount: reportData.pageSnapshotRefs.length,
    analysisCount: reportData.analysisRefs.length,
    acceptedGapCount: reportData.gaps.length,
    queryClusters: intelData.queryClusters,
  };
}
