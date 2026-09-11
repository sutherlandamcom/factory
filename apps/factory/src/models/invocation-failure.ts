import { FactoryError } from "../executor/errors.js";

/** Trusted adapter evidence, retained independently of model output validity.
 * Absent evidence always means possible execution and unknown actual cost.
 * Never populate these fields from model-authored content or error text.
 */
export class InvocationFailure extends FactoryError {
  readonly requestSubmitted: boolean;
  readonly trustedCostMicros: number | null;

  constructor(
    code: string,
    message: string,
    evidence: { requestSubmitted?: boolean; trustedCostMicros?: number | null } = {},
  ) {
    super(code, message);
    this.requestSubmitted = evidence.requestSubmitted ?? true;
    this.trustedCostMicros = evidence.trustedCostMicros ?? null;
  }
}

/** Validation failure after a completed invocation must retain its usage. */
export function preserveInvocationCost(error: unknown, trustedCostMicros: number | null): InvocationFailure {
  return new InvocationFailure(
    error instanceof FactoryError ? error.code : "model_failed",
    error instanceof Error ? error.message : "Model output validation failed",
    { trustedCostMicros },
  );
}
