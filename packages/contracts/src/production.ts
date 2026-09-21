import { z } from "zod";
import { canonicalOriginSchema } from "./site-profile.js";
import { siteProfileLanguageSchema, siteNameSchema } from "./site-profile.js";
import { designArchetypeKindSchema } from "./design.js";
import { qaVerdictSchema } from "./writer-content.js";

/**
 * PRODUCTION CONTRACTS — Macro Run 9 (Production + SEO + Performance Engine).
 *
 * The production layer turns exact accepted authority into static production
 * pages. Two immutable, version/digest-bound artifacts govern it:
 *
 *   Accepted authorities (Runs 4–7, immutable, never copied/redefined here)
 *     -> ProductionPageInput   (manifest of exact authority bindings)
 *     -> Astro static renderer (deterministic materialization)
 *     -> ProductionCandidate   (immutable build result + lineage)
 *     -> Production QA         (typed PASS/REVIEW/FAIL gates)
 *
 * ProductionPageInput is a MANIFEST OF EXACT AUTHORITIES, not a copy of
 * editable page data: it binds id/version/digest of the accepted content,
 * design and visual-set plus route/site identity and the renderer identity.
 * Nothing downstream may rewrite accepted copy, redesign accepted visual
 * authority, substitute another image, invent business facts or change route
 * identity by convenience.
 */

export const PRODUCTION_SCHEMA_VERSION = "production-v1" as const;

/**
 * Run 10 derivative-aware production input schema. Historical production-v1
 * inputs/manifests remain immutable historical truth; new derivative-aware
 * inputs use production-v2 and additionally bind the exact
 * AcceptedDerivativeSet identity (id/version/digest).
 */
export const PRODUCTION_SCHEMA_VERSION_V2 = "production-v2" as const;

/**
 * Pre-Run-12 render manifest schema (manifest-only; never a PPI version).
 * production-v3 manifests carry the derived DesignImplementationContract
 * digest + policy version and the projected semantic tokens/composition so
 * the Astro renderer is a pure compositor. Historical v1/v2 manifests stay
 * valid and parseable.
 */
export const PRODUCTION_SCHEMA_VERSION_V3 = "production-v3" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
export const productionDigestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);
export const productionIdSchema = z.string().trim().min(1).max(128);

/** Rooted lowercase route path (mirrors the accepted Factory slug semantics). */
export const productionRouteSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/(?:|[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)$/, {
    message:
      'route must be a rooted lowercase path like "/" or "/services/roof-repair" (only [a-z0-9], single "/" or "-" separators)',
  });

/** Run 8 renderer decision: Astro static is the single ordinary renderer. */
export const productionRendererIdSchema = z.literal("astro-static");

// ---------------------------------------------------------------------------
// ProductionPageInput — immutable manifest of exact accepted authorities
// ---------------------------------------------------------------------------

export const productionAuthorityRefSchema = z
  .object({
    /** Exact accepted artifact id (e.g. accepted_page_content row id). */
    id: productionIdSchema,
    /** Exact accepted artifact version (monotonic per project). */
    version: z.number().int().min(1),
    /** Exact accepted artifact digest (canonical-JSON sha256). */
    digest: productionDigestSchema,
  })
  .strict();
export type ProductionAuthorityRef = z.infer<typeof productionAuthorityRefSchema>;

export const productionSiteIdentitySchema = z
  .object({
    siteId: productionIdSchema,
    siteName: siteNameSchema,
    canonicalOrigin: canonicalOriginSchema,
    language: siteProfileLanguageSchema,
    profileDigest: productionDigestSchema,
  })
  .strict();
export type ProductionSiteIdentity = z.infer<typeof productionSiteIdentitySchema>;

export const productionRendererIdentitySchema = z
  .object({
    id: productionRendererIdSchema,
    /** Renderer implementation version (e.g. Astro package version in use). */
    version: boundedText(60),
    /** Version of the production rendering policy this build obeys. */
    policyVersion: boundedText(60),
  })
  .strict();
export type ProductionRendererIdentity = z.infer<typeof productionRendererIdentitySchema>;

