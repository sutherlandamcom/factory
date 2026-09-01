import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import {
  parseResearchEvidenceBundle,
  parseSiteIntelligencePlan,
  parseSiteIntelligenceRequest,
  type NormalizedResearchEvidenceBundle,
  type SiteIntelligencePlan,
  type SiteIntelligenceRequest,
} from "@factory/contracts";
import { deterministicDigest } from "../intelligence/digest.js";
import { buildSynthesisPrompt } from "../intelligence/prompt.js";
import { buildBlueprintPrompt } from "../blueprint/prompt.js";
import {
  ModelCallError,
  invokeModel,
  listOpenRouterModels,
  type FetchLike,
  type ModelCallRequest,
  type OpenRouterModelSummary,
} from "../models/gateway.js";
import { FactoryError } from "../executor/errors.js";
import { buildArtifactDigests, publishJsonAtomically, writeArtifact } from "../blueprint/artifacts.js";
import { MODEL_ROLE_POLICY, mayReceiveProprietaryData, type ModelRolePolicy } from "../models/policy.js";
import {
  parseJudgeVerdict,
  type EvalCandidateSummary,
  type EvalJudgeSummary,
  type EvalResult,
  type EvalRoleId,
  type JudgeVerdict,
} from "./contracts.js";
import {
  buildContentTask,
  buildDesignTask,
  buildJudgeTask,
  inputDigests,
  runDeterministicGate,
  type RoleTaskContext,
} from "./tasks.js";

/**
 * Autonomy v0 bake-off runner.
 *
 * Three layers of evaluation (mission §18), all Factory-owned:
 *   1. deterministic Factory gates (the SAME accepted validators)
 *   2. blind rubric judging by two different judge models
 *   3. human-readable evidence artifacts under .factory/evals/
 *
 * Candidate discovery inspects CURRENT gateway availability at runtime —
 * stale model ids are never trusted. The same real inputs go to every
 * candidate; families differ only by model. Cost is bounded by
 * FACTORY_EVAL_BUDGET_USD (default 25 USD) and every invocation's cost is
 * recorded from gateway usage accounting.
 */

const FAMILY_PREFIXES: ReadonlyArray<{ family: "openai" | "anthropic" | "google"; prefix: string; envOverride: string }> =
  [
    { family: "openai", prefix: "openai/", envOverride: "FACTORY_EVAL_MODEL_OPENAI" },
    { family: "anthropic", prefix: "anthropic/", envOverride: "FACTORY_EVAL_MODEL_ANTHROPIC" },
    { family: "google", prefix: "google/", envOverride: "FACTORY_EVAL_MODEL_GOOGLE" },
  ];

const MIN_CONTEXT_TOKENS = 100_000;
const LABELS = ["A", "B", "C"] as const;

export interface RunRoleEvalOptions {
  roleId: EvalRoleId;
  requestInput: unknown;
  researchInput: unknown;
  planInput?: unknown;
  pageSlug?: string;
  onProgress?: (message: string) => void;
  /** Injectable gateway transport (tests); defaults to the real OpenRouter adapter. */
  gatewayDeps?: { fetchImpl?: FetchLike; loadApiKey?: () => string | null };
  /** Injectable role policy for the sensitive-data gate (tests); defaults to the authoritative policy. */
  policyOverride?: ModelRolePolicy;
}

