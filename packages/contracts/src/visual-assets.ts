import { z } from "zod";

/**
 * VISUAL ASSET CONTRACTS — Macro Run 7 (Final Visual Assets).
 *
 * Governed final-asset-resolution pipeline on top of the accepted Run 5
 * media authority (Asset -> AssetVersion -> approval -> assignment) and the
 * accepted Run 6 design authority (AcceptedDesignArtifact):
 *
 *   AcceptedDesignArtifact (immutable; live-mode for production authority)
 *   -> VisualAssetPlan (versioned; per-slot truth class + resolution strategy)
 *   -> operator truth-class confirmation (human governance decision)
 *   -> [reuse_real]                 existing approved AssetVersion (zero spend)
 *   -> [deterministic_transform]    sharp op on approved parent -> derived version
 *   -> [ai_edit / ai_generate]      approved VisualPromptSnapshot (human gate)
 *                                   -> fail-before-spend preflight
 *                                   -> budget reservation
 *                                   -> VisualAssetProvider (@google/genai)
 *                                   -> VisualAssetCandidate (immutable,
 *                                      byte-validated, content-addressed)
 *   -> human slot acceptance (binds exact candidate/version digests;
 *      ingests through the Run 5 authority — NEVER a parallel asset system)
 *   -> AcceptedVisualAssetSet (version/digest bound; per-slot resolution)
 *
 * Authority boundaries (Constitution §2, §10, §11):
 * - Run 5 asset_versions/assignments remain the ONLY media authority. Run 7
 *   resolves requirements and records lineage; accepted outputs enter Run 5.
 * - The provider owns execution only; Factory owns truth, prompts, model
 *   policy, cost, approval and provenance.
 * - Human review is mandatory; no automated path accepts an asset.
 * - Synthetic imagery never masquerades as documentary evidence: the truth
 *   classification constrains allowed resolution modes and documentary AI
 *   edits embed a forbidden-edit list verbatim in the prompt snapshot.
 */

export const VISUAL_ASSETS_SCHEMA_VERSION = "visual-assets-v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalBoundedText = (max: number) => z.string().trim().max(max).default("");

/** SHA-256 hex over exact bytes (binary) or canonical JSON (governance). */
export const visualDigestSchema = z.string().trim().regex(/^[0-9a-f]{64}$/);

export const visualPlanIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^vap-[0-9a-f-]{36}$/, "visual plan id must match vap-<uuid>");
export const visualPromptSnapshotIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^vps-[0-9a-f-]{36}$/, "visual prompt snapshot id must match vps-<uuid>");
export const visualGenerationRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^vgr-[0-9a-f-]{36}$/, "visual generation request id must match vgr-<uuid>");
export const visualCandidateIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^vac-[0-9a-f-]{36}$/, "visual candidate id must match vac-<uuid>");
export const visualAssetSetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^avs-[0-9a-f-]{36}$/, "visual asset set id must match avs-<uuid>");

// ---------------------------------------------------------------------------
// Truth classification + resolution policy (hard product policy)
// ---------------------------------------------------------------------------

/**
 * Visual truth/use classification. Decides which resolution modes are
 * allowed BEFORE any provider execution. The service derives a deterministic
 * proposal; the OPERATOR confirms or overrides it (human governance).
 */
export const visualTruthClassSchema = z.enum([
  /** Evidence of a real place/person/property/project/event. */
  "documentary",
  /** Started from documentary imagery but transformed; no longer plain evidence. */
  "documentary_edited",
  /** Conceptual/illustrative imagery; no documentary claim. */
  "illustrative",
  /** Purely decorative; no content claim at all. */
  "decorative",
  /** Factual quantitative display; deterministic authority only for the data. */
  "data_visualization",
]);
export type VisualTruthClass = z.infer<typeof visualTruthClassSchema>;

/** How a slot was (or is proposed to be) resolved. */
export const visualResolutionModeSchema = z.enum([
  "reuse_real",
  "deterministic_transform",
  "ai_edit",
  "ai_generate",
]);
export type VisualResolutionMode = z.infer<typeof visualResolutionModeSchema>;

/** Bounded escalation reasons for the premium image model. */
export const visualEscalationReasonSchema = z.enum([
  "composition_complexity",
  "brand_consistency",
  "text_rendering",
  "reference_composition",
  "quality_floor_failure",
]);
export type VisualEscalationReason = z.infer<typeof visualEscalationReasonSchema>;

/**
 * The truth-policy matrix, expressed as data (single authority; the service,
 * store CHECKs and tests all derive from this vocabulary).
 */
