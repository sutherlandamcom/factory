# Factory vNext Roadmap

Status: proposed execution plan after merge of PR #16 (`62d60575f73e70067f83254aa3eff23b5995fdcf`).

Development should proceed in 2–3 hour macro-runs. Each macro-run delivers a vertical capability: contract -> application service -> API -> Dashboard -> deterministic tests -> E2E. Backend semantics lead by a small step; frontend is delivered in the same run so operator behavior continuously validates the domain model.

Every meaningful implementation PR ends at `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`; independent QA reviews an exact SHA, frozen P0/P1 findings are remediated narrowly, then the exact candidate is re-reviewed before merge.

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

Exit: high-quality `AcceptedPageContent` for one Sutherland page is produced entirely through Dashboard; no page coder authors copy.

## Program III — Design & Assets

### Macro Run 5 — Asset Foundation + Operator Photography

Deliver project/page asset storage, rights/provenance/digests, page imagery strategies (none/operator/generated/mixed), upload UX, responsive derivatives and approval/assignment lifecycle.

Exit: an operator can upload and approve real Chamonix imagery for a specific page/slot through Dashboard.

### Macro Run 6 — Google Stitch Design Provider

Implement a narrow `DesignProvider` adapter with Google Stitch as preferred v0 provider. Feed real accepted content, brand facts, references/anti-references and available assets. Generate a site design system plus representative archetypes rather than independently designing every page.

Human review/approval is the visual authority. If Stitch clears the institutional-quality floor, stop provider search. Only if it fails should the next cheapest viable provider (Framer, then Figma, then others) be tested.

Exit: accepted Sutherland design artifacts and implementation references exist for homepage plus representative page archetypes.

### Macro Run 7 — Nano Banana Pro + Final Asset Resolution

Implement `VisualAssetProvider` with Google Vertex/Gemini Nano Banana Pro as preferred production path. Support generated candidates and AI-derived edits of operator photos while retaining provenance.

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

Exit: one accepted Sutherland page produces a Cloudflare-ready static bundle with zero unnecessary LLM calls.

### Macro Run 10 — Page Derivatives: Summary + Audio

Add project defaults/page overrides for pre-generated AI summary and audio narration. Generate once per accepted content digest, persist and serve as static/CDN artifacts. Content mutation makes derivatives stale.

Exit: long editorial pages expose approved/reusable `Listen to article` and `AI-generated summary` controls without per-visitor AI/TTS calls.

## Program V — Productization

### Macro Run 11 — Full Operator Workflow

Unify existing vertical slices into a coherent Dashboard navigation and state model:

Overview -> Intake -> Research -> Search -> Content -> Design -> Assets -> Production -> QA -> Versions -> Costs -> Deploy.

Expose typed states such as DRAFT, READY, APPROVED, STALE, BLOCKED and FAILED. Do not duplicate domain logic in the UI.

### Macro Run 12 — High-quality Multi-page Proof

Produce a small real Sutherland set: homepage + service + location + editorial/research page using one accepted design system and multiple archetypes.

Prove search-strategy coherence, internal linking, no cannibalisation, content quality, authentic/generated asset handling, performance and deterministic mass-page production economics.

Measure per-page costs (SERP/research, reasoning, Opus writing, amortized design, assets, production). Target architecture: a typical page using an accepted archetype requires no new Stitch design call and no coding-worker call.

### Macro Run 13 — Production Delivery

Complete browser-operated candidate preview -> human approval -> production publish -> verification -> rollback on Cloudflare with exact lineage across input version, search snapshot, writer brief, accepted content, design, assets, candidate, QA and deployment.

## Scope deliberately excluded from MVP

Do not spend MVP time on:
- generic CMS/page-builder features;
- Puck or drag-and-drop visual editing;
- proprietary AI design engine;
- multi-provider implementations before a real provider fails requirements;
- complex RBAC/multi-tenancy;
- microservices/Kubernetes/queues without demonstrated need;
- real-time collaboration;
- arbitrary plugin systems;
- expensive LLM screenshot review for every page.

## Engineering sequencing rule

Within each macro-run, roughly:

1. first quarter: contract/state machine/application service + deterministic tests;
2. middle half: API + Dashboard workflow;
3. final quarter: E2E, persistence/restart, adversarial/direct-API cases, QA and documentation.

The goal is not equal backend/frontend effort. The rule is: **backend semantics lead by one small step; the real operator experience lands in the same run.**
