# Factory vNext Constitution

Status: **proposed authoritative architecture policy for the next Factory workstream**.

This document records the product and engineering direction accepted after the first real Sutherland one-page workflow proof. It governs new vNext work unless a later reviewed ADR explicitly supersedes a rule.

## 1. Product identity

Factory is an AI-native production control plane for research, search intelligence, content production, design orchestration, assets, deterministic build/QA, versioning, approvals and deployment.

Factory is **not** a generic CMS, visual page builder, proprietary design generator, or autonomous all-in-one website agent.

Factory owns truth, provenance, approvals, readiness, execution policy, QA, candidate lineage and deployment. Specialized providers create bounded outputs inside that governance.

## 2. Separation of authority

The system MUST preserve the following role boundaries:

- **Operator / accepted evidence**: authoritative business facts, constraints, allowed/prohibited claims and first-party evidence.
- **Search Intelligence**: determines search demand, SERP composition, intent, query clusters, entities, topics, subtopics, questions, modifiers, search vocabulary, related concepts and semantic coverage requirements from real acquired evidence.
- **Anthropic Opus writer**: authors marketing/editorial prose from a human-approved Content Production Brief. The writer is an author, not factual authority.
- **External Design Provider**: creates professional visual design. Preferred v0 provider is Google Stitch behind a provider adapter; cheaper/alternative providers are tested only if the preferred provider fails the agreed quality floor.
- **Visual Asset Provider**: creates or edits synthetic visual assets where appropriate. Authentic operator-owned photography has priority when it represents real places, people, properties or first-party experience.
- **Code worker**: implements accepted content/design only when deterministic production is insufficient. It has zero authority to originate or rewrite marketing copy and zero authority to redesign an accepted page.
- **Factory**: validates, versions, approves, materializes, tests and deploys accepted outputs.

No single model should perform research, writing, design and coding as one unconstrained task.

## 3. Provenance is first-class

Significant information MUST retain origin and status. At minimum distinguish:

- `operator_supplied`
- `discovered`
- `derived`
- `model_proposed`
- `human_accepted`

Acceptance never erases provenance.

Every significant accepted artifact MUST be versioned and digest-bound. Mutating an authoritative dependency makes downstream approval stale.

## 4. Project Intake is the beginning of production

A new project begins as a DRAFT workspace in the Dashboard. The operator enters structured source information before research or generation:

- business identity and offering;
- audiences and markets/geography;
- domain/language/site identity;
- conversion goals and verified destinations;
- evidence and factual claims;
- prohibited/unknown claims;
- search seeds and known competitors;
- brand voice and brand facts;
- design references and anti-references;
- existing assets and rights;
- project constraints.

Human `ACCEPT INPUTS` creates an immutable `ProjectInputSnapshot` version/digest. Editing accepted inputs creates a new draft version; history is never rewritten.

## 5. Search and content intelligence

Search strategy MUST use real acquired search evidence, not an LLM's imagined SERP.

For relevant queries Factory should preserve query, location, language, device and observation time and normalize SERP results, SERP features, related questions/searches and competitors.

Page-level content intelligence MUST be capable of expressing:

- search intent;
- primary/secondary/long-tail query clusters;
- entities;
- topics and subtopics;
- questions;
- modifiers;
- search vocabulary;
- related concepts;
- required semantic coverage;
- optional semantic coverage;
- competitor/SERP patterns;
- content gaps;
- differentiation opportunities;
- evidence requirements and missing evidence.

Do not use `LSI keywords` or keyword density as architectural abstractions. Do not rewrite or average the Top 10. Competitors are evidence of market/search expectations; original value must come from accepted evidence, expertise and analysis.

## 6. Project Content Constitution and writer governance

Each project MUST have a versioned, human-approved **Project Content Constitution** visible in the Dashboard. It governs every page and includes brand voice, tone, writing principles, preferred/forbidden terminology, factuality/evidence policy, search policy, people-first usefulness, AI-language avoidance and operator-supplied custom writer instructions.

