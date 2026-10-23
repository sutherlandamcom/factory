import { productionRouteSchema, type ExecutionOrigin } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/** Historical route authority is never reconstructed from current inputs or defaults. */
export function requireHistoricalRollbackRoutes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200 ||
      !value.every(route => productionRouteSchema.safeParse(route).success) ||
      new Set(value).size !== value.length) {
    throw new FactoryError("rollback_target_invalid", "Rollback requires a complete, valid, unique historical route manifest.");
  }
  return [...value];
}

/** Every supplied authority must agree with the provider actually executing this operation. */
export function requireRollbackExecutionOrigin(
  provider: { readonly isSimulated?: boolean },
  origins: readonly unknown[],
): ExecutionOrigin {
  const actual: ExecutionOrigin = provider.isSimulated === true ? "TEST_SIMULATION" : "REAL_CLOUDFLARE";
  if (origins.length === 0 || origins.some(origin => origin !== actual)) {
    throw new FactoryError("rollback_target_invalid", "Rollback provider, historical target and effective operation provenance must agree; missing or UNKNOWN provenance is not authority.");
  }
  return actual;
}
