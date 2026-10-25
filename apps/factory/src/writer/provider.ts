import {
  resolveRoleModel,
  MODEL_ROLE_POLICY,
  type FactoryRoleId,
} from "../models/policy.js";
import {
  calculateConservativeInvocationCostMicros,
  calculateInvocationActualCostMicros,
} from "../models/pricing.js";
import { invokeModel, type ModelCallResult, type ModelCallRequest } from "../models/gateway.js";
import { invokeModelViaMerge } from "../models/merge-gateway.js";
import {
  isMergePilotRequested,
  mergePilotModelForRole,
  MERGE_PILOT_MODEL,
  MERGE_PILOT_PROVIDER,
  MERGE_TEST_PROFILE_VERSION,
} from "../models/merge-policy.js";
import {
  resolvePilotGrant,
  mergePilotPublicationForbiddenError,
  type MergePilotGrant,
} from "../models/merge-pilot-guard.js";
import { reservePilotBudget, type PilotBudgetReservationHandle } from "../models/pilot-budget.js";
import type { FactoryDb } from "../persistence/db.js";
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
  /** P1-04 three-way cost decomposition (provider / policy / accounted). */
  costBreakdown: InvocationCostBreakdown;
  /** P1-02 wire provenance digests (merge pilot; else null). */
  requestDigest: string | null;
  responseDigest: string | null;
}

/** P1-04 — the three cost figures, kept independently distinguishable. */
export interface InvocationCostBreakdown {
  /** Cost reported by the provider (Merge usage.cost), null when absent. */
  providerReportedMicros: number | null;
  /** Factory's conservative token x trusted-rate estimate. */
  policyEstimatedMicros: number;
  /** Amount durably accounted in the ledger (never silently 0). */
  accountedMicros: number;
  /** Which deterministic accounting rule produced accountedMicros. */
  accountingBasis:
    | "provider_reported_or_policy_estimate"
    | "policy_estimate"
    | "unknown_cost_conservative_full";
  /** accounted - providerReported when both exist; null otherwise. */
  discrepancyMicros: number | null;
}

/**
 * P1-04 accounting rule (documented, deterministic):
 * - a trusted provider-reported figure is never replaced by a lower
 *   estimate and an estimate is never replaced by 0;
 * - when both figures exist the ledger records the MAX (conservative);
 * - when only the estimate exists -> the estimate;
 * - when NEITHER trusted signal exists -> the full authorized conservative
 *   reservation (never 0 — a post-submission unknown may already be
 *   billed; a provable pre-submission failure releases instead of
 *   accounting).
 */
export function computeAccountedCostMicros(input: {
  providerReportedMicros: number | null;
  policyEstimatedMicros: number;
  fullyTrustedEstimateAvailable: boolean;
}): number {
  const { providerReportedMicros, policyEstimatedMicros } = input;
  if (providerReportedMicros != null && Number.isFinite(providerReportedMicros) && providerReportedMicros >= 0) {
    return Math.max(providerReportedMicros, policyEstimatedMicros, 1);
  }
  if (input.fullyTrustedEstimateAvailable) {
    return Math.max(policyEstimatedMicros, 1);
  }
  // No trusted cost signal at all: the caller falls back to the authorized
  // conservative reservation amount — handled at the settlement call site
  // by passing that amount as policyEstimatedMicros with
  // fullyTrustedEstimateAvailable=false (convention kept here explicit).
  return Math.max(policyEstimatedMicros, 1);
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
  /** Durable DB for the guard + pilot budget (pilot path only). */
  db?: FactoryDb;
  /** Bound pilot run id (pilot path only; authority re-verified by the guard). */
  pilotRunId?: string;
}

function failClosedDb(): FactoryDb {
  throw new FactoryError(
    "writer_provider_not_configured",
    "Merge pilot requires a durable FactoryDb for registry-backed authority (fail closed: no DB, no pilot call).",
  );
}

