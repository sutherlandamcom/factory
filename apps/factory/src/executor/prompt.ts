import type { SiteTask } from "@factory/contracts";
import type { FailureReport } from "./classify.js";
import type { TaskWritePolicy } from "./module-policy.js";

/**
 * Factory-owned task instruction contract — ONE methodology shared by every
 * coding runtime (Kimi Code primary worker, Claude Code senior worker,
 * legacy Codex rollback worker). Runtime-specific wrappers may adapt
 * transport/formatting, never task semantics.
 *
 * IMPORTANT vNext transition note:
 * This prompt serves the CURRENT pre-AcceptedPageContent create_page contract.
 * It is a compatibility execution path, not the target authoring architecture.
 * vNext marketing/editorial copy is produced separately by the approved writer
 * pipeline and then implemented by a code worker without rewriting. Do not
 * broaden this prompt's bounded contentBrief materialization into general
 * marketing-copy authority.
 */

/**
 * Mechanically generated worker prompt for a validated SiteTask (Attempt 1).
 */
export function buildWorkerPrompt(task: SiteTask, policy: TaskWritePolicy): string {
  const targetPath = policy.writablePaths[0]!;
  return `You are the Factory site engineering worker. Implement exactly one CURRENT SiteTask in this repository.

## Rules (all mandatory)

- Follow the repository's AGENTS.md and its instruction-precedence rules.
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
- When page.contentBrief is present, it is accepted Factory business truth compiled from accepted Blueprint/ProductionSpec semantics. It remains a LEGACY COMPATIBILITY input; it is not permission to act as a general marketing writer. Implement every keyPoint faithfully as visible content, honor every prohibitedClaim, use planned internalLinks where they fit naturally, and add NO business claim, qualification, metric, credential, client, performance statement, guarantee, positioning idea, or factual assertion beyond the brief.
- Because the current SiteTask may contain semantic key points rather than final AcceptedPageContent, you may add only the minimum neutral connective prose necessary to render those exact points coherently. Do not embellish, market, optimize, invent a new angle, or introduce new claims. This compatibility allowance ends when exact accepted copy is supplied by a future contract: exact accepted marketing copy must be reproduced without rewriting.
- When a brief section carries productionGuidance or purpose, treat it as binding art direction for that section (layout, editorial treatment, and the reason the section exists); do not substitute a generic component default. This is transitional implementation guidance only and does not grant the worker design authority to invent a visual system, reinterpret the supplied direction, or redesign the page.

## SiteTask (authoritative, validated JSON)

\`\`\`json
${JSON.stringify(task, null, 2)}
\`\`\`

Create or replace exactly ${targetPath} using the existing page patterns. The page must use the SiteTask title as its visible heading and metadata title, the description as the meta description, and compose the listed sections from existing components. Reuse only approved/existing local image assets when imagery is required. When you are done, stop — no summary of unrelated ideas, no extra files.`;
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

  return `You are the Factory site engineering worker. This is REPAIR ATTEMPT #${report.attemptNumber} for an existing CURRENT SiteTask.

The previous attempt implemented the page but failed Factory verification at stage: **${report.failingStage}** with code **${report.failureCode}**.

Your goal is to inspect the current implementation in the repository and FIX THE REPORTED DEFECTS while preserving the original SiteTask intent.

## Rules (all mandatory)

- Follow the repository's AGENTS.md and its instruction-precedence rules.
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
- When page.contentBrief is present, it is accepted Factory business truth and remains a LEGACY COMPATIBILITY input. Preserve every keyPoint, prohibitedClaim and planned internalLink, and add no new business claims or marketing ideas. Only minimal neutral connective prose is allowed when the current contract lacks final accepted copy.
- When a brief section carries productionGuidance or purpose, treat it as binding art direction for that section. This is transitional implementation guidance only and does not grant the worker design authority to invent a visual system, reinterpret the supplied direction, or redesign the page. Do not use a repair as an opportunity to redesign the page.

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
