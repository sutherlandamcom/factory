import type { SiteTask } from "@factory/contracts";

/**
 * Mechanically generated Codex prompt for a validated SiteTask. The task
 * JSON is embedded verbatim; the constraint list is fixed and deliberately
 * redundant with the sandbox + post-hoc scope enforcement.
 */
export function buildCodexPrompt(task: SiteTask): string {
  return `You are the Factory site engineering worker. Implement exactly one SiteTask in this repository.

## Rules (all mandatory)

- Follow the repository's AGENTS.md.
- Implement ONLY the supplied SiteTask — nothing else.
- Modify only the requested Astro page implementation under sites/starter/src/. Reuse existing components (sites/starter/src/components/) and layouts instead of inventing new ones.
- Do NOT redesign or touch unrelated pages.
- Do NOT install dependencies or change any package manifest (package.json, pnpm-lock.yaml, pnpm-workspace.yaml).
- Do NOT change the Factory control plane (apps/factory) or the contracts package (packages/contracts).
- Do NOT change tests, QA configuration, Playwright config, or weaken QA in any way.
- Do NOT change configuration files unless the task explicitly requires it.
- Do NOT run pnpm install or any package manager — dependencies are already installed.
- Do NOT commit, push, stash, or otherwise run git-mutating commands.
- Do NOT access the network; it is disabled.

## SiteTask (authoritative, validated JSON)

\`\`\`json
${JSON.stringify(task, null, 2)}
\`\`\`

Create the page for the given slug using the existing page patterns in this repo (see sites/starter/src/pages/services/example.astro). The page must use the SiteTask title as its visible heading and metadata title, the description as the meta description, and compose the listed sections from existing components. Reuse existing local image assets for any imagery. When you are done, stop — no summary of unrelated ideas, no extra files.`;
}
