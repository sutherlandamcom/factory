# AGENTS.md — Factory engineering rules

These rules apply to every change in this repository, whether written by a
human or an agent executing a `SiteTask`.

Normative vNext product/architecture policy:
- `docs/architecture/factory-constitution-vnext.md`
- `docs/roadmap-vnext.md`

Specialized normative design-implementation policy:
- `docs/design-system-implementation-policy.md`

Instruction precedence and historical-document handling:
- `docs/instruction-authority.md`

When current implementation and vNext direction differ, preserve the accepted
current implementation until the roadmap's explicit migration proof/ADR is
accepted. Do not silently migrate architecture by inference. Equally, do not
extend a transitional v0 behavior merely because it still exists in code.

## Technology constraints

- **Language: TypeScript** for Factory control-plane, contracts, application
  services and operator UI unless a concrete reviewed task requires otherwise.
- **Ordinary production renderer: Astro 7 + Tailwind CSS 4.** Run 8's reviewed
  architecture decision selects Astro static as the single ordinary production
  renderer. Google Stitch / `DesignProvider` generates professional design
  candidates and evidence; it is never Factory design authority. Human
  acceptance creates the immutable/version-bound `AcceptedDesignArtifact`,
  which is the durable Factory design authority. Raw Stitch/provider HTML may
  be retained as implementation/design evidence, but it is not a second
  production renderer or source of truth. Do not maintain a parallel
  Stitch-native/direct-static path unless a later reviewed ADR meets the
  documented reversal conditions.
- **Dashboard/operator UI is explicitly in vNext scope.** It must be a thin
  operator surface over shared application services, not a second source of
  business truth or a separate business-logic implementation.
- **No proprietary AI design engine.** Professional design generation is
  supplied through a bounded external `DesignProvider`; Google Stitch is the
  preferred v0 provider until it fails an agreed quality/cost gate.
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
- For the production Astro path, **reuse existing components**
  (`sites/starter/src/components/`) before creating new ones. New reusable
  primitives must be justified by repeated accepted archetype needs rather than
  speculative page-builder generality.
- For governed design implementation, follow
  `docs/design-system-implementation-policy.md`. Ordinary page implementation
  must prefer `existing component + existing variant` -> `justified variant` ->
  `new reusable component`; a page-local one-off is an exception requiring an
  explicit rationale. Coding agents must use governed semantic tokens and must
  not silently invent new colors, spacing, radii, typography, shadows, CTA
  treatments or cloned design components.
- **No hidden design model between accepted design and production.** Once an
  `AcceptedDesignArtifact` is accepted, do not insert an LLM/coding-model step
  that freely interprets how the design should work. Implementation policy must
  be deterministic/versioned/validated; if the governed contract cannot express
  the accepted design, extend the contract deliberately rather than hiding a
  page-local CSS/model exception.
- Every public page requires:
  - a unique `title` and meta `description`,
  - a canonical URL,
  - exactly one `<h1>` and a sensible heading hierarchy,
  - a responsive layout,
  - coherent internal links,
  - JSON-LD structured data where applicable (e.g. `Article` on blog posts).
- Production rendering must consume exact accepted authority:
  `AcceptedPageContent` + `AcceptedDesignArtifact` +
  `AcceptedVisualAssetSet` + route/site identity. The renderer may materialize
  these authorities but may not silently rewrite, substitute or redesign them.
- Production components consume accepted visual roles/slots; they must not
  hardcode arbitrary project asset paths or call an image provider themselves.
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
- **Code workers do not invent accepted design.** Once an
  `AcceptedDesignArtifact` or approved archetype exists, implementation workers
  must implement it rather than redesign it. Legacy `ProductionSpec`
  layout/editorial guidance remains a compatibility input only; it must not
  supersede the accepted `AcceptedDesignArtifact` authority or expand into a
  proprietary Factory design engine.
- Committed visual-regression baselines are implementation regression oracles,
  not design authority. Do not update snapshots merely to make CI green; a
  baseline change requires intentional review of the visual change.

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
- Professional visual design generation is supplied by `DesignProvider`, not by
  legacy `design_director` model-eval tasks. Google Stitch is the preferred
  first v0 provider; alternatives are tested only if it fails the quality/cost
  floor. Provider HTML/screenshots/DESIGN.md are evidence and implementation
  references; they are never Factory design authority. Human acceptance binds
  the exact immutable/version-bound `AcceptedDesignArtifact`, which is the
  accepted design authority.
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

### Verification and completion evidence

- For each mandatory acceptance criterion, record the relevant test/evidence
  path, exact command, observed result and candidate SHA in the final PR report.
  Distinguish implemented, verified, independently accepted and merged.
- Mark unexecuted required checks `NOT VERIFIED`; missing or failing required
  checks prevent an implementation-complete claim. Report the remaining work.
  A green CI badge proves only the suites that the workflow actually ran.
- New workspace tests ADD to existing regression coverage. Removing, replacing,
  skipping or weakening a required suite/assertion needs explicit justification
  and review; it must never be an incidental way to obtain green CI.
- A browser capability requires its real acceptance journey against the built
  UI and actual API/persistence boundary where applicable. Typechecks, manually
  constructed objects and mocked UI/API tests do not establish that journey.
- Derive test counts and PASS claims from the final execution evidence, including
  skipped tests. Builder self-verification is not independent QA.
- During development run focused checks for affected behavior; run the full
  required QA at the final candidate checkpoint. A 2–3 hour session is a scope
  guideline, not permission to waive acceptance criteria.

After meaningful website changes, run `pnpm qa` (typecheck -> build ->
Playwright). **A task is never complete while required QA is failing.**

Repository engineering agents may change the Factory code, tests and policy
files needed for their explicitly assigned task, under the merge rules below.
The narrower runtime boundary below applies to workers executing a `SiteTask`;
it is not a general ban on authorized Factory maintenance. Neither role may
broaden its own assignment by inference.

The design-system implementation policy does **not** expand a runtime `SiteTask`
worker's write authority. Registry/token/component evolution belongs only to an
explicitly authorized repository-engineering task. A `SiteTask` worker remains
bound by `TaskWritePolicy` and the exact write scope below even if a design
capability would otherwise need extension.

When implementing a current `SiteTask`:
- **Authorized write scope**: current `create_page` permits only the exact page
  path derived from its validated slug by the trusted `TaskWritePolicy`.
  Other files under `sites/starter/src/**` remain read-only for that task.
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
explicitly persists them. When committed visual-regression baselines are added
by the design-system hardening policy, they remain reviewed test oracles rather
than accepted design authority.

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

- At session start inspect current Git/PR state and read this policy, the
  relevant roadmap slice and the task delta. Consult domain documents/code as
  needed. Instruction precedence is not an obligation to reload every document
  on every turn; see `docs/instruction-authority.md`.
- Reuse unchanged context, use targeted searches/ranges and keep successful
  logs compact. After repeated identical failures without new evidence, change
  the diagnostic approach rather than repeating the same command/prompt.
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
- `sites/starter` — accepted Astro static production foundation selected by the Run 8 renderer decision.
- `docs/architecture.md` — detailed record of implemented architecture; historical "future/deferred" statements inside older sections do not override vNext sequencing.
- `docs/architecture/factory-constitution-vnext.md` — governing vNext product/engineering constitution.
- `docs/roadmap-vnext.md` — macro-run implementation sequence.
- `docs/design-system-implementation-policy.md` — normative rules for translating accepted design authority into governed reusable production implementation.
- `docs/instruction-authority.md` — precedence rules for repository instructions and historical artifacts.
