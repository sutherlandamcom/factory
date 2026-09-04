# Factory instruction-surface audit — 2026-09-04

Purpose: record which repository files can influence human/agent decisions and how they relate to the vNext Constitution. This is not a substitute for `AGENTS.md`; it is an audit/evidence record.

## Repository-level instruction files discovered

A recursive repository-tree inspection found:

- root `AGENTS.md` — the only `AGENTS.md` in the repository;
- no `CLAUDE.md`;
- no Copilot instruction file;
- no nested agent-policy file with higher path-specific precedence.

The repository therefore has one explicit repository-wide agent policy. Its authority and conflict resolution are now defined by `docs/instruction-authority.md`.

## Active normative surfaces

### `AGENTS.md`

Status: **current normative policy**.

Updated for vNext: orchestration role, Dashboard scope, real Search Intelligence, human-approved writer prompt, Opus writer boundary, external DesignProvider/Stitch direction, VisualAssetProvider/Nano Banana direction, authentic-photo priority, deterministic/cost discipline, transitional Astro status, and build/QA governance.

### `docs/architecture/factory-constitution-vnext.md`

Status: **normative vNext product/architecture policy**.

### `docs/roadmap-vnext.md`

Status: **current sequencing authority** for macro-runs and migrations.

### `docs/seo-policy.md`

Status: **specialized normative policy** for Search/SEO correctness. The substantive rules remain compatible with vNext: people-first content, evidence/factuality, route/canonical integrity, no scaled spam, technical SEO, and current official Google documentation as external authority.

## Implemented-state / explanatory surfaces

### `README.md`

Status: **current operator/developer orientation**.

Updated to separate the current accepted v0/v0.1 implementation from the vNext target and to prevent transitional behavior from being treated as permanent architecture.

### `docs/architecture.md`

Status: **implemented-state record with historical sections accumulated over prior PRs**.

Important reading rule: descriptions of code that still exists are useful implementation evidence, but old phrases such as "next", "deferred", or old model/runtime tables must not override current code or vNext policy. When a factual statement conflicts with current code, current code/tests win; when future sequencing conflicts with vNext, `docs/roadmap-vnext.md` wins.

Known transition corrections that agents must keep in mind:

- current code-worker routing is the accepted Kimi K3 primary / Claude Opus 5 senior architecture (`CODE_WORKER_POLICY.migrationActivated === true`), not the older Codex-only or "migration not activated" description retained in earlier architecture chronology;
- current Astro/Tailwind rendering is accepted implementation, not a permanent product invariant;
- current First-Site Intelligence consumes supplied research evidence and is not the future live-SERP Search Intelligence subsystem;
- SiteBlueprint `designDirection` and SiteProductionSpec creative/layout guidance are bounded planning/production inputs, not the vNext professional-design authority;
- professional design belongs to external `DesignProvider` in vNext;
- legacy/evaluation model roles named `design_director`, `visual_critic`, or `image_generator` are not production provider authority.

### `docs/site-production-spec-v0.md`

Status: **current v0 contract documentation; transitional relative to vNext**.

Retain its truth about current `SiteProductionSpec`, readiness, references, assets and packet compilation. Do not infer that its `creativeDirection` becomes a proprietary Factory design engine. In vNext it can contribute to a DesignBrief/implementation handoff, while final professional visual authority comes from an accepted external DesignProvider artifact and final marketing copy from AcceptedPageContent.

## Runtime prompt surfaces

Runtime prompt builders are executable scoped contracts, not repository-wide policy.

### `apps/factory/src/executor/prompt.ts`

Status: **current compatibility execution prompt**.

Updated to state explicitly that the current `create_page` contract predates `AcceptedPageContent`. It may materialize only minimal neutral connective prose needed to express bounded accepted key points and may not broaden that into marketing authorship. Once exact accepted marketing copy exists, implementation workers reproduce it rather than rewrite it. Production guidance is transitional current instruction, not permission to invent a new visual system.

### `apps/factory/src/blueprint/prompt.ts`

Status: **current SiteBlueprint planning prompt**.

Its content jobs, evidence references, visual requirements and bounded `site.designDirection` are planning outputs. They do not supersede the vNext DesignProvider boundary. Do not expand this prompt into final visual design generation.

### `apps/factory/src/intelligence/prompt.ts`

Status: **current pre-vNext planning prompt**.

It synthesizes a plan from a supplied `ResearchEvidenceBundle`; it does not acquire current SERPs. Future Search Intelligence must acquire real provider evidence before inference.

### `apps/factory/src/evals/tasks.ts`

Status: **non-authoritative diagnostic/evaluation tasks**.

The file contains historical bounded `content_writer` and `design_director` evaluation tasks. They are model-comparison fixtures, not the production WriterProvider/DesignProvider workflow. In particular:

- the eval `content_writer` task is not a substitute for Project Content Constitution + page Content Production Brief + exact human-approved WriterPromptSnapshot;
- the eval `design_director` task is not professional visual-design authority and its Astro/Tailwind constraints are compatibility constraints of that old evaluation;
- results from evals cannot promote themselves into production policy.

### `apps/factory/src/models/policy.ts`

Status: **current executable model/routing policy plus pre-vNext future-role placeholders**.

Do not alter current accepted Kimi/Claude code-worker routing casually. For vNext production-provider work:

- `design_director`/`visual_critic` entries do not replace `DesignProvider`;
- the old `image_generator = openai/gpt-image-2` future entry is a placeholder from the earlier model-policy matrix and must not be activated as the vNext production image path without a reviewed policy migration; preferred current direction is `VisualAssetProvider` backed by Google Vertex/Gemini Nano Banana Pro;
- `content_writer` identifies the intended Opus model family, but the production writer pipeline still requires the vNext approval/governance artifacts before activation.

## Historical documents intentionally preserved

Dated audits, bake-offs and build reports were not globally rewritten. Rewriting them would destroy provenance about what was true or recommended at the time.

Examples:

- `docs/architecture/execution-layer-bakeoff.md`
- `docs/audits/**`
- `docs/handoffs/*-build-report.md`
- `docs/handoffs/autonomy-v0-*`

They are historical evidence only unless a current normative document explicitly adopts a conclusion.

`docs/handoffs/site-shell-gap.md` was specially annotated because its explicit "next phase" wording and historical code-worker-content assumption were unusually likely to misdirect a current agent.

## Rule for future changes

Whenever a reviewed architecture decision changes an agent/provider/content/design boundary, the same PR or its immediately preceding governance PR should audit and update:

1. `AGENTS.md`;
2. `docs/instruction-authority.md` if precedence changes;
3. README/current architecture orientation;
4. affected runtime prompts;
5. model/provider policy comments or executable policy where the migration is actually accepted;
6. roadmap/handoff files that are still intended to guide future work.

Do not silently leave two current normative instructions that require incompatible behavior.
