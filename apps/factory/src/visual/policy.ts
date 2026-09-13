import {
  DOCUMENTARY_FORBIDDEN_EDITS,
  VISUAL_TRUTH_POLICY,
  type VisualResolutionMode,
  type VisualTruthClass,
} from "@factory/contracts";

/**
 * FACTORY VISUAL MODEL POLICY — versioned, operator-fixed image-model
 * authority for Run 7. Model ids live HERE, never scattered through
 * application code. Runtime/pre-flight re-verifies current model support
 * against the official SDK/API before any spend; verification dates are
 * recorded below.
 *
 * The legacy `image_generator` OpenRouter policy entry (openai/gpt-image-2)
 * is a pre-vNext placeholder and is NOT activated by this module; Run 7
 * uses a dedicated Google GenAI provider path per the Constitution §11.
 */

export const FACTORY_VISUAL_MODEL_POLICY_VERSION = "factory-visual-model-policy-v1";
export const FACTORY_VISUAL_PROMPT_POLICY_VERSION = "factory-visual-prompt-policy-v1" as const;

/**
 * Cost/quality default (Nano Banana family) — normal first choice.
 * LIVE-VERIFIED against Vertex AI (us-central1, project access probe) on
 * 2026-09-13: `gemini-2.5-flash-image` responds; the `gemini-3.1-flash-image`
 * id is not yet served to this project (404) and is NOT used until Google
 * serves it. The prompt-task baseline ids are recorded in
 * FACTORY_VISUAL_MODEL_POLICY_NOTES for re-verification at the next
 * policy review.
 */
export const VISUAL_DEFAULT_MODEL = "gemini-2.5-flash-image";

/**
 * Premium escalation (Nano Banana Pro family) — explicit reasons only.
 * LIVE-VERIFIED 2026-09-13: `gemini-3-pro-image-preview` is 404 on this
 * project's Vertex listing; the premium tier is recorded but unavailable
 * here. Requests naming it fail closed with a typed provider error rather
 * than silently substituting a model.
 */
export const VISUAL_PREMIUM_MODEL = "gemini-3-pro-image-preview";

/** Bounded note trail for model-id verification history (policy evidence). */
export const FACTORY_VISUAL_MODEL_POLICY_NOTES: readonly string[] = Object.freeze([
  "2026-09-13: planning baseline named gemini-3.1-flash-image / gemini-3-pro-image (prompt task §14).",
  "2026-09-13: live Vertex probe (us-central1) — gemini-2.5-flash-image OK; gemini-3.1-flash-image 404; gemini-3-pro-image-preview 404 on this project.",
  "2026-09-13: policy pinned to the LIVE-VERIFIED default; premium id recorded per current docs naming and gated by preflight model checks.",
]);

/**
 * Bounded generation parameters. Single attempt per request (no endless
 * retries); failures are classified and recorded, and a corrected retry is
 * a NEW request identity (new prompt snapshot if the prompt changed).
 */
export const VISUAL_GENERATION_CONFIG = Object.freeze({
  maxAttemptsPerRequest: 1,
  /** Gemini image aspect ratios supported by the current API (verified 2026-09-13). */
  aspectRatios: Object.freeze(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]),
  /** imageConfig.imageSize values (Nano Banana Pro; default 1K). */
  sizes: Object.freeze(["1K", "2K", "4K"]),
} as const);

/** Whether a resolution mode is allowed for a truth class (hard policy). */
export function isResolutionAllowed(truthClass: VisualTruthClass, mode: VisualResolutionMode): boolean {
  return VISUAL_TRUTH_POLICY[truthClass][mode];
}

/** The mandatory forbidden-edit list for documentary AI edits (verbatim). */
export function documentaryForbiddenEdits(): readonly string[] {
  return DOCUMENTARY_FORBIDDEN_EDITS;
}

/**
 * Deterministic truth-class proposal from the design slot context. This is
 * a PROPOSAL for operator confirmation — never an authority by itself.
 *
 * Mapping rationale (bounded, inspectable):
 * - chart/data roles propose data_visualization (deterministic authority).
 * - logo roles propose illustrative (brand marks are designed, not filmed).
 * - illustration roles propose illustrative.
 * - hero/background/inline/supporting propose documentary (real photography
 *   preference; the operator may downgrade to illustrative/decorative).
 */
export function proposeTruthClass(requiredRole: string): { truthClass: VisualTruthClass; rationale: string } {
  switch (requiredRole) {
    case "chart":
      return {
        truthClass: "data_visualization",
        rationale: "Chart role: quantitative truth stays deterministic; image models never redraw factual data.",
      };
    case "logo":
      return {
        truthClass: "illustrative",
        rationale: "Logo role: brand marks are designed/illustrative, not documentary evidence.",
      };
    case "illustration":
      return {
        truthClass: "illustrative",
        rationale: "Illustration role: conceptual imagery is appropriate; documentary claim not implied.",
      };
    case "hero":
    case "background":
    case "inline":
    case "supporting":
    default:
      return {
        truthClass: "documentary",
        rationale:
          "Photography slot: real approved imagery is preferred for evidence-bearing roles; synthetic imagery requires an explicit operator downgrade.",
      };
  }
}

/**
 * Deterministic resolution-strategy proposal per slot. Priority (hard
 * product policy): existing real approved asset > deterministic transform
 * > AI edit > generation. Zero provider spend before real assets are
 * evaluated.
 */
export function proposeResolutionStrategy(input: {
  hasBoundAsset: boolean;
  truthClass: VisualTruthClass;
}): { strategy: VisualResolutionMode; reason: string } {
  if (input.hasBoundAsset) {
    return {
      strategy: "reuse_real",
      reason: "An approved asset version is bound to this exact page/role; reuse it (zero provider spend).",
    };
  }
  if (input.truthClass === "data_visualization") {
    return {
      strategy: "reuse_real",
      reason: "Data_visualization slots resolve via deterministic authority only; no image-model call is proposed.",
    };
  }
  if (input.truthClass === "documentary") {
    return {
      strategy: "ai_edit",
      reason:
        "No approved asset is bound; documentary slots cannot be fully generated. Supply a real source photograph for a controlled AI edit, or downgrade the classification explicitly.",
    };
  }
  return {
    strategy: "ai_generate",
    reason: "No approved asset is bound and the slot is non-documentary; generation is allowed.",
  };
}