export const VISUAL_TRUTH_POLICY: Readonly<
  Record<VisualTruthClass, Readonly<Record<VisualResolutionMode, boolean>>>
> = Object.freeze({
  documentary: Object.freeze({
    reuse_real: true,
    deterministic_transform: true,
    ai_edit: true, // controlled policy only: forbidden-edit list is mandatory
    ai_generate: false, // forbidden outright
  }),
  documentary_edited: Object.freeze({
    reuse_real: true,
    deterministic_transform: true,
    ai_edit: true,
    ai_generate: false,
  }),
  illustrative: Object.freeze({
    reuse_real: true,
    deterministic_transform: true,
    ai_edit: true,
    ai_generate: true,
  }),
  decorative: Object.freeze({
    reuse_real: true,
    deterministic_transform: true,
    ai_edit: true,
    ai_generate: true,
  }),
  data_visualization: Object.freeze({
    reuse_real: true,
    deterministic_transform: true,
    ai_edit: false, // a model must never redraw factual data
    ai_generate: false,
  }),
});

/** Verbatim forbidden-edit list embedded in every documentary ai_edit prompt. */
export const DOCUMENTARY_FORBIDDEN_EDITS: readonly string[] = Object.freeze([
  "Do NOT add people.",
  "Do NOT remove people.",
  "Do NOT add buildings or structures.",
  "Do NOT remove buildings or structures.",
  "Do NOT move, add or remove objects in the scene.",
  "Do NOT replace the sky or weather in a way that changes real conditions.",
  "Do NOT add signage, logos or text that does not exist in the original.",
  "Do NOT invent scenery or extend the scene with imagined elements.",
  "Do NOT change the apparent condition of the property or its features.",
  "Do NOT fabricate events, activity or use that did not occur.",
]);

// ---------------------------------------------------------------------------
// Plan slot (typed member of the versioned VisualAssetPlan)
// ---------------------------------------------------------------------------

export const visualPlanSlotSchema = z
  .object({
    /** Slot identity from the accepted design archetype (e.g. "hero.primary"). */
    slot: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9.-]*$/),
    /** Exact page/role lineage from the accepted design asset slot. */
    pageSlug: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(60),
    requiredRole: z.enum(["hero", "background", "inline", "chart", "illustration", "logo", "supporting"]),
    /** Visual requirement verbatim from the accepted design artifact. */
    requirement: boundedText(500),
    /** Deterministic truth-class PROPOSAL (operator must confirm). */
    truthClassProposal: visualTruthClassSchema,
    /** Why the proposal maps this way (bounded, inspectable). */
    truthClassRationale: boundedText(500),
    /** Target aspect ratio (bounded vocabulary: "1:1" | "3:2" | "4:3" | "16:9"). */
    aspectRatio: z.enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]),
    /** Minimum usable dimensions for the slot. */
    minDimensions: z
      .object({ width: z.number().int().min(1).max(8000), height: z.number().int().min(1).max(8000) })
      .strict(),
    /** Existing bound asset version from the accepted design, when any. */
    existingVersionId: z
      .string()
      .trim()
      .max(128)
      .regex(/^asv-[0-9a-f-]{36}$/)
      .optional(),
    existingBinaryDigest: visualDigestSchema.optional(),
    existingGovernanceDigest: visualDigestSchema.optional(),
    /** Deterministic resolution-strategy proposal (operator may override). */
    proposedStrategy: visualResolutionModeSchema,
    /** Typed unresolved reason while the slot is not resolved. */
    unresolvedReason: z.string().trim().min(1).max(300),
  })
  .strict();
export type VisualPlanSlot = z.infer<typeof visualPlanSlotSchema>;

/** One versioned VisualAssetPlan payload (immutable once written). */
export const visualPlanDataSchema = z
  .object({
    schemaVersion: z.literal(VISUAL_ASSETS_SCHEMA_VERSION),
    /** Exact accepted design lineage (never mutable "latest"). */
    designArtifactId: z.string().trim().min(1).max(128),
    designArtifactVersion: z.number().int().min(1),
    designCandidateDigest: visualDigestSchema,
    designInputDigest: visualDigestSchema,
    designProviderMode: z.enum(["live", "fixture"]),
    /** The archetype kind each slot came from (provenance of the requirement). */
    slots: z.array(visualPlanSlotSchema).min(1).max(60),
  })
  .strict();
export type VisualPlanData = z.infer<typeof visualPlanDataSchema>;

// ---------------------------------------------------------------------------
// Operator truth-class confirmation (classification authority)
// ---------------------------------------------------------------------------

export const visualClassificationSchema = z
  .object({
    slot: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9.-]*$/),
    truthClass: visualTruthClassSchema,
    /** Required operator acknowledgment of the classification consequences. */
    acknowledged: z.literal(true),
  })
  .strict();
