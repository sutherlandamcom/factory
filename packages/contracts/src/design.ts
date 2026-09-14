import { z } from "zod";

/**
 * DESIGN CONTRACTS — Macro Run 6 (Google Stitch Design Provider).
 *
 * Governed design pipeline:
 *   accepted upstream authorities (ProjectInputSnapshot, AcceptedPageContent,
 *   approved AssetVersions, references/anti-references)
 *   -> immutable DesignInputSnapshot (exact lineage binding)
 *   -> DesignProvider (Google Stitch via official MCP client)
 *   -> raw provider artifacts (content-addressed storage)
 *   -> normalized candidate (DESIGN.md + archetype previews)
 *   -> human review (mandatory; no auto-acceptance)
 *   -> immutable AcceptedDesignArtifact (version/digest bound)
 *   -> staleness when any upstream dependency mutates.
 *
 * Authority boundaries (Constitution §2, §10):
 * - Stitch owns design GENERATION only; it is never Factory authority.
 * - AcceptedPageContent is immutable production copy authority; provider
 *   output may visually arrange but never rewrite accepted words.
 * - Human review is the visual authority; no automated score can accept.
 * - DESIGN.md is a versioned artifact payload (with parser/tool version),
 *   not an eternal database schema.
 */

export const DESIGN_SCHEMA_VERSION = "design-v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
/** Bounded text where an empty string is meaningful ("not specified"). */
const optionalBoundedText = (max: number) => z.string().trim().max(max).default("");

export const designIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^dsn-[0-9a-f-]{36}$/, "design id must match dsn-<uuid>");
export const designInputSnapshotIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^dsi-[0-9a-f-]{36}$/, "design input snapshot id must match dsi-<uuid>");

/** SHA-256 hex over canonical JSON (governance) or exact bytes (binary). */
export const designDigestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Design archetypes (first-class vocabulary; Run 8/9 reuse these)
// ---------------------------------------------------------------------------

export const designArchetypeKindSchema = z.enum([
  "homepage",
  "service",
  "location",
  "editorial",
  "investment_advisory",
]);
export type DesignArchetypeKind = z.infer<typeof designArchetypeKindSchema>;

/**
 * Explicit representative-page binding: which accepted page stands in for
 * each design archetype. Copy routing is page-exact — an archetype prompt
 * receives ONLY its representative page's accepted copy, never the whole
 * project content set.
 */
export const designRepresentativePageSchema = z
  .object({
    archetype: designArchetypeKindSchema,
    /** AcceptedPageContent slug bound as this archetype's representative. */
    slug: z.string().trim().min(1).max(120),
    /** Exact contentDigest of the bound page at snapshot time. */
    contentDigest: designDigestSchema,
  })
  .strict();
export type DesignRepresentativePage = z.infer<typeof designRepresentativePageSchema>;

/**
 * One design asset slot with exact page/role lineage. Asset resolution is
 * NEVER project-global: a slot binds (pageSlug, role) — an unrelated
 * homepage hero cannot satisfy a service supporting slot without an
 * explicit authoritative assignment for that exact page+role.
 */
export const designAssetSlotSchema = z
  .object({
    /** Slot identity, e.g. "hero.primary", "location.gallery", "author.portrait". */
    slot: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9.-]*$/, "slot must be lowercase dotted identity"),
    /** What the slot is for (human-readable requirement). */
    requirement: boundedText(500),
    /** The representative page this slot belongs to (exact lineage). */
    pageSlug: z.string().trim().min(1).max(120),
    /** The asset role this slot requires on that page (e.g. "hero"). */
    role: z.string().trim().min(1).max(60),
    /** Required asset kind/role type for the slot. */
    requiredRole: z.enum(["hero", "background", "inline", "chart", "illustration", "logo", "supporting"]),
    /** Bound approved asset version when one exists (exact page+role assignment). */
    boundAssetVersionId: z
      .string()
      .trim()
      .max(128)
      .regex(/^asv-[0-9a-f-]{36}$/)
      .optional(),
    /** Exact binary digest of the bound version (bind-time copy). */
    boundBinaryDigest: designDigestSchema.optional(),
    /** Exact governance digest of the bound version (bind-time copy). */
    boundGovernanceDigest: designDigestSchema.optional(),
    /**
     * Explicit evidence dimensions (P2):
     * - designProviderReferencedFinalAsset: TRUE when the design provider emitted a binding/reference (e.g. img tag or screen slot) to the final asset
     * - designProviderConsumedFinalAsset: TRUE ONLY when the design provider actually ingested/consumed the final asset bytes
     */
    designProviderReferencedFinalAsset: z.boolean().default(false),
    designProviderConsumedFinalAsset: z.boolean().default(false),
    /**
     * @deprecated Ambiguous legacy field retained for schema backwards compatibility.
     * Narrowly represents whether the provider consumed the asset bytes.
     */
    providerConsumed: z.boolean().default(false),
    /** Placeholder handling (false when the provider consumes an approved asset). */
    placeholder: z.boolean(),
    /** Why the slot is unresolved, when it is (typed, bounded reason). */
    unresolvedReason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((slot) => (slot.providerConsumed === false && slot.designProviderConsumedFinalAsset === false) || (slot.boundAssetVersionId !== undefined && slot.boundBinaryDigest !== undefined), {
    message: "providerConsumed=true requires a bound asset version and binary digest",
  });