export const productionPageInputDataSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION),
    projectId: productionIdSchema,
    /** Accepted page identity: the slug of the bound AcceptedPageContent. */
    pageIdentity: boundedText(200),
    /** Archetype kind from the accepted design authority vocabulary. */
    pageType: designArchetypeKindSchema,
    /** The single production route for this page. */
    route: productionRouteSchema,
    /** Exact validated repository-owned site identity used by the build. */
    siteIdentity: productionSiteIdentitySchema,
    acceptedContent: productionAuthorityRefSchema,
    acceptedDesign: productionAuthorityRefSchema,
    acceptedVisualSet: productionAuthorityRefSchema,
    renderer: productionRendererIdentitySchema,
  })
  .strict();
export type ProductionPageInputData = z.infer<typeof productionPageInputDataSchema>;

// ---------------------------------------------------------------------------
// production-v2 — Run 10 derivative-aware production input
// ---------------------------------------------------------------------------

export const productionPageInputV2DataSchema = productionPageInputDataSchema.extend({
  schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION_V2),
  /** Exact accepted derivative set bound into this production input. */
  acceptedDerivativeSet: productionAuthorityRefSchema,
});
export type ProductionPageInputV2Data = z.infer<typeof productionPageInputV2DataSchema>;

/** Parse the derivative-aware production-v2 input. */
export function parseProductionPageInputV2Data(input: unknown): ProductionPageInputV2Data {
  return productionPageInputV2DataSchema.parse(input);
}

/** Parse either schema version of a production page input. */
export function parseProductionPageInputAnyVersion(
  input: unknown,
): ProductionPageInputData | ProductionPageInputV2Data {
  const data = input as { schemaVersion?: unknown };
  if (data?.schemaVersion === PRODUCTION_SCHEMA_VERSION_V2) {
    return productionPageInputV2DataSchema.parse(input);
  }
  return productionPageInputDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// production-v3 — render manifest composition authority (evidence, not PPI)
// ---------------------------------------------------------------------------

/** One resolved semantic token (governed projection of accepted design). */
export const manifestSemanticTokenSchema = z
  .object({
    role: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9.-]*$/),
    value: z.string().trim().min(1).max(300),
  })
  .strict();
export type ManifestSemanticToken = z.infer<typeof manifestSemanticTokenSchema>;

/** One composed component instance in the page render order. */
export const manifestCompositionEntrySchema = z
  .object({
    /** Registered production component id (unknown ids fail closed). */
    componentId: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Registered variant id (unknown variants fail closed). */
    variant: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** The accepted design section pattern this instance realizes. */
    pattern: z.string().trim().min(1).max(60),
    /** once | per_section (bound to accepted content sections in order). */
    repetition: z.enum(["once", "per_section"]),
    /** Accepted content section index bound to a per_section instance. */
    sectionIndex: z.number().int().min(0).max(29).optional(),
    /** Visual asset slot bound to this instance (exact page authority). */
    assetSlot: z.string().trim().max(120).optional(),
  })
  .strict();
export type ManifestCompositionEntry = z.infer<typeof manifestCompositionEntrySchema>;

/** DIC evidence block carried in production-v3 manifests. */
export const manifestDesignImplementationSchema = z
  .object({
    /** Exact derived DIC digest (deterministic derivation evidence). */
    implementationContractDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
    /** Renderer policy version that derived the DIC. */
    policyVersion: z.string().trim().min(1).max(60),
    /** DIC schema version. */
    schemaVersion: z.string().trim().min(1).max(40),
  })
  .strict();
export type ManifestDesignImplementation = z.infer<typeof manifestDesignImplementationSchema>;

/** Deterministic font delivery record in production-v3 manifests. */
export const manifestFontDeliverySchema = z
  .object({
    mode: z.enum(["approved_system_stack", "bundled_local_asset"]),
    family: z.string().trim().min(1).max(300),
    sourceToken: z.enum(["typography.display", "typography.heading", "typography.body"]),
  })
  .strict();
export type ManifestFontDelivery = z.infer<typeof manifestFontDeliverySchema>;

export const manifestDerivativesDisabledSchema = z
  .object({
    state: z.literal("disabled"),
  })
  .strict();