export type VisualClassificationInput = z.infer<typeof visualClassificationSchema>;

// ---------------------------------------------------------------------------
// Prompt snapshot (immutable, digest-bound; human-approved before spend)
// ---------------------------------------------------------------------------

export const visualPromptSnapshotDataSchema = z
  .object({
    schemaVersion: z.literal(VISUAL_ASSETS_SCHEMA_VERSION),
    /** Prompt policy version (bumped when prompt construction changes). */
    promptPolicyVersion: z.literal("factory-visual-prompt-policy-v1"),
    projectId: z.string().trim().min(1).max(128),
    /** Exact accepted design lineage. */
    designArtifactId: z.string().trim().min(1).max(128),
    designArtifactVersion: z.number().int().min(1),
    designCandidateDigest: visualDigestSchema,
    /** Slot context. */
    archetype: z.enum(["homepage", "service", "location", "editorial", "investment_advisory"]),
    slot: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9.-]*$/),
    pageSlug: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(60),
    /** Confirmed truth class (classification authority flowed in). */
    truthClass: visualTruthClassSchema,
    /** Visual requirement (from the accepted design slot). */
    visualRequirement: boundedText(500),
    /** Brand/style constraints (from the accepted design tokens, verbatim). */
    brandConstraints: z.array(boundedText(300)).max(10),
    targetAspectRatio: z.enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]),
    targetSize: z.enum(["1K", "2K", "4K"]).default("1K"),
    /** Allowed edit scope (bounded list; empty for ai_generate). */
    allowedEdits: z.array(boundedText(200)).max(10),
    /** Forbidden edit scope: documentary slots embed DOCUMENTARY_FORBIDDEN_EDITS. */
    forbiddenEdits: z.array(boundedText(200)).max(10),
    /** Operation. */
    operation: z.enum(["edit", "generate"]),
    /** Source (parent) asset lineage — mandatory for edit operations. */
    sourceAssets: z
      .array(
        z
          .object({
            versionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/),
            binaryDigest: visualDigestSchema,
            governanceDigest: visualDigestSchema,
          })
          .strict(),
      )
      .max(3),
    /** Model policy identity in force when this snapshot was compiled. */
    modelPolicyVersion: z.string().trim().min(1).max(100),
    /** The FINAL prompt text sent to the provider. */
    promptText: z.string().trim().min(1).max(6000),
  })
  .strict()
  .refine((data) => data.operation !== "edit" || data.sourceAssets.length > 0, {
    message: "edit operations require at least one source asset",
  })
  .refine(
    (data) =>
      data.truthClass !== "documentary" ||
      data.operation !== "edit" ||
      DOCUMENTARY_FORBIDDEN_EDITS.every((rule) => data.forbiddenEdits.includes(rule)),
    { message: "documentary ai_edit prompts must embed the full forbidden-edit list" },
  );
export type VisualPromptSnapshotData = z.infer<typeof visualPromptSnapshotDataSchema>;

// ---------------------------------------------------------------------------
// Provider boundary (narrow; Factory owns everything except execution)
// ---------------------------------------------------------------------------

/** Provider request issued through the trusted service (post-preflight). */
export interface VisualProviderRequest {
  provider: "google-genai";
  model: string;
  operation: "edit" | "generate";
  promptText: string;
  promptDigest: string;
  requestDigest: string;
  promptSnapshotId: string;
  targetAspectRatio: string;
  targetSize: string;
  /** Parent image bytes (base64) + media type, in snapshot order. */
  sourceImages: Array<{ dataBase64: string; mediaType: string; versionId: string }>;
}

/** One provider-returned image candidate (UNVALIDATED bytes + metadata). */
export interface VisualProviderCandidate {
  /** Raw provider bytes (exact; never re-encoded by the adapter). */
  bytes: Uint8Array;
  /** Provider-reported media type (untrusted; verified by byte validation). */
  mediaType: string;
  /** Candidate index within the response (0-based). */
  index: number;
}

export interface VisualProviderResult {
  candidates: VisualProviderCandidate[];
  /** Provider session/response identifier when available (evidence). */
  providerRequestRef: string | null;
  /** Provider-reported usage metadata when available (never invented). */
  providerUsage: Record<string, unknown> | null;
}

export interface VisualAssetProviderPreflightConfigured {
  configured: true;
  provider: "google-genai";
  reachable: boolean;
  /** Policy-configured model ids the adapter permits (honest reporting). */
  configuredModels: string[];
  /** Optional model ids dynamically verified by an interactive zero-cost probe. */
  verifiedModels?: string[];
}