export type DesignAssetSlot = z.infer<typeof designAssetSlotSchema>;

/**
 * One representative archetype. Screens reference provider-native screen
 * identifiers; Factory never treats those identifiers as authority — the
 * normalized archetype payload plus its digests are the authority.
 */
export const designArchetypeSchema = z
  .object({
    kind: designArchetypeKindSchema,
    /** Human-readable archetype purpose (e.g. "Homepage — trust-first entry"). */
    purpose: boundedText(300),
    /** Provider screen resource names backing this archetype (evidence). */
    providerScreenNames: z.array(z.string().trim().min(1).max(300)).max(10),
    /** Allowed section patterns (bounded vocabulary, renderer-neutral). */
    sectionPatterns: z.array(boundedText(120)).max(20),
    /** Required content patterns the design must present. */
    contentRequirements: z.array(boundedText(300)).max(20),
    /** Asset slots this archetype requires (Run 7 resolves unresolved ones). */
    assetSlots: z.array(designAssetSlotSchema).max(20),
    /** CTA hierarchy: primary then secondary (empty string = not specified). */
    primaryCta: optionalBoundedText(300),
    secondaryCta: optionalBoundedText(300),
    /** Responsive behavior summary (mobile-first expectations). */
    responsiveBehavior: boundedText(1000),
    /** Trust/E-E-A-T presentation notes (author/source/date/methodology areas). */
    trustPresentation: boundedText(1000),
  })
  .strict();
export type DesignArchetype = z.infer<typeof designArchetypeSchema>;

// ---------------------------------------------------------------------------
// DesignInputSnapshot — immutable, authority-bound generation input
// ---------------------------------------------------------------------------

export const designUpstreamContentRefSchema = z
  .object({
    /** AcceptedPageContent id. */
    id: z.string().trim().min(1).max(128),
    version: z.number().int().min(1),
    slug: z.string().trim().min(1).max(120),
    /** Exact contentDigest at bind time (staleness anchor). */
    contentDigest: designDigestSchema,
  })
  .strict();
export type DesignUpstreamContentRef = z.infer<typeof designUpstreamContentRefSchema>;

export const designUpstreamAssetRefSchema = z
  .object({
    /** Approved AssetVersion id. */
    versionId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^asv-[0-9a-f-]{36}$/),
    binaryDigest: designDigestSchema,
    /** Exact accepted Run 5 rights/provenance authority; never the bytes digest. */
    acceptedPageContentId: z.string().min(1),
    acceptedPageContentVersion: z.number().int().positive(),
    acceptedPageContentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    governanceDigest: designDigestSchema,
    pageSlug: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(60),
  })
  .strict();
export type DesignUpstreamAssetRef = z.infer<typeof designUpstreamAssetRefSchema>;

/**
 * The exact accepted input the provider receives. Every material upstream
 * dependency is bound by id + version + digest so Factory can answer:
 * "Which exact content, facts, and assets were used to produce this design?"
 * and mark the design stale when any of them mutates.
 */