export const manifestDerivativesAcceptedSchema = z
  .object({
    state: z.literal("accepted").optional(),
    setDigest: productionDigestSchema,
    summary: z.discriminatedUnion("state", [
      z.object({ state: z.literal("disabled") }).strict(),
      z
        .object({
          state: z.literal("accepted"),
          acceptedId: productionIdSchema,
          acceptedVersion: z.number().int().min(1),
          acceptedDigest: productionDigestSchema,
          language: z.string().trim().min(1).max(40),
          summaryText: z.string().min(1).max(20000),
        })
        .strict(),
    ]),
    audio: z.discriminatedUnion("state", [
      z.object({ state: z.literal("disabled") }).strict(),
      z
        .object({
          state: z.literal("accepted"),
          acceptedId: productionIdSchema,
          acceptedVersion: z.number().int().min(1),
          acceptedDigest: productionDigestSchema,
          binaryDigest: productionDigestSchema,
          mimeType: z.string().trim().min(1).max(100),
          durationSeconds: z.number().int().min(0).max(86400).nullable(),
          publicPath: z.string().trim().min(1).max(300),
        })
        .strict(),
    ]),
  })
  .strict();

/** Run 10 derivative authority block (verbatim accepted summary/audio bindings). */
export const manifestDerivativesSchema = z.union([
  manifestDerivativesDisabledSchema,
  manifestDerivativesAcceptedSchema,
]);
export type ManifestDerivatives = z.infer<typeof manifestDerivativesSchema>;

/**
 * Canonical JSON: sorted keys, preserved array order, no whitespace.
 * NOTE: the digest COMPUTATION lives in the Factory app
 * (`apps/factory/src/intelligence/digest.ts` — the proven RFC 8785-aligned
 * serializer); contracts stay Node/browser-neutral and export only the
 * canonical serialization shape so the Dashboard can render digests without
 * bundling Node crypto.
 */
