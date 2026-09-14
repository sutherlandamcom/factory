# Factory vNext Constitution

Status: **accepted normative vNext architecture policy**, adopted through
PR #17 (`c6c7e000caf9797398dc4e05642ed42a40e664d0`). Acceptance of this policy
does not assert that all capabilities below are implemented or verified;
implementation status and sequencing live in `docs/roadmap-vnext.md`.

This document records the product and engineering direction accepted after the first real Sutherland one-page workflow proof. It governs new vNext work unless a later reviewed ADR explicitly supersedes a rule.

Repository instruction precedence is defined in `docs/instruction-authority.md`. Historical build reports, bake-offs and dated handoffs are evidence about the state at their date and do not override this Constitution or the current roadmap.

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
- **Code worker**: implements accepted content/design only when deterministic production is insufficient. It has zero authority to originate or rewrite marketing copy and zero authority to redesign an accepted page. The current pre-vNext `create_page` compatibility path may still materialize only minimal neutral connective prose from bounded semantic key points until `AcceptedPageContent` exists; this transitional exception MUST NOT be expanded into a new content architecture.
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
- differentiation opportunities.

Do not implement "LSI keywords" or keyword-density pseudo-scoring as a substitute for semantic/search analysis.

Competitor pages are evidence of SERP expectations, not text sources. Factory must not average/rewrite the Top 10 into a derivative page.

## 6. Content Gap is a first-class artifact

The system should reason approximately as:

`user need x SERP expectation x competitor coverage x our accepted evidence -> differentiated content opportunity`.

A `ContentGapReport` should preserve the user need/question, existing SERP coverage, competitor treatment quality, available first-party evidence, differentiation opportunity, priority and whether the gap is required in the page brief.

## 7. Project Content Constitution and writer governance

Every project has a versioned, human-approved **Project Content Constitution** defining the site-wide brand/editorial voice. It includes structured rules plus a large free-form custom writer-instructions field.

It should cover at least:

- brand voice and tone;
- audience communication principles;
- writing/editorial rules;
- preferred and forbidden terminology;
- factuality/evidence policy;
- allowed/prohibited claim policy;
- people-first/helpfulness policy;
- search/SEO writing policy;
- AI-language/cliche/repetition avoidance;
- project-specific custom instructions.

Each page also has a Search-derived `ContentProductionBrief`. Factory compiles the project Constitution + page brief + evidence/claims into an exact `WriterPromptSnapshot`.

**No marketing content generation may execute until a human has seen and explicitly approved the exact compiled WriterPromptSnapshot.** Approval binds its version/digest; changing an authoritative dependency makes it stale.

## 8. Writer authority

Anthropic Opus is the intended v0 production marketing/editorial writer behind a `WriterProvider` boundary.

The writer receives accepted truth and requirements. It MUST NOT invent unsupported facts, metrics, credentials, experience, client claims, permissions or guarantees.

Writer output is a structured proposal. Independent factual/search/editorial QA and a second human approval produce `AcceptedPageContent`.

Once `AcceptedPageContent` exists, an implementation worker must reproduce it faithfully and must not rewrite, paraphrase, shorten, expand or SEO-optimize it. Genuine content-fit conflicts return to the content workflow rather than being silently fixed by the coder.

## 9. People-first and trust quality

Factory should evaluate concrete qualities rather than fabricate a synthetic "E-E-A-T score". Relevant checks include factual support, first-party experience where applicable, real expertise evidence, authority signals, trust, usefulness, originality, intent satisfaction and the Google-aligned Who/How/Why questions.

Authentic first-party evidence is strategically valuable. Real operator photography or observations from a location should not be replaced by synthetic documentary-looking imagery merely for convenience.

## 10. Professional design is external

Factory MUST NOT build a proprietary AI design engine as an MVP goal.

Professional visual direction and page design are created by an external `DesignProvider`. Google Stitch is the preferred first v0 candidate because of current cost/integration fit; Framer, Figma and other challengers are evaluated only if the preferred provider fails the quality floor.

The provider receives real accepted copy, brand constraints, references/anti-references and available assets. It should create a coherent site design system plus representative page archetypes rather than independently redesigning every SEO page.

Factory stores/version-binds the accepted provider artifacts and human approval. Generated HTML/design-system material may be implementation input; it is not automatically trusted production output.

Current `SiteBlueprint.designDirection`, SiteProductionSpec `creativeDirection`, and legacy `design_director` evaluation roles are transitional planning/evaluation constructs. They do **not** supersede the external DesignProvider as vNext professional-design authority.

## 11. Assets and authenticity

Pages can use a project/page asset strategy such as:

- no imagery;
- operator-supplied photography;
- AI-generated imagery;
- mixed.