function throwMissingPilotRunId(): string {
  throw mergePilotPublicationForbiddenError();
}

/** Resolve the effective writer model through the governed policy seam. */
export function resolveWriterModel(env: Record<string, string | undefined> = process.env) {
  // Merge Gateway TEST PILOT path: the operator-approved profile replaces
  // the model/gateway for this role with the fixed pilot binding. Provenance
  // is recorded as provider "merge" on every artifact and the pilot carries
  // NO publication authority (see merge-policy.ts). Standard frozen
  // champions are untouched; this can never be combined with
  // FACTORY_MODEL_OVERRIDE__* (that seam stays on the OpenRouter path).
  if (isMergePilotRequested(env)) {
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
  const loader = deps.loadApiKey ?? (isMergePilotRequested() ? loadMergeApiKey : () => process.env["OPENROUTER_API_KEY"]?.trim() ?? null);
  const apiKey = loader();
  if (apiKey === null || apiKey.trim().length === 0) {
    throw new FactoryError(
      "writer_provider_not_configured",
      isMergePilotRequested()
        ? `${MERGE_GATEWAY_API_KEY_ENV} is not configured; the Merge Gateway pilot fails closed without credentials.`
        : "OPENROUTER_API_KEY is not configured; the writer provider fails closed without credentials.",
    );
  }
  return apiKey;
}

/**
 * Run one bounded writer invocation under full budget governance:
 * authority guard (registry-issued pilot grant or champion path) ->
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
  const pilotActive = isMergePilotRequested(env);
  const effectiveProvider = pilotActive ? MERGE_PILOT_PROVIDER : policy.gateway;

  // P0-01 MergePilotAuthorityGuard: registry-issued grant BEFORE any budget
  // reservation. Env alone (FACTORY_LLM_PROVIDER=merge) is intent, not
  // authority; solid refusal here kills every downstream path.
  const pilotGrant = pilotActive
    ? await resolvePilotGrant({
        db: deps.db ?? failClosedDb(),
        projectId: request.projectId,
        runId: deps.pilotRunId ?? throwMissingPilotRunId(),
        role: WRITER_ROLE_ID,
        env,
      })
    : null;

  // 1. Credential preflight BEFORE any reservation or provider call.
  assertWriterCredentialAvailable({ loadApiKey: deps.invoke ? () => "test-key" : undefined });

  // 2. Conservative authorization bound (fail closed on unpriced models).
  const policyEstimatedMicros =
    deps.authorizedMicrosOverride ??
    calculateConservativeInvocationCostMicros({
      model: resolved.model,
      provider: effectiveProvider,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
    });

  // P0-02: pilot reservations go through the UNIFIED pilot budget (shared
  // ceiling across writer/search/competitor roles). Champion path keeps the
  // ordinary writer daily-limit semantics.
  const invocationDigest = deterministicWriterInvocationDigest({
    promptSnapshotDigest: request.promptSnapshotDigest,
    promptSnapshotRevision: request.promptSnapshotRevision,
    model: resolved.model,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
  });

  const reservation = pilotGrant
    ? await reservePilotBudget({
        grant: pilotGrant,
        ledger: "writer",
        model: resolved.model,
        authorizedMicros: policyEstimatedMicros,
        invocationDigest,
        role: WRITER_ROLE_ID,
        lineage: {
          kind: "writer_proposal",
          projectId: request.projectId,
          promptSnapshotDigest: request.promptSnapshotDigest,
          promptSnapshotRevision: request.promptSnapshotRevision,
        },
      }, { db: deps.db })
    : await deps.budget.reserveWriterBudget(
        {
          provider: effectiveProvider,
          model: resolved.model,
          authorizedMicros: policyEstimatedMicros,
          invocationDigest,
          lineage: {
            kind: "writer_proposal",
            projectId: request.projectId,
            promptSnapshotDigest: request.promptSnapshotDigest,
            promptSnapshotRevision: request.promptSnapshotRevision,
            overrideApplied: resolved.overrideApplied,
            overriddenChampion: resolved.overrideApplied ? resolved.championModel : null,
          },
        },
        deps.dailyLimitUsd ??
          (env["FACTORY_WRITER_DAILY_LIMIT_USD"] ? Number(env["FACTORY_WRITER_DAILY_LIMIT_USD"]) : undefined),
      );

  // Provider call with full settlement semantics. The pilot routes via the
  // guard-backed Merge Gateway adapter (grant-verified pre-HTTP).
  const invoke = deps.invoke
    ? (deps.invoke as unknown as (req: ModelCallRequest) => Promise<ModelCallResult>)
    : pilotGrant
      ? (req: ModelCallRequest) => invokeModelViaMerge(pilotGrant, req, { db: deps.db })
      : invokeModel;
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
      deps.invoke
        ? { fetchImpl: async () => { throw new Error("fixture gateway must not hit network"); } }
        : {},
    );
    // P1-04 cost decomposition (three distinct figures):
    // - providerReportedMicros: cost reported by Merge in usage.cost.
    // - policyEstimatedMicros: Factory's conservative token x rate estimate.
    // - accountedMicros: what the durable ledger actually records, by the
    //   documented accounting rule (max of trusted signals; never 0 for a
    //   real invocation; full authorized amount when nothing is trusted).
    const providerReportedMicros =
      result.costUsd != null && Number.isFinite(result.costUsd) && result.costUsd >= 0
        ? Math.round(result.costUsd * 1_000_000)
        : null;
    const tokenPolicyMicros =
      result.promptTokens == null || result.completionTokens == null
        ? null
        : calculateInvocationActualCostMicros({
            model: resolved.model,
            provider: effectiveProvider,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          });
    const accountedMicros = computeAccountedCostMicros({
      providerReportedMicros,
      policyEstimatedMicros: tokenPolicyMicros ?? policyEstimatedMicros,
      fullyTrustedEstimateAvailable: tokenPolicyMicros != null,
    });
    await reservation.account(accountedMicros);
    const costBreakdown: InvocationCostBreakdown = {
      providerReportedMicros,
      policyEstimatedMicros,
      accountedMicros,
      accountingBasis: providerReportedMicros != null
        ? "provider_reported_or_policy_estimate"
        : tokenPolicyMicros != null
          ? "policy_estimate"
          : "unknown_cost_conservative_full",
      discrepancyMicros:
        providerReportedMicros != null && tokenPolicyMicros != null
          ? accountedMicros - providerReportedMicros
          : null,
    };
    return {
      content: result.content,
      model: resolved.model,
      overrideApplied: resolved.overrideApplied,
      overriddenChampion: resolved.overrideApplied ? resolved.championModel : null,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
      costBreakdown,
      requestDigest: result.requestDigest ?? null,
      responseDigest: result.responseDigest ?? null,
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
    // Post-submission gateway/HTTP failures: keep the specific bounded cause
    // (classification, HTTP status, timeout class) attached for operators —
    // no secrets, no prompt material, no provider-internal payloads.
    const status = error instanceof Error && "httpStatus" in error ? (error as { httpStatus?: number | null }).httpStatus : null;
    const detail = error.message.slice(0, 180);
    const summary = error.requestSubmitted
      ? ` (code=${error.code}${status != null ? ` status=${status}` : ""})`
      : ` (code=${error.code})`;
    const mapped = new FactoryError("writer_provider_unavailable", `Writer provider invocation failed.${summary}`);
    (mapped as Error & { cause?: unknown }).cause = new Error(detail);
    return mapped;
  }
  if (error instanceof FactoryError) return error;
  const detail = error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
  const mapped = new FactoryError("writer_provider_unavailable", `Writer provider invocation failed. (${detail})`);
  (mapped as Error & { cause?: unknown }).cause = error instanceof Error ? error : new Error(detail);
  return mapped;
}

export { preserveInvocationCost };
