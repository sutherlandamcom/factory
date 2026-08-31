import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  NormalizedResearchEvidenceBundle,
  SiteBlueprint,
  SiteIntelligencePlan,
  SiteIntelligenceRequest,
} from "@factory/contracts";
import { SITE_BLUEPRINT_METHODOLOGY_VERSION } from "@factory/contracts";
import { loadFixtureRequestJsonSync, loadFixtureResearchJsonSync, makeValidPlan } from "./intelligence-fixtures.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "intelligence");

type AnyRecord = Record<string, unknown>;

export function loadBlueprintFixtureInputs(): { request: AnyRecord; research: AnyRecord; plan: AnyRecord } {
  const request = loadFixtureRequestJsonSync();
  const research = loadFixtureResearchJsonSync();
  const plan = makeValidPlan(request, research);
  return { request, research, plan };
}

/** Typed fixture inputs for validators that require contract types. */
export function loadBlueprintFixtureInputsTyped(): {
  request: SiteIntelligenceRequest;
  research: NormalizedResearchEvidenceBundle;
  plan: SiteIntelligencePlan;
} {
  const { request, research, plan } = loadBlueprintFixtureInputs();
  return {
    request: request as unknown as SiteIntelligenceRequest,
    research: research as unknown as NormalizedResearchEvidenceBundle,
    plan: plan as unknown as SiteIntelligencePlan,
  };
}

export function loadBlueprintFixtureInputsRaw(): { request: string; research: string; plan: string } {
  const request = readFileSync(path.join(FIXTURE_DIR, "summit-roofing.request.json"), "utf8");
  const research = readFileSync(path.join(FIXTURE_DIR, "summit-roofing.research.json"), "utf8");
  const requestJson = JSON.parse(request) as AnyRecord;
  const researchJson = JSON.parse(research) as AnyRecord;
  return { request, research, plan: `${JSON.stringify(makeValidPlan(requestJson, researchJson), null, 2)}\n` };
}

/**
 * A fully valid SiteBlueprint (raw object form) mirroring the accepted
 * summit-roofing fixture plan exactly: same 5 pages, same types, same
 * primary topics, same intents; section-level provenance resolves to fixture
 * evidence and operator facts.
 */