Design produces explicit asset slots/requirements. Operator uploads retain rights/provenance and pass an approval lifecycle before production.

Synthetic imagery sits behind `VisualAssetProvider`; preferred v0 production direction is Google Vertex/Gemini Nano Banana Pro. An older executable-policy placeholder named `image_generator` MUST NOT be treated as the vNext production image path without an explicit reviewed provider-policy migration.

AI edits of real photographs preserve `derivedFrom`, transformation/provider/model provenance. Synthetic images MUST NOT masquerade as documentary evidence of a real location/property/person.

Final design freeze occurs after actual assets are resolved so the design can adapt to the accepted real images. Freeze means the accepted Design + Content + VisualAsset authorities are mutually consistent by exact digests. If the selected DesignProvider cannot ingest the exact asset bytes (e.g. the current text-only Stitch seam), the design is still re-derived against the exact final asset lineage, `providerConsumed` stays false, and no UI or report may claim the provider generated with the actual assets.

Run 7 resolution authority is durable and plan-specific for every visual slot.
`reuse_real`, `deterministic_transform`, `ai_edit` and `ai_generate` must all
record the exact old→new version/digest transition before a visual set can
become accepted. `AcceptedVisualAssetSet` must be built from that exact
plan/slot resolution evidence rather than reconstructed from project-wide
candidate history. Final design acceptance must be serialized with competing
project authority mutations so a design cannot become stale inside its own
acceptance commit.

Evidence must distinguish different provider claims. In particular, visual
provider source-byte consumption, visual-provider output generation, design
provider reference to a final asset and design-provider consumption of final
asset bytes are different facts and must not be collapsed into one optimistic
boolean.

## 12. Production should become deterministic at scale

Do not invoke a code/design model for every routine page if an accepted design archetype plus structured content/assets can be rendered deterministically.

Target pattern:

`AcceptedDesignArtifact/archetype + AcceptedPageContent + AcceptedVisualAssetSet + SEO/derivatives -> deterministic Astro production`.

Code workers become an exception path for custom/interactive functionality or genuinely non-template implementation work.

## 13. Astro static is the selected ordinary production renderer

Run 8 selected Astro 7 + Tailwind CSS 4 as Factory's ordinary production
renderer through an evidence-based architecture review rather than a duplicate
throwaway production build.

Google Stitch remains the professional design authority. Accepted Stitch
artifacts, DESIGN.md, screenshots and raw provider HTML may be retained as
immutable implementation/design evidence, but they are not production content,
asset or renderer authority.

Ordinary pages follow:

`AcceptedPageContent + AcceptedDesignArtifact + AcceptedVisualAssetSet -> governed Astro archetype/component -> static HTML/CSS/assets`.

Astro components implement accepted design; they do not redesign it. Client
JavaScript remains opt-in for functionality that genuinely requires it.

Factory does not maintain a parallel general-purpose Stitch-HTML/direct-static
renderer. A later reviewed ADR may reverse this decision only if provider output
offers a stable versioned semantic/slot contract and direct-static can
demonstrably meet the same semantic HTML, SEO, accessibility, security,
governance, visual-fidelity and 20/100-page maintenance requirements with
materially lower total complexity.

## 14. Static production, SEO and performance

Production Astro pages should be static-first: complete semantic HTML at
request time, minimal JavaScript and deterministic technical SEO.

Factory owns/validates metadata, canonical identity, structured data, sitemap/robots/redirect semantics, internal links, image optimization and performance budgets.

Cloudflare remains the preferred current delivery foundation unless a later reviewed decision replaces it.

Core Web Vitals/performance are hard acceptance concerns; "static" alone is not proof. Use deterministic/lab QA such as Lighthouse/Playwright and later field data. Avoid unnecessary third-party scripts and runtime dependencies.

## 15. Visual QA cost rule

Do NOT send every rendered page screenshot to a multimodal LLM by default.

Use expensive/human visual calibration when establishing a new design system/archetype. Mass pages should rely primarily on deterministic checks: content integrity, approved component/template usage, structure, responsive overflow, links/assets, semantic SEO, accessibility and performance. Optional local screenshot/pixel regression or selective human sampling is allowed without creating repeated model spend.

## 16. Page derivatives: summary and audio

Factory supports page-level AI summary and audio narration as version-bound derivatives of `AcceptedPageContent`.

They are generated **once per accepted content version**, stored and delivered as normal cached/static artifacts. Visitor clicks MUST NOT trigger repeated LLM/TTS generation of unchanged content.

Changing the source content makes old derivatives stale.

Project-level defaults plus page overrides control whether summary/audio are enabled. The accepted design system should include reusable controls for these capabilities where appropriate.

