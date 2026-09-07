# Factory vNext Roadmap

Status: **accepted vNext sequencing policy**, adopted through PR #17 after
PR #16 (`62d60575f73e70067f83254aa3eff23b5995fdcf`). Planned scope is distinct
from implemented, verified, independently accepted and merged state.

Instruction precedence: `AGENTS.md` -> `docs/architecture/factory-constitution-vnext.md` -> this roadmap -> specialized current policy. Historical handoff/bake-off sequencing does not override this file; see `docs/instruction-authority.md`.

Prefer focused 2–3 hour working sessions within each macro-run. This is a scope
and context-management guideline, not a completion deadline. Split large work
into explicit checkpoints without waiving acceptance criteria. Each macro-run
delivers a vertical capability: contract -> application service -> API ->
Dashboard -> deterministic tests -> E2E. Backend semantics lead by a small
step; frontend belongs to the same capability so operator behavior validates
the domain model.

Every meaningful implementation PR ends at `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`; independent QA reviews an exact SHA, frozen P0/P1 findings are remediated narrowly, then the exact candidate is re-reviewed before merge.

## Observed implementation status — 2026-09-06

Verified main: `d6eeaaa593e45be3be259feb9cda61fa8b6567c4`.
This entry supersedes the previous snapshot for navigation; the original
2026-09-05 snapshot below remains historical evidence. Recheck live Git/PR state
at session start. Merge, executed checks and independent acceptance remain
distinct facts.

