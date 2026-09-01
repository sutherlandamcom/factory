import {
  MAX_BLUEPRINT_MODEL_OUTPUT_BYTES,
  MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS,
  SITE_BLUEPRINT_METHODOLOGY_VERSION,
  parseBlueprintResult,
  parseResearchEvidenceBundle,
  parseSiteBlueprint,
  parseSiteIntelligencePlan,
  parseSiteIntelligenceRequest,
  type BlueprintArtifacts,
  type BlueprintError,
  type BlueprintErrorCode,
  type BlueprintResult,
  type ModelInvocation,
  type SiteBlueprint,
} from "@factory/contracts";
import { resolveFactorySourceCommit, type FactorySourceProvenance } from "../intelligence/driver.js";
import { canonicalJsonStringify, deterministicDigest } from "../intelligence/digest.js";
import { validateSiteIntelligencePlan } from "../intelligence/plan-validation.js";
import { normalizeResearchBundle } from "../intelligence/normalize.js";
import { parseModelPlanOutput } from "../intelligence/synthesis.js";
import { FactoryError } from "../executor/errors.js";
import {
  ModelCallError,
  invokeModel,
  loadOpenRouterApiKey,
  scrubCredentials,
  type ModelCallRequest,
  type ModelCallResult,
} from "../models/gateway.js";
import {
  FACTORY_MODEL_POLICY_VERSION,
  MODEL_ROLE_POLICY,
  mayReceiveProprietaryData,
  resolveModelSequence,
  type ModelRolePolicy,
} from "../models/policy.js";
import {
  buildArtifactDigests,
  generateRunId,
  prepareRunDirectory,
  publishJsonAtomically,
  randomRunIdSuffix,
  verifyArtifactIntegrity,
  writeArtifact,
} from "./artifacts.js";
import { buildBlueprintPrompt, buildBlueprintRepairPrompt } from "./prompt.js";
import { validateSiteBlueprint } from "./validation.js";

/**
 * Blueprint vertical-slice driver.
 *
 * accepted/candidate-valid SiteIntelligencePlan + SiteIntelligenceRequest
 *   + normalized ResearchEvidenceBundle
 *   → strict validation of ALL inputs (the base plan must itself pass the
 *     accepted Intelligence quality gates — defense in depth)
 *   → source provenance + credential availability fail closed
 *   → gateway synthesis through the Factory role policy (bounded repair,
 *     explicit champion→challenger fallback, exact model provenance)
 *   → strict blueprint validation (IA preservation, provenance, readiness)
 *   → atomic artifact publication (definitive result LAST)
 *   → structured BlueprintResult
 *
 * Never throws for run-level failures: every terminal outcome is a
 * structured BlueprintResult. Never reports success unless every gate
 * passed and artifacts were published and verified.
 */

export type ModelInvoker = (request: ModelCallRequest) => Promise<ModelCallResult>;

export interface RunBlueprintInput {
  repoRoot: string;
  planInput: unknown;
  requestInput: unknown;
  researchInput: unknown;
}

export interface RunBlueprintDeps {
  /** Injected role policy (defaults to the authoritative blueprint_architect policy). */
  policy?: ModelRolePolicy;
  /** Injectable gateway invoker (defaults to the OpenRouter adapter). */
  invoker?: ModelInvoker;
  now?: () => Date;
  runIdSuffix?: () => string;
  sourceCommitResolver?: (repoRoot: string) => Promise<FactorySourceProvenance>;
  /** Progress diagnostics (stderr for the CLI; never evidence dumps). */
  onProgress?: (message: string) => void;
}

function boundedMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Defensive credential scrubbing (URL credentials, bearer tokens, key
  // shapes) before any message can reach results or artifacts.
  return scrubCredentials(raw).slice(0, 500);
}

