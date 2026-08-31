import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_INTELLIGENCE_MODEL_OUTPUT_BYTES, type ModelRuntime } from "@factory/contracts";
import { RUN_ID_PATTERN } from "./artifacts.js";
import type { CodexRunRequest, CodexRunResult, CodexRunner } from "../executor/codex.js";

/**
 * Single isolated synthesis attempt.
 *
 * The model workspace lives strictly inside the approved Factory mount root
 * `.factory/worktrees/intelligence-<runId>/` and contains ONLY the validated
 * request data, the normalized research data, the prompt, and an empty
 * `output/` directory. The model's single writable path is
 * `output/plan.json`. No primary checkout, host HOME, /tmp, sockets, or
 * credentials are mounted (guaranteed by the reused accepted Codex runner).
 */

export interface SynthesisWorkspace {
  path: string;
  outputRelativePath: "output/plan.json";
}

export function intelligenceWorkspacePath(repoRoot: string, runId: string): string {
  // runId must be strictly pattern-validated before any path is constructed;
  // no model- or evidence-controlled value may reach path construction.
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid intelligence runId: ${runId}`);
  }
  return path.join(repoRoot, ".factory", "worktrees", `intelligence-${runId}`);
}

export async function prepareSynthesisWorkspace(
  repoRoot: string,
  runId: string,
  files: { prompt: string; requestJson: string; researchJson: string },
): Promise<SynthesisWorkspace> {
  const workspacePath = intelligenceWorkspacePath(repoRoot, runId);
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(path.join(workspacePath, "output"), { recursive: true });
  await writeFile(path.join(workspacePath, "request.json"), files.requestJson, "utf8");
  await writeFile(path.join(workspacePath, "normalized-research.json"), files.researchJson, "utf8");
  await writeFile(path.join(workspacePath, "prompt.txt"), files.prompt, "utf8");
  return { path: workspacePath, outputRelativePath: "output/plan.json" };
}

export async function writeWorkspacePrompt(workspace: SynthesisWorkspace, prompt: string): Promise<void> {
  await writeFile(path.join(workspace.path, "prompt.txt"), prompt, "utf8");
}

export async function removeSynthesisWorkspace(workspace: SynthesisWorkspace): Promise<void> {
  await rm(workspace.path, { recursive: true, force: true });
}

export interface SynthesisAttemptResult {
  codex: CodexRunResult;
  /** Raw output file content (null when unavailable; `outputError` explains). */
  rawOutput: string | null;
  outputError: string | null;
}

export async function runSynthesisAttempt(
  runner: CodexRunner,
  params: {
    workspace: SynthesisWorkspace;
    prompt: string;
    /** Attempt artifact directory (host-side, inside the run directory). */
    runArtifactDir: string;
    timeoutMs: number;
  },
): Promise<SynthesisAttemptResult> {
  const codexRequest: CodexRunRequest = {
    worktreePath: params.workspace.path,
    prompt: params.prompt,
    runDir: params.runArtifactDir,
    timeoutMs: params.timeoutMs,
    writablePaths: [params.workspace.outputRelativePath],
  };
  const codex = await runner(codexRequest);

  const outputPath = path.join(params.workspace.path, params.workspace.outputRelativePath);
  let rawOutput: string | null = null;
  let outputError: string | null = null;
  try {
    const stat = await lstat(outputPath);
    if (stat.isSymbolicLink()) {
      outputError = "output file is a symlink";
    } else if (stat.size > MAX_INTELLIGENCE_MODEL_OUTPUT_BYTES) {
      outputError = `output exceeds the maximum allowed ${MAX_INTELLIGENCE_MODEL_OUTPUT_BYTES} bytes`;
    } else {
      rawOutput = await readFile(outputPath, "utf8");
    }
  } catch {
    outputError = "model did not write the required output file output/plan.json";
  }
  return { codex, rawOutput, outputError };
}

export type ModelOutputParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Strict model output parsing: exactly one JSON document. Markdown fences,
 * leading/trailing prose, empty output, and multiple documents all fail.
 * No permissive heuristic salvage.
 */
export function parseModelPlanOutput(
  rawOutput: string | null,
  outputError: string | null,
): ModelOutputParseResult {
  if (rawOutput === null) {
    return { ok: false, error: outputError ?? "no model output available" };
  }
  if (rawOutput.trim().length === 0) {
    return { ok: false, error: "model output is empty" };
  }
  try {
    return { ok: true, value: JSON.parse(rawOutput) };
  } catch (error) {
    return {
      ok: false,
      error: `model output is not a single valid JSON document: ${
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      }`,
    };
  }
}

/**
 * Truthful model runtime provenance: the pinned Codex version from the
 * runner, plus the model identifier only when it is genuinely present in the
 * runtime's own JSONL events. When unavailable, `model` stays null and the
 * limitation is documented — never invented.
 */
export function parseModelRuntimeFromStdout(stdout: string, version: string | null): ModelRuntime {
  let model: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { model?: unknown };
      if (typeof event.model === "string" && event.model.length > 0) {
        model = event.model.slice(0, 200);
        break;
      }
    } catch {
      continue;
    }
  }
  return {
    provider: "openai",
    runtime: "codex-cli",
    codexVersion: version?.replace(/^codex-cli\s*/, "") || "unknown",
    model,
  };
}
