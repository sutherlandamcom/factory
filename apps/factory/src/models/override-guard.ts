import {
  activeModelOverrides,
  type FactoryRoleId,
} from "./policy.js";
import { FactoryError } from "../executor/errors.js";

/**
 * GOVERNED DEV-TIME MODEL OVERRIDE — startup guard.
 *
 * Overrides are DEV-TIME ONLY. They must never run in CI/acceptance mode or
 * any gated live-proof path, and those environments must additionally run in
 * production provider mode (no fixture mode), so a fixture cannot silently
 * masquerade as a live acceptance proof.
 */

/** Environments where model overrides are forbidden (hard-fail at startup). */
export function isGovernedEnvironment(env: Record<string, string | undefined>): boolean {
  if (env["CI"] === "true" || env["CI"] === "1") return true;
  if (env["FACTORY_ACCEPTANCE_MODE"] === "true" || env["FACTORY_ACCEPTANCE_MODE"] === "1") return true;
  if (env["FACTORY_LIVE_PROOF"] === "true" || env["FACTORY_LIVE_PROOF"] === "1") return true;
  return false;
}

/** Provider-mode fixture variables that are forbidden in gated live-proof paths. */
export function activeFixtureModes(env: Record<string, string | undefined>): string[] {
  const fixtureVars: string[] = [];
  for (const key of ["FACTORY_SEARCH_MODE", "FACTORY_COMPETITOR_MODE", "FACTORY_WRITER_MODE", "FACTORY_DESIGN_MODE", "FACTORY_VISUAL_MODE"]) {
    if (env[key] === "fixture") fixtureVars.push(key);
  }
  return fixtureVars;
}

export interface OverrideStartupCheckResult {
  /** Active overrides (empty in governed environments — the check would have thrown). */
  activeOverrides: Array<{ roleId: FactoryRoleId; model: string; championModel: string }>;
  /** Fixture provider modes detected (informational; forbidden in live-proof paths). */
  fixtureModes: string[];
}

/**
 * Assert the startup override policy. Throws a typed FactoryError (fail
 * closed) when any override is set in a governed environment, or when a
 * fixture provider mode is set on a gated live-proof path.
 */
export function assertOverrideStartupPolicy(
  env: Record<string, string | undefined> = process.env,
): OverrideStartupCheckResult {
  const overrides = activeModelOverrides(env);
  const governed = isGovernedEnvironment(env);
  if (governed && overrides.length > 0) {
    const detail = overrides.map((o) => `${o.roleId} -> ${o.model} (champion ${o.championModel})`).join("; ");
    throw new FactoryError(
      "writer_provider_not_configured",
      `DEV MODEL OVERRIDE FORBIDDEN: model overrides are dev-time only and are set in a governed (CI/acceptance/live-proof) environment: ${detail}. Unset all FACTORY_MODEL_OVERRIDE__* variables.`,
    );
  }
  const fixtureModes = activeFixtureModes(env);
  if (env["FACTORY_LIVE_PROOF"] === "true" || env["FACTORY_LIVE_PROOF"] === "1") {
    if (fixtureModes.length > 0) {
      throw new FactoryError(
        "writer_provider_not_configured",
        `LIVE PROOF REQUIRES PRODUCTION PROVIDER MODE: fixture mode is forbidden on gated live-proof paths (${fixtureModes.join(", ")}).`,
      );
    }
  }
  return { activeOverrides: overrides, fixtureModes };
}

/** Prominent startup diagnostics for every active override. */
export function logOverrideDiagnostics(result: OverrideStartupCheckResult): void {
  if (result.activeOverrides.length > 0) {
    for (const o of result.activeOverrides) {
      console.warn(
        `DEV MODEL OVERRIDE ACTIVE: role ${o.roleId} resolves to ${o.model} instead of frozen champion ${o.championModel}. Dev-time only; forbidden in CI/acceptance/live-proof.`,
      );
    }
  }
}