function evalBudgetCapUsd(): number {
  const raw = process.env.FACTORY_EVAL_BUDGET_USD;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

interface CandidateSelection {
  family: "openai" | "anthropic" | "google";
  model: string;
  source: "operator-override" | "discovered-newest";
}

function selectCandidates(models: OpenRouterModelSummary[]): CandidateSelection[] {
  const selections: CandidateSelection[] = [];
  for (const familySpec of FAMILY_PREFIXES) {
    const override = process.env[familySpec.envOverride];
    if (override && override.trim().length > 0) {
      selections.push({ family: familySpec.family, model: override.trim(), source: "operator-override" });
      continue;
    }
    const eligible = models
      .filter((model) => model.id.startsWith(familySpec.prefix))
      .filter((model) => !model.id.includes(":free"))
      .filter((model) => (model.contextLength ?? 0) >= MIN_CONTEXT_TOKENS)
      // Newest first: current flagship generation, not stale ids.
      .sort((left, right) => (right.created ?? 0) - (left.created ?? 0));
    const chosen = eligible[0];
    if (chosen) {
      selections.push({ family: familySpec.family, model: chosen.id, source: "discovered-newest" });
    }
  }
  return selections;
}

export async function runRoleEval(
  repoRoot: string,
  options: RunRoleEvalOptions,
): Promise<EvalResult> {
  const onProgress = options.onProgress ?? (() => undefined);
  const runId = `eval-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${Math.random().toString(16).slice(2, 10)}`;
  const runDir = path.join(repoRoot, ".factory", "evals", "autonomy-v0", runId);
  const budgetCap = evalBudgetCapUsd();
  const warnings: string[] = [];
  let totalCostUsd = 0;

  const failure = (code: string, message: string): EvalResult => ({
    version: "v0",
    status: "failed",
    runId,
    roleId: options.roleId,
    inputDigests: {},
    candidates: [],
    judges: [],
    winner: null,
    totalCostUsd,
    budgetUsdCap: budgetCap,
    warnings: warnings.slice(0, 20),
    error: { code, message: message.slice(0, 1000) },
  });

  try {
    // --- 1. Inputs -----------------------------------------------------------
    let request: SiteIntelligenceRequest;
    try {
      request = parseSiteIntelligenceRequest(options.requestInput);
    } catch (error) {
      return failure("eval_input_invalid", `request invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    let researchRaw: ReturnType<typeof parseResearchEvidenceBundle>;
    try {
      researchRaw = parseResearchEvidenceBundle(options.researchInput);
    } catch (error) {
      return failure("eval_input_invalid", `research invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { normalizeResearchBundle } = await import("../intelligence/normalize.js");
    const research: NormalizedResearchEvidenceBundle = normalizeResearchBundle(researchRaw);
    let plan: SiteIntelligencePlan | undefined;
    if (options.planInput !== undefined) {
      try {
        plan = parseSiteIntelligencePlan(options.planInput);
      } catch (error) {
        return failure("eval_input_invalid", `plan invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const context: RoleTaskContext = { request, research, plan };
    const digests = inputDigests(context);

    // Sensitive-data gate: evaluation inputs include the proprietary
    // request/research/plan material. A role policy not permitted to receive
    // proprietary data must never see it — zero invocations, zero artifacts.
    const rolePolicy = options.policyOverride ?? MODEL_ROLE_POLICY[options.roleId];
    if (!mayReceiveProprietaryData(rolePolicy)) {
      return failure(
        "eval_policy_violation",
        `role ${options.roleId} has sensitiveDataPolicy "${rolePolicy.sensitiveDataPolicy}" but evaluation inputs contain proprietary/unpublished material; no model invocation was performed`,
      );
    }

    // --- 2. Fresh run directory ---------------------------------------------
    await mkdir(runDir, { recursive: true });
    const existing = await lstat(runDir);
    if (!existing.isDirectory()) {
      return failure("eval_artifact_failed", "eval run directory is not a directory");
    }
    await writeArtifact(runDir, "input-digests.json", `${JSON.stringify(digests, null, 2)}\n`);

    // --- 3. Candidate discovery (current gateway truth) ----------------------
    const models = await listOpenRouterModels(options.gatewayDeps ?? {});
    const selections = selectCandidates(models);
    if (selections.length === 0) {
      return failure("eval_no_candidates", "no eligible candidate models discovered on the gateway");
    }
    await writeArtifact(
      runDir,
      "candidate-selection.json",
      `${JSON.stringify({ selections, discovered: models.length }, null, 2)}\n`,
    );
    onProgress(`candidates: ${selections.map((selection) => `${selection.family}=${selection.model}`).join(", ")}`);

    // --- 4. Per-candidate invocation + deterministic gates --------------------
    const candidates: EvalCandidateSummary[] = [];
    const rawOutputs: Array<{ label: (typeof LABELS)[number]; output: string }> = [];
    const gateResults: Array<{ label: (typeof LABELS)[number]; ok: boolean; issueCount: number }> = [];

    const buildTask = (): { systemPrompt: string; prompt: string; maxTokens: number } => {
      if (options.roleId === "site_intelligence") {
        // The EXACT accepted production synthesis prompt (fairness).
        const prompt = buildSynthesisPrompt(request, research);
        return { systemPrompt: "You are the Factory site intelligence planner. Follow the user message exactly.", prompt, maxTokens: 32_000 };
      }
      if (options.roleId === "blueprint_architect") {
        if (!plan) {
          throw new FactoryError("eval_input_invalid", "blueprint_architect evaluation requires an accepted plan input");
        }
        const prompt = buildBlueprintPrompt({ plan, request, research });
        return { systemPrompt: "You are the Factory blueprint architect. Follow the user message exactly.", prompt, maxTokens: 32_000 };
      }
      if (options.roleId === "content_writer") {
        const task = buildContentTask(context, options.pageSlug);
        return { systemPrompt: task.systemPrompt, prompt: task.prompt, maxTokens: task.maxTokens };
      }
      const task = buildDesignTask(context);
      return { systemPrompt: task.systemPrompt, prompt: task.prompt, maxTokens: task.maxTokens };
    };

    const task = buildTask();

    for (let index = 0; index < selections.length; index++) {
      const selection = selections[index]!;
      const label = LABELS[index]!;
      const startedAt = Date.now();
      let summary: EvalCandidateSummary = {
        label,
        family: selection.family,
        model: selection.model,
        respondedModel: null,
        provider: null,
        schemaValid: false,
        deterministicValid: false,
        issueCount: 1,
        firstIssue: "not invoked",
        outputDigest: null,
        durationMs: 0,
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
        invocationError: null,
      };

      try {
        const callRequest: ModelCallRequest = {
          roleId: options.roleId,
          model: selection.model,
          systemPrompt: task.systemPrompt,
          prompt: task.prompt,
          maxTokens: task.maxTokens,
          timeoutMs: MODEL_ROLE_POLICY.content_critic.timeoutMs,
        };
        const result = await invokeModel(callRequest, options.gatewayDeps ?? {});
        const cost = result.costUsd ?? 0;
        totalCostUsd += cost;
        const gate = runDeterministicGate(options.roleId, result.content, context);
        summary = {
          ...summary,
          respondedModel: result.respondedModel,
          provider: result.provider,
          schemaValid: gate.ok || (gate.firstIssue !== null && !gate.firstIssue.includes("is not a single valid JSON")),
          deterministicValid: gate.ok,
          issueCount: gate.issueCount,
          firstIssue: gate.firstIssue,
          outputDigest: gate.outputDigest,
          durationMs: result.durationMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: result.costUsd,
          invocationError: null,
        };
        rawOutputs.push({ label, output: result.content });
        gateResults.push({ label, ok: gate.ok, issueCount: gate.issueCount });
        await writeArtifact(runDir, `candidates/${label}/raw-output.txt`, result.content);
        await writeArtifact(runDir, `candidates/${label}/gate.json`, `${JSON.stringify({ ok: gate.ok, issueCount: gate.issueCount, firstIssue: gate.firstIssue }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof ModelCallError ? error.message : String(error);
        summary = {
          ...summary,
          issueCount: 1,
          firstIssue: message.slice(0, 300),
          durationMs: Date.now() - startedAt,
          invocationError: message.slice(0, 500),
        };
        gateResults.push({ label, ok: false, issueCount: 1 });
        await writeArtifact(runDir, `candidates/${label}/gate.json`, `${JSON.stringify({ ok: false, invocationError: message.slice(0, 500) }, null, 2)}\n`);
      }
      candidates.push(summary);
      onProgress(`candidate ${label} (${selection.family}) done: deterministicValid=${summary.deterministicValid} cost=${summary.costUsd ?? 0}`);

      if (totalCostUsd > budgetCap) {
        return {
          version: "v0",
          status: "failed",
          runId,
          roleId: options.roleId,
          inputDigests: digests,
          candidates,
          judges: [],
          winner: null,
          totalCostUsd,
          budgetUsdCap: budgetCap,
          warnings,
          error: { code: "eval_budget_exceeded", message: `total cost ${totalCostUsd.toFixed(4)} exceeded budget cap ${budgetCap}` },
        };
      }
    }

    // --- 5. Blind rubric judging (two different judge models) -----------------
    const judges: EvalJudgeSummary[] = [];
    const judgeSelections = selections.filter((selection) => selection.family !== "anthropic");
    const judgeModels = judgeSelections.slice(0, 2).map((selection) => selection.model);
    if (rawOutputs.length >= 2 && judgeModels.length >= 1) {
      const judgeTask = buildJudgeTask(
        options.roleId,
        "Judge the candidates.",
        rawOutputs.map((entry) => ({ label: entry.label, output: entry.output })),
      );
      for (const judgeModel of judgeModels) {
        const judgeIndex = judges.length + 1;
        try {
          const result = await invokeModel({
            roleId: "content_critic",
            model: judgeModel,
            systemPrompt: judgeTask.systemPrompt,
            prompt: judgeTask.prompt,
            maxTokens: judgeTask.maxTokens,
            timeoutMs: MODEL_ROLE_POLICY.content_critic.timeoutMs,
          }, options.gatewayDeps ?? {});
          totalCostUsd += result.costUsd ?? 0;
          const verdict: JudgeVerdict = parseJudgeVerdict(JSON.parse(result.content));
          judges.push({ model: judgeModel, verdict, error: null });
          await writeArtifact(runDir, `judging/${judgeIndex}.json`, `${JSON.stringify({ model: judgeModel, verdict }, null, 2)}\n`);
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          judges.push({ model: judgeModel, verdict: null, error: message });
          await writeArtifact(runDir, `judging/${judgeIndex}.json`, `${JSON.stringify({ model: judgeModel, error: message }, null, 2)}\n`);
        }
      }
    } else {
      warnings.push("judging skipped: fewer than two candidate outputs or no available judge model");
    }

    // --- 6. Winner selection (gates first, rubric second) ---------------------
    const validLabels = new Set(gateResults.filter((gate) => gate.ok).map((gate) => gate.label));
    let winner: EvalResult["winner"] = null;
    if (validLabels.size > 0 && judges.some((judge) => judge.verdict !== null)) {
      const scored = [...validLabels].map((label) => {
        const perDimension: number[][] = [];
        let votes = 0;
        for (const judge of judges) {
          if (!judge.verdict) continue;
          const scores = judge.verdict.scores[label];
          if (scores) {
            perDimension.push([scores.grounding, scores.usefulness, scores.restraint, scores.accuracy, scores.quality]);
          }
          if (judge.verdict.preferred === label) votes++;
        }
        const flat = perDimension.flat();
        const average = flat.length > 0 ? flat.reduce((sum, value) => sum + value, 0) / flat.length : 0;
        return { label, average, votes };
      });
      scored.sort((left, right) => right.average - left.average || right.votes - left.votes || left.label.localeCompare(right.label));
      const top = scored[0]!;
      const model = candidates.find((candidate) => candidate.label === top.label)?.model ?? "unknown";
      winner = { label: top.label, model, deterministicValid: true, averageRubric: top.average, preferenceVotes: top.votes };
    } else if (validLabels.size > 0) {
      warnings.push("no judge verdict available; winner not selected despite deterministic passes");
    } else {
      warnings.push("no candidate passed the deterministic Factory gates");
    }

    if (totalCostUsd > budgetCap) {
      warnings.push(`total cost ${totalCostUsd.toFixed(4)} exceeded the budget cap ${budgetCap} during judging`);
    }

    // --- 7. Publication: manifest + result LAST -------------------------------
    const manifestFiles = [
      "input-digests.json",
      "candidate-selection.json",
      ...candidates.map((candidate) => `candidates/${candidate.label}/gate.json`),
      ...judges.map((_, index) => `judging/${index + 1}.json`),
    ];
    const digestsByPath = await buildArtifactDigests(runDir, manifestFiles);
    const evalResult: EvalResult = {
      version: "v0",
      status: "succeeded",
      runId,
      roleId: options.roleId,
      inputDigests: digests,
      candidates,
      judges,
      winner,
      totalCostUsd,
      budgetUsdCap: budgetCap,
      warnings: warnings.slice(0, 20),
      error: null,
    };
    await publishJsonAtomically(runDir, "manifest.json", {
      runId,
      roleId: options.roleId,
      status: "succeeded",
      digests: digestsByPath,
      artifacts: ["manifest.json", "eval-result.json", ...manifestFiles],
      resultDigest: deterministicDigest(evalResult),
    });
    await publishJsonAtomically(runDir, "eval-result.json", evalResult);
    return evalResult;
  } catch (error) {
    return failure(
      error instanceof FactoryError ? error.code : "eval_internal",
      error instanceof Error ? error.message : String(error),
    );
  }
}
