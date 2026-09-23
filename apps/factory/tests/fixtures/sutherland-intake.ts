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
    ],
    evidenceNotes: [
      "Accepted 2026-09-04: homepage workflow (docs/handoffs/2026-09-04-sutherland-one-page-workflow.md).",
      "Typographic identity only: no approved photographic assets exist; imagery must not imply documentary truth.",
      "Mode B: no verified CTA destination; pages explain how an engagement begins in prose without conversion elements.",
    ],
    allowedClaims: [
      "Independent buyer-side property advisory",
      "Evidence-led analysis approach",
      "French Alps focus including Chamonix and Megève",
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
