import { z } from "zod";

/**
 * ASSET CONTRACTS — Macro Run 5 (Asset Foundation + Operator Photography).
 *
 * Durable authority model for project imagery:
 *   upload -> validate bytes -> provenance -> rights -> immutable
 *   AssetVersion -> approval (binds exact digest) -> page/slot assignment
 *   (binds exact approved version) -> explicit replacement only.
 *
 * Semantics mirror the accepted writer-content patterns: strict schemas,
 * version/digest binding, fail-closed approval, computed staleness.
 * The legacy `SiteProductionSpec` asset vocabulary (assetKindSchema,
 * assetRightsStatusSchema, assetRoleSchema) is REUSED here so later
 * production projection stays vocabulary-compatible; this contract is the
 * durable lifecycle authority, not a second copy of those enums.
 */

export const ASSETS_SCHEMA_VERSION = "assets-v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const assetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^asst-[0-9a-f-]{36}$/, "asset id must match asst-<uuid>");
export const assetVersionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^asv-[0-9a-f-]{36}$/, "asset version id must match asv-<uuid>");
export const assetAssignmentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^apa-[0-9a-f-]{36}$/, "asset assignment id must match apa-<uuid>");

/** SHA-256 hex over exact bytes (binary) or canonical JSON (governance). */
export const assetDigestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);

/** Page identity for assignments — same shape as the writer pageTarget slug. */
export const assetPageSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-/]*$/, "page slug must be lowercase letters, digits, hyphens (and optional slashes)");

// ---------------------------------------------------------------------------
// Imagery strategy (project-level; vocabulary per Constitution §11)
// ---------------------------------------------------------------------------

export const imageryStrategySchema = z.enum(["none", "operator", "generated", "mixed"]);
export type ImageryStrategy = z.infer<typeof imageryStrategySchema>;

// ---------------------------------------------------------------------------
// Asset kinds / rights / approval / provenance
// ---------------------------------------------------------------------------

/** Same vocabulary as the legacy production-spec asset kind enum. */
export const assetKindSchemaV2 = z.enum(["logo", "photo", "illustration", "chart", "icon"]);
export type AssetKindV2 = z.infer<typeof assetKindSchemaV2>;

/** Same vocabulary as the legacy production-spec rights enum. */
export const assetRightsStatusSchemaV2 = z.enum([
  "operator_owned",
  "licensed",
  "public_domain",
  "unknown",
]);
export type AssetRightsStatusV2 = z.infer<typeof assetRightsStatusSchemaV2>;

export const assetApprovalStateSchema = z.enum(["pending", "approved", "rejected"]);
export type AssetApprovalState = z.infer<typeof assetApprovalStateSchema>;

export const assetProvenanceCategorySchema = z.enum([
  "operator_upload",
  // Run 7: `derived` marks versions produced from an approved parent asset
  // (deterministic transform or AI edit); `generated` marks fully synthetic
  // creation. Run 5 itself still only creates operator_upload rows.
  "derived",
  "generated",
  "imported",
]);
export type AssetProvenanceCategory = z.infer<typeof assetProvenanceCategorySchema>;

/**
 * Exact derivation lineage for versions that originate from an approved
 * parent (Run 7). Present ONLY on derived/generated rows; operator uploads
 * never carry it. Parent references are exact ids + both digests — never a
 * prose description like "edited from the homepage photo".
 */
export const assetDerivationSchema = z
  .object({
    origin: z.enum(["deterministic_transform", "ai_edit", "ai_generate"]),
    parentVersionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/),
    parentBinaryDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
    parentGovernanceDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
    /** Deterministic-transform description (e.g. "crop 16:9, resize 1600w"). */
    transformation: z.string().trim().max(300).optional(),
    provider: z.string().trim().max(60).optional(),
    model: z.string().trim().max(120).optional(),
    promptSnapshotId: z.string().trim().max(128).optional(),
    generationRequestId: z.string().trim().max(128).optional(),
    /** Visual slot this version was produced for (exact design lineage). */
    visualSlot: z.string().trim().max(120).optional(),
    visualTruthClass: z.string().trim().max(40).optional(),
  })
  .strict();