function tryCanonicalJson(raw: string): string | null {
  try {
    return canonicalJsonStringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function runBlueprint(
  input: RunBlueprintInput,
  deps: RunBlueprintDeps = {},
): Promise<BlueprintResult> {
  const onProgress = deps.onProgress ?? (() => undefined);
  const policy = deps.policy ?? MODEL_ROLE_POLICY.blueprint_architect;
  const runId = generateRunId(deps.now?.() ?? new Date(), deps.runIdSuffix?.() ?? randomRunIdSuffix());
  const runDirectoryRelative = `.factory/blueprint/${runId}`;

  let attemptCount = 0;
  let siteId: string | null = null;
  let requestDigest: string | null = null;
  let researchDigest: string | null = null;
  let planDigest: string | null = null;
  let blueprintDigest: string | null = null;
  let factorySourceCommit: string | null = null;
  let artifacts: BlueprintArtifacts | null = null;
  const invocations: ModelInvocation[] = [];
  const warnings: string[] = [];
  let acceptedBlueprint: SiteBlueprint | null = null;

  const finish = (status: BlueprintResult["status"], error: BlueprintError | null): BlueprintResult => {
    const accepted = invocations.length > 0 ? invocations[invocations.length - 1]! : null;
    // The accepted invocation is the LAST successful invocation that produced
    // the accepted artifact; on failure paths the last invocation is still
    // recorded for provenance but modelInvocation stays null unless succeeded.
    const acceptedInvocation = status === "succeeded" ? accepted : null;
    const pageCount = acceptedBlueprint?.pages.length ?? 0;
    return parseBlueprintResult({
      version: "v0",
      status,
      runId,
      siteId,
      factorySourceCommit,
      methodologyVersion: SITE_BLUEPRINT_METHODOLOGY_VERSION,
      requestDigest,
      researchDigest,
      planDigest,
      blueprintDigest,
      attemptCount,
      modelInvocation: acceptedInvocation,
      modelInvocations: invocations.slice(0, 10),
      artifacts,
      pageCount,
      readyCount: acceptedBlueprint?.pages.filter((page) => page.readiness === "ready").length ?? 0,
      blockedCount: acceptedBlueprint?.pages.filter((page) => page.readiness === "blocked").length ?? 0,
      warnings: warnings.slice(0, 50),
      error,
    });
  };

  try {
    // --- 1. Input validation: the base plan must pass the accepted gates ---
    let plan: ReturnType<typeof parseSiteIntelligencePlan>;
    try {
      plan = parseSiteIntelligencePlan(input.planInput);
    } catch (error) {
      return finish("failed", { code: "blueprint_plan_invalid", message: boundedMessage(error) });
    }
    let request: ReturnType<typeof parseSiteIntelligenceRequest>;
    try {
      request = parseSiteIntelligenceRequest(input.requestInput);
    } catch (error) {
      return finish("failed", { code: "blueprint_input_invalid", message: boundedMessage(error) });
    }
    let research: ReturnType<typeof parseResearchEvidenceBundle>;
    try {
      research = parseResearchEvidenceBundle(input.researchInput);
    } catch (error) {
      return finish("failed", { code: "blueprint_research_invalid", message: boundedMessage(error) });
    }
    siteId = request.siteId;
    if (plan.siteId !== request.siteId) {
      return finish("failed", {
        code: "blueprint_plan_invalid",
        message: `plan siteId "${plan.siteId}" does not match request siteId "${request.siteId}"`,
      });
    }
    onProgress(`inputs validated: siteId=${request.siteId}, plan pages=${plan.pages.length}`);

    // --- 2. Normalization + digests -----------------------------------------
    const normalized = normalizeResearchBundle(research);
    requestDigest = deterministicDigest(request);
    researchDigest = deterministicDigest(normalized);
    planDigest = deterministicDigest(plan);

    // Defense in depth: the incoming plan must satisfy the accepted
    // Intelligence deterministic gates, not merely the Zod schema.
    const planValidation = validateSiteIntelligencePlan(plan, { request, research: normalized });
    if (!planValidation.ok) {
      return finish("failed", {
        code: "blueprint_plan_invalid",
        message: `incoming plan failed the accepted Intelligence quality gates (${planValidation.issues.length} issue(s); first: ${planValidation.issues[0] ?? "unknown"})`,
      });
    }

    // --- 3. Source provenance (fail closed BEFORE any model work) -----------
    let source: FactorySourceProvenance;
    try {
      source = await (deps.sourceCommitResolver ?? resolveFactorySourceCommit)(input.repoRoot);
    } catch (error) {
      return finish("failed", {
        code: "blueprint_source_unverified",
        message: `factory source provenance could not be verified: ${boundedMessage(error)}`,
      });
    }
    if (!source.ok) {
      return finish("failed", { code: "blueprint_source_unverified", message: source.reason });
    }
    factorySourceCommit = source.commit;
    onProgress(`factorySourceCommit=${factorySourceCommit}`);

    // --- 4. Sensitive-data policy gate (fail closed BEFORE any model work) ---
    // The Blueprint planning input set (request + research + accepted plan)
    // is proprietary/unpublished material at the model boundary. A role
    // policy not permitted to receive proprietary data must never see it:
    // zero invocations, zero model-call artifacts.
    if (!mayReceiveProprietaryData(policy)) {
      return finish("failed", {
        code: "blueprint_policy_violation",
        message: `role ${policy.roleId} has sensitiveDataPolicy "${policy.sensitiveDataPolicy}" but the Blueprint planning inputs contain proprietary/unpublished material; no model invocation was performed`,
      });
    }

    // --- 5. Credential availability (fail closed) ----------------------------
    const invoker: ModelInvoker =
      deps.invoker ??
      (async (request: ModelCallRequest) => {
        const result = await invokeModel(request);
        return result;
      });
    if (deps.invoker === undefined && loadOpenRouterApiKey() === null) {
      return finish("failed", {
        code: "blueprint_credentials_unavailable",
        message:
          "OPENROUTER_API_KEY is not configured; blueprint synthesis fails closed without gateway credentials",
      });
    }

    // --- 5. Fresh artifact root ----------------------------------------------
    let runDir: string;
    try {
      runDir = await prepareRunDirectory(input.repoRoot, runId);
    } catch (error) {
      return finish("failed", { code: "blueprint_artifact_failed", message: boundedMessage(error) });
    }
    artifacts = { runDirectory: runDirectoryRelative, manifest: null, blueprint: null, result: null };

    // --- 6. Intermediate artifacts -------------------------------------------
    await writeArtifact(runDir, "request.json", `${JSON.stringify(request, null, 2)}\n`);
    await writeArtifact(runDir, "accepted-plan.json", `${JSON.stringify(plan, null, 2)}\n`);
    await writeArtifact(runDir, "normalized-research.json", `${JSON.stringify(normalized, null, 2)}\n`);
    await writeArtifact(runDir, "request-digest.txt", `${requestDigest}\n`);
    await writeArtifact(runDir, "research-digest.txt", `${researchDigest}\n`);
    await writeArtifact(runDir, "plan-digest.txt", `${planDigest}\n`);

    // --- 7. Bounded synthesis through the role policy -------------------------
    const promptInput = { plan, request, research: normalized };
    const modelSequence = resolveModelSequence(policy);
    if (modelSequence.length < 1) {
      return finish("failed", {
        code: "blueprint_policy_violation",
        message: `role ${policy.roleId} policy defines no models`,
      });
    }

    const recordInvocation = (
      result: ModelCallResult | null,
      requestedModel: string,
      startedAt: number,
      fallback: boolean,
      failure?: { code: BlueprintErrorCode; message: string },
    ): void => {
      invocations.push({
        roleId: policy.roleId,
        requestedModel,
        respondedModel: result?.respondedModel ?? null,
        provider: result?.provider ?? null,
        gateway: "openrouter",
        policyVersion: FACTORY_MODEL_POLICY_VERSION,
        durationMs: failure ? Math.max(0, Date.now() - startedAt) : (result?.durationMs ?? 0),
        promptTokens: result?.promptTokens ?? null,
        completionTokens: result?.completionTokens ?? null,
        totalTokens: result?.totalTokens ?? null,
        costUsd: result?.costUsd ?? null,
        fallback,
      });
      if (failure) {
        warnings.push(`${requestedModel}: ${failure.code} — ${failure.message.slice(0, 200)}`);
      }
    };

    let previousRaw: string | null = null;
    let previousCanonical: string | null = null;
    let repairIssues: string[] | null = null;
    let modelIndex = 0;
    let lastSequenceFailureCode: BlueprintErrorCode | null = null;
    let blueprint: SiteBlueprint | null = null;

    try {
      for (let attemptNumber = 1; attemptNumber <= Math.min(policy.maxAttempts, MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS); attemptNumber++) {
        attemptCount = attemptNumber;
        const prompt =
          repairIssues !== null && previousRaw !== null
            ? buildBlueprintRepairPrompt(promptInput, previousRaw, repairIssues)
            : buildBlueprintPrompt(promptInput);
        await writeArtifact(runDir, `attempts/${attemptNumber}/prompt.txt`, prompt);

        // Invocation with explicit champion→challenger fallback. Credentials
        // and policy errors are terminal (never fallback); model failures and
        // timeouts advance to the next EXPLICIT model in the role sequence.
        let callResult: ModelCallResult | null = null;
        while (modelIndex < modelSequence.length) {
          const model = modelSequence[modelIndex]!;
          const startedAt = Date.now();
          try {
            onProgress(`invoking ${model} (attempt ${attemptNumber})`);
            callResult = await invoker({
              roleId: policy.roleId,
              model,
              systemPrompt: DEFAULT_SYSTEM_PROMPT,
              prompt,
              // An accepted 8-page blueprint legitimately serializes to
              // ~45KB of strict JSON; the gateway default (16k tokens)
              // truncates it mid-document. Give the planning role an
              // explicit bounded completion ceiling well under the
              // MAX_BLUEPRINT_MODEL_OUTPUT_BYTES byte cap (32k tokens
              // ≈ 80-100KB of JSON).
              maxTokens: 32_000,
              timeoutMs: policy.timeoutMs,
            });
            recordInvocation(callResult, model, startedAt, modelIndex > 0);
            break;
          } catch (error) {
            if (error instanceof ModelCallError) {
              if (error.code === "credentials_unavailable" || error.code === "policy_violation") {
                recordInvocation(null, model, startedAt, modelIndex > 0, {
                  code: error.code === "credentials_unavailable"
                    ? "blueprint_credentials_unavailable"
                    : "blueprint_policy_violation",
                  message: boundedMessage(error),
                });
                return finish("failed", {
                  code: error.code === "credentials_unavailable"
                    ? "blueprint_credentials_unavailable"
                    : "blueprint_policy_violation",
                  message: boundedMessage(error),
                });
              }
              const isTimeout = error.code === "model_timeout";
              lastSequenceFailureCode = isTimeout ? "blueprint_model_timeout" : "blueprint_model_failed";
              recordInvocation(null, model, startedAt, modelIndex > 0, {
                code: lastSequenceFailureCode,
                message: boundedMessage(error),
              });
              modelIndex++;
              continue;
            }
            lastSequenceFailureCode = "blueprint_model_failed";
            recordInvocation(null, model, startedAt, modelIndex > 0, {
              code: "blueprint_model_failed",
              message: boundedMessage(error),
            });
            modelIndex++;
            continue;
          }
        }

        if (callResult === null) {
          return finish("failed", {
            code: lastSequenceFailureCode ?? "blueprint_model_failed",
            message: `all ${modelSequence.length} configured model(s) failed for role ${policy.roleId}`,
          });
        }

        const rawOutput = callResult.content;
        const rawOutputBytes = Buffer.byteLength(rawOutput, "utf8");
        const outputOverCap = rawOutputBytes > MAX_BLUEPRINT_MODEL_OUTPUT_BYTES;
        await writeArtifact(
          runDir,
          `attempts/${attemptNumber}/raw-output.txt`,
          outputOverCap
            ? `${rawOutput.slice(0, MAX_BLUEPRINT_MODEL_OUTPUT_BYTES)}\n[truncated: ${rawOutputBytes} bytes exceeded the ${MAX_BLUEPRINT_MODEL_OUTPUT_BYTES}-byte output cap]\n`
            : rawOutput,
        );
        onProgress(`attempt ${attemptNumber} completed (${rawOutputBytes} bytes)`);

        // No-progress detection over already-invalid attempts.
        const currentCanonical = tryCanonicalJson(rawOutput);
        if (previousRaw !== null) {
          const rawIdentical = rawOutput === previousRaw;
          const canonicalIdentical =
            currentCanonical !== null && previousCanonical !== null && currentCanonical === previousCanonical;
          if (rawIdentical || canonicalIdentical) {
            return finish("needs_review", {
              code: "blueprint_no_progress",
              message: `attempt ${attemptNumber} repeated the previous invalid output without progress`,
            });
          }
        }

        // Strict rejection reasons, applied before JSON acceptance: the raw
        // UTF-8 output cap first, then single-JSON-document parsing.
        let attemptIssue: string | null = outputOverCap
          ? `model output of ${rawOutputBytes} bytes exceeds the ${MAX_BLUEPRINT_MODEL_OUTPUT_BYTES}-byte output cap`
          : null;
        let parsedValue: unknown;
        if (attemptIssue === null) {
          const parsed = parseModelPlanOutput(rawOutput, null);
          if (!parsed.ok) {
            attemptIssue = parsed.error;
          } else {
            parsedValue = parsed.value;
          }
        }
        if (attemptIssue !== null) {
          if (attemptNumber === Math.min(policy.maxAttempts, MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS)) {
            return finish("needs_review", {
              code: "blueprint_attempts_exhausted",
              message: `all ${attemptCount} attempts produced invalid output: ${attemptIssue}`,
            });
          }
          previousRaw = rawOutput;
          previousCanonical = currentCanonical;
          repairIssues = [attemptIssue];
          continue;
        }

        // Bounded strict contract parse + deterministic semantic validation.
        let candidate: SiteBlueprint;
        try {
          candidate = parseSiteBlueprint(parsedValue);
        } catch (error) {
          if (attemptNumber === Math.min(policy.maxAttempts, MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS)) {
            return finish("needs_review", {
              code: "blueprint_attempts_exhausted",
              message: `all ${attemptCount} attempts produced schema-invalid blueprints: ${boundedMessage(error)}`,
            });
          }
          previousRaw = rawOutput;
          previousCanonical = currentCanonical;
          repairIssues = [boundedMessage(error)];
          continue;
        }

        const validation = validateSiteBlueprint(candidate, { plan, request, research: normalized });
        if (!validation.ok) {
          if (attemptNumber === Math.min(policy.maxAttempts, MAX_BLUEPRINT_SYNTHESIS_ATTEMPTS)) {
            return finish("needs_review", {
              code: "blueprint_attempts_exhausted",
              message: `all ${attemptCount} attempts produced invalid blueprints (${validation.issues.length} issue(s); first: ${validation.issues[0] ?? "unknown"})`,
            });
          }
          previousRaw = rawOutput;
          previousCanonical = currentCanonical;
          repairIssues = [...validation.issues];
          continue;
        }

        blueprint = validation.blueprint;
        break;
      }

      if (blueprint === null) {
        return finish("needs_review", {
          code: "blueprint_attempts_exhausted",
          message: "synthesis produced no valid blueprint",
        });
      }

      acceptedBlueprint = blueprint;
      const resolvedBlueprintDigest = deterministicDigest(blueprint);
      blueprintDigest = resolvedBlueprintDigest;
      onProgress("blueprint validated by deterministic gates (IA preserved)");

      // --- 8. Publication: intermediates, manifest, result LAST --------------
      await writeArtifact(runDir, "site-blueprint.json", `${JSON.stringify(blueprint, null, 2)}\n`);

      const manifestFiles = [
        "request.json",
        "accepted-plan.json",
        "normalized-research.json",
        "request-digest.txt",
        "research-digest.txt",
        "plan-digest.txt",
        "site-blueprint.json",
        ...invocations.map((_, index) => `attempts/invocations/${index + 1}.json`),
      ];
      // Persist per-invocation provenance artifacts (no credentials).
      for (let index = 0; index < invocations.length; index++) {
        await writeArtifact(
          runDir,
          `attempts/invocations/${index + 1}.json`,
          `${JSON.stringify(invocations[index], null, 2)}\n`,
        );
      }

      const digests = await buildArtifactDigests(runDir, manifestFiles);
      const manifest = {
        runId,
        siteId: request.siteId,
        status: "succeeded",
        factorySourceCommit,
        methodologyVersion: SITE_BLUEPRINT_METHODOLOGY_VERSION,
        roleId: policy.roleId,
        requestDigest,
        researchDigest,
        planDigest,
        blueprintDigest,
        attemptCount,
        modelInvocations: invocations,
        artifacts: ["manifest.json", "blueprint-result.json", ...manifestFiles],
        pageCount: blueprint.pages.length,
        readyCount: blueprint.pages.filter((page) => page.readiness === "ready").length,
        blockedCount: blueprint.pages.filter((page) => page.readiness === "blocked").length,
        digests,
      };
      await publishJsonAtomically(runDir, "manifest.json", manifest);
      await verifyArtifactIntegrity(runDir, digests, resolvedBlueprintDigest);

      artifacts = {
        runDirectory: runDirectoryRelative,
        manifest: "manifest.json",
        blueprint: "site-blueprint.json",
        result: "blueprint-result.json",
      };
      warnings.push(...blueprint.warnings);
      warnings.push(...blueprint.missingInputs.map((input) => `site missing input: ${input}`));

      const result = finish("succeeded", null);
      await publishJsonAtomically(runDir, "blueprint-result.json", result);
      onProgress(
        `run complete: ${blueprint.pages.length} page(s), ${result.readyCount} ready, ${result.blockedCount} blocked`,
      );
      return result;
    } catch (error) {
      return finish("failed", { code: "blueprint_artifact_failed", message: boundedMessage(error) });
    }
  } catch (error) {
    const code: BlueprintErrorCode =
      error instanceof FactoryError && error.code.startsWith("blueprint_")
        ? (error.code as BlueprintErrorCode)
        : "blueprint_artifact_failed";
    return finish("failed", { code, message: boundedMessage(error) });
  }
}

const DEFAULT_SYSTEM_PROMPT =
  "You are the Factory blueprint architect. Follow the user message exactly: output exactly one strict JSON document and nothing else.";