Each page MUST also have a structured **Content Production Brief** compiled from Search Intelligence, Content Gap, semantic requirements, accepted evidence, claims policy, page objective, internal links and conversion requirements.

Factory compiles the project constitution + page brief + immutable Factory writer policy into the exact `WriterPromptSnapshot` that will be sent to the writer. The exact prompt MUST be visible to the operator and MUST receive explicit human approval before a paid writer call can run.

If any contributing input changes, the approval becomes `STALE` and generation fails closed until re-approved.

## 7. Marketing copy authority

For v0, the marketing/editorial writer role is **Anthropic Opus** through the reviewed WriterProvider/model policy.

A code worker, design provider, summary model or research model MUST NOT originate, rewrite, paraphrase, shorten, expand or SEO-optimize accepted marketing copy.

Opus output is a proposal. It must pass factual, evidence, search-intent, semantic-coverage, differentiation, originality, usefulness, brand-voice and editorial QA before a human may create `AcceptedPageContent`.

Do not invent an artificial E-E-A-T score. Evaluate concrete trust/experience/expertise/authority evidence and Google-aligned people-first quality criteria.

## 8. Design is externally synthesized

Factory MUST NOT build an internal AI design-generation engine.

Design is supplied through a `DesignProvider` boundary. Google Stitch is the preferred v0 provider because it can return professional design artifacts and implementation references; provider-specific details must remain behind the adapter.

Design generation should use real accepted copy, brand facts, references/anti-references and available real assets. Prefer creation of a site design system plus a small number of representative page archetypes over independent AI design generation for every page.

Human design approval creates an `AcceptedDesignArtifact`/digest.

## 9. Assets and authentic imagery

Page imagery strategy supports at least:

- no imagery;
- operator-supplied imagery;
- AI-generated imagery;
- mixed.

Design requirements should materialize as explicit asset slots with purpose, aspect ratio, minimum quality, visual direction and preferred origin.

Authentic operator-owned photography SHOULD be preferred for documentary/local truth (for example real Chamonix/Megève places, actual properties, offices, people or first-party experience). Synthetic imagery must not impersonate documentary evidence.

Generated/AI-edited assets require provenance, provider/model identity, source relationship where applicable, rights/usage status, digest and human approval. Current preferred generated-image path is Google Vertex/Gemini Nano Banana Pro behind `VisualAssetProvider`.

## 10. Human-in-the-loop gates

At minimum, explicit human gates exist for:

1. accepted project inputs;
2. writer prompt/Content Production Brief;
3. final page content;
4. design;
5. material assets where policy requires it;
6. final candidate/publication.

UI state never substitutes for server-side enforcement. Direct API calls must fail closed when approval/readiness requirements are not met.

## 11. Intelligence budget principle

Use expensive model intelligence only where it creates material value. Prefer deterministic algorithms, versioned templates, caching, precomputation and one-time generation everywhere else.

Examples that justify model intelligence: search/content reasoning, high-quality writing, professional external design synthesis, image generation/editing, exceptional custom coding.

Examples that normally do not justify model calls: HTML assembly, metadata/schema insertion, sitemaps, cache headers, asset optimization, link checking, content-integrity checks, responsive overflow checks, build/deploy, static summary/audio delivery, template rendering.

Repeated visitor actions MUST NOT trigger repeated LLM/TTS generation for static page derivatives. Generate once per accepted content version, persist, cache and serve.

## 12. Paid-execution preflight

No paid model execution may run merely because the UI exposes a button. The trusted backend must establish required provider credentials/reachability, effective available budget/limit, accepted inputs, readiness, execution identity and relevant environment/DB preconditions first.

Fail before spend whenever possible. Automatic blind retries are prohibited. A failed attempt must be classified; trusted environment defects are fixed outside the worker before a new execution with a new idempotency identity.

