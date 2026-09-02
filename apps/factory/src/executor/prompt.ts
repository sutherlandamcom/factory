import type { SiteTask } from "@factory/contracts";
import type { FailureReport } from "./classify.js";
import type { TaskWritePolicy } from "./module-policy.js";

/**
 * Factory-owned task instruction contract — ONE methodology shared by every
 * coding runtime (Kimi Code primary worker, Claude Code senior worker,
 * legacy Codex rollback worker). Runtime-specific wrappers may adapt
 * transport/formatting, never task semantics.
 */

/**
 * Mechanically generated worker prompt for a validated SiteTask (Attempt 1).
 */
export function buildWorkerPrompt(task: SiteTask, policy: TaskWritePolicy): string {
  const targetPath = policy.writablePaths[0]!;
  return `You are the Factory site engineering worker. Implement exactly one SiteTask in this repository.

## Rules (all mandatory)

- Follow the repository's AGENTS.md.
- Implement ONLY the supplied SiteTask — nothing else.
- Modify only ${targetPath}. Reuse existing components and layouts without editing them.
- Do NOT redesign or touch unrelated pages.
- Do NOT install dependencies or change any package manifest (package.json, pnpm-lock.yaml, pnpm-workspace.yaml).
- Do NOT change the Factory control plane (apps/factory) or the contracts package (packages/contracts).
- Do NOT change tests, QA configuration, Playwright config, or weaken QA in any way.
- Do NOT change configuration files unless the task explicitly requires it.
- Do NOT run pnpm install or any package manager — dependencies are already installed.
- Do NOT commit, push, stash, or otherwise run git-mutating commands.
- Do NOT access the network; it is disabled at the execution boundary.
- Do NOT attempt to run "pnpm qa" or launch background dev/preview servers. Factory runs the authoritative QA oracle outside your runtime; your work is verified after you stop.
- When page.type is "general", use existing layouts/components and emit one truthful WebPage JSON-LD object whose name equals the SiteTask title and whose url equals the canonical URL.

## SiteTask (authoritative, validated JSON)

\`\`\`json
${JSON.stringify(task, null, 2)}
\`\`\`

Create or replace exactly ${targetPath} using the existing page patterns. The page must use the SiteTask title as its visible heading and metadata title, the description as the meta description, and compose the listed sections from existing components. Reuse existing local image assets for any imagery. When you are done, stop — no summary of unrelated ideas, no extra files.`;
}

/**
 * Mechanically generated worker prompt for a repair attempt (Attempt > 1).
 */
export function buildWorkerRepairPrompt(task: SiteTask, report: FailureReport, policy: TaskWritePolicy): string {
  const targetPath = policy.writablePaths[0]!;
  const assertionsBlock =
    report.failingAssertions && report.failingAssertions.length > 0
      ? `\n### Key Failing Assertions / Errors:\n${report.failingAssertions.map((a) => `- ${a}`).join("\n")}\n`
      : "";

  const changedBlock =
    report.changedFiles && report.changedFiles.length > 0
      ? `\n### Modified Files From Previous Attempt:\n${report.changedFiles.map((f) => `- ${f}`).join("\n")}\n`
      : "";

  return `You are the Factory site engineering worker. This is REPAIR ATTEMPT #${report.attemptNumber} for an existing SiteTask.

The previous attempt implemented the page but failed Factory verification at stage: **${report.failingStage}** with code **${report.failureCode}**.

Your goal is to inspect the current implementation in the repository and FIX THE REPORTED DEFECTS while preserving the original SiteTask intent.

## Rules (all mandatory)

- Follow the repository's AGENTS.md.
- Fix ONLY the reported defects for the SiteTask — do not rewrite working code unnecessarily.
- Modify only ${targetPath}. Reuse existing components and layouts without editing them.
- Do NOT redesign or touch unrelated pages.
- Do NOT install dependencies or change any package manifest (package.json, pnpm-lock.yaml, pnpm-workspace.yaml).
- Do NOT change the Factory control plane (apps/factory) or the contracts package (packages/contracts).
- Do NOT change tests, QA configuration, Playwright config, or weaken QA in any way.
- Do NOT change configuration files unless the task explicitly requires it.
- Do NOT run pnpm install or any package manager — dependencies are already installed.
- Do NOT commit, push, stash, or otherwise run git-mutating commands.
- Do NOT access the network; it is disabled at the execution boundary.
- Do NOT attempt to run "pnpm qa" or launch background dev/preview servers. Factory runs the authoritative QA oracle outside your runtime; your work is verified after you stop.
- When page.type is "general", use existing layouts/components and emit one truthful WebPage JSON-LD object whose name equals the SiteTask title and whose url equals the canonical URL.

## Target SiteTask

\`\`\`json
${JSON.stringify(task, null, 2)}
\`\`\`
${changedBlock}
## Failure Report from Previous Attempt (Stage: ${report.failingStage})

Summary: ${report.summary}
${assertionsBlock}
### Verification Output Excerpt:
\`\`\`
${report.excerpt}
\`\`\`

Inspect ${targetPath}, repair the implementation to resolve all errors above, and stop when done.`;
}