export function canonicalProductionJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalProductionJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalProductionJson(entryValue)}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonicalProductionJson cannot serialize value of type ${typeof value}`);
}

export function parseProductionPageInputData(input: unknown): ProductionPageInputData {
  return productionPageInputDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Route authority — one intended page = one route = one canonical identity
// ---------------------------------------------------------------------------

export const PRODUCTION_ERROR_CODES = [
  /** No accepted ProjectInputSnapshot exists for this project (production). */
  "production_input_not_accepted",
  /** Required accepted authority (content/design/visual set) does not exist. */
  "production_authority_not_found",
  /** A bound accepted authority is stale versus current upstream authority. */
  "production_authority_stale",
  /** Authority digest mismatch (forged or drifted binding). */
  "production_authority_digest_mismatch",
  /** Authority belongs to a different project (cross-project misuse). */
  "production_authority_wrong_project",
  /** Route authority conflict: duplicate route or contradictory canonical. */
  "production_route_conflict",
  /** Production input is immutable; a new version is required. */
  "production_input_immutable",
  /** Candidate does not exist / was not built for this input. */
  "production_candidate_not_found",
  /** Candidate build rejected (readiness, staleness or renderer failure). */
  "production_build_rejected",
  /** A required QA gate verdict is FAIL; candidate acceptance blocked. */
  "production_qa_failed",
  /** QA run referenced does not exist or belongs to another candidate. */
  "production_qa_not_found",
] as const;
export type ProductionErrorCode = (typeof PRODUCTION_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// QA result model — typed evidence, no opaque numeric scores
// ---------------------------------------------------------------------------

export const qaGateGroupSchema = z.enum([
  "content",
  "html",
  "seo",
  "images",
  "accessibility",
  "links",
  "performance",
  "security",
  "design",
]);
export type QaGateGroup = z.infer<typeof qaGateGroupSchema>;

export const productionQaCheckIdSchema = z.enum([
  // content integrity
  "content.accepted_authority",
  "content.sections_complete",
  "content.sections_unique",
  "content.section_order",
  "content.h1_intent",
  "content.cta_intent",
  "content.factual_copy",
  "content.no_placeholder_copy",
  "content.no_truncation",
  "content.no_duplicate_pages",
  // html semantics
  "html.main_landmark",
  "html.h1_count",
  "html.heading_hierarchy",
  "html.landmarks",
  "html.crawlable_links",
  "html.valid_structure",
  "html.no_duplicate_ids",
  "html.metadata_valid",
  // seo
  "seo.title_unique",
  "seo.title_present",
  "seo.description_unique",
  "seo.description_present",
  "seo.canonical",
  "seo.robots",
  "seo.sitemap",
  "seo.breadcrumb",
  "seo.structured_data",
  "seo.structured_data_urls",
  "seo.internal_links",
  "seo.images",
  // images
  "images.accepted_authority",
  "images.dimensions",
  "images.alt_authority",
  "images.lcp_priority",
  // accessibility
  "accessibility.axe",
  "accessibility.keyboard",
  // links
  "links.internal_resolvable",
  "links.canonical_destination",
  "links.external",
  // performance
  "performance.lighthouse",
  "performance.resource_budget",
  "performance.js_budget",
  // security
  "security.gitleaks",
  "security.osv",
  "security.public_output",
  // design implementation hardening (Pre-Run-12)
  "design.registry_integrity",
  "design.token_governance",
  "design.composition_valid",
  "design.drift_source_scan",
]);
export type ProductionQaCheckId = z.infer<typeof productionQaCheckIdSchema>;

export const qaCheckEvidenceRefSchema = z
  .object({
    kind: z.enum(["route", "section", "asset", "url", "check", "artifact"]),
    ref: z.string().min(1).max(300),
    note: z.string().max(500).optional(),
  })
  .strict();
export type QaCheckEvidenceRef = z.infer<typeof qaCheckEvidenceRefSchema>;

export const productionQaCheckResultSchema = z
  .object({
    checkId: productionQaCheckIdSchema,
    group: qaGateGroupSchema,
    verdict: qaVerdictSchema,
    scope: z.enum(["page", "site", "repository"]).optional(),
    /** Route for page scope; manifest-set digest or repository SHA otherwise. */
    subject: z.string().trim().min(1).max(300).optional(),
    tool: z.string().trim().min(1).max(100).optional(),
    toolVersion: z.string().trim().min(1).max(100).optional(),
    executionDigest: productionDigestSchema.optional(),
    detail: z.string().min(1).max(2000),
    evidence: z.array(qaCheckEvidenceRefSchema).max(50),
  })
  .strict();
export type ProductionQaCheckResult = z.infer<typeof productionQaCheckResultSchema>;

export const productionQaReportDataSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION),
    candidateId: productionIdSchema,
    checks: z.array(productionQaCheckResultSchema).max(10_000),
    /** Overall verdict: FAIL if any FAIL; REVIEW if any REVIEW; else PASS. */
    overall: qaVerdictSchema,
  })
  .strict();
export type ProductionQaReportData = z.infer<typeof productionQaReportDataSchema>;

export function parseProductionQaReportData(input: unknown): ProductionQaReportData {
  return productionQaReportDataSchema.parse(input);
}

/** Deterministic overall verdict from individual check results. */
export function qaOverallVerdict(checks: readonly { verdict: z.infer<typeof qaVerdictSchema> }[]): z.infer<typeof qaVerdictSchema> {
  if (checks.some((check) => check.verdict === "FAIL")) return "FAIL";
  if (checks.some((check) => check.verdict === "REVIEW")) return "REVIEW";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Redirect authority — renderer/delivery-neutral (Run 13 materializes host)
// ---------------------------------------------------------------------------

export const redirectRuleSchema = z
  .object({
    /** Source path (rooted lowercase); must not collide with a page route. */
    source: productionRouteSchema,
    /** Destination path (rooted lowercase) or absolute URL. */
    destination: z.string().trim().min(1).max(400),
    /** Permanent vs temporary; one-hop redirects preferred. */
    kind: z.enum(["permanent", "temporary"]),
  })
  .strict();
export type RedirectRule = z.infer<typeof redirectRuleSchema>;

export const redirectAuthorityDataSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION),
    projectId: productionIdSchema,
    rules: z.array(redirectRuleSchema).max(200),
  })
  .strict();
export type RedirectAuthorityData = z.infer<typeof redirectAuthorityDataSchema>;

export function parseRedirectAuthorityData(input: unknown): RedirectAuthorityData {
  return redirectAuthorityDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Cache-policy metadata — emitted for Run 13; Run 9 adds no Publish action
// ---------------------------------------------------------------------------

export const cachePolicyEntrySchema = z
  .object({
    /** Route or asset glob the policy applies to. */
    target: z.string().trim().min(1).max(300),
    /** Immutable hashed assets vs HTML documents vs redirects. */
    kind: z.enum(["immutable_asset", "html", "redirect"]),
    /** Suggested max-age seconds (Run 13 decides final delivery policy). */
    maxAgeSeconds: z.number().int().min(0).max(31536000),
  })
  .strict();
export type CachePolicyEntry = z.infer<typeof cachePolicyEntrySchema>;

export const cachePolicyDataSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION),
    projectId: productionIdSchema,
    entries: z.array(cachePolicyEntrySchema).max(500),
  })
  .strict();
export type CachePolicyData = z.infer<typeof cachePolicyDataSchema>;

export function parseCachePolicyData(input: unknown): CachePolicyData {
  return cachePolicyDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Shared render-manifest contract (single structural truth)
// ---------------------------------------------------------------------------

/**
 * The single shared render-manifest structural contract. The trusted
 * Factory compiler PRODUCES manifests validated against this schema and the
 * Astro build CONSUMES manifests validated against the SAME schema — there
 * is no duplicated structural truth. Digest verification uses
 * canonicalProductionJson over the manifest body (excluding manifestDigest).
 */
export const renderManifestBodySchema = z
  .object({
    schemaVersion: z.enum([PRODUCTION_SCHEMA_VERSION, PRODUCTION_SCHEMA_VERSION_V2, PRODUCTION_SCHEMA_VERSION_V3]),
    input: z
      .object({
        id: productionIdSchema,
        version: z.number().int().min(1),
        digest: productionDigestSchema,
        projectId: productionIdSchema,
        pageIdentity: boundedText(200),
        pageType: designArchetypeKindSchema,
        route: productionRouteSchema,
        siteIdentity: productionSiteIdentitySchema,
      })
      .strict(),
    seo: z
      .object({
        fullTitle: boundedText(400),
        description: z.string().trim().min(1).max(1000),
        canonicalUrl: z.string().trim().min(1).max(2000),
        ogTitle: boundedText(400),
        ogDescription: z.string().trim().min(1).max(1000),
        ogUrl: z.string().trim().min(1).max(2000),
      })
      .strict(),
    content: z
      .object({
        acceptedId: productionIdSchema,
        acceptedVersion: z.number().int().min(1),
        acceptedDigest: productionDigestSchema,
        title: boundedText(200),
        metaDescription: z.string().min(1).max(400),
        introduction: z.string().min(1).max(20000),
        sections: z.array(z.object({ heading: boundedText(300), body: z.string().min(1).max(20000) }).strict()).max(30),
        conclusion: z.string().min(1).max(20000),
        cta: boundedText(1000),
        internalLinks: z.array(boundedText(300)).max(10),
      })
      .strict(),
    design: z
      .object({
        acceptedId: productionIdSchema,
        acceptedVersion: z.number().int().min(1),
        acceptedDigest: productionDigestSchema,
        tokens: z
          .object({
            colors: z.record(z.string().trim().min(1).max(30), z.string().trim().max(60)),
            typography: z.object({ headingFont: boundedText(120), bodyFont: boundedText(120), scaleNotes: z.string().trim().max(500) }).strict(),
            spacing: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(40)),
            rounded: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(40)),
            ctaHierarchy: z.string().trim().max(500),
            navigationLanguage: z.string().trim().max(500),
            imageryTreatment: z.string().trim().max(500),
            sectionRhythm: z.string().trim().max(500),
          })
          .strict(),
        archetype: z
          .object({
            kind: designArchetypeKindSchema,
            sectionPatterns: z.array(boundedText(120)).max(20),
            contentRequirements: z.array(boundedText(300)).max(20),
            assetSlots: z.array(z.object({ slot: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(60), requiredRole: z.string().trim().min(1).max(60) }).strict()).max(20),
            primaryCta: z.string().trim().max(300),
            secondaryCta: z.string().trim().max(300),
            responsiveBehavior: boundedText(1000),
            trustPresentation: boundedText(1000),
            rendererPrimitives: z.array(boundedText(60)).max(20),
          })
          .strict(),
        /** production-v3 only: DIC evidence + semantic tokens + composition. */
        designImplementation: manifestDesignImplementationSchema.optional(),
        semanticTokens: z.array(manifestSemanticTokenSchema).max(20).optional(),
        fontDelivery: z.array(manifestFontDeliverySchema).max(3).optional(),
        composition: z.array(manifestCompositionEntrySchema).max(40).optional(),
      })
      .strict(),
    links: z.array(z.object({ href: z.string().trim().min(1).max(300), title: boundedText(200) }).strict()).max(50),
    breadcrumbs: z.array(z.object({ name: boundedText(200), url: z.string().trim().max(2000) }).strict()).max(20),
    assets: z
      .array(
        z
          .object({
            slot: z.string().trim().min(1).max(120),
            role: z.string().trim().min(1).max(60),
            truthClass: z.string().trim().min(1).max(40),
            versionId: productionIdSchema,
            binaryDigest: productionDigestSchema,
            governanceDigest: productionDigestSchema,
            publicPath: z.string().trim().min(1).max(300),
            width: z.number().int().min(1).max(100000),
            height: z.number().int().min(1).max(100000),
            alt: z.string().max(1000),
            altAuthorityComplete: z.boolean(),
            isProbableLcp: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    /** Run 10 derivative authority (production-v2/v3 manifests only). */
    derivatives: manifestDerivativesSchema.optional(),
    manifestDigest: productionDigestSchema,
  })
  .strict();

/** Version-aware manifest validation with version-specific invariants. */
export function parseRenderManifestAnyVersion(input: unknown): z.infer<typeof renderManifestBodySchema> {
  const parsed = renderManifestBodySchema.parse(input);
  // NOTE: digest VERIFICATION lives with the consumers that have Node crypto
  // (Factory compiler `assertManifest`, starter manifest loader) — this
  // module stays Node/browser-neutral (no node:crypto import; the Dashboard
  // bundles it for the browser). The canonical digest formula is:
  //   sha256(canonicalProductionJson(bodyWithoutManifestDigestAndSchemaVersion))
  // schemaVersion is structurally validated and NOT part of the digest body
  // (historical manifest compatibility); the v3 design authority fields are
  // inside `design` and ARE digest-bound.
  if (parsed.schemaVersion === PRODUCTION_SCHEMA_VERSION_V2 && parsed.derivatives === undefined) {
    throw new TypeError("production-v2 manifest is missing its derivatives authority.");
  }
  if (parsed.schemaVersion === PRODUCTION_SCHEMA_VERSION && parsed.derivatives !== undefined) {
    throw new TypeError("production-v1 manifest must not carry derivatives authority.");
  }
  if (parsed.schemaVersion === PRODUCTION_SCHEMA_VERSION_V3) {
    if (parsed.derivatives === undefined) {
      throw new TypeError("production-v3 manifest is missing its derivatives authority (explicit disabled state is required).");
    }
    const design = parsed.design as { designImplementation?: unknown; semanticTokens?: unknown; fontDelivery?: unknown; composition?: unknown };
    if (!design.designImplementation || !design.semanticTokens || !design.fontDelivery || !design.composition) {
      throw new TypeError("production-v3 manifest is missing its designImplementation/semanticTokens/fontDelivery/composition authority.");
    }
  }
  if (parsed.schemaVersion !== PRODUCTION_SCHEMA_VERSION_V3 && (parsed.design as { designImplementation?: unknown }).designImplementation !== undefined) {
    throw new TypeError("Only production-v3 manifests may carry designImplementation evidence.");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Page Archetype Authority (Pre-Run-12 Durable Typed Page Authority)
// ---------------------------------------------------------------------------

export const pageArchetypeAuthoritySchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    pageIdentity: z.string().trim().min(1),
    archetype: designArchetypeKindSchema,
    version: z.number().int().min(1),
    authorityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type PageArchetypeAuthority = z.infer<typeof pageArchetypeAuthoritySchema>;
