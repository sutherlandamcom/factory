import type { ProjectIntakePayload } from "@factory/contracts";

/**
 * RUN 12 SUTHERLAND PROJECT INTAKE — accepted operator facts only.
 *
 * Source of truth: the accepted Sutherland one-page workflow handoff
 * (docs/handoffs/2026-09-04-sutherland-one-page-workflow.md, operator-approved
 * 2026-09-04) plus the accepted SiteProfile `sutherland-private-office`
 * (sites/starter/site-profile.json, canonicalOrigin https://sutherlandam.com).
 *
 * GOVERNANCE RULES ENFORCED HERE:
 *  - Every fact below traces to the accepted handoff/profile. Nothing is
 *    invented: no registration numbers, no regulatory status, no phone,
 *    no address, no credentials, no client list, no awards.
 *  - Unknown/absent facts are recorded in unknownClaims, never asserted.
 *  - Mode B quality-proof conversion (no verified CTA destination exists;
 *    the accepted handoff records the explicit no-CTA operator decision).
 */
export const sutherlandIntakePayload: ProjectIntakePayload = {
  schemaVersion: "v1",
  business: {
    name: "Sutherland Private Office",
    description:
      "Independent buyer-side property advisory for consequential French Alps property decisions, published as evidence-led analysis rather than listings.",
    businessModel:
      "Buyer-side advisory engagement: independent analysis and decision support for property purchases in the French Alps (Chamonix, Megève).",
    positioning:
      "Independent advisory positioning: evidence-led property analysis for international buyers, distinct from listing intermediaries.",
    offerings: [
      "Buyer-side property advisory for French Alps purchases",
      "Evidence-led property decision support",
    ],
    priorities: ["Evidence-first analysis", "Buyer-side independence"],
  },
  audience: {
    segments: ["International buyers evaluating French Alps property"],
    needs: [
      "Independent decision support before a consequential purchase",
      "Understanding how an advisory engagement works",
    ],
    decisionContext:
      "Comparing independent advisory against listing-side intermediaries before a consequential alpine property decision.",
  },
  markets: {
    geographies: ["Chamonix", "Megève", "French Alps"],
    priorityLocations: ["Chamonix", "Megève"],
  },
  siteIdentity: {
    siteName: "Sutherland Private Office",
    candidateDomain: "sutherlandam.com",
    language: "en",
    locale: "en-GB",
  },
  conversion: {
    primaryObjective: "Quality proof: explain the advisory proposition (Mode B, no verified CTA destination)",
    ctaType: "none (Mode B quality proof; no verified destination)",
    ctaDestinationType: "other",
    ctaDestination: "",
    verificationState: "UNVERIFIED",
  },
  evidence: {
    operatorFacts: [
      "Sutherland Private Office is an independent buyer-side property advisory.",
      "Advisory focus: consequential French Alps property decisions, including Chamonix and Megève.",
      "Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
      "Site identity: sutherlandam.com (accepted SiteProfile sutherland-private-office).",
      "Accepted illustrative worked example for methodology demonstration: annual rent 26400 EUR over purchase price 366000 EUR gives an illustrative gross yield of 7.2% under stated assumptions; it is a labelled calculation, never an observed fact or forecast.",
      "INSEE Dossier Complet 2022 for Chamonix-Mont-Blanc (COM-74056) records 13,864 total dwellings: 69.2% secondary residences, 26.8% primary residences, 4.0% vacant, 72.6% apartments, 27.3% houses, and 26,880 EUR median 2021 income.",
      "INSEE Dossier Complet 2022 for Chamonix-Mont-Blanc (COM-74056) records 58.2% of main residences built between 1946 and 1990, and only 6.0% built in 2006 or later.",
      "INSEE Dossier Complet 2022 for Megève (COM-74173) records 11,291 total dwellings in 2022: 83.1% secondary residences, 13.4% primary residences, 78.8% apartments, and 28,020 EUR median 2021 income.",
      "Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes against an outflow of 90 inhabitants per year, and 1 May 2025 tourist-rental rules require registration numbers and cap authorizations at 1 property per person.",
      "Notaires de France statutory procedure requires a preliminary contract with a 10-day cooling-off period, DDT diagnostics with energy audits for classes F and G (2023), class E (2025), and class D (2034), and completion by notarized acte authentique.",
      "DGFiP and Etalab Demande de valeurs foncières (DVF) publish notarized transfer prices over a 5-year window, and Impôt sur la Fortune Immobilière (IFI) applies above 1,300,000 EUR (1.3 million EUR), assessed from 800,000 EUR.",
      "BRGM Géorisques and the February 2024 Cour des comptes ski-resort audit document that parcel-level PPRN avalanche, flood, and slope zones and altitude snow dispersion require pre-contract ERP natural hazard verification.",
      "Under French Loi Hoguet (Law No. 70-9 of 2 January 1970), regulated property intermediation requires a carte professionnelle T and written mandat with no commission before the notarized act, distinct from non-intermediated advisory.",
    ],
    evidenceNotes: [
      "Accepted 2026-09-04: homepage workflow (docs/handoffs/2026-09-04-sutherland-one-page-workflow.md).",
      "Normalized primary research ledger: .factory/blueprint/20260901T114820Z-8976f5e5/normalized-research.json (INSEE, DGFiP/DVF/IFI, Notaires de France, Ville de Chamonix PLU, Géorisques, Cour des comptes, DGCCRF Loi Hoguet).",
      "Typographic identity only: no approved photographic assets exist; imagery must not imply documentary truth.",
      "Mode B: no verified CTA destination; pages explain how an engagement begins in prose without conversion elements.",
    ],
    allowedClaims: [
      "Independent buyer-side property advisory",
      "Evidence-led analysis approach",
      "French Alps focus including Chamonix and Megève",
      "INSEE 2022 housing structure comparisons for Chamonix-Mont-Blanc (COM-74056) and Megève (COM-74173)",
      "Ville de Chamonix-Mont-Blanc PLU permanent-housing servitudes and 1 May 2025 tourist-rental registration rules",
      "Notaires de France 10-day cooling-off withdrawal period, DDT diagnostics, and 2023/2025/2034 energy audit schedule",
      "DGFiP 5-year DVF notarized transfer dataset and 1,300,000 EUR / 800,000 EUR IFI real estate wealth tax thresholds",
      "Géorisques PPRN natural hazard screening and February 2024 Cour des comptes climate-adaptation findings",
      "Loi Hoguet (Law No. 70-9 of 2 January 1970) distinction between regulated intermediation and non-intermediated advisory",
    ],
    prohibitedClaims: [
      "Guaranteed investment returns",
      "#1 or best advisory",
      "Regulatory authorization or licensing",
      "Specific past performance figures",
      "Client names or testimonials",
    ],
    unknownClaims: [
      "Company registration number",
      "Regulatory status",
      "Business address",
      "Telephone number",
      "Named individual qualifications",
    ],
  },
  searchSeeds: {
    topics: [
      "buyer-side property advisory French Alps",
      "Chamonix property market",
      "Megève property market",
    ],
    queries: [
      "independent property advisory French Alps",
      "buying property in Chamonix",
      "Megeve property market analysis",
    ],
    competitors: [],
    marketHints: ["Alpine resort property markets differ from primary housing markets"],
  },
  brand: {
    facts: [
      "Independent buyer-side property advisory",
      "Evidence-led analysis",
      "French Alps focus (Chamonix, Megève)",
    ],
    positioning:
      "Evidence-led buyer-side property analysis for consequential French Alps decisions.",
    tone: "Institutional, precise, understated",
    visualIdentityNotes:
      "Warm paper, deep ink, single deep teal accent (#2f5d62); editorial serif display + disciplined sans body; typographic identity, no imagery.",
  },
  designReferences: {
    referenceUrls: [],
    antiReferenceUrls: [],
    learn: [
      "Asymmetric first viewport, one argument per band",
      "Definition-list argumentation",
      "Evidence-first institutional voice",
    ],
    avoid: [
      "Card grids and stat widgets",
      "Stock UHNW imagery",
      "Credential claims",
      "Scarcity or booking CTAs",
    ],
    preferredPerception: "Dated, sourced research paper / private-bank orientation letter",
  },
  assetAvailability: {
    hasLogo: false,
    hasAuthenticPhotography: false,
    hasLocalFirstPartyPhotography: false,
    otherAssets: [],
    notes: "Operator-recorded: typographic identity only; no approved assets.",
  },
  constraints: {
    legal: [
      "No guaranteed-return language",
      "No regulatory status claims",
    ],
    editorial: ["No competitor names in copy"],
    technical: [],
    regulatory: ["French property transaction disclosures only as accepted facts allow"],
    mustNot: [
      "Never invent credentials, registration, addresses, phone numbers or testimonials",
      "Never present forecasts or scenarios as observed facts",
    ],
  },
  contentConstitution: {
    brandVoice: "Institutional research paper voice: precise, sourced, unhurried",
    tone: "Confident through evidence, never promotional",
    audiencePrinciples: ["Address the reader as a capable adult evaluating a consequential decision"],
    writingPrinciples: [
      "One argument per section",
      "Every material claim classified (fact, assumption, forecast, scenario)",
      "State limits symmetrically with strengths",
    ],
    preferredTerminology: ["buyer-side", "evidence-led", "decision support"],
    forbiddenTerminology: ["guaranteed", "risk-free", "unbeatable", "luxury lifestyle"],
    evidencePolicy:
      "Every material claim traces to an operator fact or a cited source with claim-type classification; assumptions and forecasts are always labelled.",
    peopleFirstPrinciples: ["Answer the decision question first"],
    trustExpectations:
      "Organization identity and methodology must be findable on the site; material analysis discloses how conclusions were produced.",
    aiLanguageAvoidance: ["delve", "unleash", "elevate", "game-changer"],
    clicheAvoidance: ["your one-stop shop", "we've got you covered", "dream home"],
    localePreferences: "British English",
    customWriterInstructions:
      "Never assert a number that is not an accepted operator fact or a labelled calculation. Present scenarios and forecasts only with explicit labelling. Keep the research-paper register; no marketing superlatives.",
  },
};