export interface VisualAssetProviderPreflightNotConfigured {
  configured: false;
  provider: "google-genai";
  /** Human-readable reason (no secrets). */
  reason: string;
}

export type VisualAssetProviderPreflight =
  | VisualAssetProviderPreflightConfigured
  | VisualAssetProviderPreflightNotConfigured;

/** The narrow provider boundary. Run 7: Google GenAI only (+ fixture). */
export interface VisualAssetProvider {
  readonly id: string;
  /** Evidence mode: live provider execution vs deterministic fixture. */
  readonly providerMode: "live" | "fixture";
  preflight(): Promise<VisualAssetProviderPreflight>;
  generateImage(request: VisualProviderRequest): Promise<VisualProviderResult>;
  editImage(request: VisualProviderRequest): Promise<VisualProviderResult>;
}

// ---------------------------------------------------------------------------
// Candidates + acceptance
// ---------------------------------------------------------------------------

/** Immutable candidate QA evidence (byte-level validation results). */
export const visualCandidateQaSchema = z
  .object({
    sniffedMediaType: z.string().trim().min(1).max(60),
    decoded: z.literal(true),
    width: z.number().int().min(1).max(8000),
    height: z.number().int().min(1).max(8000),
    byteSize: z.number().int().min(1),
    withinLimits: z.literal(true),
  })
  .strict();
export type VisualCandidateQa = z.infer<typeof visualCandidateQaSchema>;

/** C2PA read result (READ/VALIDATE/RECORD only; never fabricated). */
export const visualCandidateC2paSchema = z
  .object({
    /** present_valid = manifest present and validated;
     *  present_invalid = manifest present but signature/hash validation failed;
     *  present_untrusted = manifest present and validly signed but trust anchor not trusted;
     *  absent = no manifest embedded;
     *  unreadable = manifest bytes present but parse failed;
     *  verification_unavailable = the C2PA runtime could not run at all;
     *  validated = legacy alias for present_valid. */
    status: z.enum([
      "present_valid",
      "present_invalid",
      "present_untrusted",
      "absent",
      "unreadable",
      "verification_unavailable",
      "validated",
    ]),
    reason: z.string().trim().max(300).optional(),
    /** Bounded manifest summary when validated (never the full manifest). */
    manifestSummary: z
      .object({
        generator: z.string().trim().max(200).optional(),
        signed: z.boolean().optional(),
        validationCodes: z.array(z.string().trim().max(100)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type VisualCandidateC2pa = z.infer<typeof visualCandidateC2paSchema>;

// ---------------------------------------------------------------------------
// Typed failure codes (operator contract maps them to HTTP)
// ---------------------------------------------------------------------------

export const VISUAL_ERROR_CODES = [
  /** Accepted design missing, stale, or fixture-classified for a live path. */
  "visual_design_not_eligible",
  /** The plan is stale versus the accepted design (re-derive required). */
  "visual_plan_stale",
  /** Truth classification must be confirmed before this operation. */
  "visual_classification_required",
  /** Requested resolution mode is forbidden for the slot's truth class. */
  "visual_truth_policy_violation",
  /** Prompt snapshot missing/not approved, or digest mismatch. */
  "visual_prompt_not_approved",
  /** Visual provider credentials/configuration are missing. */
  "visual_provider_not_configured",
  /** Visual provider endpoint failed before or during execution. */
  "visual_provider_unavailable",
  /** Provider output failed strict byte/contract validation (fail closed). */
  "visual_provider_output_invalid",
  /** Trusted visual budget policy blocks this execution (fail before spend). */
  "visual_budget_blocked",
  /** Visual plan/prompt/request/candidate/set does not exist for this project. */
  "visual_not_found",
  /** Slot acceptance rejected (digest mismatch, invalid state, or lineage). */
  "visual_acceptance_failed",
  /** Accepted visual set is immutable; resolve remaining slots or re-accept. */
  "visual_set_immutable",
  /** Slot has no accepted resolution yet (set acceptance fail-closed). */
  "visual_slot_unresolved",
  /** Follower timeout waiting for concurrent provider generation to complete. */
  "visual_generation_timeout",
] as const;
export type VisualErrorCode = (typeof VISUAL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Parsers (fail closed on drift, mirroring the other contract parsers)
// ---------------------------------------------------------------------------

export function parseVisualPlanData(input: unknown): VisualPlanData {
  return visualPlanDataSchema.parse(input);
}
export function parseVisualPromptSnapshotData(input: unknown): VisualPromptSnapshotData {
  return visualPromptSnapshotDataSchema.parse(input);
}
