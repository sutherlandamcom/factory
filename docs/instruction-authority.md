# Factory instruction authority

This document defines how humans and agents resolve repository instructions when multiple files discuss the same subject.

The latest instruction-alignment follow-up is recorded in
`docs/instruction-surface-audit-2026-09-06.md`. The 2026-09-04 and 2026-09-05
audits remain historical evidence; their past PR states are not today's task queue.

## Precedence

Use this order when instructions conflict:

1. **`AGENTS.md`** — repository-wide engineering and agent policy.
2. **`docs/architecture/factory-constitution-vnext.md`** — normative vNext product/architecture policy.
3. **`docs/roadmap-vnext.md`** — accepted sequencing and scope for current/future macro-runs.
4. **Specialized normative policy** for the affected domain, including
   `docs/seo-policy.md` and `docs/design-system-implementation-policy.md`.
5. **Implemented contracts/code and `docs/architecture.md`** — source of truth for what exists today. These do not silently override a reviewed vNext policy; when current implementation differs, preserve the accepted implementation until the roadmap's explicit migration/ADR is completed.
6. **Task-specific handoff/prompt** — authoritative only for the exact run it names and only within the boundaries above.
7. **Historical audits, bake-offs, build reports and gap reports** — evidence about past states. They are not current implementation instructions unless a newer normative document explicitly adopts their recommendation.

Runtime prompt builders under `apps/factory/src/**/prompt.ts` are scoped execution contracts for the specific runtime that consumes them. They are not general architecture policy.

## Reading and resuming work

Precedence resolves conflicts; it is not a requirement to reread every file on
every turn. At session start inspect the current branch/base, worktree changes
and relevant PRs, read `AGENTS.md`, the applicable roadmap slice and the task
delta. For architecture/provider changes consult the Constitution; for public
Search changes consult SEO policy; for work that creates or changes governed
production components, semantic tokens, archetype implementation, responsive
design behavior or design-regression QA, consult
`docs/design-system-implementation-policy.md`. Read implementation/domain
documentation and historical evidence only as needed to resolve the task. Reuse
unchanged context and use focused code searches rather than repeated full
repository scans.

Before executing an old handoff's "next step", verify whether a PR already
implements it, which SHA is being reviewed, and whether it is merged. Continue
from the actual delta; do not restart completed work or label an open candidate
accepted. Preserve other agents' changes and use an isolated branch/worktree
for the assigned task.

Roadmap status is a dated index with evidence links, not a second operational
database. Live Git/CI and exact-SHA review evidence determine current state.
The Constitution governs design decisions; accepted policy does not mean every
capability it describes has been delivered.

## Historical documents

Do not rewrite historical findings merely because the product direction changed. Preserve provenance. When a historical document contains phrases such as "next phase", "future", "deferred", or an old model/framework recommendation, interpret them as statements made at that document's date unless a current normative file re-adopts their recommendation.

For current work, use `docs/roadmap-vnext.md` rather than old handoff sequencing.

## Current implementation vs vNext target

Factory deliberately has transitional areas where accepted current behavior predates vNext. Examples include the current Astro/Tailwind production path, the legacy `create_page` SiteTask content materialization path, and evaluation-only model roles that predate external design/asset providers.

Agents MUST NOT "fix" those differences by silently migrating production behavior. Migration requires the explicit roadmap slice, tests, independent QA and, where architecture changes, a reviewed ADR.

Conversely, agents MUST NOT treat transitional behavior as permission to extend the old architecture. New work should move toward the vNext Constitution.

## Important vNext boundaries

- Factory orchestrates and governs; specialized providers create bounded outputs.
- Real acquired search evidence underpins Search Intelligence; an LLM does not invent a current SERP.
- Anthropic Opus is the intended marketing/editorial writer behind a human-approved exact writer prompt.
- Professional design candidates come from an external `DesignProvider`; Google Stitch is the preferred first provider for v0 evaluation. The provider owns generation only. Human acceptance creates the immutable/version-bound `AcceptedDesignArtifact`, which is the durable Factory design authority.
- Synthetic/generated imagery belongs behind `VisualAssetProvider`; the preferred v0 production direction is Google Vertex/Gemini Nano Banana Pro, while authentic operator-owned photography has priority when it is documentary evidence.
- Code workers are implementation workers, not production marketing writers or design authorities. The current pre-vNext `create_page` compatibility path may still materialize minimal neutral connective prose from bounded `contentBrief` key points because it predates `AcceptedPageContent`; do not broaden that compatibility behavior, and do not use it as the design for new content workflows.
- Typical mass-page production should become deterministic/cached rather than repeatedly invoking coding or vision models.
- Per-page multimodal screenshot comparison is not a default QA strategy.
- Run 8 selected **Astro 7 + Tailwind CSS 4 static rendering as the single ordinary production renderer**. Google Stitch / `DesignProvider` remains professional design generation/evidence only, not Factory design authority and not production runtime authority. Raw provider HTML may be retained as implementation/design evidence but is not a second production renderer. A parallel Stitch-native/direct-static ordinary production path may be introduced only by a later reviewed ADR satisfying the documented reversal conditions.
- Governed production design implementation follows `docs/design-system-implementation-policy.md`: `AcceptedDesignArtifact` remains authority; implementation is deterministic/bounded; coding agents reuse registered capabilities and semantic tokens rather than silently redesigning pages.

## Known transitional names that are not future authority

Some executable policy/eval code still contains role names created before vNext:

- `design_director` / `visual_critic`: legacy model-policy/evaluation roles, not substitutes for `DesignProvider`;
- `image_generator`: a pre-vNext future-role placeholder, not permission to activate the old OpenAI image assignment as the vNext production image path;
- eval `content_writer`: a bounded diagnostic task, not the production Project Content Constitution + approved WriterPromptSnapshot pipeline.

Do not rename/remove these mechanically in a governance PR if tests/current provenance depend on them. Their production migration belongs to the explicit provider/content macro-runs.

## When uncertain

If two current normative files genuinely conflict, stop the affected architectural decision and surface the conflict in the PR. Do not resolve it by guessing which document the operator "probably meant".
