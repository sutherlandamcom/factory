import {
  resolveRoleModel,
  MODEL_ROLE_POLICY,
  type FactoryRoleId,
} from "../models/policy.js";
import {
  calculateConservativeInvocationCostMicros,
  calculateInvocationActualCostMicros,
} from "../models/pricing.js";
import { invokeModel, type ModelCallResult } from "../models/gateway.js";
import { invokeModelViaMerge } from "../models/merge-gateway.js";
import {
  isMergePilotEnabled,
  mergePilotModelForRole,
  MERGE_PILOT_BUDGET_LIMIT_USD,
  MERGE_PILOT_MODEL,
  MERGE_PILOT_PROVIDER,
  MERGE_TEST_PROFILE_VERSION,
} from "../models/merge-policy.js";
import {
  loadMergeApiKey,
  MERGE_GATEWAY_API_KEY_ENV,
} from "../models/merge-gateway.js";
import { InvocationFailure, preserveInvocationCost } from "../models/invocation-failure.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { WriterBudgetStore } from "./budget.js";

/**
 * WRITER PROVIDER BOUNDARY — thin, replaceable adapter for the content_writer
 * policy role. The model id ALWAYS comes from the governed policy resolution
 * seam (never from browser input). Every paid invocation passes trusted
 * preflight: credential check + conservative budget authorization, fail
 * closed before any provider call.
 */

/** The writer role served by this boundary. */
export const WRITER_ROLE_ID: FactoryRoleId = "content_writer";

/** Conservative bounded output ceiling for one writer invocation (tokens). */
export const WRITER_MAX_OUTPUT_TOKENS = 16_000;