export type AssetDerivation = z.infer<typeof assetDerivationSchema>;

export const assetProvenanceSchema = z
  .object({
    category: assetProvenanceCategorySchema,
    originalFilename: z.string().trim().min(1).max(300),
    uploadedAt: z.string().trim().min(1).max(40),
    /** Evidence-only extracted metadata; never proof of legal ownership. */
    extracted: z
      .object({
        format: z.string().trim().min(1).max(40).optional(),
        space: z.string().trim().min(1).max(60).optional(),
        exif: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
    /** Exact derivation lineage (Run 7 derived/generated rows only). */
    derivation: assetDerivationSchema.optional(),
  })
  .strict();
export type AssetProvenance = z.infer<typeof assetProvenanceSchema>;

// ---------------------------------------------------------------------------
// Upload input (base64-in-JSON; server re-validates everything)
// ---------------------------------------------------------------------------

export const assetUploadSchema = z
  .object({
    /** Raw base64 (standard alphabet, padding allowed); length must be valid mod 4. */
    dataBase64: z
      .string()
      .trim()
      .min(1)
      .max(48_000_000)
      .refine((value) => {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
        // Standard base64 length is always ≡ 0 mod 4 (padding included).
        return value.length % 4 === 0;
      }, "dataBase64 must be standard base64 with valid padding"),
    /** Declared filename — display/provenance only, never a storage path. */
    filename: boundedText(300),
    kind: assetKindSchemaV2,
    title: boundedText(300),
    rightsStatus: assetRightsStatusSchemaV2,
    rightsNote: z.string().trim().max(1000).optional(),
    altIntent: z.string().trim().max(500).optional(),
  })
  .strict();
export type AssetUploadInput = z.infer<typeof assetUploadSchema>;

// ---------------------------------------------------------------------------
// Metadata update (pre-approval only; approved versions are immutable)
// ---------------------------------------------------------------------------

export const assetVersionMetadataSchema = z
  .object({
    rightsStatus: assetRightsStatusSchemaV2,
    rightsNote: z.string().trim().max(1000).optional(),
    altIntent: z.string().trim().max(500).optional(),
    expectedBinaryDigest: assetDigestSchema,
  })
  .strict();
export type AssetVersionMetadataInput = z.infer<typeof assetVersionMetadataSchema>;

// ---------------------------------------------------------------------------
// Approval / rejection (bind exact binary digest; idempotent on same digest)
// ---------------------------------------------------------------------------

export const assetApprovalSchema = z
  .object({
    expectedBinaryDigest: assetDigestSchema,
  })
  .strict();
export type AssetApprovalInput = z.infer<typeof assetApprovalSchema>;

// ---------------------------------------------------------------------------
// Assignment (binds exact approved version; explicit replacement only)
// ---------------------------------------------------------------------------

export const assetRoleSchemaV2 = z.enum([
  "hero",
  "background",
  "inline",
  "chart",
  "illustration",
  "logo",
  "supporting",
]);
export type AssetRoleV2 = z.infer<typeof assetRoleSchemaV2>;

export const assetAssignSchema = z
  .object({
    assetId: assetIdSchema,
    versionId: assetVersionIdSchema,
    acceptedPageContentId: z.string().min(1),
    acceptedPageContentVersion: z.number().int().positive(),
    acceptedPageContentDigest: assetDigestSchema,
    expectedGovernanceDigest: assetDigestSchema,
    pageSlug: assetPageSlugSchema,
    role: assetRoleSchemaV2,
    /** Optimistic concurrency: caller must echo the approved version digest. */
    expectedBinaryDigest: assetDigestSchema,
  })
  .strict();
export type AssetAssignInput = z.infer<typeof assetAssignSchema>;

export const assetReplaceSchema = z
  .object({
    pageAuthority: z.object({ id: z.string().min(1), version: z.number().int().positive(), contentDigest: assetDigestSchema, slug: assetPageSlugSchema }).strict().optional(),
    toVersionId: assetVersionIdSchema,
    expectedBinaryDigest: assetDigestSchema,
  })
  .strict();
export type AssetReplaceInput = z.infer<typeof assetReplaceSchema>;

/**
 * Explicit compare-and-swap replacement (Run 5 → Run 7 authority seam).
 *
 * The caller must echo the ENTIRE expected current authority of the
 * assignment (asset id, version id, governance digest) and the exact
 * expected target binary digest. Every expected value is verified inside
 * one PostgreSQL transaction under row locks; any mismatch fails closed
 * with a typed conflict. This is what makes a cross-asset slot move
 * (Asset A/v1 -> Asset B/v1 for the same page/role) safe: authorization is
 * proven against exact digests, never against mutable "latest" state.
 */
export const assetReplaceCasSchema = z
  .object({
    /** Expected current bound asset (old authority identity). */
    expectedCurrentAssetId: assetIdSchema,
    /** Expected current bound version (old authority identity). */
    expectedCurrentVersionId: assetVersionIdSchema,
    /** Expected current governance digest (old authority authority surface). */
    expectedCurrentGovernanceDigest: assetDigestSchema,
    /** Target logical asset (may differ from the current one). */
    toAssetId: assetIdSchema,
    /** Target approved version. */
    toVersionId: assetVersionIdSchema,
    /** Optimistic concurrency: caller must echo the target's binary digest. */
    expectedTargetBinaryDigest: assetDigestSchema,
  })
  .strict();
export type AssetReplaceCasInput = z.infer<typeof assetReplaceCasSchema>;

export const assetSettingsSchema = z
  .object({
    imageryStrategy: imageryStrategySchema,
  })
  .strict();
export type AssetSettingsInput = z.infer<typeof assetSettingsSchema>;

// ---------------------------------------------------------------------------
// Typed failure codes (domain-level; operator contract maps them to HTTP)
// ---------------------------------------------------------------------------

export const ASSET_ERROR_CODES = [
  /** Upload failed deterministic validation (type, size, corruption, mismatch). */
  "asset_upload_invalid",
  /** Asset/asset version/derivative does not exist for this project. */
  "asset_not_found",
  /** Alias for readability at call sites that reference versions explicitly. */
  "asset_version_not_found",
  /** Assignment does not exist for this project. */
  "asset_assignment_not_found",
  /** Approval/rejection rejected (digest mismatch or non-pending state). */
  "asset_approval_failed",
  /** Metadata mutation rejected (approved versions are immutable). */
  "asset_version_immutable",
  /** Assignment rejected (version not approved, rights unresolved, digest mismatch). */
  "asset_rights_blocked",
  /** Assignment slot conflict or replacement digest/version mismatch. */
  "asset_assignment_conflict",
  /** Trusted local asset storage failed (fail closed, nothing persisted). */
  "asset_storage_failed",
] as const;
export type AssetErrorCode = (typeof ASSET_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Parsers (fail closed on drift, mirroring the other contract parsers)
// ---------------------------------------------------------------------------

export function parseAssetUploadInput(value: unknown): AssetUploadInput {
  return assetUploadSchema.parse(value);
}
export function parseAssetVersionMetadataInput(value: unknown): AssetVersionMetadataInput {
  return assetVersionMetadataSchema.parse(value);
}
export function parseAssetAssignInput(value: unknown): AssetAssignInput {
  return assetAssignSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Base64 strictness regression (QA remediation): `len % 4 === 1` inputs were
// previously accepted by the charset regex and silently truncated by
// Buffer.from; the length refinement now rejects them at the boundary.
// ---------------------------------------------------------------------------
