# Factory instruction authority

This document defines how humans and agents resolve repository instructions when multiple files discuss the same subject.

## Precedence

Use this order when instructions conflict:

1. **`AGENTS.md`** — repository-wide engineering and agent policy.
2. **`docs/architecture/factory-constitution-vnext.md`** — normative vNext product/architecture policy.
3. **`docs/roadmap-vnext.md`** — accepted sequencing and scope for current/future macro-runs.
4. **Specialized normative policy** for the affected domain, for example `docs/seo-policy.md`.
5. **Implemented contracts/code and `docs/architecture.md`** — source of truth for what exists today. These do not silently override a reviewed vNext policy; when current implementation differs, preserve the accepted implementation until the roadmap's explicit migration/ADR is completed.
6. **Task-specific handoff/prompt** — authoritative only for the exact run it names and only within the boundaries above.
7. **Historical audits, bake-offs, build reports and gap reports** — evidence about past states. They are not current implementation instructions unless a newer normative document explicitly adopts their recommendation.

Runtime prompt builders under `apps/factory/src/**/prompt.ts` are scoped execution contracts for the specific runtime that consumes them. They are not general architecture policy.

## Historical documents

Do not rewrite historical findings merely because the product direction changed. Preserve provenance. When a historical document contains phrases such as "next phase", "future", "deferred", or an old model/framework recommendation, interpret them as statements made at that document's date unless a current normative file re-adopts them.

For current work, use `docs/roadmap-vnext.md` rather than old handoff sequencing.

## Current implementation vs vNext target

Factory deliberately has transitional areas where accepted current behavior predates vNext. Examples include the current Astro/Tailwind production path, the legacy `create_page` SiteTask content materialization path, and evaluation-only model roles that predate external design/asset providers.

Agents MUST NOT "fix" those differences by silently migrating production behavior. Migration requires the explicit roadmap slice, tests, independent QA and, where architecture changes, a reviewed ADR.

Conversely, agents MUST NOT treat transitional behavior as permission to extend the old architecture. New work should move toward the vNext Constitution.

## Important vNext boundaries

- Factory orchestrates and governs; specialized providers create bounded outputs.
- Real acquired search evidence underpins Search Intelligence; an LLM does not invent a current SERP.
- Anthropic Opus is the intended marketing/editorial writer behind a human-approved exact writer prompt.
- Professional design comes from an external `DesignProvider`; Google Stitch is the preferred first provider for v0 evaluation.
- Synthetic/generated imagery belongs behind `VisualAssetProvider`; the preferred v0 production direction is Google Vertex/Gemini Nano Banana Pro, while authentic operator-owned photography has priority when it is documentary evidence.
- Code workers are implementation workers, not production marketing writers or design authorities. The current pre-vNext `create_page` compatibility path may still materialize minimal prose from bounded `contentBrief` key points because it predates `AcceptedPageContent`; do not broaden that compatibility behavior, and do not use it as the design for new content workflows.
- Typical mass-page production should become deterministic/cached rather than repeatedly invoking coding or vision models.
- Per-page multimodal screenshot comparison is not a default QA strategy.
- Astro remains the current accepted renderer until the explicit Stitch-native-static vs Astro bake-off selects the ordinary production path.

## When uncertain

If two current normative files genuinely conflict, stop the affected architectural decision and surface the conflict in the PR. Do not resolve it by guessing which document the operator "probably meant".