export const designInputSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    /** Accepted ProjectInputSnapshot lineage. */
    acceptedInputSnapshotId: z.string().trim().min(1).max(128),
    acceptedInputSnapshotVersion: z.number().int().min(1),
    acceptedInputDigest: designDigestSchema,
    /** Accepted brand facts (operator truth — never invented by the provider). */
    brand: z
      .object({
        facts: z.array(boundedText(300)).max(10),
        positioning: optionalBoundedText(500).refine((v) => v.length > 0, {
          message: "brand.positioning is required",
        }),
        tone: optionalBoundedText(300).refine((v) => v.length > 0, {
          message: "brand.tone is required",
        }),
        visualIdentityNotes: optionalBoundedText(500),
      })
      .strict(),
    /** Target audience summary (from accepted intake). */
    audience: z
      .object({
        segments: z.array(boundedText(300)).max(10),
        needs: z.array(boundedText(300)).max(10),
        decisionContext: optionalBoundedText(500),
      })
      .strict(),
    /** References (principles to learn) and anti-references (what to avoid). */
    references: z
      .object({
        referenceUrls: z.array(z.string().trim().max(2000)).max(10),
        antiReferenceUrls: z.array(z.string().trim().max(2000)).max(10),
        learn: z.array(boundedText(300)).max(10),
        avoid: z.array(boundedText(300)).max(10),
        preferredPerception: optionalBoundedText(500),
      })
      .strict(),
    /** UX requirements the design must honor. */
    uxRequirements: z.array(boundedText(300)).max(20),
    /** Accepted page content bound at snapshot time (copy authority). */
    contentRefs: z.array(designUpstreamContentRefSchema).max(50),
    /** Approved asset versions bound at snapshot time (Run 5 authority). */
    assetRefs: z.array(designUpstreamAssetRefSchema).max(100),
    /**
     * Explicit representative-page routing: each archetype binds exactly one
     * accepted page. Generation prompts receive only the representative
     * page's copy (page-exact authority routing). MAY be empty when the
     * project has no accepted page content yet — generation then runs with
     * structural slots only and no accepted copy is sent to the provider.
     */
    representativePages: z.array(designRepresentativePageSchema).max(5),
    /** Archetypes this generation must produce. */
    archetypes: z.array(designArchetypeKindSchema).min(1).max(5),
  })
  .strict();
export type DesignInputSnapshotData = z.infer<typeof designInputSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// Normalized provider result (candidate payload)
// ---------------------------------------------------------------------------

export const designTokenColorsSchema = z
  .object({
    primary: z.string().trim().min(1).max(60),
    secondary: z.string().trim().max(60).optional(),
    accent: z.string().trim().max(60).optional(),
    neutral: z.string().trim().max(60).optional(),
    background: z.string().trim().max(60).optional(),
    surface: z.string().trim().max(60).optional(),
    textPrimary: z.string().trim().max(60).optional(),
    textSecondary: z.string().trim().max(60).optional(),
  })
  .strict();
export type DesignTokenColors = z.infer<typeof designTokenColorsSchema>;

export const designTokenTypographySchema = z
  .object({
    headingFont: z.string().trim().min(1).max(120),
    bodyFont: z.string().trim().min(1).max(120),
    /** Optional scale notes (e.g. "display 3rem / body 1rem / label 0.75rem"). */
    scaleNotes: optionalBoundedText(500),
  })
  .strict();
export type DesignTokenTypography = z.infer<typeof designTokenTypographySchema>;

export const designSystemTokensSchema = z
  .object({
    colors: designTokenColorsSchema,
    typography: designTokenTypographySchema,
    /** Spacing scale (bounded named steps). */
    spacing: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(40)),
    /** Corner radii. */
    rounded: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(40)),
    /** CTA hierarchy summary. */
    ctaHierarchy: optionalBoundedText(500),
    /** Navigation language summary. */
    navigationLanguage: optionalBoundedText(500),
    /** Imagery treatment principles. */
    imageryTreatment: optionalBoundedText(500),
    /** Section rhythm principles. */
    sectionRhythm: optionalBoundedText(500),
  })
  .strict();
export type DesignSystemTokens = z.infer<typeof designSystemTokensSchema>;

