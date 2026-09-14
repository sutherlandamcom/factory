import { z } from "zod";
import { canonicalOriginSchema } from "./site-profile.js";
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
    /** Production origin for canonical/OG/sitemap/structured-data URLs. */
    canonicalOrigin: canonicalOriginSchema,
    acceptedContent: productionAuthorityRefSchema,
    acceptedDesign: productionAuthorityRefSchema,
    acceptedVisualSet: productionAuthorityRefSchema,
    renderer: productionRendererIdentitySchema,
  })
  .strict();
export type ProductionPageInputData = z.infer<typeof productionPageInputDataSchema>;

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
    detail: z.string().min(1).max(2000),
    evidence: z.array(qaCheckEvidenceRefSchema).max(50),
  })
  .strict();
export type ProductionQaCheckResult = z.infer<typeof productionQaCheckResultSchema>;

export const productionQaReportDataSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_SCHEMA_VERSION),
    candidateId: productionIdSchema,
    checks: z.array(productionQaCheckResultSchema).max(200),
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
