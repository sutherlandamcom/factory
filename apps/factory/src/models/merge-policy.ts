import type { ModelGateway } from "@factory/contracts";

/**
 * MERGE GATEWAY TEST PILOT PROFILE — operator-approved, TEST-ONLY.
 *
 * This profile is the ONLY governed way Factory may execute real model
 * inference through Merge Gateway (https://api-gateway.merge.dev). It is:
 * - bound to a fixed exact model id (no overrides, no fallback lists),
 * - pinned to a bounded role set (the four Factory LLM-inference stages
 *   that exist as running services today),
 * - cost-capped by an explicit pilot budget ceiling,
 * - explicitly versioned,
 * - provenance-fixed to provider "merge" (never openrouter, never zai
 *   direct), and
 * - graphically NOT publication authority: artifacts produced under this
 *   profile are evidence for the pilot QA only (see publicationAuthority).
 *
 * Standard production champions in MODEL_ROLE_POLICY / CODE_WORKER_POLICY
 * remain untouched. FACTORY_MODEL_OVERRIDE__* playing no part here; the
 * assertOverrideStartupPolicy guard is unaffected.
 */

export const MERGE_TEST_PROFILE_VERSION = "merge-gateway-test-pilot-v1";

/** The ONLY model id this pilot may call through Merge Gateway. */
export const MERGE_PILOT_MODEL = "zai/glm-5.3-flash";

/** Wire-provider provenance recorded on every merge pilot invocation. */
export const MERGE_PILOT_PROVIDER: Extract<ModelGateway, "merge"> = "merge";

/**
 * Roles the pilot is permitted to serve. Exactly the running Factory
 * application stages that genuinely perform LLM inference:
 * - site intelligence analyst (search analyst runner),
 * - competitor site analysis + content gap analyst runner,
 * - content writer smoke stage.
 * GLM NEVER replaces SERP, Stitch or Visual providers; those stages are not
 * in this role set by construction.
 */
export const MERGE_PILOT_ALLOWED_ROLES = [
  "site_intelligence", // search analyst runner
  "competitor_site_analysis", // competitor + gap analyst runners
  "content_writer", // writer smoke stage
] as const satisfies ReadonlyArray<string>;

export type MergePilotRoleId = (typeof MERGE_PILOT_ALLOWED_ROLES)[number];

/**
 * Pilot budget ceiling (USD) for the WHOLE pilot across all roles. Enforced
 * by the existing durable budget reservation lifecycle; a reservation whose
 * authorized conservative amount exceeds the remaining ceiling fails closed
 * BEFORE any paid call.
 */
export const MERGE_PILOT_BUDGET_LIMIT_USD = 2.0;
export const MERGE_PILOT_BUDGET_LIMIT_MICROS = Math.round(MERGE_PILOT_BUDGET_LIMIT_USD * 1_000_000);

/** Env switch that activates the pilot (default: strictly off). */
export const MERGE_PILOT_ENABLED_ENV = "FACTORY_LLM_PROVIDER";
export const MERGE_PILOT_ENABLED_ENV_VALUE = "merge";

/** Whether the merge pilot is active in the given environment. */
export function isMergePilotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[MERGE_PILOT_ENABLED_ENV] ?? "").trim() === MERGE_PILOT_ENABLED_ENV_VALUE;
}

/** Effective model for a role under the pilot profile (exact, no override seam). */
export function mergePilotModelForRole(roleId: string): string | null {
  return (MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes(roleId) ? MERGE_PILOT_MODEL : null;
}

export interface MergePilotProfile {
  policyVersion: typeof MERGE_TEST_PROFILE_VERSION;
  provider: Extract<ModelGateway, "merge">;
  model: typeof MERGE_PILOT_MODEL;
  allowedRoles: readonly MergePilotRoleId[];
  budgetLimitUsd: number;
  /** True ONLY for genuine production champion paths; this pilot is never one. */
  productionChampion: false;
  /**
   * Hard gate: artifacts produced under this profile have NO publication
   * authority. Test-project scope only.
   */
  publicationAuthority: false;
  /** Scope restriction: a dedicated Factory TEST project; never a production project id. */
  scope: "test_project_only";
}