/** One provider screen normalized into a renderer-neutral preview record. */
export const designScreenSchema = z
  .object({
    /** Factory-side identity for the screen record. */
    id: z.string().trim().min(1).max(128),
    /** Provider-native resource name (evidence, not authority). */
    providerScreenName: z.string().trim().min(1).max(300),
    title: boundedText(300),
    deviceType: z.enum(["MOBILE", "DESKTOP", "TABLET", "AGNOSTIC"]),
    /** Archetype this screen represents. */
    archetype: designArchetypeKindSchema,
    /** Digest of the raw HTML artifact (content-addressed storage key input). */
    htmlDigest: designDigestSchema.optional(),
    /** Digest of the raw screenshot artifact. */
    screenshotDigest: designDigestSchema.optional(),
  })
  .strict();
export type DesignScreen = z.infer<typeof designScreenSchema>;

/**
 * Normalized design candidate payload — what the provider produced, in
 * Factory vocabulary. Raw provider artifacts are stored separately and
 * referenced by digest; this payload never becomes production authority
 * without human acceptance.
 */
export const designCandidateDataSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    /** Provider identity. Run 6 implements exactly one provider. */
    provider: z.literal("google-stitch"),
    /**
     * Evidence mode: live provider execution vs deterministic fixture.
     * Durable and machine-checkable — a fixture candidate can NEVER
     * masquerade as live Stitch output (this field is persisted with the
     * candidate and survives restarts).
     */
    providerMode: z.enum(["live", "fixture"]),
    providerProjectName: z.string().trim().min(1).max(300),
    providerDesignSystemAsset: optionalBoundedText(300),
    /** DESIGN.md artifact digest (content-addressed raw artifact). */
    designMdDigest: designDigestSchema,
    /**
     * The EXACT validator/tool identity that actually ran on the DESIGN.md
     * artifact. Never claim official Google tooling unless that exact
     * tool/version executed for the recorded evidence.
     */
    designMdToolVersion: z.string().trim().min(1).max(100),
    /** Lint summary (errors/warnings/infos counts; findings stored raw). */
    designMdLint: z
      .object({
        errors: z.number().int().min(0),
        warnings: z.number().int().min(0),
        infos: z.number().int().min(0),
      })
      .strict(),
    /**
     * The Factory/operator-approved design seed (generation constraints).
     * Recorded separately from provider output so the seed is never
     * misrepresented as provider-derived design authority.
     */
    designSeed: z
      .object({
        colors: designTokenColorsSchema,
        typography: designTokenTypographySchema,
        rationale: optionalBoundedText(2000),
      })
      .strict(),
    /**
     * Provider design evidence: what the provider actually returned/derived.
     * Empty/absent fields mean the provider did not return that evidence —
     * never backfill from the seed.
     */
    providerEvidence: z
      .object({
        /** Provider design-system asset reference when the provider created one. */
        designSystemAsset: optionalBoundedText(300),
        /** Raw provider design data when the provider returned structured design output. */
        rawDesignData: z.record(z.string().trim().max(100), z.unknown()).optional(),
      })
      .strict(),
    tokens: designSystemTokensSchema,
    screens: z.array(designScreenSchema).min(1).max(20),
    archetypes: z.array(designArchetypeSchema).min(1).max(5),
    /** Human-readable design rationale from the provider (non-authoritative). */
    rationale: optionalBoundedText(4000),
    /** Provider session id when available (cost/trace evidence). */
    providerSessionId: optionalBoundedText(200),
    /** Provider-reported usage metadata when available (never invented). */
    providerUsage: z
      .object({
        reported: z.literal(true),
        detail: z.record(z.string().trim().max(100), z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DesignCandidateData = z.infer<typeof designCandidateDataSchema>;

// ---------------------------------------------------------------------------
// Provider boundary types (narrow, Factory-owned)
// ---------------------------------------------------------------------------

export interface DesignProviderPreflightConfigured {
  configured: true;
  /** Provider identity details for operator display (no secrets). */
  provider: "google-stitch";
  /** Reachability/auth state as observed by the preflight probe. */
  reachable: boolean;
}

export interface DesignProviderPreflightNotConfigured {
  configured: false;
  provider: "google-stitch";
  /** Human-readable reason (no secrets). */
  reason: string;
}

export type DesignProviderPreflight =
  | DesignProviderPreflightConfigured
  | DesignProviderPreflightNotConfigured;

export interface DesignGenerationRequest {
  /** Exact DesignInputSnapshot to generate from (already persisted). */
  inputSnapshot: DesignInputSnapshotData;
  inputSnapshotId: string;
  projectId: string;
  /**
   * Page-exact accepted copy routing: for each archetype, ONLY the
   * representative page's accepted copy (resolved by the trusted service
   * layer from AcceptedPageContent, digest-verified). The provider prompt
   * for an archetype embeds exactly this page's copy verbatim with a strict
   * no-rewrite instruction — never the whole project content set.
   */
  acceptedCopyByArchetype: Partial<Record<DesignArchetypeKind, DesignGenerationAcceptedPage>>;
  /**
   * The Factory/operator design seed (approved generation constraints).
   * Recorded as seed authority; provider output is evidence, never the
   * seed itself.
   */
  designSeed: {
    colors: DesignTokenColors;
    typography: DesignTokenTypography;
    rationale: string;
  };
}

/** One representative page's full accepted copy body. */
export interface DesignGenerationAcceptedPage {
  slug: string;
  title: string;
  introduction: string;
  sections: Array<{ heading: string; body: string }>;
  conclusion: string;
  cta: string;
}

export interface DesignGenerationResult {
  /** Normalized candidate payload (validated against the contract). */
  candidate: DesignCandidateData;
  /** Raw provider artifacts for content-addressed storage. */
  rawArtifacts: Array<{
    kind: "design_md" | "screen_html" | "screen_screenshot" | "provider_response";
    bytes: Uint8Array;
    mediaType: string;
    /** Provider-native identifier evidence. */
    providerRef: string | null;
  }>;
  providerProjectName: string;
  providerSessionId: string | null;
}

/** The narrow provider boundary. Run 6: Google Stitch only. */
export interface DesignProvider {
  readonly id: string;
  preflight(): Promise<DesignProviderPreflight>;
  generateDesignSystem(request: DesignGenerationRequest): Promise<DesignGenerationResult>;
}

// ---------------------------------------------------------------------------
// Typed failure codes (domain-level; operator contract maps them to HTTP)
// ---------------------------------------------------------------------------

export const DESIGN_ERROR_CODES = [
  /** No accepted ProjectInputSnapshot exists for this project (design). */
  "design_input_not_accepted",
  /** Design input snapshot does not exist for this project. */
  "design_input_not_found",
  /** Design candidate does not exist for this project. */
  "design_candidate_not_found",
  /** Accepted design does not exist for this project. */
  "design_accepted_not_found",
  /** Design input snapshot is stale versus upstream accepted authorities. */
  "design_input_stale",
  /** Design approval/rejection rejected (digest mismatch or invalid state). */
  "design_approval_failed",
  /** Accepted design is immutable; a new version is required. */
  "design_immutable",
  /** Design provider credentials/configuration are missing. */
  "design_provider_not_configured",
  /** Design provider endpoint unreachable/failed before or during generation. */
  "design_provider_unavailable",
  /** Provider output failed strict contract validation (fail closed). */
  "design_provider_output_invalid",
  /** DESIGN.md artifact failed validation (structural or lint errors). */
  "design_md_invalid",
  /** Provider generation blocked by trusted preflight (fail before spend). */
  "design_budget_blocked",
] as const;
export type DesignErrorCode = (typeof DESIGN_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Parsers (fail closed on drift, mirroring the other contract parsers)
// ---------------------------------------------------------------------------

export function parseDesignInputSnapshotData(input: unknown): DesignInputSnapshotData {
  return designInputSnapshotDataSchema.parse(input);
}
export function parseDesignCandidateData(input: unknown): DesignCandidateData {
  return designCandidateDataSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Design staleness classification (typed authority; Run 7 uses this)
// ---------------------------------------------------------------------------

export const designStalenessCodeSchema = z.enum([
  "INPUT_CHANGED",
  "INPUT_REMOVED",
  "CONTENT_CHANGED",
  "CONTENT_REMOVED",
  "CONTENT_ADDED",
  "ASSET_ASSIGNMENT_CHANGED",
  "ASSET_ASSIGNMENT_REMOVED",
  "RUN7_ASSET_ASSIGNMENTS_ADDED",
  "RUN7_EXACT_ASSET_REPLACED",
  "DESIGN_INPUT_SNAPSHOT_REMOVED",
  "DESIGN_INPUT_SNAPSHOT_INVALID",
]);
export type DesignStalenessCode = z.infer<typeof designStalenessCodeSchema>;

export interface DesignStaleness {
  stale: boolean;
  reason: string | null;
  code?: DesignStalenessCode | null;
}

