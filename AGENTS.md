# AGENTS.md — Factory engineering rules

These rules apply to every change in this repository, whether written by a
human or an agent executing a `SiteTask`.

Normative vNext product/architecture policy:
- `docs/architecture/factory-constitution-vnext.md`
- `docs/roadmap-vnext.md`

Instruction precedence and historical-document handling:
- `docs/instruction-authority.md`

When current implementation and vNext direction differ, preserve the accepted
current implementation until the roadmap's explicit migration proof/ADR is
accepted. Do not silently migrate architecture by inference. Equally, do not
extend a transitional v0 behavior merely because it still exists in code.

## Technology constraints

- **Language: TypeScript** for Factory control-plane, contracts, application
  services and operator UI unless a concrete reviewed task requires otherwise.
- **Current website production path: Astro 7 + Tailwind CSS 4.** This remains
  the accepted implementation until the roadmap's explicit Stitch-native
  static vs Astro bake-off produces a reviewed ADR. Do not remove Astro or
  weaken current Astro QA before that decision; also do not treat Astro as a
  permanent vNext invariant.
- **Dashboard/operator UI is explicitly in vNext scope.** It must be a thin
  operator surface over shared application services, not a second source of
  business truth or a separate business-logic implementation.
- **No proprietary AI design engine.** Professional design is supplied through
  a bounded external `DesignProvider`; Google Stitch is the preferred v0
  provider until it fails an agreed quality/cost gate.
- **No packages without a concrete reason.** Every new dependency must solve a
  requirement of the task at hand. Plain TS types beat runtime schema
  libraries unless runtime validation is genuinely needed.
- **No infrastructure by speculation.** Databases, object storage, APIs,
  dashboards, provider integrations and deployment capabilities are permitted
  only when required by the current vertical slice and must have explicit
  ownership/trust boundaries.

## Websites and content production

- Prefer **static generation**. Client-side JavaScript only where strictly
  necessary; zero is the default.
- For the current Astro path, **reuse existing components**
  (`sites/starter/src/components/`) before creating new ones.
- Every public page requires:
  - a unique `title` and meta `description`,
  - a canonical URL,
  - exactly one `<h1>` and a sensible heading hierarchy,
  - a responsive layout,
  - coherent internal links,
  - JSON-LD structured data where applicable (e.g. `Article` on blog posts).
- Current Astro-site images are local assets processed through the accepted
  asset path; no external hotlinks. vNext asset work must preserve local/durable
  provenance, rights, optimization and deterministic production semantics.
- **New vNext production paths must not give code workers marketing/editorial
  authorship.** Once `AcceptedPageContent` exists, implementation workers must
  reproduce the accepted copy faithfully and must not originate, rewrite,
  paraphrase, shorten, expand, SEO-optimize or otherwise change it.
- **Legacy compatibility exception:** the current pre-vNext `create_page`
  SiteTask contract can contain semantic `contentBrief` key points rather than
  final accepted prose. The accepted v0 executor may still materialize the
  minimum connective prose needed to render those bounded points. This is a
  transitional compatibility behavior, not a design pattern for new content
  workflows and not permission to invent additional claims or marketing ideas.
- **Code workers do not invent accepted design.** Once a design artifact or
  approved archetype exists, implementation workers must implement it rather
  than redesign it. Current `ProductionSpec` layout/editorial guidance is a
  transitional production input until the external DesignProvider workflow is
  accepted; do not expand it into a proprietary Factory design engine.

## Search, writer and provider governance

- Search Intelligence must be grounded in real acquired evidence. An LLM must
  not fabricate or "imagine" current SERPs.
- The project-level Content Constitution and each page Content Production Brief
  are versioned inputs. The exact compiled writer prompt sent to the marketing
  writer must be visible to and explicitly approved by a human.
- For v0, the intended production marketing/editorial writer role is Anthropic
  Opus under reviewed model/provider policy. Writer output is a proposal, never
  factual authority. Existing evaluation-only content-writer tasks are not a
  substitute for this approval pipeline.
- External providers are isolated behind narrow adapters (`SerpProvider`,
  `WriterProvider`, `DesignProvider`, `VisualAssetProvider`, and later
  `SummaryProvider` / `SpeechProvider`). Provider secrets never enter browser
  state, public artifacts or model prompts that do not need them.
- Professional visual design is owned by `DesignProvider`, not by legacy
  `design_director` model-eval tasks. Google Stitch is the preferred first v0
  candidate; alternatives are tested only if it fails the quality/cost floor.
- Synthetic/generated imagery belongs behind `VisualAssetProvider`; the
  preferred v0 production direction is Google Vertex/Gemini Nano Banana Pro.
  Any older `image_generator` model-policy entry is a pre-vNext placeholder and
  must not be activated as production imagery without an explicit reviewed
  policy migration.
- Authentic operator-owned imagery should be preferred over synthetic imagery
  when the visual is evidence of a real location, person, property, office or
  first-party experience. Synthetic imagery must not impersonate documentary
  evidence.

## Cost and execution discipline

- **Use intelligence where it creates value; use deterministic computation
  everywhere else.** Prefer caching, precomputation, templates and one-time
  generation over repeated model calls.
- No paid model execution may start solely because a UI button exists. Trusted
  backend preflight must establish the required accepted inputs/readiness,
  provider credential/reachability, effective budget/limit and environment/DB
  prerequisites first; fail before spend whenever possible.
- Do not blindly retry paid failures. Classify the failure; fix trusted
  environment/provider causes outside the worker; retry as a new execution
  identity with preserved lineage.