export interface WriterInvocationRequest {
  /** Exact approved WriterPromptSnapshot digest (budget lineage binding). */
  promptSnapshotDigest: string;
  /** Exact approved snapshot revision (digest binding: authorized == executed). */
  promptSnapshotRevision: number;
  projectId: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface WriterInvocationResult {
  content: string;
  model: string;
  overrideApplied: boolean;
  overriddenChampion: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
}

export interface WriterProviderDeps {
  budget: WriterBudgetStore;
  /** Daily limit override (tests); production reads FACTORY_WRITER_DAILY_LIMIT_USD. */
  dailyLimitUsd?: number;
  /** Gateway invocation override (tests inject fixtures here; zero paid calls). */
  invoke?: typeof invokeModel;
  /** Env override for resolution/testing. */
  env?: Record<string, string | undefined>;
  /** Conservative authorization override (tests); default computes from pricing. */
  authorizedMicrosOverride?: number;
}

/** Resolve the effective writer model through the governed policy seam. */
export function resolveWriterModel(env: Record<string, string | undefined> = process.env) {
  // Merge Gateway TEST PILOT path: the operator-approved profile replaces
  // the model/gateway for this role with the fixed pilot binding. Provenance
  // is recorded as provider "merge" on every artifact and the pilot carries
  // NO publication authority (see merge-policy.ts). Standard frozen
  // champions are untouched; this can never be combined with
  // FACTORY_MODEL_OVERRIDE__* (that seam stays on the OpenRouter path).
  if (isMergePilotEnabled(env)) {
    const pilotModel = mergePilotModelForRole(WRITER_ROLE_ID);
    if (pilotModel === null) {
      throw new FactoryError(
        "writer_provider_not_configured",
        `Merge Gateway pilot profile does not permit role ${WRITER_ROLE_ID}.`,
      );
    }
    return {
      model: pilotModel,
      championModel: pilotModel,
      overrideApplied: false,
      policy: MODEL_ROLE_POLICY[WRITER_ROLE_ID as keyof typeof MODEL_ROLE_POLICY],
      pilot: { provider: MERGE_PILOT_PROVIDER, policyVersion: MERGE_TEST_PROFILE_VERSION } as const,
    };
  }
  const resolved = resolveRoleModel(WRITER_ROLE_ID, env);
  return { ...resolved, policy: MODEL_ROLE_POLICY[WRITER_ROLE_ID as keyof typeof MODEL_ROLE_POLICY] };
}

/** Credential preflight: missing/unusable credential -> typed failure, zero provider calls. */
export function assertWriterCredentialAvailable(deps: { loadApiKey?: () => string | null } = {}): string {
  // Merge pilot: the pilot credential (MERGE_GATEWAY_API_KEY) is required.
  const loader = deps.loadApiKey ?? (isMergePilotEnabled() ? loadMergeApiKey : () => process.env["OPENROUTER_API_KEY"]?.trim() ?? null);
  const apiKey = loader();
  if (apiKey === null || apiKey.trim().length === 0) {
    throw new FactoryError(
      "writer_provider_not_configured",
      isMergePilotEnabled()
        ? `${MERGE_GATEWAY_API_KEY_ENV} is not configured; the Merge Gateway pilot fails closed without credentials.`
        : "OPENROUTER_API_KEY is not configured; the writer provider fails closed without credentials.",
    );
  }
  return apiKey;
}

/**
 * Run one bounded writer invocation under full budget governance:
 * preflight (credential + conservative authorization) -> reservation ->
 * provider call -> settlement (account trusted usage / release on
 * pre-submission failure / conservative accounting on post-submission
 * failure). The invocation digest binds authorized == executed.
 */
export async function runWriterInvocation(
  request: WriterInvocationRequest,
  deps: WriterProviderDeps,
): Promise<WriterInvocationResult> {
  const env = deps.env ?? process.env;
  const resolved = resolveWriterModel(env);
  const policy = MODEL_ROLE_POLICY[WRITER_ROLE_ID as keyof typeof MODEL_ROLE_POLICY];
  // Merge pilot: pilot budget ceiling bounds the reservation; the effective
  // wire provider is "merge" (provenance), never the OpenRouter enum value.
  const pilotActive = isMergePilotEnabled(env);
  const effectiveProvider = pilotActive ? MERGE_PILOT_PROVIDER : policy.gateway;

  // 1. Credential preflight BEFORE any reservation or provider call.
  assertWriterCredentialAvailable({ loadApiKey: deps.invoke ? () => "test-key" : undefined });

  // 2. Conservative authorization bound (fail closed on unpriced models).
  const authorizedMicros =
    deps.authorizedMicrosOverride ??
    calculateConservativeInvocationCostMicros({
      model: resolved.model,
      provider: effectiveProvider,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
    });

  // 3. Invocation digest: binds the authorized call to the executed call.
  const invocationDigest = deterministicWriterInvocationDigest({
    promptSnapshotDigest: request.promptSnapshotDigest,
    promptSnapshotRevision: request.promptSnapshotRevision,
    model: resolved.model,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
  });

  // 4. Durable budget reservation (fail closed when blocked). The pilot adds
  // its OWN explicit ceiling (MERGE_PILOT_BUDGET_LIMIT_USD) so pilot spend
  // is bounded independently of the writer's ordinary daily limit.
  const dailyLimitUsd = pilotActive
    ? Math.min(
        deps.dailyLimitUsd ?? Number.POSITIVE_INFINITY,
        env["FACTORY_MERGE_PILOT_LIMIT_USD"]
          ? Number(env["FACTORY_MERGE_PILOT_LIMIT_USD"])
          : MERGE_PILOT_BUDGET_LIMIT_USD,
      )
    : deps.dailyLimitUsd ??
      (env["FACTORY_WRITER_DAILY_LIMIT_USD"] ? Number(env["FACTORY_WRITER_DAILY_LIMIT_USD"]) : undefined);
  const reservation = await deps.budget.reserveWriterBudget(
    {
      provider: effectiveProvider,
      model: resolved.model,
      authorizedMicros,
      invocationDigest,
      lineage: {
        kind: "writer_proposal",
        projectId: request.projectId,
        promptSnapshotDigest: request.promptSnapshotDigest,
        promptSnapshotRevision: request.promptSnapshotRevision,
        overrideApplied: resolved.overrideApplied,
        overriddenChampion: resolved.overrideApplied ? resolved.championModel : null,
        ...(pilotActive ? { mergePilotPolicyVersion: MERGE_TEST_PROFILE_VERSION } : {}),
      },
    },
    Number.isFinite(dailyLimitUsd) ? (dailyLimitUsd as number) : undefined,
  );

  // 5. Provider call with full settlement semantics. The pilot routes via
  // the Merge Gateway adapter (same contract, same failure taxonomy).
  const invoke = deps.invoke ?? (pilotActive ? invokeModelViaMerge : invokeModel);
  try {
    const result: ModelCallResult = await invoke(
      {
        roleId: WRITER_ROLE_ID,
        model: resolved.model,
        systemPrompt: request.systemPrompt,
        prompt: request.userPrompt,
        maxTokens: WRITER_MAX_OUTPUT_TOKENS,
        timeoutMs: policy.timeoutMs,
      },
      deps.invoke ? { fetchImpl: async () => { throw new Error("fixture gateway must not hit network"); } } : {},
    );
    // Trusted actual cost from usage telemetry. Missing usage (null tokens)
    // is unknown cost -> null -> conservative accounting at the authorized
    // amount; a known-zero-usage paid response still accounts the floor of 1
    // micro via the pricing helper. Unpriced model -> null (conservative).
    const actualMicros =
      result.promptTokens == null || result.completionTokens == null
        ? null
        : calculateInvocationActualCostMicros({
            model: resolved.model,
            provider: effectiveProvider,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          });
    await reservation.account(actualMicros);
    return {
      content: result.content,
      model: resolved.model,
      overrideApplied: resolved.overrideApplied,
      overriddenChampion: resolved.overrideApplied ? resolved.championModel : null,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
    };
  } catch (error) {
    if (error instanceof InvocationFailure) {
      if (!error.requestSubmitted) {
        // Provably pre-submission: release permitted, zero spend.
        await reservation.releaseUnexecuted();
      } else {
        // Post-submission failure: NOT released; conservative accounting
        // (unknown cost -> authorized amount; trusted evidence retained).
        await reservation.account(error.trustedCostMicros);
      }
    } else {
      // Non-invocation failures after reservation are treated as unknown-cost
      // post-submission failures (fail closed: conservative accounting).
      await reservation.account(null);
    }
    throw error;
  }
}

/** Deterministic digest binding the exact authorized invocation. */
export function deterministicWriterInvocationDigest(input: {
  promptSnapshotDigest: string;
  promptSnapshotRevision: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}): string {
  return deterministicDigest(input);
}

/** Map a gateway failure to the typed writer error surface. */
export function writerProviderError(error: unknown): FactoryError {
  if (error instanceof InvocationFailure) {
    if (error.code === "credentials_unavailable") {
      return new FactoryError(
        "writer_provider_not_configured",
        "Writer provider credentials are missing or unusable.",
      );
    }
    return new FactoryError("writer_provider_unavailable", "Writer provider invocation failed.");
  }
  if (error instanceof FactoryError) return error;
  return new FactoryError("writer_provider_unavailable", "Writer provider invocation failed.");
}

export { preserveInvocationCost };
