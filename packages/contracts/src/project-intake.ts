import { z } from "zod";

/**
 * Project Intake contracts (Operator Kernel v0).
 *
 * Project Intake is the FIRST stage of the Factory vNext production pipeline:
 * the operator supplies structured source truth (business, audience, markets,
 * site identity, conversion, evidence/claims, search seeds, brand, design
 * references, asset availability, constraints, and the project-level Content
 * Constitution) BEFORE any research or generation happens.
 *
 * Schemas are the source of truth; TypeScript types are derived from them.
 * Everything is `.strict()` — unknown fields fail closed.
 *
 * Draft semantics: the payload schema is deliberately permissive about
 * PRESENCE (operators fill the draft progressively), while bounds are strict.
 * Requiredness and semantic validity (e.g. is the origin well-formed?) are
 * deterministic READINESS concerns, not schema concerns, so a half-filled
 * draft can always be saved but never accepted.
 *
 * Provenance is first-class (vNext Constitution §3): the intake provenance
 * vocabulary is defined here; acceptance never rewrites payload provenance —
 * the human-accepted fact lives on the snapshot record itself.
 */

export const PROJECT_INTAKE_SCHEMA_VERSION = "v1" as const;

/** Serialized intake payload ceiling. */
export const MAX_INTAKE_PAYLOAD_BYTES = 512 * 1024;

/** Stable typed diagnostic codes surfaced by intake validation/readiness. */
export const INTAKE_ERROR_CODES = [
  "intake_schema_invalid",
  "intake_business_name_required",
  "intake_business_description_required",
  "intake_site_language_required",
  "intake_invalid_canonical_origin",
  "intake_cta_destination_unverified",
  "intake_no_search_seeds",
  "intake_no_competitors",
  "intake_no_photography",
  "intake_secret_shaped_field",
] as const;

export type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];

const boundedText = (max: number) => z.string().trim().max(max);

/** Conservative absolute http/https URL (no credentials). */
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || isHttpUrl(v), "must be an absolute http(s) URL");

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Domain or origin shape; emptiness allowed (readiness decides requiredness). */
const domainSchema = z
  .string()
  .trim()
  .max(253)
  .refine(
    (v) =>
      v === "" ||
      /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?\/?$/i.test(v) ||
      /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v),
    "must be a domain or absolute origin",
  );

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const intakeProvenanceSchema = z.enum([
  "operator_supplied",
  "discovered",
  "derived",
  "model_proposed",
  "human_accepted",
]);

export type IntakeProvenance = z.infer<typeof intakeProvenanceSchema>;

// ---------------------------------------------------------------------------
// Input groups
// ---------------------------------------------------------------------------

export const businessSchema = z
  .object({
    name: boundedText(200),
    description: boundedText(2000),
    businessModel: boundedText(500),
    positioning: boundedText(500),
    offerings: z.array(boundedText(300)).max(20),
    priorities: z.array(boundedText(300)).max(10),
  })
  .strict();

export const audienceSchema = z
  .object({
    segments: z.array(boundedText(300)).max(10),
    needs: z.array(boundedText(300)).max(10),
    decisionContext: boundedText(500),
  })
  .strict();

export const marketsSchema = z
  .object({
    geographies: z.array(boundedText(200)).max(10),
    priorityLocations: z.array(boundedText(200)).max(10),
  })
  .strict();

export const siteIdentitySchema = z
  .object({
    siteName: boundedText(100),
    candidateDomain: domainSchema,
    language: boundedText(35),
    locale: boundedText(35),
  })
  .strict();

export const verificationStateSchema = z.enum(["VERIFIED", "UNVERIFIED", "UNKNOWN", "DEFERRED"]);

export const conversionSchema = z
  .object({
    primaryObjective: boundedText(300),
    ctaType: boundedText(100),
    ctaDestinationType: z.enum(["phone", "email", "url", "form", "in_person", "other"]),
    ctaDestination: boundedText(300),
    verificationState: verificationStateSchema,
  })
  .strict();

export const evidenceSchema = z
  .object({
    operatorFacts: z.array(boundedText(1000)).max(30),
    evidenceNotes: z.array(boundedText(500)).max(20),
    allowedClaims: z.array(boundedText(300)).max(20),
    prohibitedClaims: z.array(boundedText(300)).max(20),
    unknownClaims: z.array(boundedText(300)).max(20),
  })
  .strict();

export const searchSeedsSchema = z
  .object({
    topics: z.array(boundedText(200)).max(20),
    queries: z.array(boundedText(200)).max(30),
    competitors: z.array(boundedText(200)).max(10),
    marketHints: z.array(boundedText(200)).max(10),
  })
  .strict();

