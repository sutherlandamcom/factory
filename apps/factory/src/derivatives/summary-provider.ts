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
import { InvocationFailure } from "../models/invocation-failure.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { WriterBudgetStore } from "../writer/budget.js";

/**
 * SUMMARY PROVIDER BOUNDARY — Run 10.
 *
 * Reuses the EXISTING approved text-model infrastructure (OpenRouter gateway
 * + governed MODEL_ROLE_POLICY + budget reservation + cost telemetry) with a
 * new narrowly scoped `page_summarizer` role. No new SDK, no parallel
 * provider abstraction. The role may only summarize exact AcceptedPageContent.
 *
 * Tests and CI always inject a fixture `invoke` — zero paid calls.
 */

export const SUMMARY_ROLE_ID: FactoryRoleId = "page_summarizer";

/** Conservative bounded output ceiling for one summary invocation (tokens). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

export interface SummaryInvocationRequest {
  /** Exact SummaryPromptSnapshot digest (budget lineage binding). */
  promptSnapshotDigest: string;
  projectId: string;
  pageIdentity: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface SummaryInvocationResult {
  content: string;
  model: string;
  providerRequestId: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
}

export interface SummaryProviderDeps {
  budget: WriterBudgetStore;
  /** Daily limit override (tests); production reads FACTORY_SUMMARIZER_DAILY_LIMIT_USD. */
  dailyLimitUsd?: number;
  /** Gateway invocation override (tests inject fixtures here; zero paid calls). */
  invoke?: typeof invokeModel;
  /** Env override for resolution/testing. */
  env?: Record<string, string | undefined>;
  /** Conservative authorization override (tests). */
  authorizedMicrosOverride?: number;
}

/** Resolve the effective summarizer model through the governed policy seam. */
export function resolveSummaryModel(env: Record<string, string | undefined> = process.env) {
  const resolved = resolveRoleModel(SUMMARY_ROLE_ID, env);
  return {
    ...resolved,
    policy: MODEL_ROLE_POLICY[SUMMARY_ROLE_ID as keyof typeof MODEL_ROLE_POLICY],
  };
}

/** Credential preflight: missing/unusable credential -> typed failure, zero provider calls. */
export function assertSummaryCredentialAvailable(deps: { loadApiKey?: () => string | null } = {}): string {
  const loader = deps.loadApiKey ?? (() => process.env["OPENROUTER_API_KEY"]?.trim() ?? null);
  const apiKey = loader();
  if (apiKey === null || apiKey.trim().length === 0) {
    throw new FactoryError(
      "summary_provider_not_configured",
      "OPENROUTER_API_KEY is not configured; the summary provider fails closed without credentials.",
    );
  }
  return apiKey;
}

/** Deterministic digest binding the exact authorized summary invocation. */
export function deterministicSummaryInvocationDigest(input: {
  promptSnapshotDigest: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}): string {
  return deterministicDigest(input);
}

/**
 * Run one bounded summary invocation under full budget governance:
 * preflight (credential + conservative authorization) -> reservation ->
 * provider call -> settlement. The invocation digest binds authorized ==
 * executed. Never retries blindly; failures propagate for classification.
 */
export async function runSummaryInvocation(
  request: SummaryInvocationRequest,
  deps: SummaryProviderDeps,
): Promise<SummaryInvocationResult> {
  const env = deps.env ?? process.env;
  const resolved = resolveSummaryModel(env);
  const policy = MODEL_ROLE_POLICY[SUMMARY_ROLE_ID as keyof typeof MODEL_ROLE_POLICY];

  // 1. Credential preflight BEFORE any reservation or provider call.
  assertSummaryCredentialAvailable({ loadApiKey: deps.invoke ? () => "test-key" : undefined });

  // 2. Conservative authorization bound (fail closed on unpriced models).
  const authorizedMicros =
    deps.authorizedMicrosOverride ??
    calculateConservativeInvocationCostMicros({
      model: resolved.model,
      provider: policy.gateway,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

  // 3. Invocation digest: binds the authorized call to the executed call.
  const invocationDigest = deterministicSummaryInvocationDigest({
    promptSnapshotDigest: request.promptSnapshotDigest,
    model: resolved.model,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });

  // 4. Durable budget reservation (fail closed when blocked).
  const dailyLimitUsd =
    deps.dailyLimitUsd ??
    (env["FACTORY_SUMMARIZER_DAILY_LIMIT_USD"] ? Number(env["FACTORY_SUMMARIZER_DAILY_LIMIT_USD"]) : undefined);
  const reservation = await deps.budget.reserveWriterBudget(
    {
      provider: policy.gateway,
      model: resolved.model,
      authorizedMicros,
      invocationDigest,
      lineage: {
        kind: "derivative_summary",
        projectId: request.projectId,
        pageIdentity: request.pageIdentity,
        promptSnapshotDigest: request.promptSnapshotDigest,
        overrideApplied: resolved.overrideApplied,
        overriddenChampion: resolved.overrideApplied ? resolved.championModel : null,
      },
    },
    dailyLimitUsd,
  );

  // 5. Provider call with full settlement semantics.
  const invoke = deps.invoke ?? invokeModel;
  try {
    const result: ModelCallResult = await invoke(
      {
        roleId: SUMMARY_ROLE_ID,
        model: resolved.model,
        systemPrompt: request.systemPrompt,
        prompt: request.userPrompt,
        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        timeoutMs: policy.timeoutMs,
      },
      deps.invoke ? { fetchImpl: async () => { throw new Error("fixture gateway must not hit network"); } } : {},
    );
    const actualMicros =
      result.promptTokens == null || result.completionTokens == null
        ? null
        : calculateInvocationActualCostMicros({
            model: resolved.model,
            provider: policy.gateway,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          });
    await reservation.account(actualMicros);
    return {
      content: result.content,
      model: resolved.model,
      providerRequestId: `sum_${invocationDigest.slice(0, 24)}`,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
    };
  } catch (error) {
    if (error instanceof InvocationFailure) {
      if (!error.requestSubmitted) {
        await reservation.releaseUnexecuted();
      } else {
        await reservation.account(error.trustedCostMicros);
      }
    } else {
      await reservation.account(null);
    }
    throw error;
  }
}