export function makeValidBlueprint(request: AnyRecord, plan: AnyRecord): AnyRecord {
  const facts = ((request.business as AnyRecord)?.operatorFacts ?? []) as Array<AnyRecord>;
  const hasFact = (id: string): boolean => facts.some((fact) => fact.id === id);
  const fact = (id: string): string[] => (hasFact(id) ? [id] : []);

  return {
    version: "v0",
    methodologyVersion: SITE_BLUEPRINT_METHODOLOGY_VERSION,
    siteId: plan.siteId,
    site: {
      positioningSummary:
        "A family-owned Denver roofing contractor positioning on licensed storm-damage expertise, fast inspections, and durable workmanship warranties.",
      primaryAudience: "Denver homeowners needing urgent or planned roofing work",
      navigation: [
        { label: "Home", targetSlug: "/" },
        { label: "Emergency Roof Repair", targetSlug: "/services/emergency-roof-repair" },
        { label: "Gutter Installation", targetSlug: "/services/gutter-installation" },
        { label: "Inspection Guide", targetSlug: "/blog/hail-damage-roof-inspection-guide" },
      ],
      primaryConversionGoal: "Book a free 48-hour roof inspection that routes into the right service line.",
      designDirection: {
        visualCharacter: "Sturdy, plain, trade-credible: flat surfaces, generous whitespace, no decorative effects.",
        density: "Sparse with single-column focus on mobile.",
        typographyMood: "Neutral humanist sans for UI, high-contrast bold H1s.",
        colorMood: "Slate neutrals with one restrained sky-blue action color.",
        imageryPolicy: "Only real project photography with honest alt text; no stock storm imagery, no fabricated roofs.",
        ctaTreatment: "One primary button style used consistently, labeled by the job it performs.",
      },
    },
    pages: [
      {
        type: "homepage",
        slug: "/",
        primaryTopic: "roofing contractor denver",
        pageRole: "conversion_landing",
        audience: "Denver homeowners comparing roofing contractors",
        intent: "commercial_investigation",
        seoTitle: "Denver Roofing Contractor | Hail Damage & Gutter Services",
        metaDescription:
          "Licensed Denver roofing contractor for hail damage repair, replacement, and seamless gutters with free 48-hour inspections.",
        h1: "Denver roofing done right, the first time",
        purpose: "Establish licensed local credibility and route visitors to the two must-cover service lines.",
        businessGoal: "Generate qualified inspection requests for both service lines.",
        userQuestions: ["Is this contractor licensed and insured?", "How fast can someone inspect my roof?"],
        objections: ["I am not sure whether I need repair or replacement yet."],
        sections: [
          {
            id: "sec-home-hero",
            componentType: "hero",
            purpose: "State the licensed contractor value proposition and open the primary conversion path.",
            heading: "Denver roofing done right, the first time",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: fact("fact-local"),
            prohibitedClaims: ["family-owned since 2009 unless the operator fact says so"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-home-capabilities",
            componentType: "feature_cards",
            purpose: "Group the service capabilities so visitors can self-select the right line.",
            heading: "What we handle for Denver homes",
            keyPoints: ["Hail damage repair", "Roof replacement", "Seamless gutters"],
            evidenceIds: ["mkt-seasonal-demand"],
            operatorFactIds: fact("fact-license"),
            prohibitedClaims: ["24/7 emergency response"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-home-faq",
            componentType: "faq",
            purpose: "Answer the pre-contact licensing and scheduling questions honestly.",
            heading: "Before you call",
            keyPoints: ["Licensing status", "Inspection scheduling"],
            evidenceIds: ["kw-best-roofer"],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-home-cta",
            componentType: "cta",
            purpose: "Close with the single primary conversion action.",
            heading: "Book your free inspection",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
            cta: { role: "primary", job: "Request the free 48-hour inspection" },
          },
        ],
        internalLinks: [
          { targetSlug: "/services/emergency-roof-repair", purpose: "Route storm-damage urgency to the repair service" },
          { targetSlug: "/services/gutter-installation", purpose: "Route gutter interest to the installation service" },
        ],
        structuredDataType: "local_business",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "service",
        slug: "/services/emergency-roof-repair",
        primaryTopic: "emergency roof repair",
        pageRole: "service_detail",
        audience: "Denver homeowners with active storm damage",
        intent: "transactional",
        seoTitle: "Emergency Roof Repair in Denver | Free 48-Hour Inspection",
        metaDescription:
          "Rapid emergency roof repair across the Denver metro with free inspections within 48 hours and a 10-year workmanship warranty.",
        h1: "Emergency roof repair when Denver weather strikes",
        purpose: "Convert active storm-damage urgency into inspection bookings.",
        businessGoal: "Win emergency repair jobs during seasonal demand spikes.",
        userQuestions: ["How quickly can you inspect after a hailstorm?", "What does the warranty cover?"],
        objections: ["My insurance deductible may not make a claim worth it."],
        sections: [
          {
            id: "sec-err-hero",
            componentType: "hero",
            purpose: "Meet urgent intent with the response promise and the inspection CTA.",
            heading: "Emergency roof repair when Denver weather strikes",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: fact("fact-hail"),
            prohibitedClaims: ["guaranteed insurance approval"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-err-value",
            componentType: "feature_cards",
            purpose: "Explain the response and warranty advantages as grouped value points.",
            heading: "Why homeowners call us after the storm",
            keyPoints: ["48-hour inspection window", "10-year workmanship warranty"],
            evidenceIds: ["mkt-hail-frequency"],
            operatorFactIds: fact("fact-inspection"),
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-err-process",
            componentType: "content_section",
            purpose: "Explain the inspection-to-repair process so the visitor knows what happens next.",
            heading: "What happens after you call",
            keyPoints: ["Inspection, documentation, repair scope"],
            evidenceIds: ["kw-emergency-repair", "serp-emergency-repair"],
            operatorFactIds: [],
            prohibitedClaims: ["we work with every insurance carrier"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-err-faq",
            componentType: "faq",
            purpose: "Answer urgency and cost-process questions.",
            heading: "Emergency repair questions",
            keyPoints: ["Response timing", "Insurance documentation"],
            evidenceIds: [],
            operatorFactIds: fact("fact-inspection"),
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-err-cta",
            componentType: "cta",
            purpose: "Close with the inspection booking action.",
            heading: "Get your roof inspected within 48 hours",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
            cta: { role: "primary", job: "Request an emergency inspection" },
          },
        ],
        internalLinks: [
          { targetSlug: "/blog/hail-damage-roof-inspection-guide", purpose: "Help undecided visitors understand inspection scope" },
        ],
        structuredDataType: "service",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "service",
        slug: "/services/gutter-installation",
        primaryTopic: "gutter installation",
        pageRole: "service_detail",
        audience: "Denver homeowners planning gutter replacement",
        intent: "transactional",
        seoTitle: "Seamless Gutter Installation in Denver | Sized for Snow & Hail",
        metaDescription:
          "Seamless gutter installation sized for Colorado snow and hail, with material options, warranties, and tidy same-week scheduling.",
        h1: "Gutters sized for Colorado snow and hail",
        purpose: "Convert planned gutter replacement interest into scheduled installation quotes.",
        businessGoal: "Fill the gutter installation line outside storm spikes.",
        userQuestions: ["Which gutter material lasts here?", "How fast can installation happen?"],
        objections: ["I do not know whether repair or full replacement is right."],
        sections: [
          {
            id: "sec-gut-hero",
            componentType: "hero",
            purpose: "Open with the climate-fit gutter proposition.",
            heading: "Gutters sized for Colorado snow and hail",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: fact("fact-license"),
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-gut-benefits",
            componentType: "feature_cards",
            purpose: "Group material and warranty benefits.",
            heading: "Gutter options built for this climate",
            keyPoints: ["Seamless aluminum", "Snow-load sizing"],
            evidenceIds: ["mkt-gutter-materials", "kw-gutter-installation"],
            operatorFactIds: [],
            prohibitedClaims: ["lifetime no-clog guarantee"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-gut-process",
            componentType: "content_section",
            purpose: "Explain measurement, sizing, and scheduling.",
            heading: "From measurement to same-week install",
            keyPoints: ["Measurement, sizing, tidy installation"],
            evidenceIds: ["serp-gutter-installation", "comp-front-gutter"],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-gut-faq",
            componentType: "faq",
            purpose: "Answer material and scheduling questions.",
            heading: "Gutter questions",
            keyPoints: ["Material comparison", "Scheduling"],
            evidenceIds: [],
            operatorFactIds: fact("fact-license"),
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-gut-cta",
            componentType: "cta",
            purpose: "Close with the scheduling action.",
            heading: "Schedule your gutter installation",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
            cta: { role: "primary", job: "Request a gutter installation quote" },
          },
        ],
        internalLinks: [
          { targetSlug: "/services/emergency-roof-repair", purpose: "Offer storm-damage repair when gutters reveal roof damage" },
        ],
        structuredDataType: "service",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "article",
        slug: "/blog/hail-damage-roof-inspection-guide",
        primaryTopic: "hail damage roof inspection",
        pageRole: "editorial",
        audience: "Owners assessing hail risk after storms",
        intent: "informational",
        seoTitle: "Hail Damage Roof Inspection: A Denver Homeowner's Guide",
        metaDescription:
          "Learn what inspectors check after a hailstorm, which damage signs matter, and when repair beats replacement for Denver homes.",
        h1: "What a hail damage inspection actually covers",
        purpose: "Answer the informational bridge between storms and repair decisions without selling.",
        businessGoal: "Build trust that feeds both service lines.",
        userQuestions: ["What do inspectors look for?", "When is repair enough?"],
        objections: ["Inspections feel like sales pretexts."],
        sections: [
          {
            id: "sec-hail-checklist",
            componentType: "content_section",
            purpose: "Explain the inspection checklist substantively.",
            heading: "The inspection checklist, explained",
            keyPoints: ["Shingle, flashing, and gutter checks"],
            evidenceIds: ["kw-hail-inspection", "mkt-insurance-deductibles"],
            operatorFactIds: fact("fact-hail"),
            prohibitedClaims: ["inspectors always find damage"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-hail-faq",
            componentType: "faq",
            purpose: "Answer deductible and documentation questions.",
            heading: "Common questions after a storm",
            keyPoints: ["Deductibles", "Documentation"],
            evidenceIds: ["mkt-hail-frequency"],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-hail-cta",
            componentType: "cta",
            purpose: "Offer the free inspection as the natural next step.",
            heading: "Want a professional opinion?",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
            cta: { role: "primary", job: "Book the free inspection" },
          },
        ],
        internalLinks: [
          { targetSlug: "/services/emergency-roof-repair", purpose: "Route readers who confirmed damage to the repair service" },
        ],
        structuredDataType: "article",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "article",
        slug: "/blog/roof-replacement-cost-guide",
        primaryTopic: "roof replacement cost",
        pageRole: "editorial",
        audience: "Homeowners budgeting a full replacement",
        intent: "commercial_investigation",
        seoTitle: "Roof Replacement Cost in Denver: What Drives the Price",
        metaDescription:
          "Understand the material, slope, and labor factors behind Denver roof replacement budgets so you can plan with realistic ranges.",
        h1: "What actually drives replacement cost in Denver",
        purpose: "Help replacement shoppers build realistic budgets without publishing prices.",
        businessGoal: "Capture consideration-phase demand for the replacement funnel.",
        userQuestions: ["What drives cost?", "How do I compare quotes?"],
        objections: ["Quotes vary too much to trust."],
        sections: [
          {
            id: "sec-cost-factors",
            componentType: "content_section",
            purpose: "Explain the cost factors without inventing prices.",
            heading: "The factors behind your quote",
            keyPoints: ["Material, slope, labor"],
            evidenceIds: ["kw-roof-replacement-cost", "comp-front-cost"],
            operatorFactIds: [],
            prohibitedClaims: ["average replacement price is $X"],
            visualRequirement: { required: false },
          },
          {
            id: "sec-cost-faq",
            componentType: "faq",
            purpose: "Answer quote-comparison questions.",
            heading: "Comparing quotes",
            keyPoints: ["Scope comparability"],
            evidenceIds: ["serp-roof-replacement"],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
          {
            id: "sec-cost-cta",
            componentType: "cta",
            purpose: "Offer the inspection as the honest budgeting step.",
            heading: "Get a real number for your roof",
            keyPoints: [],
            evidenceIds: [],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
            cta: { role: "primary", job: "Book the free inspection" },
          },
        ],
        internalLinks: [
          { targetSlug: "/services/emergency-roof-repair", purpose: "Route storm-damaged shoppers to the repair service" },
        ],
        structuredDataType: "article",
        readiness: "ready",
        missingInputs: [],
      },
    ],
    warnings: ["Fixture blueprint for synthetic summit-roofing data only."],
    missingInputs: [],
  };
}

export function makeValidBlueprintTyped(request: AnyRecord, plan: AnyRecord): SiteBlueprint {
  return makeValidBlueprint(request, plan) as unknown as SiteBlueprint;
}

/** Raw JSON string of the valid fixture blueprint (model-output form). */
export function makeValidBlueprintJson(request: AnyRecord, plan: AnyRecord): string {
  return `${JSON.stringify(makeValidBlueprint(request, plan), null, 2)}\n`;
}