export const brandSchema = z
  .object({
    facts: z.array(boundedText(300)).max(10),
    positioning: boundedText(500),
    tone: boundedText(300),
    visualIdentityNotes: boundedText(500),
  })
  .strict();

export const designReferencesSchema = z
  .object({
    referenceUrls: z.array(urlSchema).max(10),
    antiReferenceUrls: z.array(urlSchema).max(10),
    learn: z.array(boundedText(300)).max(10),
    avoid: z.array(boundedText(300)).max(10),
    preferredPerception: boundedText(500),
  })
  .strict();

export const assetAvailabilitySchema = z
  .object({
    hasLogo: z.boolean(),
    hasAuthenticPhotography: z.boolean(),
    hasLocalFirstPartyPhotography: z.boolean(),
    otherAssets: z.array(boundedText(300)).max(10),
    notes: boundedText(1000),
  })
  .strict();

export const constraintsSchema = z
  .object({
    legal: z.array(boundedText(300)).max(10),
    editorial: z.array(boundedText(300)).max(10),
    technical: z.array(boundedText(300)).max(10),
    regulatory: z.array(boundedText(300)).max(10),
    mustNot: z.array(boundedText(300)).max(10),
  })
  .strict();

export const contentConstitutionSchema = z
  .object({
    brandVoice: boundedText(1000),
    tone: boundedText(500),
    audiencePrinciples: z.array(boundedText(300)).max(10),
    writingPrinciples: z.array(boundedText(300)).max(10),
    preferredTerminology: z.array(boundedText(100)).max(20),
    forbiddenTerminology: z.array(boundedText(100)).max(20),
    evidencePolicy: boundedText(1000),
    peopleFirstPrinciples: z.array(boundedText(300)).max(10),
    trustExpectations: boundedText(500),
    aiLanguageAvoidance: z.array(boundedText(200)).max(10),
    clicheAvoidance: z.array(boundedText(200)).max(10),
    localePreferences: boundedText(300),
    /** Large free-form field: project-wide custom writer instructions. */
    customWriterInstructions: boundedText(8000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Payload envelope
// ---------------------------------------------------------------------------

export const projectIntakeSchemaVersionSchema = z.literal(PROJECT_INTAKE_SCHEMA_VERSION);

const secretShaped = (value: string): boolean =>
  /(DATABASE_URL|OPENROUTER_API_KEY|ANTHROPIC[A-Z_]*KEY|GOOGLE[A-Z_]*KEY|CLOUDFLARE_[A-Z_]*|AWS_SECRET[A-Z_]*|PRIVATE_KEY)/i.test(
    value,
  );

export const projectIntakePayloadSchema = z
  .object({
    schemaVersion: projectIntakeSchemaVersionSchema,
    business: businessSchema,
    audience: audienceSchema,
    markets: marketsSchema,
    siteIdentity: siteIdentitySchema,
    conversion: conversionSchema,
    evidence: evidenceSchema,
    searchSeeds: searchSeedsSchema,
    brand: brandSchema,
    designReferences: designReferencesSchema,
    assetAvailability: assetAvailabilitySchema,
    constraints: constraintsSchema,
    contentConstitution: contentConstitutionSchema,
  })
  .strict()
  .superRefine((payload, ctx): void => {
    // Secrets must never enter intake payloads. Strict schemas already reject
    // unknown keys; this additionally rejects credential-shaped values.
    const walk = (value: unknown, path: string): void => {
      if (value == null) return;
      if (typeof value === "string") {
        if (secretShaped(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `payload contains credential-shaped content at ${path} — secrets are forbidden in Project Intake`,
            path: path.split(".").filter(Boolean) as (string | number)[],
          });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, i) => walk(entry, `${path}.${i}`));
        return;
      }
      if (typeof value === "object") {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          walk(entry, `${path}.${key}`);
        }
      }
    };
    walk(payload, "payload");
  });

export type ProjectIntakePayload = z.infer<typeof projectIntakePayloadSchema>;
export type Business = z.infer<typeof businessSchema>;
export type Audience = z.infer<typeof audienceSchema>;
export type Markets = z.infer<typeof marketsSchema>;
export type SiteIdentity = z.infer<typeof siteIdentitySchema>;
export type Conversion = z.infer<typeof conversionSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type SearchSeeds = z.infer<typeof searchSeedsSchema>;
export type Brand = z.infer<typeof brandSchema>;
export type DesignReferences = z.infer<typeof designReferencesSchema>;
export type AssetAvailability = z.infer<typeof assetAvailabilitySchema>;
export type Constraints = z.infer<typeof constraintsSchema>;
export type ContentConstitution = z.infer<typeof contentConstitutionSchema>;

/** Parse an intake payload, failing closed on any contract violation. */
export function parseProjectIntakePayload(input: unknown): ProjectIntakePayload {
  return projectIntakePayloadSchema.parse(input);
}
