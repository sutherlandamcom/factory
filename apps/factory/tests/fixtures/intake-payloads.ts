import type { ProjectIntakePayload } from "@factory/contracts";

/**
 * Deterministic test fixture for Project Intake payloads.
 * Used by persistence, service, and E2E tests so every layer validates
 * against one canonical example payload.
 */
export const completeIntakePayload: ProjectIntakePayload = {
  schemaVersion: "v1",
  business: {
    name: "Summit Roofing",
    description: "Family-owned roofing company serving Denver since 1998.",
    businessModel: "Residential and commercial roofing services.",
    positioning: "Honest local roofer with 25 years of experience.",
    offerings: ["Shingle roof replacement", "Emergency leak repair"],
    priorities: ["Fast storm response", "Transparent pricing"],
  },
  audience: {
    segments: ["Homeowners 30-60", "Small commercial property owners"],
    needs: ["Fast storm-damage repair", "Reliable warranty support"],
    decisionContext: "Insurance-driven, compares 2-3 local companies.",
  },
  markets: {
    geographies: ["Denver metro", "Colorado Springs"],
    priorityLocations: ["Denver", "Aurora"],
  },
  siteIdentity: {
    siteName: "Summit Roofing",
    candidateDomain: "summitroofing.com",
    language: "en",
    locale: "en-US",
  },
  conversion: {
    primaryObjective: "Book free roof inspections",
    ctaType: "call",
    ctaDestinationType: "phone",
    ctaDestination: "(555) 010-0100",
    verificationState: "UNVERIFIED",
  },
  evidence: {
    operatorFacts: ["Serving Denver since 1998", "BBB A+ rating"],
    evidenceNotes: ["License #RC-1234 on file"],
    allowedClaims: ["Licensed and insured", "25-year limited warranty"],
    prohibitedClaims: ["#1 roofing company", "Cheapest prices in Denver"],
    unknownClaims: ["Insurance approval timelines"],
  },
  searchSeeds: {
    topics: ["roof replacement", "storm damage repair"],
    queries: ["roof repair denver", "hail damage inspection"],
    competitors: ["Front Range Roofing", "Peak Roofing Co"],
    marketHints: ["Hail season drives demand spikes"],
  },
  brand: {
    facts: ["Family-owned since 1998"],
    positioning: "Honest local roofer",
    tone: "Friendly, direct, expert",
    visualIdentityNotes: "Navy and orange, mountain imagery",
  },
  designReferences: {
    referenceUrls: ["https://example.com/inspiration"],
    antiReferenceUrls: [],
    learn: ["Clear service navigation"],
    avoid: ["Dark themes", "Stock photo overload"],
    preferredPerception: "Trustworthy local expert",
  },
  assetAvailability: {
    hasLogo: true,
    hasAuthenticPhotography: true,
    hasLocalFirstPartyPhotography: false,
    otherAssets: ["Crew headshots on file"],
    notes: "Logo vector available; crew photos available on request.",
  },
  constraints: {
    legal: ["No guarantees on insurance approval"],
    editorial: ["No competitor names in copy"],
    technical: [],
    regulatory: ["Colorado consumer protection rules"],
    mustNot: ["Never invent testimonials", "Never quote prices on site"],
  },
  contentConstitution: {
    brandVoice: "Warm, plain-spoken expert",
    tone: "Confident but never pushy",
    audiencePrinciples: ["Speak to homeowners directly"],
    writingPrinciples: ["Short paragraphs", "Concrete examples"],
    preferredTerminology: ["roof system"],
    forbiddenTerminology: ["cheap", "bargain"],
    evidencePolicy: "Every claim traces to an operator fact or cited source.",
    peopleFirstPrinciples: ["Answer the question first"],
    trustExpectations: "Show license numbers where relevant.",
    aiLanguageAvoidance: ["delve", "unleash", "elevate"],
    clicheAvoidance: ["your one-stop shop", "we've got you covered"],
    localePreferences: "US English",
    customWriterInstructions:
      'Always mention our 25-year workmanship warranty only as "limited warranty" until legal confirms. Never name competitors. Keep sentences under 20 words.',
  },
};

export function buildIntakePayload(
  overrides?: DeepPartial<ProjectIntakePayload>,
): ProjectIntakePayload {
  return deepMerge(structuredClone(completeIntakePayload), overrides ?? {}) as ProjectIntakePayload;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function deepMerge<T>(base: T, override: DeepPartial<T> | null | undefined): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return (override as T) ?? base;
  }
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue;
    result[key] = deepMerge(result[key], value);
  }
  return result as T;
}
