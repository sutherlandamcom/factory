import { createHash } from "node:crypto";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import {
  ASSETS_SCHEMA_VERSION,
  DOCUMENTARY_FORBIDDEN_EDITS,
  VISUAL_ASSETS_SCHEMA_VERSION,
  parseVisualPlanData,
  parseVisualPromptSnapshotData,
  type AssetDerivation,
  type AssetProvenance,
  type DesignCandidateData,
  type VisualPlanData,
  type VisualPlanSlot,
  type VisualPromptSnapshotData,
  type VisualProviderRequest,
  type VisualProviderResult,
  type VisualResolutionMode,
  type VisualTruthClass,
  type VisualCandidateC2pa,
  type VisualCandidateQa,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { resolveRepositoryRoot } from "../repo-root.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { AssetService } from "../assets/service.js";
import type { AssetRow, AssetVersionRow } from "../assets/asset-store.js";
import { DesignStore } from "../design/design-store.js";
import type { DesignService, AcceptedDesignView, DesignCandidateView } from "../design/service.js";
import type { AcceptedDesignArtifactRecord } from "../persistence/schema.js";
import { VisualBudgetStore } from "./budget.js";
import { createVisualCandidateStorage, type VisualCandidateStorage } from "./candidate-storage.js";
import { readC2paEvidence } from "./c2pa.js";
import {
  FACTORY_VISUAL_MODEL_POLICY_VERSION,
  FACTORY_VISUAL_PROMPT_POLICY_VERSION,
  VISUAL_DEFAULT_MODEL,
  VISUAL_GENERATION_CONFIG,
  isResolutionAllowed,
  proposeResolutionStrategy,
  proposeTruthClass,
} from "./policy.js";
import {
  VisualStore,
  visualRequestDigest,
  visualSetDigest,
} from "./store.js";
import type {
  AcceptedVisualAssetSetRecord,
  AcceptedVisualAssetSlotRecord,
  VisualAssetCandidateRecord,
  VisualAssetPlanRecord,
  VisualGenerationRequestRecord,
  VisualPromptSnapshotRecord,
} from "../persistence/schema.js";
import type { VisualAssetProvider, VisualAssetProviderPreflight } from "@factory/contracts";

/**
 * VisualService — the governed application service for the Run 7 vertical:
 * resolve every required visual slot from the accepted design with the best
 * available approved asset, preferring authentic real imagery over AI
 * generation, while preserving exact provenance, lineage, human approval
 * and staleness semantics.
 *
 * Governance invariants enforced here (fail closed):
 * - plans derive ONLY from a current, non-stale accepted design; fixture
 *   accepted designs force the fixture provider path (never live spend);
 * - every provider operation requires a confirmed truth classification and
 *   an APPROVED prompt snapshot bound to its exact digest;
 * - truth policy gates resolution modes BEFORE spend (documentary slots can
 *   never be fully generated; data_visualization never AI-redrawn);
 * - fail-before-spend preflight runs the full §15 checklist in order;
 * - generation is request-digest deduplicated — identical requests reuse
 *   existing candidates and never re-spend;
 * - provider bytes are never trusted: size ceiling -> MIME sniff -> sharp
 *   decode -> dimension checks -> SHA-256 -> content-addressed storage;
 * - acceptance binds exact digests and routes EVERY output through the Run 5
 *   AssetService authority (ingest + assignment) — never a parallel system.
 */

/** Hard response ceiling for provider images (fail closed before decode). */
export const MAX_PROVIDER_IMAGE_BYTES = 24 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_DIMENSION = 8000;

/** Conservative authorized reservation per provider request (USD micros). */
const AUTHORIZED_RESERVATION_MICROS = 1_000_000; // $1.00 per request ceiling

/**
 * Verify mechanical slot requirements (P1-12):
 * Dimensions must meet minDimensions and aspect ratio must match within 5% tolerance.
 */
export function verifySlotDimensions(
  slot: VisualPlanSlot,
  width: number,
  height: number,
): void {
  if (width < slot.minDimensions.width || height < slot.minDimensions.height) {
    throw new FactoryError(
      "visual_acceptance_failed",
      `Image dimensions (${width}x${height}) do not meet slot minimum dimensions (${slot.minDimensions.width}x${slot.minDimensions.height}).`,
    );
  }
  const parts = slot.aspectRatio.split(":").map(Number);
  if (parts.length === 2 && parts[0]! > 0 && parts[1]! > 0) {
    const targetRatio = parts[0]! / parts[1]!;
    const actualRatio = width / height;
    const tolerance = 0.05;
    if (Math.abs(actualRatio - targetRatio) / targetRatio > tolerance) {
      throw new FactoryError(
        "visual_acceptance_failed",
        `Image aspect ratio (${actualRatio.toFixed(2)}) does not match slot target aspect ratio ${slot.aspectRatio} (${targetRatio.toFixed(2)}) within 5% tolerance.`,
      );
    }
  }
}

export interface VisualServiceDeps {
  store: VisualStore;
  designStore: DesignStore;
  assets: AssetService;
  budget: VisualBudgetStore;
  provider: VisualAssetProvider;
  repoRoot?: string;
  storage?: VisualCandidateStorage;
  dailyLimitUsd?: number;
  designService?: DesignService;
  followerTimeoutMs?: number;
  followerPollIntervalMs?: number;
}

export interface VisualSlotView {
  slot: string;
  pageSlug: string;
  role: string;
  requiredRole: string;
  requirement: string;
  truthClassProposal: VisualTruthClass;
  truthClassRationale: string;
  truthClass: VisualTruthClass | null;
  truthClassConfirmedAt: string | null;
  proposedStrategy: VisualResolutionMode;
  strategyReason: string;
  aspectRatio: string;
  minDimensions: { width: number; height: number };
  existingVersionId: string | null;
  existingBinaryDigest: string | null;
  existingGovernanceDigest: string | null;
  unresolvedReason: string;
  resolved: boolean;
  promptSnapshot: { id: string; digest: string; approvalState: string; operation: string } | null;
  candidates: Array<{
    id: string;
    candidateIndex: number;
    binaryDigest: string;
    mediaType: string;
    width: number;
    height: number;
    state: string;
    c2paStatus: string;
    parentLineage: Array<{ versionId: string; binaryDigest: string }>;
    requestId: string;
    providerMode: string;
    model: string;
  }>;
  acceptedResolution: {
    resolutionMode: string;
    truthClass: string;
    versionId: string;
    binaryDigest: string;
    governanceDigest: string;
    assetId: string;
    assignmentId: string | null;
    visualProviderConsumedSourceAsset?: boolean;
    visualProviderProducedAsset?: boolean;
    designProviderReferencedFinalAsset?: boolean;
    designProviderConsumedFinalAsset?: boolean;
  } | null;
}

export interface VisualWorkspaceReadModel {
  schemaVersion: typeof VISUAL_ASSETS_SCHEMA_VERSION;
  provider: { preflight: VisualAssetProviderPreflight; providerMode: string };
  plan: {
    id: string;
    version: number;
    planDigest: string;
    designArtifactId: string;
    designArtifactVersion: number;
    designCandidateDigest: string;
    designInputDigest: string;
    designProviderMode: string;
    createdAt: string;
    stale: boolean;
    staleReason: string | null;
  } | null;
  slots: VisualSlotView[];
  acceptedSet: {
    id: string;
    version: number;
    setDigest: string;
    providerMode: string;
    acceptedAt: string;
    slots: Array<{
      slot: string;
      pageSlug: string;
      role: string;
      versionId: string;
      resolutionMode: string;
      truthClass: string;
      /**
       * TRUE only when the provider actually received/consumed the exact
       * asset bytes for this slot. The production Stitch seam is text-only,
       * so this stays false there; Factory still binds the exact asset as
       * production authority. Never conflated with "bound".
       */
      providerConsumed: boolean;
      visualProviderConsumedSourceAsset: boolean;
      visualProviderProducedAsset: boolean;
      designProviderReferencedFinalAsset: boolean;
      designProviderConsumedFinalAsset: boolean;
    }>;
  } | null;
  budget: { accountedTodayMicros: number; activeReservationMicros: number };
  finalDesignPass?: {
    required: boolean;
    frozen: boolean;
    acceptedDesignVersion: number | null;
    designStalenessCode: string | null;
    /**
     * TRUE only when every bound asset slot of the accepted design was
     * actually consumed by the design provider; FALSE when the provider
     * (e.g. the text-only Stitch seam) never received the asset bytes;
     * null when no bound slots exist. UI/report claims about "actual
     * assets" MUST be gated on this, never assumed.
     */
    providerConsumed: boolean | null;
    visualProviderConsumedSourceAsset: boolean | null;
    visualProviderProducedAsset: boolean | null;
    designProviderReferencedFinalAsset: boolean | null;
    designProviderConsumedFinalAsset: boolean | null;
  };
}

export class VisualService {
  private readonly store: VisualStore;
  private readonly designStore: DesignStore;
  private readonly assets: AssetService;
  private readonly budget: VisualBudgetStore;
  private readonly provider: VisualAssetProvider;
  private readonly storage: VisualCandidateStorage | null;
  private readonly repoRoot: string | undefined;
  private readonly dailyLimitUsd: number | undefined;
  private readonly designService?: DesignService;
  private readonly inFlightGenerations = new Map<
    string,
    Promise<{ request: VisualGenerationRequestRecord; reused: boolean; candidates: VisualAssetCandidateRecord[] }>
  >();
  // P3-F4: preflight TTL cache — workspace reads must not issue provider
  // probes on every GET. Spend paths still fail closed on real request-time
  // provider failures (typed + classified), so a <=60s stale preflight read
  // never turns a failure into spend.
  private static readonly PREFLIGHT_TTL_MS = 60_000;
  private preflightCache: { at: number; value: VisualAssetProviderPreflight } | null = null;

  private readonly followerTimeoutMs: number;
  private readonly followerPollIntervalMs: number;

  constructor(deps: VisualServiceDeps) {
    this.store = deps.store;
    this.designStore = deps.designStore;
    this.assets = deps.assets;
    this.budget = deps.budget;
    this.provider = deps.provider;
    this.storage = deps.storage ?? null;
    this.repoRoot = deps.repoRoot;
    this.dailyLimitUsd = deps.dailyLimitUsd;
    this.designService = deps.designService;
    this.followerTimeoutMs = deps.followerTimeoutMs ?? 60_000;
    this.followerPollIntervalMs = deps.followerPollIntervalMs ?? 200;
  }

  /** Cached provider preflight (60s TTL; one provider call per TTL window). */
  private async cachedPreflight(): Promise<VisualAssetProviderPreflight> {
    if (this.preflightCache && Date.now() - this.preflightCache.at < VisualService.PREFLIGHT_TTL_MS) {
      return this.preflightCache.value;
    }
    const value = await this.provider.preflight();
    this.preflightCache = { at: Date.now(), value };
    return value;
  }

  static async create(deps: Omit<VisualServiceDeps, "storage">): Promise<VisualService> {
    const root = deps.repoRoot ?? (await resolveRepositoryRoot());
    return new VisualService({ ...deps, repoRoot: root, storage: createVisualCandidateStorage(root) });
  }

  private async storageOrThrow(): Promise<VisualCandidateStorage> {
    if (this.storage) return this.storage;
    const root = this.repoRoot ?? (await resolveRepositoryRoot());
    return createVisualCandidateStorage(root);
  }

  /**
   * P1-02: Structured transitive staleness enforcement.
   * RUN7_ASSET_ASSIGNMENTS_ADDED is the expected Run 7 cascade and is permitted.
   * All other upstream mutations (INPUT_CHANGED, CONTENT_CHANGED, ASSET_REMOVED_OR_CHANGED)
   * must fail closed.
   */
  assertDesignAuthorityEligible(design: {
    staleness: { code?: string | null; stale: boolean; reason: string | null };
  }): void {
    const allowed =
      design.staleness.code === "RUN7_ASSET_ASSIGNMENTS_ADDED" ||
      design.staleness.code === "RUN7_EXACT_ASSET_REPLACED";
    if (design.staleness.stale && !allowed) {
      throw new FactoryError(
        "visual_design_not_eligible",
        `The accepted design is stale versus current upstream authority (${design.staleness.code ?? "STALE"}): ${design.staleness.reason}. Re-derive and re-accept the design first.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Plan derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the visual asset plan from the CURRENT accepted design. Fails
   * closed when: no accepted design exists, the design is stale, or (for a
   * live provider path) the design is fixture-classified authority.
   */
  async derivePlan(input: { projectId: string }): Promise<VisualAssetPlanRecord> {
    const latest = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!latest) {
      throw new FactoryError("visual_design_not_eligible", "No accepted design artifact exists for this project; accept a design first.");
    }
    this.assertDesignAuthorityEligible(latest);
    const designData = latest.artifact.data as DesignCandidateData;
    if (designData.providerMode === "fixture" && this.provider.providerMode === "live") {
      throw new FactoryError(
        "visual_design_not_eligible",
        "The accepted design is fixture-classified authority (providerMode=fixture); it cannot drive live provider visual generation. Accept a live design or run the fixture visual path.",
      );
    }

    // Collect required slots from every archetype's assetSlots (page-exact).
    const slots: VisualPlanSlot[] = [];
    const seen = new Set<string>();
    for (const archetype of designData.archetypes) {
      for (const designSlot of archetype.assetSlots) {
        const key = `${designSlot.pageSlug}::${designSlot.role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bound = designSlot.boundAssetVersionId != null && designSlot.boundBinaryDigest != null;
        const proposal = proposeTruthClass(designSlot.requiredRole);
        const strategy = proposeResolutionStrategy({ hasBoundAsset: bound, truthClass: proposal.truthClass });
        slots.push({
          slot: designSlot.slot,
          pageSlug: designSlot.pageSlug,
          role: designSlot.role,
          requiredRole: designSlot.requiredRole,
          requirement: designSlot.requirement,
          truthClassProposal: proposal.truthClass,
          truthClassRationale: proposal.rationale,
          aspectRatio: designSlot.requiredRole === "hero" ? "16:9" : "3:2",
          minDimensions: designSlot.requiredRole === "hero" ? { width: 1200, height: 675 } : { width: 800, height: 533 },
          ...(bound
            ? {
                existingVersionId: designSlot.boundAssetVersionId,
                existingBinaryDigest: designSlot.boundBinaryDigest,
                existingGovernanceDigest: designSlot.boundGovernanceDigest,
              }
            : {}),
          proposedStrategy: strategy.strategy,
          unresolvedReason: strategy.reason.slice(0, 300),
        });
      }
    }
    if (slots.length === 0) {
      throw new FactoryError(
        "visual_design_not_eligible",
        "The accepted design declares no visual asset slots; nothing to resolve.",
      );
    }

    const data = parseVisualPlanData({
      schemaVersion: VISUAL_ASSETS_SCHEMA_VERSION,
      designArtifactId: latest.artifact.id,
      designArtifactVersion: latest.artifact.version,
      designCandidateDigest: latest.artifact.candidateDigest,
      designInputDigest: latest.artifact.inputDigest,
      designProviderMode: latest.artifact.providerMode as "live" | "fixture",
      slots,
    });
    const planDigest = deterministicDigest(data);
    // Idempotent: identical digest to the existing plan returns it.
    const existing = await this.store.findPlanByDigest(input.projectId, planDigest);
    if (existing) return existing;
    return await this.store.createPlan({ projectId: input.projectId, data });
  }

  /** Confirm the operator truth class for one slot (classification authority). */
  async confirmClassification(input: {
    projectId: string;
    planId: string;
    slot: string;
    truthClass: VisualTruthClass;
  }): Promise<void> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const data = this.store.planData(plan);
    const slot = data.slots.find((s) => s.slot === input.slot);
    if (!slot) {
      throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    }
    await this.store.confirmClassification({
      projectId: input.projectId,
      planId: plan.id,
      slot: input.slot,
      truthClass: input.truthClass,
    });
  }

  // -------------------------------------------------------------------------
  // Prompt snapshots (compile + approve)
  // -------------------------------------------------------------------------

  /**
   * Compile the immutable prompt snapshot for a slot. Deterministic from
   * confirmed authority; documentary ai_edit embeds the forbidden-edit list
   * verbatim. The snapshot starts pending — human approval is a separate
   * explicit action binding the exact digest.
   */
  async compilePromptSnapshot(input: {
    projectId: string;
    planId: string;
    slot: string;
    operation: "edit" | "generate";
    sourceVersionId?: string;
  }): Promise<VisualPromptSnapshotRecord> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const data = this.store.planData(plan);
    const slot = data.slots.find((s) => s.slot === input.slot);
    if (!slot) {
      throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    }
    const classification = await this.store.getClassification(plan.id, input.slot);
    if (!classification) {
      throw new FactoryError(
        "visual_classification_required",
        "Confirm the slot's truth classification before compiling a prompt snapshot.",
      );
    }
    const truthClass = classification.truthClass as VisualTruthClass;
    if (!isResolutionAllowed(truthClass, input.operation === "edit" ? "ai_edit" : "ai_generate")) {
      throw new FactoryError(
        "visual_truth_policy_violation",
        `Truth class "${truthClass}" does not allow ${input.operation === "edit" ? "ai_edit" : "ai_generate"} for slot ${input.slot}.`,
      );
    }

    // Source (parent) assets: exact approved versions with both digests.
    const sourceAssets: VisualPromptSnapshotData["sourceAssets"] = [];
    if (input.operation === "edit") {
      if (!input.sourceVersionId) {
        throw new FactoryError(
          "visual_truth_policy_violation",
          "AI edit requires an exact source AssetVersion (parent lineage is mandatory).",
        );
      }
      const version = await this.getApprovedVersionOrThrow(input.projectId, input.sourceVersionId);
      sourceAssets.push({
        versionId: version.id,
        binaryDigest: version.binaryDigest,
        governanceDigest: version.governanceDigest ?? "",
      });
    }

    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    const brandConstraints: string[] = [];
    if (design) {
      const designData = design.artifact.data as DesignCandidateData;
      brandConstraints.push(
        `Primary color ${designData.tokens.colors.primary}`,
        `Heading font ${designData.tokens.typography.headingFont}`,
        `Body font ${designData.tokens.typography.bodyFont}`,
      );
      if (designData.tokens.imageryTreatment) {
        brandConstraints.push(`Imagery treatment: ${designData.tokens.imageryTreatment}`);
      }
    }

    const forbiddenEdits =
      truthClass === "documentary" && input.operation === "edit" ? [...DOCUMENTARY_FORBIDDEN_EDITS] : [];
    const allowedEdits =
      input.operation === "edit"
        ? ["crop/composition", "resize", "light exposure adjustment", "restrained color balance", "denoise/sharpen", "format adaptation"]
        : [];

    const promptText = buildPromptText({
      operation: input.operation,
      slot: input.slot,
      requirement: slot.requirement,
      truthClass,
      aspectRatio: slot.aspectRatio,
      allowedEdits,
      forbiddenEdits,
      brandConstraints,
    });

    const snapshotData = parseVisualPromptSnapshotData({
      schemaVersion: VISUAL_ASSETS_SCHEMA_VERSION,
      promptPolicyVersion: FACTORY_VISUAL_PROMPT_POLICY_VERSION,
      projectId: input.projectId,
      designArtifactId: plan.designArtifactId,
      designArtifactVersion: plan.designArtifactVersion,
      designCandidateDigest: plan.designCandidateDigest,
      archetype: deriveArchetypeForSlot(design, input.slot),
      slot: input.slot,
      pageSlug: slot.pageSlug,
      role: slot.role,
      truthClass,
      visualRequirement: slot.requirement,
      brandConstraints,
      targetAspectRatio: slot.aspectRatio as VisualPromptSnapshotData["targetAspectRatio"],
      targetSize: "1K",
      allowedEdits,
      forbiddenEdits,
      operation: input.operation,
      sourceAssets,
      modelPolicyVersion: FACTORY_VISUAL_MODEL_POLICY_VERSION,
      promptText,
    });

    return await this.store.createPromptSnapshot({
      projectId: input.projectId,
      planId: plan.id,
      slot: input.slot,
      operation: input.operation,
      truthClass,
      data: snapshotData,
    });
  }

  /** Human approval gate: binds the exact prompt digest (row-locked). */
  async approvePromptSnapshot(input: {
    projectId: string;
    snapshotId: string;
    expectedPromptDigest: string;
  }): Promise<VisualPromptSnapshotRecord> {
    return await this.store.approvePromptSnapshot(input);
  }

  // -------------------------------------------------------------------------
  // Fail-before-spend preflight + generation (dedup)
  // -------------------------------------------------------------------------

  /**
   * The full §15 checklist. Every failure here is zero-spend by definition.
   * Returns the resolved model (default vs premium escalation).
   */
  private async preflightGeneration(input: {
    projectId: string;
    plan: VisualAssetPlanRecord;
    slot: VisualPlanSlot;
    truthClass: VisualTruthClass;
    mode: "ai_edit" | "ai_generate";
    snapshot: VisualPromptSnapshotRecord;
    sourceVersions: AssetVersionRow[];
    escalationReason: string | null;
  }): Promise<string> {
    // 1. Prompt snapshot must be APPROVED and its digest must match.
    if (input.snapshot.approvalState !== "approved") {
      throw new FactoryError(
        "visual_prompt_not_approved",
        "The exact prompt snapshot must be human-approved before any provider spend.",
      );
    }
    const snapshotData = this.store.promptSnapshotData(input.snapshot);
    if (deterministicDigest(snapshotData) !== input.snapshot.promptDigest) {
      throw new FactoryError("visual_prompt_not_approved", "Prompt snapshot digest mismatch (corrupt evidence).");
    }

    // 2. Truth policy gate (defense in depth; compile already gated).
    const mode: VisualResolutionMode = input.mode === "ai_edit" ? "ai_edit" : "ai_generate";
    if (!isResolutionAllowed(input.truthClass, mode)) {
      throw new FactoryError(
        "visual_truth_policy_violation",
        `Truth class "${input.truthClass}" forbids ${mode}.`,
      );
    }

    // 3. Parent assets: approved, rights-resolved, digests match bind time.
    if (input.mode === "ai_edit") {
      for (const version of input.sourceVersions) {
        if (version.approvalState !== "approved") {
          throw new FactoryError("visual_truth_policy_violation", "Source asset version is not approved.");
        }
        if (version.rightsStatus === "unknown") {
          throw new FactoryError("visual_truth_policy_violation", "Source asset version has unresolved rights.");
        }
        if (version.governanceDigest === null) {
          throw new FactoryError("visual_truth_policy_violation", "Source asset version has no governance digest.");
        }
        const snapshotSource = snapshotData.sourceAssets.find((s) => s.versionId === version.id);
        if (!snapshotSource || snapshotSource.binaryDigest !== version.binaryDigest) {
          throw new FactoryError(
            "visual_truth_policy_violation",
            "Source asset digests no longer match the approved prompt snapshot.",
          );
        }
      }
    }

    // 4. Provider configured (60s TTL cache; a real request-time provider
    // failure is still typed and classified — the cache never turns a
    // provider failure into spend).
    const preflight = await this.cachedPreflight();
    if (!preflight.configured) {
      throw new FactoryError("visual_provider_not_configured", preflight.reason);
    }

    // 5. Model allowed by policy (escalation requires a recorded reason).
    const model = input.escalationReason ? "gemini-3-pro-image" : VISUAL_DEFAULT_MODEL;

    // 6. Budget available (reservation created by the caller after dedup).
    return model;
  }

  /**
   * Run a generation/edit for one slot. Dedup: the request digest covers
   * slot + design digest + prompt digest + source digests + provider +
   * model + params; an identical prior request's candidates are reused
   * with NO second provider call.
   */
  async generateForSlot(input: {
    projectId: string;
    planId: string;
    slot: string;
    sourceVersionId?: string;
    escalationReason?: string | null;
  }): Promise<{ request: VisualGenerationRequestRecord; reused: boolean; candidates: VisualAssetCandidateRecord[] }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const data = this.store.planData(plan);
    const slot = data.slots.find((s) => s.slot === input.slot);
    if (!slot) {
      throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    }

    // Design currency re-check at execution time (fail before spend).
    // The identity check (same artifact id + version) is authoritative here:
    // an accepted design's staleness against CURRENT upstream is expected to
    // flip the moment Run 7 resolves a slot (new assignments exist), which
    // is the designed staleness cascade — not a reason to block generation.
    // Re-derivation of the DESIGN is the final-freeze step, not a gate for
    // resolving its own slots.
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    this.assertDesignAuthorityEligible(design);

    const classification = await this.store.getClassification(plan.id, input.slot);
    if (!classification) {
      throw new FactoryError(
        "visual_classification_required",
        "Confirm the slot's truth classification before generating.",
      );
    }
    const truthClass = classification.truthClass as VisualTruthClass;
    const mode: "ai_edit" | "ai_generate" = input.sourceVersionId ? "ai_edit" : "ai_generate";
    if (!isResolutionAllowed(truthClass, mode)) {
      throw new FactoryError(
        "visual_truth_policy_violation",
        `Truth class "${truthClass}" forbids ${mode === "ai_edit" ? "ai_edit" : "ai_generate"}.`,
      );
    }

    const snapshot = await this.store.latestPromptSnapshotForSlot(input.projectId, input.slot);
    const expectedOperation = mode === "ai_edit" ? "edit" : "generate";
    if (!snapshot || snapshot.operation !== expectedOperation) {
      throw new FactoryError(
        "visual_prompt_not_approved",
        `Compile a ${expectedOperation} prompt snapshot for this slot first.`,
      );
    }

    const sourceVersions: AssetVersionRow[] = [];
    if (mode === "ai_edit") {
      const version = await this.getApprovedVersionOrThrow(input.projectId, input.sourceVersionId!);
      sourceVersions.push(version);
    }

    const escalationReason = input.escalationReason ?? null;
    const model = await this.preflightGeneration({
      projectId: input.projectId,
      plan,
      slot,
      truthClass,
      mode,
      snapshot,
      sourceVersions,
      escalationReason,
    });

    const snapshotData = this.store.promptSnapshotData(snapshot);
    const requestDigest = visualRequestDigest({
      slot: input.slot,
      designCandidateDigest: plan.designCandidateDigest,
      promptDigest: snapshot.promptDigest,
      sourceAssets: snapshotData.sourceAssets,
      provider: this.provider.id,
      providerMode: this.provider.providerMode,
      model,
      operation: mode,
      targetAspectRatio: snapshotData.targetAspectRatio,
      targetSize: snapshotData.targetSize,
      escalationReason,
    });

    // Dedup: identical request -> reuse existing candidates, zero spend.
    const existing = await this.store.findRequestByDigest(input.projectId, requestDigest);
    if (existing && existing.resultState === "succeeded") {
      const candidates = await this.store.listCandidatesForRequest(existing.id);
      if (candidates.length > 0) {
        return { request: existing, reused: true, candidates };
      }
    }

    const inFlightKey = `${input.projectId}:${requestDigest}`;
    const inFlight = this.inFlightGenerations.get(inFlightKey);
    if (inFlight) {
      return inFlight;
    }

    // Budget reservation BEFORE any provider call (fail before spend).
    const reservation = await this.budget.reserveVisualBudget(
      {
        provider: this.provider.id,
        model,
        authorizedMicros: AUTHORIZED_RESERVATION_MICROS,
        invocationDigest: requestDigest,
        lineage: { projectId: input.projectId, slot: input.slot, mode },
      },
      this.dailyLimitUsd,
    );

    const { request, owner } = await this.store.createRequest({
      projectId: input.projectId,
      slot: input.slot,
      requestDigest,
      promptSnapshotId: snapshot.id,
      promptDigest: snapshot.promptDigest,
      provider: this.provider.id,
      providerMode: this.provider.providerMode,
      model,
      modelPolicyVersion: FACTORY_VISUAL_MODEL_POLICY_VERSION,
      operation: mode === "ai_edit" ? "edit" : "generate",
      escalationReason,
    });

    if (!owner) {
      await reservation.releaseUnexecuted().catch(() => undefined);
      const activeInFlight = this.inFlightGenerations.get(inFlightKey);
      if (activeInFlight) {
        return activeInFlight;
      }
      let current = request;
      const pollStart = Date.now();
      while (current.resultState === "running" && Date.now() - pollStart < this.followerTimeoutMs) {
        await new Promise((r) => setTimeout(r, this.followerPollIntervalMs));
        const found = await this.store.getRequest(input.projectId, current.id);
        if (found) current = found;
      }
      if (current.resultState === "succeeded") {
        const candidates = await this.store.listCandidatesForRequest(current.id);
        return { request: current, reused: true, candidates };
      }
      if (current.resultState === "failed") {
        throw new FactoryError(
          current.failureCode ?? "visual_generation_failed",
          "Concurrent generation request failed.",
        );
      }
      throw new FactoryError(
        "visual_generation_timeout",
        "Concurrent generation request timed out waiting for execution lease.",
      );
    }

    const executeLeader = async (): Promise<{
      request: VisualGenerationRequestRecord;
      reused: boolean;
      candidates: VisualAssetCandidateRecord[];
    }> => {
      try {
        const providerRequest: VisualProviderRequest = {
          provider: "google-genai",
          model,
          operation: mode === "ai_edit" ? "edit" : "generate",
          promptText: snapshotData.promptText,
          promptDigest: snapshot.promptDigest,
          requestDigest,
          promptSnapshotId: snapshot.id,
          targetAspectRatio: snapshotData.targetAspectRatio,
          targetSize: snapshotData.targetSize,
          sourceImages: await Promise.all(
            sourceVersions.map(async (version) => {
              const bytes = await this.assets.readOriginal(input.projectId, version.id);
              return {
                dataBase64: Buffer.from(bytes.bytes).toString("base64"),
                mediaType: bytes.mediaType,
                versionId: version.id,
              };
            }),
          ),
        };

        const result =
          mode === "ai_edit"
            ? await this.provider.editImage(providerRequest)
            : await this.provider.generateImage(providerRequest);

        const storage = await this.storageOrThrow();
        const persisted: VisualAssetCandidateRecord[] = [];
        for (const candidate of result.candidates) {
          const qa = await validateCandidateBytes(candidate.bytes, candidate.mediaType);
          const c2pa = await readC2paEvidence({ bytes: candidate.bytes, mediaType: qa.sniffedMediaType });
          const digest = await storage.putCandidate(qa.validatedBytes ?? candidate.bytes);
          const row = await this.store.createCandidate({
            projectId: input.projectId,
            requestId: request.id,
            slot: input.slot,
            candidateIndex: candidate.index,
            binaryDigest: digest,
            mediaType: qa.sniffedMediaType,
            width: qa.width,
            height: qa.height,
            byteSize: qa.byteSize,
            storageKey: storage.candidateKey(digest),
            parentLineage: sourceVersions.map((version) => ({
              versionId: version.id,
              binaryDigest: version.binaryDigest,
              governanceDigest: version.governanceDigest ?? "",
            })),
            promptDigest: snapshot.promptDigest,
            c2pa: c2pa as unknown as Record<string, unknown>,
            providerMetadata: result.providerUsage,
            qa: {
              sniffedMediaType: qa.sniffedMediaType,
              decoded: true,
              width: qa.width,
              height: qa.height,
              byteSize: qa.byteSize,
              withinLimits: true,
            } satisfies VisualCandidateQa as unknown as Record<string, unknown>,
          });
          persisted.push(row);
        }

        await reservation.account(null);
        const completed = await this.store.completeRequest({
          requestId: request.id,
          providerRequestRef: result.providerRequestRef,
          costMicros: null,
          rawMetadata: result.providerUsage,
        });
        return { request: completed ?? request, reused: false, candidates: persisted };
      } catch (error) {
        const code = error instanceof FactoryError ? error.code : "visual_provider_unavailable";
        const preSpend =
          code === "visual_budget_blocked" ||
          code === "visual_prompt_not_approved" ||
          code === "visual_truth_policy_violation" ||
          code === "visual_classification_required" ||
          code === "visual_plan_stale" ||
          code === "visual_design_not_eligible";
        if (preSpend) {
          await reservation.releaseUnexecuted().catch(() => undefined);
        } else {
          await reservation.account(null).catch(() => undefined);
        }
        await this.store
          .failRequest({ requestId: request.id, failureCode: code, rawMetadata: null })
          .catch(() => undefined);
        throw error;
      } finally {
        this.inFlightGenerations.delete(inFlightKey);
      }
    };

    const promise = executeLeader();
    this.inFlightGenerations.set(inFlightKey, promise);
    return await promise;
  }

  // -------------------------------------------------------------------------
  // Reuse / deterministic transform (zero provider spend)
  // -------------------------------------------------------------------------

  /** Resolve a slot by reusing the existing bound approved asset (Priority 1). */
  async resolveReuse(input: {
    projectId: string;
    planId: string;
    slot: string;
    versionId?: string;
  }): Promise<{ version: AssetVersionRow; asset: AssetRow; assignmentId: string }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    this.assertDesignAuthorityEligible(design);

    const data = this.store.planData(plan);
    const slot = data.slots.find((s) => s.slot === input.slot);
    if (!slot) throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    const classification = await this.store.getClassification(plan.id, input.slot);
    if (!classification) {
      throw new FactoryError("visual_classification_required", "Confirm the truth classification before resolving.");
    }
    if (!isResolutionAllowed(classification.truthClass as VisualTruthClass, "reuse_real")) {
      throw new FactoryError("visual_truth_policy_violation", "reuse_real is not allowed for this truth class.");
    }
    const versionId = input.versionId ?? slot.existingVersionId;
    if (!versionId) {
      throw new FactoryError(
        "visual_not_found",
        "No bound asset version exists for this slot; supply an exact versionId of an approved asset.",
      );
    }
    const version = await this.getApprovedVersionOrThrow(input.projectId, versionId);
    const asset = await this.getAssetForVersion(input.projectId, version);

    // Mechanical slot requirements (P1-12)
    const original = await this.assets.readOriginal(input.projectId, version.id);
    const meta = await sharp(Buffer.from(original.bytes), { failOn: "error" }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    verifySlotDimensions(slot, width, height);

    // Assign to Run 5 pageSlug & role (P1-04). An occupied slot moves
    // through the explicit cross-asset CAS: the exact old authority
    // (assetId + versionId + governance digest) is echoed into the
    // transaction, so authorization is proven against exact digests —
    // never inferred from the slot's mere existence.
    let assignmentId: string;
    const existing = await this.findAssignment(input.projectId, slot.pageSlug, slot.role);
    if (existing && existing.versionId === version.id) {
      assignmentId = existing.id;
    } else if (existing) {
      const replaced = await this.assets.casReplaceAssignment(input.projectId, existing.id, {
        expectedCurrentAssetId: existing.assetId,
        expectedCurrentVersionId: existing.versionId,
        expectedCurrentGovernanceDigest: existing.versionDigest,
        toAssetId: asset.id,
        toVersionId: version.id,
        expectedTargetBinaryDigest: version.binaryDigest,
      });
      assignmentId = replaced.id;
    } else {
      const page = (await this.assets.workspace(input.projectId)).acceptedPages.find(p => p.slug === slot.pageSlug);
      if (!page || !version.governanceDigest) throw new FactoryError("visual_acceptance_failed", "Current accepted page/asset authority is missing.");
      const created = await this.assets.assignVersion(input.projectId, {
        acceptedPageContentId: page.id,
        acceptedPageContentVersion: page.version,
        acceptedPageContentDigest: page.contentDigest,
        expectedGovernanceDigest: version.governanceDigest,
        assetId: asset.id,
        versionId: version.id,
        pageSlug: slot.pageSlug,
        role: slot.role,
        expectedBinaryDigest: version.binaryDigest,
      });
      assignmentId = created.id;
    }

    await this.store.recordSlotResolution({
      projectId: input.projectId,
      planId: plan.id,
      slot: slot.slot,
      pageSlug: slot.pageSlug,
      role: slot.role,
      fromAssetId: existing?.assetId ?? null,
      fromVersionId: existing?.versionId ?? null,
      fromBinaryDigest: existing?.binaryDigest ?? null,
      fromGovernanceDigest: existing?.versionDigest ?? null,
      toAssetId: asset.id,
      toVersionId: version.id,
      toBinaryDigest: version.binaryDigest,
      toGovernanceDigest: version.governanceDigest!,
      resolutionMode: "reuse_real",
      visualProviderConsumedSourceAsset: false,
      visualProviderProducedAsset: false,
    });

    return { version, asset, assignmentId };
  }

  /**
   * Resolve a slot via a deterministic sharp transform of an approved
   * parent (Priority 2). NO AI call: deterministic ops never spend a model.
   * The output is ingested through the Run 5 authority as a derived version
   * with exact parent lineage.
   */
  async resolveDeterministicTransform(input: {
    projectId: string;
    planId: string;
    slot: string;
    sourceVersionId: string;
    transform: {
      maxWidth?: number;
      aspectRatioCrop?: "16:9" | "3:2" | "4:3" | "1:1";
      grayscale?: boolean;
      brightness?: number;
    };
  }): Promise<{ version: AssetVersionRow; asset: AssetRow; derivation: AssetDerivation; assignmentId: string }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    this.assertDesignAuthorityEligible(design);

    const data = this.store.planData(plan);
    const slot = data.slots.find((s) => s.slot === input.slot);
    if (!slot) throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    const classification = await this.store.getClassification(plan.id, input.slot);
    if (!classification) {
      throw new FactoryError("visual_classification_required", "Confirm the truth classification before resolving.");
    }
    if (!isResolutionAllowed(classification.truthClass as VisualTruthClass, "deterministic_transform")) {
      throw new FactoryError(
        "visual_truth_policy_violation",
        "deterministic_transform is not allowed for this truth class.",
      );
    }
    const parent = await this.getApprovedVersionOrThrow(input.projectId, input.sourceVersionId);
    const parentAsset = await this.getAssetForVersion(input.projectId, parent);
    const parentBytes = await this.assets.readOriginal(input.projectId, parent.id);

    // Bounded deterministic ops (sharp; never upscaled).
    let pipeline = sharp(Buffer.from(parentBytes.bytes), { failOn: "error" }).rotate();
    if (input.transform.aspectRatioCrop) {
      const meta = await pipeline.metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      const [rw, rh] = input.transform.aspectRatioCrop.split(":").map(Number) as [number, number];
      const targetRatio = rw / rh;
      const currentRatio = width / height;
      let cropWidth = width;
      let cropHeight = height;
      if (currentRatio > targetRatio) cropWidth = Math.round(height * targetRatio);
      else cropHeight = Math.round(width / targetRatio);
      pipeline = pipeline.extract({
        left: Math.floor((width - cropWidth) / 2),
        top: Math.floor((height - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      });
    }
    if (input.transform.maxWidth) {
      pipeline = pipeline.resize({ width: Math.min(input.transform.maxWidth, 8000), withoutEnlargement: true });
    }
    if (input.transform.grayscale) pipeline = pipeline.grayscale();
    if (input.transform.brightness != null) {
      pipeline = pipeline.modulate({ brightness: Math.min(Math.max(input.transform.brightness, 0.5), 1.5) });
    }
    const outBuffer = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    const outMeta = await sharp(outBuffer).metadata();
    const outWidth = outMeta.width ?? 0;
    const outHeight = outMeta.height ?? 0;
    verifySlotDimensions(slot, outWidth, outHeight);

    const outBytes = new Uint8Array(outBuffer);
    if (outBytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
      throw new FactoryError("visual_provider_output_invalid", "Transformed image exceeds the byte ceiling.");
    }

    const derivation: AssetDerivation = {
      origin: "deterministic_transform",
      parentVersionId: parent.id,
      parentBinaryDigest: parent.binaryDigest,
      parentGovernanceDigest: parent.governanceDigest ?? "",
      transformation: describeTransform(input.transform),
      visualSlot: input.slot,
      visualTruthClass: classification.truthClass,
    };
    const provenance: AssetProvenance = {
      category: "derived",
      originalFilename: `derived-${input.slot}-${parent.binaryDigest.slice(0, 12)}.jpg`,
      uploadedAt: new Date().toISOString(),
      derivation,
    };
    const outDigest = sha256(outBytes);
    const { asset, version, boundExisting } = await this.ingestOrBindExisting({
      projectId: input.projectId,
      bytes: outBytes,
      digest: outDigest,
      provenance,
      ingest: () => this.ingestDerivedVersion({
        projectId: input.projectId,
        parentAsset: parentAsset,
        parentVersion: parent,
        bytes: outBytes,
        provenance,
      }),
    });

    const approved = boundExisting ? version : await this.assets.approveVersion(input.projectId, version.id, version.binaryDigest);

    let assignmentId: string;
    const existing = await this.findAssignment(input.projectId, slot.pageSlug, slot.role);
    if (existing && existing.versionId === approved.id) {
      assignmentId = existing.id;
    } else if (existing) {
      // Cross-asset CAS with the exact old authority echoed (see
      // resolveReuse): a deterministic-transform output may belong to a
      // different logical asset than the slot's previous binding.
      const replaced = await this.assets.casReplaceAssignment(input.projectId, existing.id, {
        expectedCurrentAssetId: existing.assetId,
        expectedCurrentVersionId: existing.versionId,
        expectedCurrentGovernanceDigest: existing.versionDigest,
        toAssetId: asset.id,
        toVersionId: approved.id,
        expectedTargetBinaryDigest: approved.binaryDigest,
      });
      assignmentId = replaced.id;
    } else {
      const page = (await this.assets.workspace(input.projectId)).acceptedPages.find(p => p.slug === slot.pageSlug);
      if (!page || !approved.governanceDigest) throw new FactoryError("visual_acceptance_failed", "Current accepted page/asset authority is missing.");
      const created = await this.assets.assignVersion(input.projectId, {
        acceptedPageContentId: page.id,
        acceptedPageContentVersion: page.version,
        acceptedPageContentDigest: page.contentDigest,
        expectedGovernanceDigest: approved.governanceDigest,
        assetId: asset.id,
        versionId: approved.id,
        pageSlug: slot.pageSlug,
        role: slot.role,
        expectedBinaryDigest: approved.binaryDigest,
      });
      assignmentId = created.id;
    }

    await this.store.recordSlotResolution({
      projectId: input.projectId,
      planId: plan.id,
      slot: slot.slot,
      pageSlug: slot.pageSlug,
      role: slot.role,
      fromAssetId: existing?.assetId ?? null,
      fromVersionId: existing?.versionId ?? null,
      fromBinaryDigest: existing?.binaryDigest ?? null,
      fromGovernanceDigest: existing?.versionDigest ?? null,
      toAssetId: asset.id,
      toVersionId: approved.id,
      toBinaryDigest: approved.binaryDigest,
      toGovernanceDigest: approved.governanceDigest!,
      resolutionMode: "deterministic_transform",
      visualProviderConsumedSourceAsset: false,
      visualProviderProducedAsset: false,
    });

    return { version: approved, asset, derivation, assignmentId };
  }

  /**
   * Accept a provider candidate for a slot: binds exact digests, ingests
   * the candidate bytes into the Run 5 authority as a derived/generated
   * AssetVersion, and creates/updates the Run 5 page assignment.
   * Documentary ai_edit acceptance downgrades the recorded truth class to
   * documentary_edited (explicit operator confirmation required).
   */
  async acceptCandidate(input: {
    projectId: string;
    planId: string;
    slot: string;
    candidateId: string;
    expectedBinaryDigest: string;
    confirmTruthDowngrade?: boolean;
  }): Promise<{ version: AssetVersionRow; asset: AssetRow; assignmentId: string | null; truthClass: VisualTruthClass; resolutionMode: VisualResolutionMode; boundExisting: boolean }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    this.assertDesignAuthorityEligible(design);

    const candidate = await this.store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw new FactoryError("visual_not_found", "Candidate not found for this project.");
    if (candidate.slot !== input.slot) {
      throw new FactoryError("visual_acceptance_failed", "Candidate belongs to a different slot.");
    }
    const planData = this.store.planData(plan);
    const planSlot = planData.slots.find((s) => s.slot === input.slot);
    if (!planSlot) {
      throw new FactoryError("visual_not_found", `Slot "${input.slot}" is not part of this plan.`);
    }
    verifySlotDimensions(planSlot, candidate.width, candidate.height);
    if (candidate.binaryDigest !== input.expectedBinaryDigest) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "Candidate digest mismatch: the candidate changed between review and acceptance.",
      );
    }
    const request = await this.store.getRequest(input.projectId, candidate.requestId);
    if (!request) throw new FactoryError("visual_not_found", "Generation request not found.");
    if (request.providerMode === "fixture" && this.provider.providerMode === "live") {
      throw new FactoryError(
        "visual_acceptance_failed",
        "Fixture visual candidates cannot be accepted as production authority through a live provider path.",
      );
    }
    const classification = await this.store.getClassification(plan.id, input.slot);
    if (!classification) {
      throw new FactoryError("visual_classification_required", "Truth classification missing at acceptance time.");
    }
    let truthClass = classification.truthClass as VisualTruthClass;
    const mode: VisualResolutionMode = request.operation === "edit" ? "ai_edit" : "ai_generate";

    // Documentary AI-edit downgrade: ai_edit on documentary truth can no
    // longer retain plain documentary semantics — record documentary_edited
    // with explicit operator confirmation.
    if (truthClass === "documentary" && mode === "ai_edit") {
      if (!input.confirmTruthDowngrade) {
        throw new FactoryError(
          "visual_truth_policy_violation",
          "Accepting an AI edit of documentary imagery reclassifies it as documentary_edited (no longer plain evidence). Confirm the downgrade explicitly.",
        );
      }
      truthClass = "documentary_edited";
    }

    // Read the exact candidate bytes (content-addressed storage).
    const storage = await this.storageOrThrow();
    const bytes = await storage.getCandidate(candidate.storageKey);
    const reDigest = sha256(bytes);
    if (reDigest !== candidate.binaryDigest) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "Stored candidate bytes no longer match their digest (storage divergence); fail closed.",
      );
    }

    const derivation: AssetDerivation = {
      origin: mode === "ai_edit" ? "ai_edit" : "ai_generate",
      parentVersionId: candidateParentVersionId(candidate),
      parentBinaryDigest: candidateParentBinaryDigest(candidate) ?? "",
      parentGovernanceDigest: candidateParentGovernanceDigest(candidate) ?? "",
      provider: request.provider,
      model: request.model,
      promptSnapshotId: request.promptSnapshotId,
      generationRequestId: request.id,
      visualSlot: input.slot,
      visualTruthClass: truthClass,
    };
    const provenance: AssetProvenance = {
      category: mode === "ai_generate" ? "generated" : "derived",
      originalFilename: `visual-${input.slot}-${candidate.binaryDigest.slice(0, 12)}.${candidate.mediaType === "image/png" ? "png" : "jpg"}`,
      uploadedAt: new Date().toISOString(),
      derivation,
    };
    // For ai_generate there is no Run 5 parent asset; synthesize a logical
    // asset identity via the Run 5 upload path instead of hand-inserting.
    // P2-F2: byte-identical output from a different request binds to the
    // existing approved version instead of failing after the spend.
    let asset: AssetRow;
    let version: AssetVersionRow;
    let boundExisting = false;
    if (mode === "ai_generate") {
      const bound = await this.ingestOrBindExisting({
        projectId: input.projectId,
        bytes,
        digest: candidate.binaryDigest,
        provenance,
        ingest: async () => {
          const ingest = await this.assets.uploadAsset(input.projectId, {
            dataBase64: Buffer.from(bytes).toString("base64"),
            filename: `visual-${input.slot}.png`,
            kind: "photo",
            title: `Visual ${input.slot} (${candidate.binaryDigest.slice(0, 12)})`,
            rightsStatus: "operator_owned",
            rightsNote: `AI-generated via ${request.provider}/${request.model}; prompt snapshot ${request.promptSnapshotId}`,
            altIntent: `AI-generated imagery for slot ${input.slot}`,
          });
          // Record exact derivation lineage on the pending version (Run 7 seam).
          await this.assets.recordDerivationProvenance(input.projectId, ingest.version.id, {
            expectedBinaryDigest: ingest.version.binaryDigest,
            provenance,
          });
          return ingest;
        },
      });
      asset = bound.asset;
      version = bound.version;
      boundExisting = bound.boundExisting;
    } else {
      // AI edit: ingest as a derived version of the exact parent asset.
      const parent = await this.getApprovedVersionOrThrow(input.projectId, derivation.parentVersionId);
      const parentAsset = await this.getAssetForVersion(input.projectId, parent);
      const bound = await this.ingestOrBindExisting({
        projectId: input.projectId,
        bytes,
        digest: candidate.binaryDigest,
        provenance,
        ingest: () => this.ingestDerivedVersion({
          projectId: input.projectId,
          parentAsset,
          parentVersion: parent,
          bytes,
          provenance,
        }),
      });
      asset = bound.asset;
      version = bound.version;
      boundExisting = bound.boundExisting;
    }

    // Approve the new version through the Run 5 authority (binds digests).
    // A bound existing version is already approved; re-approval is skipped.
    const approved = boundExisting ? version : await this.assets.approveVersion(input.projectId, version.id, version.binaryDigest);

    // Create/replace the Run 5 page assignment through AssetService.
    // P2-F2: when binding to an existing approved version that the
    // assignment already points at, replacement would be a Run 5 no-op
    // conflict — the assignment is already exactly right, so reuse it.
    // Occupied slots move through the explicit cross-asset CAS with the
    // exact old authority echoed (same rule as resolveReuse).
    let assignmentId: string | null = null;
    const existing = await this.findAssignment(input.projectId, planSlot.pageSlug, planSlot.role);
    if (existing && existing.versionId === approved.id) {
      assignmentId = existing.id;
    } else if (existing) {
      const replaced = await this.assets.casReplaceAssignment(input.projectId, existing.id, {
        expectedCurrentAssetId: existing.assetId,
        expectedCurrentVersionId: existing.versionId,
        expectedCurrentGovernanceDigest: existing.versionDigest,
        toAssetId: asset.id,
        toVersionId: approved.id,
        expectedTargetBinaryDigest: approved.binaryDigest,
      });
      assignmentId = replaced.id;
    } else {
      const page = (await this.assets.workspace(input.projectId)).acceptedPages.find(p => p.slug === planSlot.pageSlug);
      if (!page || !approved.governanceDigest) throw new FactoryError("visual_acceptance_failed", "Current accepted page/asset authority is missing.");
      const created = await this.assets.assignVersion(input.projectId, {
        acceptedPageContentId: page.id, acceptedPageContentVersion: page.version,
        acceptedPageContentDigest: page.contentDigest, expectedGovernanceDigest: approved.governanceDigest,
        assetId: asset.id,
        versionId: approved.id,
        pageSlug: planSlot.pageSlug,
        role: planSlot.role,
        expectedBinaryDigest: approved.binaryDigest,
      });
      assignmentId = created.id;
    }

    // Mark the candidate selected (siblings rejected).
    await this.store.selectCandidate(input.projectId, candidate.id);
    // Persist the (possibly downgraded) truth classification.
    await this.store.confirmClassification({
      projectId: input.projectId,
      planId: plan.id,
      slot: input.slot,
      truthClass,
    });

    await this.store.recordSlotResolution({
      projectId: input.projectId,
      planId: plan.id,
      slot: input.slot,
      pageSlug: planSlot.pageSlug,
      role: planSlot.role,
      fromAssetId: existing?.assetId ?? null,
      fromVersionId: existing?.versionId ?? null,
      fromBinaryDigest: existing?.binaryDigest ?? null,
      fromGovernanceDigest: existing?.versionDigest ?? null,
      toAssetId: asset.id,
      toVersionId: approved.id,
      toBinaryDigest: approved.binaryDigest,
      toGovernanceDigest: approved.governanceDigest!,
      resolutionMode: mode,
      visualProviderConsumedSourceAsset: mode === "ai_edit",
      visualProviderProducedAsset: true,
      promptSnapshotId: request.promptSnapshotId,
      generationRequestId: request.id,
      candidateId: candidate.id,
    });

    return { version: approved, asset, assignmentId, truthClass, resolutionMode: mode, boundExisting };
  }

  /** Accept the full set: every plan slot must be resolved (Run 5 assignment). */
  async acceptSet(input: { projectId: string; planId: string }): Promise<AcceptedVisualAssetSetRecord> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    this.assertDesignAuthorityEligible(design);

    const data = this.store.planData(plan);

    // Every slot must have a resolved Run 5 assignment binding an approved
    // version (the acceptance path above creates them).
    const assignments = await this.listAssignments(input.projectId);
    const slotRows: Array<{
      slot: string;
      pageSlug: string;
      role: string;
      resolvedVersionId: string;
      binaryDigest: string;
      governanceDigest: string;
      resolutionMode: string;
      truthClass: VisualTruthClass;
      visualProviderConsumedSourceAsset?: boolean;
      visualProviderProducedAsset?: boolean;
      promptSnapshotId: string | null;
      generationRequestId: string | null;
      candidateId: string | null;
    }> = [];
    for (const slot of data.slots) {
      const classification = await this.store.getClassification(plan.id, slot.slot);
      if (!classification) {
        throw new FactoryError("visual_classification_required", `Slot ${slot.slot} has no confirmed classification.`);
      }
      const assignment = assignments.find((a) => a.pageSlug === slot.pageSlug && a.role === slot.role);
      if (!assignment) {
        throw new FactoryError(
          "visual_slot_unresolved",
          `Slot ${slot.slot} (${slot.pageSlug}/${slot.role}) has no accepted resolution; accept every slot before accepting the set.`,
        );
      }
      // Exact durable slot resolution authority (P1-01 / P1-02).
      // Reading directly by (planId, slot) guarantees zero cross-plan candidate leakage.
      const resolution = await this.store.getSlotResolution(plan.id, slot.slot);
      if (!resolution) {
        throw new FactoryError(
          "visual_slot_unresolved",
          `Slot ${slot.slot} (${slot.pageSlug}/${slot.role}) has no durable resolution record for plan ${plan.id}; resolve the slot before accepting the set.`,
        );
      }
      if (
        assignment.versionId !== resolution.toVersionId ||
        assignment.binaryDigest !== resolution.toBinaryDigest ||
        assignment.versionDigest !== resolution.toGovernanceDigest
      ) {
        throw new FactoryError(
          "visual_slot_resolution_conflict",
          `Slot ${slot.slot} assignment (${assignment.versionId}) conflicts with recorded plan resolution (${resolution.toVersionId}).`,
        );
      }
      slotRows.push({
        slot: slot.slot,
        pageSlug: assignment.pageSlug,
        role: assignment.role,
        resolvedVersionId: resolution.toVersionId,
        binaryDigest: resolution.toBinaryDigest,
        governanceDigest: resolution.toGovernanceDigest,
        resolutionMode: resolution.resolutionMode,
        truthClass: classification.truthClass as VisualTruthClass,
        visualProviderConsumedSourceAsset: resolution.visualProviderConsumedSourceAsset,
        visualProviderProducedAsset: resolution.visualProviderProducedAsset,
        promptSnapshotId: resolution.promptSnapshotId ?? null,
        generationRequestId: resolution.generationRequestId ?? null,
        candidateId: resolution.candidateId ?? null,
      });
    }

    const setDigest = visualSetDigest(slotRows);
    // Idempotent: identical digest returns the existing set.
    const existing = await this.store.findSetByDigest(input.projectId, setDigest);
    if (existing) {
      return existing;
    }

    // Atomic transaction for set + all slot rows (P1-06) with providerMode (P1-03)
    return await this.store.createAcceptedSetAtomic({
      projectId: input.projectId,
      planId: plan.id,
      providerMode: this.provider.providerMode,
      designArtifactId: plan.designArtifactId,
      designArtifactVersion: plan.designArtifactVersion,
      designCandidateDigest: plan.designCandidateDigest,
      designInputDigest: plan.designInputDigest,
      setDigest,
      slots: slotRows,
    });
  }

  /**
   * Final Design Pass (P1-01): After all visual asset slots are resolved and the
   * visual asset set is accepted, re-derive the design input snapshot (which
   * now binds the newly resolved and approved real/generated assets from Run 5),
   * invoke the DesignProvider to generate a new candidate ready for final
   * review and freeze.
   *
   * Truthful consumption semantics (§5): the LIVE Stitch seam is text-only —
   * it cannot ingest the actual Run 5 image bytes. The final pass therefore
   * re-derives design authority against the EXACT final asset lineage
   * (assetRefs with version/binary/governance digests); it does NOT claim
   * provider consumption of those bytes. `providerConsumed` stays false for
   * slots the provider never actually received.
   *
   * Final-freeze pre-checks (fail closed, zero provider spend on failure):
   * - an accepted visual asset set exists;
   * - the set belongs to the CURRENT accepted design lineage (exact
   *   designArtifactId/version/candidateDigest binding, never "latest");
   * - every accepted set slot row exactly matches the current Run 5
   *   assignment (versionId + binaryDigest + governanceDigest);
   * - design staleness is ONLY an expected Run 7 transition.
   */
  async runFinalDesignPass(input: { projectId: string }): Promise<DesignCandidateView> {
    const acceptedSet = await this.store.latestAcceptedSet(input.projectId);
    if (!acceptedSet) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "An accepted visual asset set is required before running the final design pass.",
      );
    }
    if (this.provider.providerMode === "live" && acceptedSet.providerMode !== "live") {
      throw new FactoryError(
        "visual_acceptance_failed",
        "Test fixture visual set cannot be used for a live final design pass.",
      );
    }
    const latestDesign = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!latestDesign) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "An accepted design artifact is required before running the final design pass.",
      );
    }
    if (!latestDesign.staleness.stale) {
      throw new FactoryError(
        "visual_acceptance_failed",
        `Final design is already frozen and up to date (version ${latestDesign.artifact.version}). No final design pass is needed.`,
      );
    }
    if (
      latestDesign.staleness.code !== "RUN7_ASSET_ASSIGNMENTS_ADDED" &&
      latestDesign.staleness.code !== "RUN7_EXACT_ASSET_REPLACED"
    ) {
      throw new FactoryError(
        "visual_design_not_eligible",
        `Final design pass is only permitted for Run 7 asset resolution staleness, but design has upstream staleness (${latestDesign.staleness.code ?? "UNKNOWN"}): ${latestDesign.staleness.reason}. Fix upstream authority first.`,
      );
    }
    // Set lineage: the accepted set must belong to the exact accepted design
    // authority (not merely the "latest" set of the project).
    if (
      acceptedSet.designArtifactId !== latestDesign.artifact.id ||
      acceptedSet.designArtifactVersion !== latestDesign.artifact.version ||
      acceptedSet.designCandidateDigest !== latestDesign.artifact.candidateDigest
    ) {
      throw new FactoryError(
        "visual_acceptance_failed",
        `The accepted visual asset set (v${acceptedSet.version}) does not belong to the current accepted design (v${latestDesign.artifact.version}); re-resolve the visual slots against the current design.`,
      );
    }
    // Every accepted slot must exactly match the CURRENT Run 5 assignment.
    await this.assertSetMatchesAssignments(input.projectId, acceptedSet.id);
    if (!this.designService) {
      throw new FactoryError("visual_not_configured", "DesignService dependency not provided to VisualService.");
    }
    await this.designService.deriveInputSnapshotDraft(input.projectId);
    return await this.designService.generateCandidate({ projectId: input.projectId });
  }

  /**
   * Accept the final design pass candidate to freeze design authority into
   * AcceptedDesignArtifact v2 (UP_TO_DATE, referencing the final visual assets).
   *
   * Mandatory TOCTOU recheck (state may change between generation and human
   * acceptance): at acceptance time this re-proves that
   *   candidate input snapshot == current accepted input/content authority
   *   AND candidate assetRefs == current assignments
   *   AND current assignments == accepted visual set exact slot rows.
   * The first two are enforced by the design store's acceptance transaction
   * (it recomputes the bound snapshot's full upstream staleness under row
   * lock and fails closed). The third is the visual-set equality check here.
   * Any mismatch fails closed — the operator re-runs the final pass.
   */
  async acceptFinalDesign(input: {
    projectId: string;
    candidateId: string;
    expectedCandidateDigest: string;
    reviewNotes?: string | null;
  }): Promise<AcceptedDesignView> {
    const acceptedSet = await this.store.latestAcceptedSet(input.projectId);
    if (!acceptedSet) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "An accepted visual asset set is required before accepting final design.",
      );
    }
    await this.assertSetMatchesAssignments(input.projectId, acceptedSet.id);
    if (!this.designService) {
      throw new FactoryError("visual_not_configured", "DesignService dependency not provided to VisualService.");
    }
    return await this.designService.acceptCandidate(input);
  }

  /**
   * Final exact reconciliation: for every AcceptedVisualAssetSet slot row,
   * the CURRENT Run 5 assignment for the same (pageSlug, role) must bind
   * the EXACT same versionId, binaryDigest and governanceDigest. Any drift
   * (assignment replaced/re-bound after set acceptance) fails closed.
   */
  private async assertSetMatchesAssignments(projectId: string, setId: string): Promise<void> {
    const slotRows = await this.store.listAcceptedSlots(setId);
    if (slotRows.length === 0) {
      throw new FactoryError(
        "visual_acceptance_failed",
        "The accepted visual asset set contains no slot rows; re-accept the visual set.",
      );
    }
    const assignments = await this.listAssignments(projectId);
    for (const slotRow of slotRows) {
      const assignment = assignments.find(
        (a) => a.pageSlug === slotRow.pageSlug && a.role === slotRow.role,
      );
      if (!assignment) {
        throw new FactoryError(
          "visual_acceptance_failed",
          `Visual slot ${slotRow.slot} (${slotRow.pageSlug}/${slotRow.role}) has no current Run 5 assignment; the final design cannot freeze against a missing authority.`,
        );
      }
      if (
        assignment.versionId !== slotRow.resolvedVersionId ||
        assignment.binaryDigest !== slotRow.binaryDigest ||
        assignment.versionDigest !== slotRow.governanceDigest
      ) {
        throw new FactoryError(
          "visual_acceptance_failed",
          `Visual slot ${slotRow.slot} (${slotRow.pageSlug}/${slotRow.role}) no longer matches the accepted visual asset set (assignment authority drifted after set acceptance); re-resolve and re-accept the set.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Workspace read model
  // -------------------------------------------------------------------------

  async workspace(projectId: string): Promise<VisualWorkspaceReadModel> {
    const preflight = await this.cachedPreflight();
    const plan = await this.store.latestPlan(projectId);
    const acceptedSet = await this.store.latestAcceptedSet(projectId);
    const acceptedSlots = acceptedSet ? await this.store.listAcceptedSlots(acceptedSet.id) : [];
    const budgetSummary = await this.budget.getVisualBudgetSummary();

    let stale = false;
    let staleReason: string | null = null;
    if (plan) {
      const design = await this.designStore.latestAcceptedDesign(projectId);
      if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
        stale = true;
        staleReason = "The accepted design changed since this plan was derived.";
      } else if (
        design.staleness.stale &&
        design.staleness.code !== "RUN7_ASSET_ASSIGNMENTS_ADDED" &&
        design.staleness.code !== "RUN7_EXACT_ASSET_REPLACED"
      ) {
        stale = true;
        staleReason = design.staleness.reason;
      }
    }

    const planResolutions = plan ? await this.store.listSlotResolutions(plan.id) : [];
    const resolutionMap = new Map(planResolutions.map((r) => [r.slot, r]));

    const slots: VisualSlotView[] = plan
      ? await Promise.all(
          this.store.planData(plan).slots.map(async (slot) => {
            const classification = await this.store.getClassification(plan.id, slot.slot);
            const snapshot = await this.store.latestPromptSnapshotForSlot(projectId, slot.slot);
            const candidates = await this.store.listCandidatesForSlot(projectId, slot.slot);
            const candidatesWithRequests = await Promise.all(
              candidates.map(async (candidate) => {
                const request = await this.store.getRequest(projectId, candidate.requestId);
                const c2pa = candidate.c2pa as VisualCandidateC2pa;
                return {
                  id: candidate.id,
                  candidateIndex: candidate.candidateIndex,
                  binaryDigest: candidate.binaryDigest,
                  mediaType: candidate.mediaType,
                  width: candidate.width,
                  height: candidate.height,
                  state: candidate.state,
                  c2paStatus: c2pa.status,
                  parentLineage: (candidate.parentLineage as Array<{ versionId: string; binaryDigest: string }>).map(
                    (p) => ({ versionId: p.versionId, binaryDigest: p.binaryDigest }),
                  ),
                  requestId: candidate.requestId,
                  providerMode: request?.providerMode ?? "unknown",
                  model: request?.model ?? "unknown",
                };
              }),
            );
            const assignment = (await this.listAssignments(projectId)).find(
              (a) => a.pageSlug === slot.pageSlug && a.role === slot.role,
            );
            const acceptedSlot = acceptedSlots.find((s) => s.slot === slot.slot);
            const slotResolution = resolutionMap.get(slot.slot);
            return {
              slot: slot.slot,
              pageSlug: slot.pageSlug,
              role: slot.role,
              requiredRole: slot.requiredRole,
              requirement: slot.requirement,
              truthClassProposal: slot.truthClassProposal,
              truthClassRationale: slot.truthClassRationale,
              truthClass: (classification?.truthClass as VisualTruthClass) ?? null,
              truthClassConfirmedAt: classification?.confirmedAt.toISOString() ?? null,
              proposedStrategy: slot.proposedStrategy,
              strategyReason: slot.unresolvedReason,
              aspectRatio: slot.aspectRatio,
              minDimensions: slot.minDimensions,
              existingVersionId: slot.existingVersionId ?? null,
              existingBinaryDigest: slot.existingBinaryDigest ?? null,
              existingGovernanceDigest: slot.existingGovernanceDigest ?? null,
              unresolvedReason: slot.unresolvedReason,
              resolved: assignment != null,
              promptSnapshot: snapshot
                ? {
                    id: snapshot.id,
                    digest: snapshot.promptDigest,
                    approvalState: snapshot.approvalState,
                    operation: snapshot.operation,
                  }
                : null,
              candidates: candidatesWithRequests,
              acceptedResolution: assignment
                ? {
                    resolutionMode: acceptedSlot?.resolutionMode ?? slotResolution?.resolutionMode ?? "reuse_real",
                    truthClass: acceptedSlot?.truthClass ?? classification?.truthClass ?? "documentary",
                    versionId: assignment.versionId,
                    binaryDigest: assignment.binaryDigest,
                    governanceDigest: assignment.versionDigest,
                    assetId: assignment.assetId,
                    assignmentId: assignment.id,
                    visualProviderConsumedSourceAsset: acceptedSlot?.visualProviderConsumedSourceAsset ?? slotResolution?.visualProviderConsumedSourceAsset ?? false,
                    visualProviderProducedAsset: acceptedSlot?.visualProviderProducedAsset ?? slotResolution?.visualProviderProducedAsset ?? false,
                    designProviderReferencedFinalAsset: true,
                    designProviderConsumedFinalAsset: false,
                  }
                : null,
            };
          }),
        )
      : [];

    const latestDesign = await this.designStore.latestAcceptedDesign(projectId);
    // Truthful provider-consumption evidence for the FINAL design: examine
    // the accepted design's own asset slots. A slot the design provider
    // actually received/consumed reports providerConsumed=true; the live
    // Stitch text-only seam keeps it false even when the slot is exactly
    // bound. null = no bound slots exist (nothing to claim either way).
    let finalProviderConsumed: boolean | null = null;
    let finalDesignReferenced: boolean | null = null;
    let finalDesignConsumed: boolean | null = null;
    let finalVisualConsumedSource: boolean | null = null;
    let finalVisualProduced: boolean | null = null;

    if (latestDesign) {
      const designData = latestDesign.artifact.data as DesignCandidateData;
      const boundSlots = designData.archetypes.flatMap((a) => a.assetSlots).filter((s) => s.boundAssetVersionId != null);
      if (boundSlots.length > 0) {
        finalProviderConsumed = boundSlots.every((s) => s.providerConsumed);
        finalDesignReferenced = boundSlots.every((s) => s.designProviderReferencedFinalAsset ?? false);
        finalDesignConsumed = boundSlots.every((s) => s.designProviderConsumedFinalAsset ?? false);
      }
    }
    if (acceptedSlots.length > 0) {
      finalVisualConsumedSource = acceptedSlots.some((s) => s.visualProviderConsumedSourceAsset);
      finalVisualProduced = acceptedSlots.some((s) => s.visualProviderProducedAsset);
    }
    const finalDesignPass = {
      required: Boolean(
        acceptedSet &&
          (latestDesign?.staleness.code === "RUN7_ASSET_ASSIGNMENTS_ADDED" ||
            latestDesign?.staleness.code === "RUN7_EXACT_ASSET_REPLACED"),
      ),
      frozen: Boolean(acceptedSet && latestDesign && !latestDesign.staleness.stale),
      acceptedDesignVersion: latestDesign?.artifact.version ?? null,
      designStalenessCode: latestDesign?.staleness.code ?? null,
      providerConsumed: finalProviderConsumed,
      visualProviderConsumedSourceAsset: finalVisualConsumedSource,
      visualProviderProducedAsset: finalVisualProduced,
      designProviderReferencedFinalAsset: finalDesignReferenced,
      designProviderConsumedFinalAsset: finalDesignConsumed,
    };

    return {
      schemaVersion: VISUAL_ASSETS_SCHEMA_VERSION,
      provider: { preflight, providerMode: this.provider.providerMode },
      plan: plan
        ? {
            id: plan.id,
            version: plan.version,
            planDigest: plan.planDigest,
            designArtifactId: plan.designArtifactId,
            designArtifactVersion: plan.designArtifactVersion,
            designCandidateDigest: plan.designCandidateDigest,
            designInputDigest: plan.designInputDigest,
            designProviderMode: plan.designProviderMode,
            createdAt: plan.createdAt.toISOString(),
            stale,
            staleReason,
          }
        : null,
      slots,
      acceptedSet: acceptedSet
        ? {
            id: acceptedSet.id,
            version: acceptedSet.version,
            setDigest: acceptedSet.setDigest,
            providerMode: acceptedSet.providerMode,
            acceptedAt: acceptedSet.acceptedAt.toISOString(),
            slots: acceptedSlots.map((s) => {
              // Truthful consumption: only ai_edit/ai_generate resolutions
              // actually delivered bytes to the provider (via sourceImages /
              // generated output round-trip). reuse_real and
              // deterministic_transform never involve the provider.
              const providerConsumed = s.resolutionMode === "ai_edit" || s.resolutionMode === "ai_generate";
              return {
                slot: s.slot,
                pageSlug: s.pageSlug,
                role: s.role,
                versionId: s.resolvedVersionId,
                resolutionMode: s.resolutionMode,
                truthClass: s.truthClass,
                providerConsumed,
                visualProviderConsumedSourceAsset: s.visualProviderConsumedSourceAsset ?? false,
                visualProviderProducedAsset: s.visualProviderProducedAsset ?? false,
                designProviderReferencedFinalAsset: true,
                designProviderConsumedFinalAsset: false,
              };
            }),
          }
        : null,
      budget: budgetSummary,
      finalDesignPass,
    };
  }

  /** Read candidate bytes (project-scoped) for preview serving. */
  async readCandidateBytes(projectId: string, candidateId: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const candidate = await this.store.getCandidate(projectId, candidateId);
    if (!candidate) throw new FactoryError("visual_not_found", "Candidate not found for this project.");
    const storage = await this.storageOrThrow();
    return { bytes: await storage.getCandidate(candidate.storageKey), mediaType: candidate.mediaType };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getPlanOrThrow(projectId: string, planId: string): Promise<VisualAssetPlanRecord> {
    const plan = await this.store.getPlan(projectId, planId);
    if (!plan) throw new FactoryError("visual_not_found", "Visual plan not found for this project.");
    return plan;
  }

  /** Test/isolation seam: project-scoped plan lookup with typed not-found. */
  async getPlanOrThrowPublic(projectId: string, planId: string): Promise<VisualAssetPlanRecord> {
    return await this.getPlanOrThrow(projectId, planId);
  }

  private async getApprovedVersionOrThrow(projectId: string, versionId: string): Promise<AssetVersionRow> {
    const version = await this.assets["store"].getVersion(projectId, versionId);
    if (!version) throw new FactoryError("asset_version_not_found", "Asset version not found for this project.");
    if (version.approvalState !== "approved") {
      throw new FactoryError("visual_truth_policy_violation", "The referenced asset version is not approved.");
    }
    return version;
  }

  private async getAssetForVersion(projectId: string, version: AssetVersionRow): Promise<AssetRow> {
    const asset = await this.assets["store"].getAsset(projectId, version.assetId);
    if (!asset) throw new FactoryError("asset_not_found", "Asset not found for this project.");
    return asset;
  }

  private async listAssignments(projectId: string) {
    return await this.assets["store"].listAssignments(projectId);
  }

  private async findAssignment(projectId: string, pageSlug: string, role: string) {
    const assignments = await this.listAssignments(projectId);
    return assignments.find((a) => a.pageSlug === pageSlug && a.role === role) ?? null;
  }

  /**
   * Ingest a derived version through the Run 5 authority: reuse the parent
   * logical asset and append an immutable version with exact derivation
   * provenance. Uses the public upload path (server-side validation, exact
   * digest, derivatives) by posting the derived bytes as a new upload whose
   * title matches the parent asset title so the Run 5 identity heuristic
   * appends a version to the SAME logical asset.
   */
  private async ingestDerivedVersion(input: {
    projectId: string;
    parentAsset: AssetRow;
    parentVersion: AssetVersionRow;
    bytes: Uint8Array;
    provenance: AssetProvenance;
  }): Promise<{ asset: AssetRow; version: AssetVersionRow }> {
    const ingest = await this.assets.uploadAsset(input.projectId, {
      dataBase64: Buffer.from(input.bytes).toString("base64"),
      filename: input.provenance.originalFilename,
      kind: input.parentAsset.kind === "photo" ? "photo" : (input.parentAsset.kind as "photo" | "illustration" | "logo" | "chart" | "icon"),
      title: input.parentAsset.title,
      rightsStatus: "operator_owned",
      rightsNote: `Derived from approved version ${input.parentVersion.id} (sha256 ${input.parentVersion.binaryDigest.slice(0, 12)}…) via ${input.provenance.derivation?.origin ?? "deterministic_transform"}`,
      altIntent: input.parentVersion.altIntent ?? undefined,
    });
    // Record exact derivation lineage on the pending version (Run 7 seam),
    // then re-read so the returned row reflects the recorded provenance.
    await this.assets.recordDerivationProvenance(input.projectId, ingest.version.id, {
      expectedBinaryDigest: ingest.version.binaryDigest,
      provenance: input.provenance,
    });
    const version = await this.assets["store"].getVersion(input.projectId, ingest.version.id);
    return { asset: ingest.asset, version: version! };
  }

  /**
   * Run 7 QA remediation (P2-F2): byte-identical output from a DIFFERENT
   * request digest must BIND to the existing approved version instead of
   * failing on the Run 5 UNIQUE(project_id, binary_digest) constraint after
   * a real provider spend.
   *
   * Semantics:
   * - no existing version with these bytes -> normal ingest path;
   * - existing APPROVED version with these bytes -> bind to it (no new
   *   version row; the candidate row already carries the full derivation
   *   lineage as evidence, so nothing is lost and nothing is mutated);
   * - existing NOT-approved version with these bytes -> fail closed (binding
   *   to unapproved bytes would bypass the Run 5 approval authority).
   */
  private async ingestOrBindExisting(input: {
    projectId: string;
    bytes: Uint8Array;
    digest: string;
    provenance: AssetProvenance;
    ingest: () => Promise<{ asset: AssetRow; version: AssetVersionRow }>;
  }): Promise<{ asset: AssetRow; version: AssetVersionRow; boundExisting: boolean }> {
    const existing = await this.assets.findByBinaryDigest(input.projectId, input.digest);
    if (existing) {
      if (existing.approvalState !== "approved") {
        throw new FactoryError(
          "visual_acceptance_failed",
          "Identical bytes already exist in this project but are not approved; approve or reject the existing version first.",
        );
      }
      const asset = await this.getAssetForVersion(input.projectId, existing);
      return { asset, version: existing, boundExisting: true };
    }
    const ingested = await input.ingest();
    return { ...ingested, boundExisting: false };
  }
}

// ---------------------------------------------------------------------------
// Byte validation (§21 exact order; provider metadata never trusted)
// ---------------------------------------------------------------------------

interface ValidatedBytes {
  sniffedMediaType: string;
  width: number;
  height: number;
  byteSize: number;
  validatedBytes?: Uint8Array;
}

async function validateCandidateBytes(bytes: Uint8Array, declaredMediaType: string): Promise<ValidatedBytes> {
  // 1. Response size ceiling.
  if (bytes.byteLength === 0) {
    throw new FactoryError("visual_provider_output_invalid", "Provider returned empty image bytes.");
  }
  if (bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
    throw new FactoryError("visual_provider_output_invalid", "Provider image exceeds the byte ceiling.");
  }
  // 2-3. Byte-level MIME sniff (declared media type is untrusted).
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !SUPPORTED_MEDIA_TYPES.has(detected.mime)) {
    throw new FactoryError(
      "visual_provider_output_invalid",
      detected
        ? `Provider returned unsupported media type "${detected.mime}".`
        : "Provider bytes are not a recognizable supported image.",
    );
  }
  // 4-6. Decode with sharp; verify dimensions.
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new FactoryError("visual_provider_output_invalid", "Provider image dimensions could not be determined.");
    }
    width = metadata.width;
    height = metadata.height;
    if (metadata.orientation && metadata.orientation >= 5) [width, height] = [height, width];
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new FactoryError("visual_provider_output_invalid", `Provider image ${width}x${height} exceeds the dimension limit.`);
    }
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    throw new FactoryError("visual_provider_output_invalid", "Provider image could not be decoded (corrupt output).");
  }
  return {
    sniffedMediaType: detected.mime,
    width,
    height,
    byteSize: bytes.byteLength,
    validatedBytes: bytes,
  };
}

function sha256(bytes: Uint8Array): string {
  // Deterministic hex SHA-256 over exact bytes (same authority as storage).
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Prompt text construction (deterministic; bounded)
// ---------------------------------------------------------------------------

function buildPromptText(input: {
  operation: "edit" | "generate";
  slot: string;
  requirement: string;
  truthClass: VisualTruthClass;
  aspectRatio: string;
  allowedEdits: string[];
  forbiddenEdits: string[];
  brandConstraints: string[];
}): string {
  const lines: string[] = [];
  if (input.operation === "edit") {
    lines.push(
      `Perform a controlled photographic edit of the supplied image for the design slot "${input.slot}".`,
      `Visual requirement: ${input.requirement}`,
      `Truth classification: ${input.truthClass} — this image is evidence of a real subject; your edit must not change reality.`,
    );
    if (input.allowedEdits.length > 0) {
      lines.push(`Allowed edits: ${input.allowedEdits.join("; ")}.`);
    }
    if (input.forbiddenEdits.length > 0) {
      lines.push("STRICT PROHIBITIONS (violating any of these makes the output unusable):");
      for (const rule of input.forbiddenEdits) lines.push(rule);
    }
  } else {
    lines.push(
      `Create a professional website image for the design slot "${input.slot}".`,
      `Visual requirement: ${input.requirement}`,
      `Truth classification: ${input.truthClass} — the result is illustrative/decorative; it must NOT depict a specific real place, person, property or event as documentary evidence.`,
    );
  }
  if (input.brandConstraints.length > 0) {
    lines.push(`Brand constraints: ${input.brandConstraints.join("; ")}.`);
  }
  lines.push(`Target aspect ratio: ${input.aspectRatio}.`);
  lines.push("Output exactly one image.");
  return lines.join("\n");
}

function deriveArchetypeForSlot(
  design: { artifact: AcceptedDesignArtifactRecord } | null,
  slot: string,
): VisualPromptSnapshotData["archetype"] {
  if (design) {
    const data = design.artifact.data as DesignCandidateData;
    for (const archetype of data.archetypes) {
      if (archetype.assetSlots.some((s) => s.slot === slot)) return archetype.kind;
    }
  }
  return "homepage";
}

function describeTransform(transform: {
  maxWidth?: number;
  aspectRatioCrop?: string;
  grayscale?: boolean;
  brightness?: number;
}): string {
  const parts: string[] = [];
  if (transform.aspectRatioCrop) parts.push(`crop ${transform.aspectRatioCrop}`);
  if (transform.maxWidth) parts.push(`resize ${transform.maxWidth}w`);
  if (transform.grayscale) parts.push("grayscale");
  if (transform.brightness != null) parts.push(`brightness ${transform.brightness}`);
  return parts.length > 0 ? parts.join(", ") : "identity";
}

function candidateParentVersionId(candidate: VisualAssetCandidateRecord): string {
  const lineage = candidate.parentLineage as Array<{ versionId: string }>;
  return lineage[0]?.versionId ?? "";
}

function candidateParentBinaryDigest(candidate: VisualAssetCandidateRecord): string | null {
  const lineage = candidate.parentLineage as Array<{ binaryDigest: string }>;
  return lineage[0]?.binaryDigest ?? null;
}

function candidateParentGovernanceDigest(candidate: VisualAssetCandidateRecord): string | null {
  const lineage = candidate.parentLineage as Array<{ governanceDigest: string }>;
  return lineage[0]?.governanceDigest ?? null;
}


