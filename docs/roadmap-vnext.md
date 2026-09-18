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

## Observed implementation status — 2026-09-15

Verified main: `637bcb4fcb9fcc20d15dba5fb4fc9d94e6584f0f` (PR #39, Run 9
merged). Recheck live Git/PR state at session start. Merge, executed checks and
independent acceptance remain distinct facts; the table below is navigation,
not a substitute for exact-SHA evidence.

| Workstream | Observed state | Evidence / next gate |
| --- | --- | --- |
| Macro Run 1 — Operator Kernel / Intake | Implemented and merged | [PR #18](https://github.com/sutherlandamcom/factory/pull/18), head `dd1cda5d5efe7394335c7bf0ca1678fde8ac5f15`, merge `263624c78d60779037543887eb60fcb617ba697f` |
| Macro Run 2 — Live Search Intelligence | Implemented and merged | [PR #21](https://github.com/sutherlandamcom/factory/pull/21), merge `3bf9652e89f213c9ffd3b2fae2007d8ed155c68f`; later Runs 1–6 system remediation is present on current main |
| Macro Run 3 — Competitors + Content Gap | Implemented and merged | [PR #24](https://github.com/sutherlandamcom/factory/pull/24), merge `46a556603047c4dce75ca3bbd05e1ed4b7ea817c`; later authority-chain remediation is present on current main |
| Macro Run 4 — Content Constitution + Opus Writer | Implemented, independently QA'd and merged | [PR #25](https://github.com/sutherlandamcom/factory/pull/25), head `76d528c1a66ec3a4dbcaea87fa9787d246a6cdf2`, merge `590ed435c7d72a6e4f1e9289db337e837cdf534c` |
| Macro Run 4.1 — QA Hardening | Implemented and merged | [PR #27](https://github.com/sutherlandamcom/factory/pull/27), merge `cd28a6af8ca4e82ecd140006d3f169d317271a74`; [PR #28](https://github.com/sutherlandamcom/factory/pull/28), merge `318661e590377c9deec44b98d933a641d7cc1d19` |
| Macro Run 5 — Asset Foundation | Implemented, QA'd and merged | [PR #30](https://github.com/sutherlandamcom/factory/pull/30), head `062e9346bb6f26b2129a9c4b1037e985634f79c7`, merge `0d5e65f0db09fffa061f127674dc4014e6e0d692`; subsequent CAS/authority hardening is present on current main |
| Macro Run 6 — Google Stitch Design Provider | Implemented, QA'd and merged | [PR #31](https://github.com/sutherlandamcom/factory/pull/31), head `660bdd11a3c27a687415f666aeb03649655b5074`, merge `928d8fab21d111dd6af89ea0c517db50baf6096b`; current Stitch seam is truthfully text-only for final local-asset byte ingestion |
| Macro Run 7 — Final Visual Assets + Design/Asset Freeze | Implemented, remediated and merged | Core [PR #32](https://github.com/sutherlandamcom/factory/pull/32), main carry [PR #33](https://github.com/sutherlandamcom/factory/pull/33), E2E fix [PR #34](https://github.com/sutherlandamcom/factory/pull/34), seam remediation [PR #35](https://github.com/sutherlandamcom/factory/pull/35), final independent-QA remediation [PR #37](https://github.com/sutherlandamcom/factory/pull/37); current main `15f38587…` includes durable plan/slot resolution authority, cross-asset CAS, project-level advisory serialization and split provider evidence dimensions |
| Macro Run 8 — Production Renderer Decision | Architecture decision accepted; no duplicate production prototype required | Evidence-based virtual bake-off selects **Astro static**. Stitch remains professional design authority; raw provider HTML is implementation/design evidence, not production authority. Direct-static is not maintained in parallel. |
| Macro Run 9 — Production + SEO + Performance Engine | Implemented, independently QA'd and merged | [PR #39](https://github.com/sutherlandamcom/factory/pull/39), merge `637bcb4fcb9fcc20d15dba5fb4fc9d94e6584f0f`; post-merge CI green |
| Macro Run 10 — Page Derivatives: Summary + Audio | Implementation candidate; open, awaiting independent QA | Branch `feat/run10-page-derivatives`; builder verification only — no independent GO claimed |
| Macro Runs 11–13 | Planned | Execute only after Run 10 exit criteria are independently accepted |

Run 8 was intentionally resolved as an evidence-based architecture decision
rather than by building two throwaway production stacks. The decision used the
current Factory implementation, the already-existing Astro foundation, the
Run 5–7 authority model, official/tooling capabilities and counterfactual
4/20/100-page scaling analysis. This is a renderer policy decision, not a claim
that two real production prototypes or field-performance measurements were run.

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

### Macro Run 4.1 — QA Hardening Window (2026-09-12)

Hardening slice on the accepted Run 4 content pipeline, split into two
independent PRs:

- Closed-runs hardening: SSRF range classification for the competitor fetcher
  ported from hand-rolled BigInt range tables to maintained `ipaddr.js`
  (policy-identical, proven by a frozen equivalence vector table); the
  canonical JSON digest core proven deterministic against RFC 8785 vectors
  (test-only; the serializer itself is unchanged because historical digests
  bind to it).
- Editorial-QA hardening: new advisory `editorial.readability` check
  (retext-readability, English-gated), new advisory opt-in `editorial.vale_style`
  check (vendored write-good style pack, `FACTORY_VALE_BIN`), and a frozen
  calibration corpus with recorded verdict baselines
  (`docs/audits/2026-09-12-run41-calibration-baselines.md`).

All new QA signals are advisory (never FAIL) so existing fixture verdicts are
unchanged. Exit: both PRs pass independent QA and merge.

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

Resolve all visual slots into exact approved assets. Perform a final design/asset reconciliation: the accepted design authority is re-derived against the exact final asset lineage, and the accepted Design + Content + VisualAsset authority combination is frozen together. If the selected DesignProvider supports exact asset ingestion, generate final provider evidence using those exact assets; if it does not (the current Google Stitch seam is text-only and cannot ingest local image bytes), record `providerConsumed=false` truthfully — the production binding remains exact in Factory authority, and no UI/report may claim the provider generated with the actual assets. Run 8 remains responsible for the renderer ADR; no renderer-specific runtime behavior is encoded here.

Exit: accepted copy + final accepted design + approved real/generated assets exist without page implementation ambiguity, with every slot's exact version/binary/governance digests provable across the accepted content, design and visual-asset authorities.

Implemented-state invariant after the final Run 7 remediation:

- every resolution mode (`reuse_real`, `deterministic_transform`, `ai_edit`,
  `ai_generate`) records durable plan-specific/slot-specific resolution
  authority;
- `AcceptedVisualAssetSet` copies provenance only from that exact plan/slot
  resolution, never from project-wide candidate history;
- cross-asset assignment replacement is an exact old→new CAS operation;
- final design freeze is serialized with competing project authority mutations
  through the shared project-level PostgreSQL advisory transaction lock;
- provider evidence distinguishes source consumption, produced assets, final
  asset references and final-asset byte consumption instead of overloading one
  boolean.

## Program IV — Production Architecture

### Macro Run 8 — Production Renderer Decision

Run 8 is complete as an evidence-based architecture decision. A duplicate
production implementation was intentionally not built merely to discard one
branch.

Decision:

`Stitch / AcceptedDesignArtifact -> Astro archetypes/components -> static HTML`

Google Stitch remains professional design authority. `DESIGN.md`, screenshots
and provider HTML are retained as design/implementation evidence; raw provider
HTML is not ordinary production authority.

Astro 7 + Tailwind CSS 4 is the single ordinary production renderer because it
preserves near-zero-JS static output while providing materially stronger
semantic HTML, accessibility, SEO invariants, reusable archetypes, 20/100-page
change propagation, AI-agent maintainability and lower proprietary normalization
surface than a Factory-owned general Stitch HTML normalizer.

Do not maintain Path A and Path B in parallel.

Reconsider the renderer only through a later reviewed ADR if Stitch/provider
output gains a stable versioned semantic/slot contract and a direct-static
normalizer can demonstrably meet Factory SEO/accessibility/security/governance
requirements with materially lower total complexity and maintenance cost.

Exit: **Production Renderer = Astro static** is the normative ordinary-page
decision; Run 9 implements and validates that path.

### Macro Run 9 — Production + SEO + Performance Engine

Implement **Astro static only** as the selected ordinary production renderer.
Production input binds exact `AcceptedPageContent` +
`AcceptedDesignArtifact` + `AcceptedVisualAssetSet` + route/site identity.
Rendering must not rewrite accepted copy, redesign accepted visual authority or
substitute assets.

Add deterministic gates for content integrity, semantic landmarks, exactly one
intended H1, heading hierarchy, crawlable links, titles/descriptions,
canonical/robots/sitemap/breadcrumbs/OpenGraph/structured data/internal links,
redirect correctness, responsive image delivery, accessibility, broken links,
responsive overflow, console errors, secrets/dependency vulnerabilities and
Lighthouse/performance regression.

Prefer mature commodity tooling (`schema-dts`, Lighthouse CI, axe-core,
Lychee, Gitleaks, OSV Scanner, Playwright) over Factory-built scanners.

Lab performance evidence must remain distinct from eventual field Core Web
Vitals. Post-deploy field targets remain p75 LCP <= 2.5 s, INP <= 200 ms and
CLS <= 0.1; do not fabricate those measurements before real traffic.

Exit: exact accepted Content + Design + Assets deterministically produce a
static, SEO-ready, accessible, inspectable production candidate with governed
lineage and hard QA gates.

### Macro Run 10 — Page Derivatives: Summary + Audio

Add project defaults and page overrides for AI summary and audio narration.

Generate both once per AcceptedPageContent version and store/cache the result. Content mutation makes derivatives stale. Visitor interactions play/reveal existing artifacts and do not trigger repeated provider generation.

Exit: long editorial pages support reusable `Listen to article` and `AI-generated summary` controls without per-visitor model spend.

## Program V — Productization and Proof

### Macro Run 11 — Full Operator Workflow

Connect existing vertical Dashboard slices into one coherent operator lifecycle with areas for Overview, Intake, Research/Search, Content, Design, Assets, Production, QA, Versions/Costs and Deployment.

Do not build a generic CMS or visual page builder. Dashboard remains a semantic operator console.

### Pre-Run-12 — Design System Implementation Hardening

After Run 11 is independently accepted, merged and post-merge verified, harden
the implementation layer between accepted design authority and Astro before the
multi-page proof. Re-baseline against the exact post-Run-11 `main` SHA first.

The governing policy is `docs/design-system-implementation-policy.md`.

The hardening must preserve the existing architecture:

`AcceptedDesignArtifact -> deterministic implementation contract/policy -> governed semantic tokens -> registered reusable Astro components -> bounded archetype composition -> Astro static output`.

This workstream must not create a second accepted design authority, a parallel
Stitch-native renderer, a generic visual page builder or a new mutable workflow
state. The default expectation is zero database migrations, zero new runtime
dependencies and zero paid provider calls for the hardening itself.

Exit: accepted design deterministically controls reusable implementation;
ordinary pages use registered bounded components/variants and governed semantic
tokens; design-drift, component accessibility and visual-regression gates are
automated; fixture routes cannot leak into production; lineage/staleness remains
correct; and reuse can be measured for Run 12. Builder completion still requires
independent exact-SHA QA before merge.

### Macro Run 12 — High-quality Multi-page Proof

Produce a small coherent Sutherland set such as homepage + service + location + editorial/research page using one accepted design system and multiple archetypes.

Prove search/content strategy, internal links, no cannibalization, accepted content quality, authentic/generated asset discipline, SEO/performance and cheap template/archetype reuse.

In addition to the representative archetypes, use an additional ordinary-page
scalability proof where practical: the expected steady state is no new design
authority, no new renderer, no new DesignProvider call and approximately zero
new component families for a normal page that fits the accepted design system.
Report factual reuse evidence rather than a subjective design score.

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