| Workstream | Observed state | Evidence / next gate |
| --- | --- | --- |
| Macro Run 1 — Operator Kernel / Intake | Implemented and merged | [PR #18](https://github.com/sutherlandamcom/factory/pull/18), final head `dd1cda5d5efe7394335c7bf0ca1678fde8ac5f15`; merged 2026-09-05; Operator code exists on inspected main |
| Agent-instruction alignment | Merged; post-merge documentation inconsistencies require the present follow-up | [PR #19](https://github.com/sutherlandamcom/factory/pull/19), head `88c83e87cdbecb24d99839ab046790f9a615b5a2`; [candidate CI success](https://github.com/sutherlandamcom/factory/actions/runs/33989714882) |
| Macro Run 2 — Live Search Intelligence | Implemented and merged | [PR #21](https://github.com/sutherlandamcom/factory/pull/21), merge commit `3bf9652e89f213c9ffd3b2fae2007d8ed155c68f`; Search Intelligence code merged into main |
| Macro Run 3 — Competitors + Content Gap | Implementation candidate; open, awaiting independent QA | Branch `feat/competitor-content-gap-v0`; deterministic QA green; bounded live proof performed (Bright Data SERP + direct-HTTP acquisition + Gemini analyses); see PR description for exact evidence |
| Macro Runs 4–13 | Planned | Exit criteria below; no completion inferred from provider/eval scaffolding |

Inspected main's [CI](https://github.com/sutherlandamcom/factory/actions/runs/33998967648)
checked out the exact SHA above and passed: Factory unit 582, Dashboard unit 6,
persistence 34, Operator 31, real-browser Operator E2E 2; site-starter 8 passed
and 2 skipped. These are main results, not PR #21 acceptance or live-provider
proof. The PR #21 author reports live structured SERP and native grounding
blocked on credentials; this documentation update does not independently
verify those claims or issue a GO.

No separate exact-SHA independent GO for PR #19 was found in the inspected
GitHub reviews/comments or repository audit records. This is an evidence gap,
not proof that no external review occurred. PR #18's merge likewise must not
be used as a substitute for its independent review evidence.

## Historical implementation snapshot — 2026-09-05

This is a dated navigation snapshot, not a substitute for live Git/PR checks.
Refresh it when a reviewed milestone changes; never infer completion from a
handoff, PR description or CI badge alone. Evidence categories are separate:
code exists -> required checks verified -> independent GO at exact SHA -> merged.

| Workstream | Observed state | Evidence / next gate |
| --- | --- | --- |
| Existing execution, SiteProfile/Blueprint/ProductionSpec and delivery foundation | Present on accepted main | Main at `c6c7e000caf9797398dc4e05642ed42a40e664d0`; implementation details in [architecture.md](./architecture.md) |
| Sutherland one-page proof | Merged (PR #16); historical QA and P2 carry-forward recorded | [PR #16](https://github.com/sutherlandamcom/factory/pull/16), [QA summary](./handoffs/2026-09-04-pr16-independent-qa-summary.md); not proof of the entire vNext pipeline |
| vNext governance | Merged (PR #17) | [PR #17](https://github.com/sutherlandamcom/factory/pull/17) |
| Macro Run 1 — Operator Kernel / Intake | Implementation candidate; open, awaiting independent QA | [PR #18](https://github.com/sutherlandamcom/factory/pull/18), head `7ef24e55417038d4b53201944f83fd13d7d34c06`; [CI success](https://github.com/sutherlandamcom/factory/actions/runs/33987804364); no GitHub review GO observed, not merged |
| Macro Runs 2–13 | Planned vNext capabilities; reuse existing foundation | Exit criteria below; current v0 planning/eval/delivery code is not proof of these complete operator workflows |

PR #18 now contains the restored site-starter test invocation, dedicated
Operator API/preparation suites and a real-browser E2E file wired into CI.
Earlier findings against `0266e9a9fad776c1456aefd0c91b0a06091e65fe` are
historical; verify the new candidate instead of assuming those defects persist.
This status records code/workflow inspection and GitHub CI results, not a new
independent acceptance verdict.

Remote Dashboard hosting on Vercel / a proposed "Macro Run 1.5" is not an
adopted prerequisite in this roadmap. Adding it requires an explicit reviewed
scope/topology decision; it must not be inferred from historical chat handoffs.

## Program I — Operator Foundation

### Macro Run 1 — Operator Kernel + Project Intake

Goal: create the first real browser-operated Factory capability.

Deliver:
- durable authority model for draft/accepted project inputs;
- Project, ProjectInputDraft and immutable ProjectInputSnapshot/version/digest semantics;
- provenance categories (`operator_supplied`, `discovered`, `derived`, `model_proposed`, `human_accepted`);
- server-enforced approval/staleness rules;
- durable storage decision for accepted inputs/approvals/artifact metadata (Postgres + Git/object/file roles explicitly documented);
- shared application services used by CLI/API/Dashboard;
- minimal trusted same-origin Operator API and Dashboard shell;
- New Project -> Intake -> Review -> Accept Inputs browser flow;
- restart/refresh persistence and direct-API bypass tests;
- Project Content Constitution fields present as project-level draft/approved data, even if writer execution comes later.

Carry PR #16 P2 debt into this run where it belongs:
- define/fix `headingIntent` execution semantics;
- eliminate silent production-intent truncation/drop behavior;
- make accepted inputs/approvals durable;
- productize packet -> task -> run as a governed application use case or establish the precise next slice if too large for the same run.

Exit criterion: an operator can create a project, enter inputs, review them, create immutable accepted snapshot v1, edit to a new draft v2, and see correct persisted/stale state after refresh/restart, with the backend rejecting bypass attempts.

## Program II — Search & Content Intelligence

### Macro Run 2 — Live Search Intelligence

Deliver `SerpProvider`, provider preflight/caching, real SERP snapshots with query/location/language/device/time, normalized organic results/features/PAA/related searches, query clustering, intent and semantic analysis, and Search views in Dashboard.

Exit: one Sutherland topic can go from seed -> real SERP -> normalized Search Intelligence visible in Dashboard without raw-JSON operation.

### Macro Run 3 — Competitors + Content Gap

Acquire and normalize relevant competitor pages, extract structure/topics/questions/entities/data/citations/CTA/freshness, and produce a structured ContentGapReport based on user need x SERP coverage x competitor quality x accepted evidence.

Dashboard lets the operator include/exclude/prioritize gaps.

Exit: a page opportunity has accepted search intent, content gaps, semantic requirements and differentiation requirements.

### Macro Run 4 — Project Content Constitution + Opus Writer

Deliver project-level Content Constitution, immutable Factory writer policy, page Content Production Brief, exact WriterPromptSnapshot preview, human approval gate, WriterProvider using Anthropic Opus, structured PageContentProposal, independent factual/search/editorial QA and final human content approval.

This workstream replaces the legacy idea that the coding worker authors final page marketing copy. Existing bounded eval/compatibility content-writer paths remain historical/current compatibility evidence only until this production pipeline is accepted.

Exit: high-quality `AcceptedPageContent` for one Sutherland page is produced entirely through Dashboard; no page coder authors production copy.

## Program III — Design & Assets

### Macro Run 5 — Asset Foundation + Operator Photography

Deliver project/page asset storage, rights/provenance/digests, page imagery strategies (none/operator/generated/mixed), upload UX, responsive derivatives and approval/assignment lifecycle.

Exit: an operator can upload and approve real Chamonix imagery for a specific page/slot through Dashboard.

### Macro Run 6 — Google Stitch Design Provider

Implement a narrow `DesignProvider` adapter with Google Stitch as preferred v0 provider. Feed real accepted content, brand facts, references/anti-references and available assets. Generate a site design system plus representative archetypes rather than independently designing every page.

This workstream supersedes legacy `design_director` model-eval roles as professional visual authority; do not extend those eval roles into a proprietary Factory design engine.

Human review/approval is the visual authority. If Stitch clears the institutional-quality floor, stop provider search. Only if it fails should the next cheapest viable provider (Framer, then Figma, then others) be tested.

Exit: accepted Sutherland design artifacts and implementation references exist for homepage plus representative page archetypes.

### Macro Run 7 — Nano Banana Pro + Final Asset Resolution

Implement `VisualAssetProvider` with Google Vertex/Gemini Nano Banana Pro as preferred production path. Support generated candidates and AI-derived edits of operator photos while retaining provenance.

The older `image_generator` model-policy placeholder is not production authority and must not be activated merely because it already exists in the v0 policy matrix.

Resolve design asset slots, approve real/generated assets, and perform a final Stitch pass with actual assets before design freeze.

Exit: accepted copy + final accepted design + approved real/generated assets exist without page implementation ambiguity.

## Program IV — Production Architecture

### Macro Run 8 — Astro vs Stitch-native Static Bake-off

Run the same accepted Sutherland design/content through two paths:

A. Stitch/design-provider HTML -> deterministic Factory normalization -> static production.

B. Stitch/design-provider output -> Astro implementation -> static production.

Do not use multimodal LLM screenshot comparison. Use one human visual calibration plus engineering metrics: implementation time, coding-token spend, semantic HTML, SEO correctness, accessibility, Lighthouse/performance, JS/CSS weight, maintainability, reusable-archetype scaling and build complexity.

Exit: reviewed ADR selects the ordinary production path. Astro is retained only if it creates material value.

### Macro Run 9 — Static Production/SEO/Performance Engine

Implement the selected path. If direct-static wins, create a deliberately small deterministic normalizer/renderer for HTML sanitization, CSS/asset localization, accepted-content insertion, metadata/canonical/schema/sitemap/redirects, image optimization, cache policy and validation.

Regardless of renderer, add deterministic content-integrity, one-H1, canonical/schema/link, responsive/overflow, console-error and Lighthouse/performance gates.

Exit: ordinary page production is fast, static-first, SEO-complete and primarily deterministic.

### Macro Run 10 — Page Derivatives: Summary + Audio

Add project defaults and page overrides for AI summary and audio narration.

Generate both once per AcceptedPageContent version and store/cache the result. Content mutation makes derivatives stale. Visitor interactions play/reveal existing artifacts and do not trigger repeated provider generation.

Exit: long editorial pages support reusable `Listen to article` and `AI-generated summary` controls without per-visitor model spend.

## Program V — Productization and Proof

### Macro Run 11 — Full Operator Workflow

Connect existing vertical Dashboard slices into one coherent operator lifecycle with areas for Overview, Intake, Research/Search, Content, Design, Assets, Production, QA, Versions/Costs and Deployment.

Do not build a generic CMS or visual page builder. Dashboard remains a semantic operator console.

### Macro Run 12 — High-quality Multi-page Proof

Produce a small coherent Sutherland set such as homepage + service + location + editorial/research page using one accepted design system and multiple archetypes.

Prove search/content strategy, internal links, no cannibalization, accepted content quality, authentic/generated asset discipline, SEO/performance and cheap template/archetype reuse.

Measure per-page/provider cost. The desired steady state is that a typical page using an accepted archetype does not require a new design or coding-model call.

### Macro Run 13 — Production Delivery vNext

Expose governed Candidate -> Preview -> Approve -> Publish -> Verify -> Rollback through the operator workflow while preserving exact source/input/content/design/asset/QA/deployment lineage.

Current Cloudflare Production Delivery remains accepted infrastructure and should be reused/migrated rather than rebuilt without evidence.

Exit: the complete MVP can be operated from the Dashboard with backend-enforced governance and reproducible production lineage.

## Scope discipline across all macro-runs

Do not prebuild future complexity. Until demonstrated necessary, avoid:

- Puck/generic CMS/page builder;
- proprietary design engine;
- enterprise RBAC/multi-tenancy;
- microservices/Kubernetes;
- generic workflow engines;
- queues/schedulers;
- real-time collaboration;
- generic plugin architecture;
- repeated paid model work that a deterministic operation/cache can replace.

Every new framework, provider call, transformation layer and infrastructure component must justify its concrete value in the current vertical slice.