- Persist provider/model usage and cost telemetry whenever the provider makes it
  available.
- Do not send every page screenshot to a multimodal LLM. Use human visual
  calibration for design/archetypes, deterministic mass-page QA, optional local
  pixel regression and selective human sampling.
- Static page summaries and audio narration are generated once per accepted
  content version and served as cached artifacts; visitor clicks must not cause
  repeated LLM/TTS generation.

## SEO & Google Search governance

- **SEO is a first-class acceptance constraint**, not a post-launch pass. Any
  change affecting public routes, indexing, crawling, canonicals, redirects,
  internal links, metadata, structured data, public content, or performance
  MUST be evaluated for Google Search impact before implementation.
- Current official Google Search documentation is the normative external
  authority for Google-specific requirements. Do not encode SEO folklore.
- Public content MUST be helpful, reliable, people-first, purpose-specific,
  original in substance, evidence-supported where factual claims are made,
  and free of fabricated facts, metrics, credentials, experience, or sources.
- Factory MUST NOT create search-engine-first spam patterns: doorway pages,
  keyword stuffing, cloaking, hidden search-targeted text/links, link spam,
  mass thin pages, substantially duplicated location/query pages made
  primarily to rank, or scaled content whose primary purpose is manipulating
  rankings. Automation never justifies lower quality.
- Every intended indexable page MUST have a coherent route/search identity.
  Canonical, internal links, structured-data URL, sitemap URL, and the
  intended public route MUST NOT knowingly conflict.
- Search-related QA gates MUST NOT be weakened merely to make generated
  content pass.
- No ranking guarantees. If official Google guidance changes materially,
  update repository policy instead of preserving stale assumptions.
- Detailed rules: `docs/seo-policy.md`.

## Capability-first workflow

For new Factory product capabilities, prefer one vertical macro-run:

`domain contract -> application service -> backend/API -> Dashboard -> deterministic tests -> E2E`.

Backend semantics lead by a small step; the real operator workflow should land
in the same macro-run. CLI and Dashboard should use the same application
services.

After meaningful website changes, run `pnpm qa` (typecheck -> build ->
Playwright). **A task is never complete while required QA is failing.**

When implementing a current `SiteTask`:
- **Authorized write scope**: the coding agent may modify only files within the
  explicitly authorized site source scope, initially `sites/starter/src/**`.
- **Deny-listed paths**: tests (`sites/starter/tests/**`), Playwright
  configuration (`sites/starter/playwright.config.ts`), root scripts,
  package manifests (`package.json`), lockfiles (`pnpm-lock.yaml`),
  `AGENTS.md`, Git metadata (`.git/**`), and unrelated files are deny-listed.
- **Oracle protection**: QA and changed-file validation run outside the coding
  agent's write scope.
- **Fail closed**: any out-of-scope changed file makes the task fail immediately.

Current Astro Playwright QA runs against the **built** site (`astro preview`),
never the dev server. Screenshot artifacts are local/gitignored QA evidence and
must not be treated as durable approval data unless a later artifact policy
explicitly persists them.

## Human approval and durable state

- Significant accepted artifacts are version/digest-bound. Mutating an
  authoritative dependency makes downstream approval stale.
- At minimum, vNext human gates cover accepted project inputs, writer prompt,
  final marketing content, design, material assets where policy requires it,
  and final publication.
- UI state is never security/governance authority. Direct API calls must fail
  closed when approval/readiness rules are not satisfied.
- Accepted operator inputs/approvals must become durable, reviewable data before
  Dashboard write workflows are considered complete; gitignored `.factory`
  runtime artifacts alone are insufficient as authoritative acceptance state.

## Instruction and evidence hygiene

- Treat dated audits, bake-offs, build reports and gap reports as historical
  evidence unless a current normative policy explicitly adopts their
  recommendation. A sentence such as "next phase" in a 2026-09-01 handoff does
  not override `docs/roadmap-vnext.md`.
- Runtime prompt builders under `apps/factory/src/**/prompt.ts` define only the
  bounded role consuming that prompt. They do not supersede repository-wide
  architecture policy.
- If two current normative files genuinely conflict, surface the conflict in
  the PR rather than selecting one by guesswork.

## Agent and merge governance

- **Build agents**:
  - May: inspect, implement, test, commit, push feature/fix branches, create/update pull requests.
  - Must NOT: merge their own PRs, push implementation directly to `main`, or declare their own work independently accepted.
  - Terminal state: `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`.
- **Independent QA**:
  - Runs separately and independently against an exact candidate commit SHA.
  - Only after an explicit, independent GO verdict may the PR merge into `main`.
  - P0/P1 remediation is narrow and triggers re-QA of the new exact functional candidate. P2 findings are carried into the next appropriate workstream rather than opportunistically expanding the accepted PR.

## Repository layout

- `apps/factory` — Factory control plane and application/backend capabilities.
- `packages/contracts` — machine-readable domain/runtime contracts shared across trusted boundaries.
- `sites/starter` — current accepted Astro starter/production path pending the explicit renderer ADR.
- `docs/architecture.md` — detailed record of implemented architecture; historical "future/deferred" statements inside older sections do not override vNext sequencing.
- `docs/architecture/factory-constitution-vnext.md` — governing vNext product/engineering constitution.
- `docs/roadmap-vnext.md` — macro-run implementation sequence.
- `docs/instruction-authority.md` — precedence rules for repository instructions and historical artifacts.
