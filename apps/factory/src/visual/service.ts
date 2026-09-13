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

export interface VisualServiceDeps {
  store: VisualStore;
  designStore: DesignStore;
  assets: AssetService;
  budget: VisualBudgetStore;
  provider: VisualAssetProvider;
  repoRoot?: string;
  storage?: VisualCandidateStorage;
  dailyLimitUsd?: number;
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
    acceptedAt: string;
    slots: Array<{ slot: string; pageSlug: string; role: string; versionId: string; resolutionMode: string; truthClass: string }>;
  } | null;
  budget: { accountedTodayMicros: number; activeReservationMicros: number };
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

  constructor(deps: VisualServiceDeps) {
    this.store = deps.store;
    this.designStore = deps.designStore;
    this.assets = deps.assets;
    this.budget = deps.budget;
    this.provider = deps.provider;
    this.storage = deps.storage ?? null;
    this.repoRoot = deps.repoRoot;
    this.dailyLimitUsd = deps.dailyLimitUsd;
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
    if (latest.staleness.stale) {
      throw new FactoryError(
        "visual_design_not_eligible",
        `The accepted design is stale versus current upstream authority: ${latest.staleness.reason} Re-derive and re-accept the design first.`,
      );
    }
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

    // 4. Provider configured.
    const preflight = await this.provider.preflight();
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
    const design = await this.designStore.latestAcceptedDesign(input.projectId);
    if (!design || design.artifact.id !== plan.designArtifactId || design.artifact.version !== plan.designArtifactVersion) {
      throw new FactoryError("visual_plan_stale", "The accepted design changed; re-derive the visual plan.");
    }
    if (design.staleness.stale) {
      throw new FactoryError(
        "visual_plan_stale",
        `The accepted design is stale: ${design.staleness.reason} Re-derive the design and plan.`,
      );
    }

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
    if (!snapshot || snapshot.operation !== mode) {
      throw new FactoryError(
        "visual_prompt_not_approved",
        `Compile a ${mode} prompt snapshot for this slot first.`,
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

    let request: VisualGenerationRequestRecord | null = null;
    try {
      request = await this.store.createRequest({
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
      // A concurrent identical request may have won the insert; if so and it
      // has candidates, reuse them (no second spend).
      if (request.requestDigest !== requestDigest || (await this.store.listCandidatesForRequest(request.id)).length > 0 && request.id !== existing?.id) {
        const deduped = await this.store.findRequestByDigest(input.projectId, requestDigest);
        if (deduped && deduped.id !== request.id) {
          await reservation.releaseUnexecuted();
          const candidates = await this.store.listCandidatesForRequest(deduped.id);
          if (candidates.length > 0) {
            return { request: deduped, reused: true, candidates };
          }
          request = deduped;
        }
      }

      // Build the provider request (parent bytes read from Run 5 storage).
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

      // Validate + persist every returned candidate.
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

      // Account the reservation (usage telemetry when the provider exposes it).
      const usage = result.providerUsage as { totalTokenCount?: number } | null;
      await reservation.account(null);
      void usage;
      await this.store.completeRequest({
        requestId: request.id,
        providerRequestRef: result.providerRequestRef,
        costMicros: null,
        rawMetadata: result.providerUsage,
      });
      return { request, reused: false, candidates: persisted };
    } catch (error) {
      // Failure classification: persist the typed failure on the request
      // (evidence), release the reservation only when provably pre-spend.
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
      if (request) {
        await this.store
          .failRequest({ requestId: request.id, failureCode: code, rawMetadata: null })
          .catch(() => undefined);
      }
      throw error;
    }
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
  }): Promise<{ version: AssetVersionRow; asset: AssetRow }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
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
    return { version, asset };
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
  }): Promise<{ version: AssetVersionRow; asset: AssetRow; derivation: AssetDerivation }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
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
    const outBytes = new Uint8Array(await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer());
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
      originalFilename: `${parent.originalFilename} (derived: ${derivation.transformation})`,
      uploadedAt: new Date().toISOString(),
      derivation,
    };
    const { asset, version } = await this.ingestDerivedVersion({
      projectId: input.projectId,
      parentAsset: parentAsset,
      parentVersion: parent,
      bytes: outBytes,
      provenance,
    });
    return { version, asset, derivation };
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
  }): Promise<{ version: AssetVersionRow; asset: AssetRow; assignmentId: string | null; truthClass: VisualTruthClass }> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
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
    let asset: AssetRow;
    let version: AssetVersionRow;
    if (mode === "ai_generate") {
      const ingest = await this.assets.uploadAsset(input.projectId, {
        dataBase64: Buffer.from(bytes).toString("base64"),
        filename: provenance.originalFilename,
        kind: "photo",
        title: `Visual ${input.slot} (${candidate.binaryDigest.slice(0, 12)})`,
        rightsStatus: "operator_owned",
        rightsNote: `AI-generated via ${request.provider}/${request.model}; prompt snapshot ${request.promptSnapshotId}`,
        altIntent: `AI-generated imagery for slot ${input.slot}`,
      });
      asset = ingest.asset;
      version = ingest.version;
      // Enrich the ingested version's provenance with exact derivation
      // lineage (pre-approval metadata update path).
      const enriched = await this.assets.updateVersionMetadata(input.projectId, version.id, {
        rightsStatus: "operator_owned",
        rightsNote: `AI-generated via ${request.provider}/${request.model}; prompt snapshot ${request.promptSnapshotId}; request ${request.id}`,
        altIntent: `AI-generated imagery for slot ${input.slot} (truth: ${truthClass})`,
        expectedBinaryDigest: version.binaryDigest,
      });
      void enriched;
    } else {
      // AI edit: ingest as a derived version of the exact parent asset.
      const parent = await this.getApprovedVersionOrThrow(input.projectId, derivation.parentVersionId);
      const parentAsset = await this.getAssetForVersion(input.projectId, parent);
      const ingest = await this.ingestDerivedVersion({
        projectId: input.projectId,
        parentAsset,
        parentVersion: parent,
        bytes,
        provenance,
      });
      asset = ingest.asset;
      version = ingest.version;
    }

    // Approve the new version through the Run 5 authority (binds digests).
    const approved = await this.assets.approveVersion(input.projectId, version.id, version.binaryDigest);

    // Create/replace the Run 5 page assignment through AssetService.
    let assignmentId: string | null = null;
    const existing = await this.findAssignment(input.projectId, planSlot.pageSlug, planSlot.role);
    if (existing) {
      const replaced = await this.assets.replaceAssignment(input.projectId, existing.id, {
        toVersionId: approved.id,
        expectedBinaryDigest: approved.binaryDigest,
      });
      assignmentId = replaced.id;
    } else {
      const created = await this.assets.assignVersion(input.projectId, {
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

    return { version: approved, asset, assignmentId, truthClass };
  }

  /** Accept the full set: every plan slot must be resolved (Run 5 assignment). */
  async acceptSet(input: { projectId: string; planId: string }): Promise<AcceptedVisualAssetSetRecord> {
    const plan = await this.getPlanOrThrow(input.projectId, input.planId);
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
      truthClass: string;
    }> = [];
    for (const slot of data.slots) {
      const assignment = assignments.find((a) => a.pageSlug === slot.pageSlug && a.role === slot.role);
      if (!assignment) {
        throw new FactoryError(
          "visual_slot_unresolved",
          `Slot ${slot.slot} (${slot.pageSlug}/${slot.role}) has no accepted resolution; accept every slot before accepting the set.`,
        );
      }
      const classification = await this.store.getClassification(plan.id, slot.slot);
      if (!classification) {
        throw new FactoryError("visual_classification_required", `Slot ${slot.slot} has no confirmed classification.`);
      }
      slotRows.push({
        slot: slot.slot,
        pageSlug: assignment.pageSlug,
        role: assignment.role,
        resolvedVersionId: assignment.versionId,
        binaryDigest: assignment.binaryDigest,
        governanceDigest: assignment.versionDigest,
        resolutionMode: deriveResolutionMode(slot, assignment.versionId),
        truthClass: classification.truthClass,
      });
    }

    const setDigest = visualSetDigest(slotRows);
    // Idempotent: identical digest returns the existing set.
    const existing = await this.store.findSetByDigest(input.projectId, setDigest);
    if (existing) {
      return existing;
    }

    const set = await this.store.createSet({
      projectId: input.projectId,
      planId: plan.id,
      designArtifactId: plan.designArtifactId,
      designArtifactVersion: plan.designArtifactVersion,
      designCandidateDigest: plan.designCandidateDigest,
      designInputDigest: plan.designInputDigest,
      setDigest,
    });
    for (const row of slotRows) {
      await this.store.insertAcceptedSlotTx(this.store["db"] as never, {
        setId: set.id,
        projectId: input.projectId,
        slot: row.slot,
        pageSlug: row.pageSlug,
        role: row.role,
        resolvedVersionId: row.resolvedVersionId,
        binaryDigest: row.binaryDigest,
        governanceDigest: row.governanceDigest,
        resolutionMode: row.resolutionMode,
        truthClass: row.truthClass as VisualTruthClass,
        promptSnapshotId: null,
        generationRequestId: null,
        candidateId: null,
      });
    }
    return set;
  }

  // -------------------------------------------------------------------------
  // Workspace read model
  // -------------------------------------------------------------------------

  async workspace(projectId: string): Promise<VisualWorkspaceReadModel> {
    const preflight = await this.provider.preflight();
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
      } else if (design.staleness.stale) {
        stale = true;
        staleReason = design.staleness.reason;
      }
    }

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
                    resolutionMode: acceptedSlot?.resolutionMode ?? "reuse_real",
                    truthClass: acceptedSlot?.truthClass ?? classification?.truthClass ?? "documentary",
                    versionId: assignment.versionId,
                    binaryDigest: assignment.binaryDigest,
                    governanceDigest: assignment.versionDigest,
                    assetId: assignment.assetId,
                    assignmentId: assignment.id,
                  }
                : null,
            };
          }),
        )
      : [];

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
            acceptedAt: acceptedSet.acceptedAt.toISOString(),
            slots: acceptedSlots.map((s) => ({
              slot: s.slot,
              pageSlug: s.pageSlug,
              role: s.role,
              versionId: s.resolvedVersionId,
              resolutionMode: s.resolutionMode,
              truthClass: s.truthClass,
            })),
          }
        : null,
      budget: budgetSummary,
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
    return { asset: ingest.asset, version: ingest.version };
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
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

function deriveResolutionMode(
  slot: VisualPlanSlot,
  resolvedVersionId: string,
): VisualResolutionMode {
  if (slot.existingVersionId === resolvedVersionId) return "reuse_real";
  return slot.proposedStrategy === "ai_generate" ? "ai_generate" : slot.proposedStrategy;
}