Persist provider/model usage and cost telemetry when the provider supplies it.

## 13. Dashboard and backend co-development

Factory is developed capability-first as vertical slices:

`domain contract -> application service -> backend/API -> Dashboard -> deterministic tests -> E2E`.

Backend semantics lead by a small step; the operator UI is delivered in the same macro-run. The Dashboard is an operator console, not a second source of truth and not a place for duplicated business logic.

CLI and Dashboard should call the same application services.

## 14. Production renderer: current implementation vs vNext decision

The accepted current production path remains Astro 7 + Tailwind 4. Do not remove or weaken it by assumption.

However, Astro is no longer a permanent architectural invariant. vNext MUST run an empirical, reviewed comparison between:

- Stitch/design-provider HTML -> deterministic Factory static normalization; and
- Stitch/design-provider output -> Astro implementation.

Compare implementation cost, model tokens, HTML semantics, SEO, accessibility, performance, maintainability, reusable-archetype scaling and production complexity. One human visual calibration is sufficient; do not use multimodal LLM screenshot comparison on every page.

Only a reviewed ADR after this proof may remove Astro from ordinary page production. Until then, existing Astro/Tailwind production guarantees remain authoritative.

## 15. Static/performance/SEO principles

Regardless of renderer, indexable content should ship as complete semantic HTML with minimal client JavaScript. SEO, accessibility, caching and Core Web Vitals are acceptance constraints, not later optimization passes.

Factory should deterministically own title/meta/canonical/schema/sitemap/redirect/indexability rules, content integrity, image optimization, asset fingerprinting, cache policy and performance gates.

Cloudflare remains the preferred delivery foundation unless a later reviewed decision changes it.

## 16. Page derivatives

Factory should support project defaults plus page overrides for:

- pre-generated AI summary;
- pre-generated audio narration.

Both derive from exact accepted content versions. Updating accepted content makes dependent derivatives stale. Summary/TTS should be generated once and served as ordinary cached/static artifacts.

## 17. Visual QA economy

Do not send every rendered page screenshot to an LLM.

Use human visual approval during design/archetype calibration, deterministic DOM/structure/content/performance QA for mass production, optional local pixel regression for stable archetypes, and human sampling where useful.

## 18. Current empirical debt carried from PR #16

PR #16 independently passed with P0=0/P1=0. The following are mandatory vNext follow-ups, not defects to rewrite into the accepted PR:

1. `headingIntent` currently does not reach the SiteTask compiler directly; define explicit execution/consumer semantics or deprecate it.
2. `boundedGuidance` and key-point/prohibited-claim slicing silently discard accepted semantics; replace silent truncation/drop behavior with fail-closed bounds or explicit reviewed truncation markers.
3. accepted operator inputs, reference approvals and run evidence currently rely substantially on gitignored `.factory` artifacts; durable approval/input/artifact authority must be defined before Dashboard write workflows ship.
4. packet -> projected task -> run is not yet a single governed application use case.
5. asset workflow, Mode-A CTA, automatic site-foundation derivation and high-quality multi-page production remain unproven.

## 19. Anti-patterns

Do not:

- let a coding worker write marketing copy;
- let a coding worker invent page design;
- build a proprietary design generator when an adequate external provider exists;
- let an LLM imagine current SERPs;
- generate scaled thin/search-engine-first pages;
- treat competitor copy as source material to rewrite;
- replace available authentic evidence with fake documentary imagery;
- call paid AI on every visitor interaction;
- perform expensive multimodal visual review on every page;
- retry paid failures blindly;
- expose provider secrets to the browser;
- allow UI/API paths to bypass approval/readiness rules;
- retain a framework or transformation layer solely because it already exists.

## 20. Governing maxim

**Do not automate a mediocre process. Choose the best specialized executor for each stage, then make Factory excellent at transferring accepted truth, provenance and bounded outputs between them.**