## 17. Dashboard is an operator console

Dashboard is explicitly in vNext scope. It is not a second source of truth and not a generic CMS/page builder.

For each new product capability, prefer a vertical implementation slice:

`domain contract -> application service -> backend/API -> Dashboard -> deterministic tests -> E2E`.

Backend semantics lead by a small step; operator UI lands in the same macro-run. CLI/API/Dashboard should reuse application services rather than duplicate business rules.

Expected workspace areas evolve toward Overview, Intake, Research/Search, Content, Design, Assets, Production, QA, Versions/Costs and Deployment.

## 18. Human approval and fail-closed backend rules

UI-disabled buttons are not governance. Backend/API rules enforce every approval/readiness condition even against direct calls.

At minimum vNext human gates include:

- accepted Project Inputs;
- exact Writer Prompt;
- final marketing content;
- final design;
- material assets where policy requires review;
- final candidate/publication.

Approvals bind exact versions/digests. Mutation makes dependent approvals stale.

## 19. Durable acceptance state

Gitignored `.factory/**` is runtime/diagnostic evidence, not sufficient authoritative storage for human acceptance.

The Operator Kernel workstream must define durable authority for drafts, accepted snapshots, approvals, staleness and artifact metadata. PostgreSQL is the preferred structured operational/product state layer; Git remains source/candidate/architecture lineage. Large binary/object storage is introduced only when the asset slice requires it.

## 20. Cost is an architecture constraint

Use expensive intelligence only where intelligence creates material value. Prefer deterministic code, caching, precomputation, templates and one-time generation for repeat work.

Before a paid call, trusted backend preflight should establish accepted inputs/readiness, provider credentials/reachability, effective budget/limits and relevant DB/environment prerequisites. Fail before spend.

Do not blindly retry paid failures. Classify the failure, fix trusted environment/provider faults outside the model worker, then retry with a new execution identity and preserved lineage.

Persist provider/model usage and cost telemetry whenever available.

## 21. QA and merge governance

Significant implementation work follows:

build agent -> exact candidate SHA -> independent QA -> narrow P0/P1 remediation if required -> re-QA exact new candidate -> merge.

Build agents do not self-accept or merge their implementation work. P2 findings normally move into the next appropriate workstream rather than expanding a frozen accepted PR.

Deterministic QA is preferred wherever it can test the requirement directly.

## 22. PR #16 empirical carry-forward

The Sutherland one-page proof established that the current bounded execution mechanics work, but independent QA accepted it with P2 follow-ups that vNext must close:

- define/fix `headingIntent` projection semantics;
- prohibit silent loss/truncation of accepted production intent;
- persist accepted inputs/approvals as durable authority rather than relying on ignored/local artifacts;
- create one governed application seam for packet -> task -> run orchestration.

PR #16 is evidence, not a reason to retain coding-agent authorship/design as the target architecture.

## 23. Anti-patterns

Do not introduce or extend these patterns:

- one model researches + writes + designs + codes without bounded authority;
- coder originates production marketing copy;
- coder redesigns accepted design;
- Factory builds a proprietary professional-design engine instead of using a provider;
- LLM invents current SERP data;
- competitor pages become rewrite sources;
- authentic first-party visual evidence is casually replaced by synthetic documentary imagery;
- visitor click triggers repeated unchanged LLM/TTS work;
- every page screenshot is sent to a vision model;
- automatic paid retries without failure classification;
- browser receives provider/database secrets;
- Dashboard/CLI duplicate business truth;
- accepted semantic input is silently truncated/dropped;
- a framework remains mandatory solely because earlier work already used it.

## 24. Factory Codex

1. Factory orchestrates; specialists create.
2. Operator truth/evidence precedes model inference.
3. Every significant artifact retains provenance and version.
4. Humans approve source inputs, exact writer prompt, final content, design and publication.
5. Search Intelligence uses real acquired search evidence.
6. Content gaps define added value; competitors are not copy sources.
7. Opus writes production marketing copy; implementation workers do not become writers.
8. External DesignProvider owns professional design; Factory does not build a proprietary design brain.
9. Authentic imagery wins when it is genuine documentary/first-party evidence.
10. VisualAssetProvider supplies synthetic/edited imagery where appropriate.
11. Use AI once where possible; deterministic rendering/caching handles scale.
12. Typical pages should eventually require no coding-model call.
13. SEO, accessibility, performance, security and content integrity are deterministic gates where possible; Astro is only the renderer and does not own those authorities.
14. Dashboard is an operator console, never a second source of truth.
15. Every additional model call, framework and transformation layer must justify its cost/complexity.
16. Do not automate a mediocre process: choose the right specialist for each creative/intelligence stage, then automate the truthful handoff between them.
