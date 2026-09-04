# Macro Run 1 — Factory Operator Kernel + Project Intake

This file is the implementation prompt for the next build agent after the Factory vNext governance PR is accepted and merged.

## Starting point

Repository: `sutherlandamcom/factory`

Base `main` after PR #16 merge:

`62d60575f73e70067f83254aa3eff23b5995fdcf`

Before doing anything, fetch `origin`, verify the actual current `origin/main`, and rebase/restart the work from the real current `main` if it has advanced. Never assume the SHA above is still current.

Read before implementation:

- `AGENTS.md`
- `docs/architecture.md`
- `docs/architecture/factory-constitution-vnext.md`
- `docs/roadmap-vnext.md`
- `docs/handoffs/2026-09-04-pr16-independent-qa-summary.md`
- `docs/handoffs/2026-09-04-openrouter-token-handoff.md`
- `docs/site-production-spec-v0.md`
- relevant persistence/contracts/executor code and migrations

Do not rely on this prompt instead of inspecting the repository. Repository truth wins when this handoff describes an implementation detail that has since changed.

---

# Mission

Implement the first complete vNext vertical product slice:

**New Project -> Project Intake -> Review -> Accept Inputs -> immutable accepted snapshot -> edit to new draft -> correct persisted/stale state.**

Build backend semantics and Dashboard together in the same macro-run. Backend/domain semantics lead by a small step, but the run is incomplete until a real browser operator can exercise the workflow without terminal/JSON editing.

At the same time, close the PR #16 P2 defects that directly affect trustworthy input projection and operator governance, without redesigning unrelated subsystems.

Target working session: approximately 2–3 focused hours. Prefer a coherent finished slice over broad scaffolding.

Terminal state:

`IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`

Do not merge your own PR.

---

# Non-negotiable architecture

1. **No second source of truth.** Dashboard does not own business state; it renders and invokes application services/API.
2. **Capability-first vertical slice.** Domain contract -> application service -> backend/API -> Dashboard -> deterministic tests -> E2E.
3. **CLI/API/Dashboard share application services.** Do not create duplicate project/approval logic.
4. **Approvals bind exact version/digest.** Mutation after approval creates a new draft and makes downstream acceptance stale where applicable.
5. **Direct API bypass must fail closed.** UI-disabled state is not governance.
6. **Accepted operator inputs/approvals are durable.** Gitignored `.factory/**` is runtime evidence, not sufficient authoritative acceptance storage.
7. **Current website path remains Astro/Tailwind.** This run does NOT execute the later Stitch-vs-Astro renderer decision.
8. **Do not build design/search/writer integrations in this run.** Add only the project-level fields/contracts needed to support later slices.
9. **No paid model calls are required for this run.** Do not burn OpenRouter/Anthropic/Google credits to implement or test Project Intake.
10. **No Puck/CMS/page builder.** Dashboard is an operator console.

---

# Part A — Inspect and close architecture decisions first

Before coding, inspect the real persistence layer and current project/site commands. Produce a short implementation note/ADR in the PR describing the chosen v0 authority split.

Preferred v0 direction unless repository evidence strongly contradicts it:

- **PostgreSQL**: durable structured operational/product state: project intake drafts/versions, accepted snapshot metadata/content, approvals, staleness/version relationships.
- **Git**: source code, architecture, production candidate/source lineage; not the sole database for mutable operator drafts.
- **`.factory/**`**: local/runtime artifacts and diagnostic evidence; never the only durable place for an accepted operator approval.
- **large/binary assets**: explicitly deferred to the asset macro-run unless a minimal interface/path is required now. Do not install object-storage infrastructure pre-emptively.

Keep one trusted operator MVP. Do not build enterprise RBAC/multi-tenancy.

---

# Part B — Domain model for Project Intake

Create strict, bounded domain contracts for the input workflow. Reuse existing `projects` table identity rather than creating a duplicate Project concept.

The exact naming may adapt to repository conventions, but the model must represent at least:

## Project intake draft

A current editable draft for a project with optimistic concurrency/version identity.

Structured fields should cover the source information required by the vNext Constitution, at minimum:

- business identity/name/description;
- offerings/services and priorities;
- audiences;
- geographic markets;
- site identity candidate: domain/origin, language, site name;
- conversion goal(s) and verified/unverified destination state;
- operator facts/evidence notes sufficient for later evidence attachment;
- allowed claims;
- prohibited claims;
- unknown/unverified claims/constraints;
- search seed topics/queries;
- known competitors;
- brand facts;
- design references/anti-reference URLs/notes as structured seeds (no screenshot acquisition yet);
- existing asset notes/availability (no binary upload pipeline yet);
- project constraints;
- **Project Content Constitution draft** with at least brand voice/tone, writing principles, preferred/forbidden terminology, people-first/evidence rules and a free-form custom writer-instructions field.

Do not require the operator to know SEO jargon. Search seeds are seeds, not mandatory `primaryKeyword` fields.

## Provenance

Represent provenance explicitly for meaningful records where practical. At minimum support:

- `operator_supplied`
- `discovered`
- `derived`
- `model_proposed`
- `human_accepted`

For Macro Run 1 most data will be `operator_supplied`; the model must be able to support later stages without migration into an incompatible provenance model.

## Accepted snapshot

Human `Accept Inputs` creates an immutable accepted snapshot with:

- project identity;
- monotonically understandable version/revision identity;
- canonical normalized payload;
- deterministic digest (SHA-256 over canonical JSON or repository-standard equivalent);
- created/accepted timestamps;
- explicit acceptance status;
- relationship to source draft/revision;
- exact accepted payload or durable content reference that survives restart.

The acceptance action must be idempotent or safely reject duplicate/concurrent acceptance in a deterministic way.

## Mutation semantics

After snapshot v1 is accepted:

- editing does NOT mutate v1;
- operator edits/create a new draft revision;
- accepting that revision yields v2;
- v1 remains inspectable;
- the workspace clearly shows which version is currently accepted and whether the editable draft differs.

Use optimistic concurrency (`baseVersion`, `updatedAt`, digest or equivalent) so two stale browser tabs cannot silently overwrite each other.

---

# Part C — Persistence and migrations

Inspect existing Drizzle/PostgreSQL schema before selecting table names.

Add the minimum tables/columns needed for durable intake/acceptance. Avoid generic workflow-engine tables.

Requirements:

- database constraints for statuses/bounds where appropriate;
- transactional acceptance: snapshot + acceptance state cannot half-commit;
- restart-safe reads;
- no secrets in payloads/logs;
- migration is transparent/reviewable SQL;
- existing persistence tests remain green;
- add real PostgreSQL integration coverage for the new state transitions.

Do not store provider credentials or browser session secrets in Project Input payloads.

---

# Part D — Shared application service layer

Create application services/use cases with semantic operations such as:

- create project/workspace;
- get operator workspace/read model;
- save/update intake draft with optimistic concurrency;
- validate/review intake;
- accept current intake into immutable snapshot;
- list/read accepted versions.

The exact function names may differ, but handlers and CLI must call these services rather than Drizzle directly.

Create a canonical read projection (for example `ProjectOperatorWorkspace`) that gives Dashboard one bounded view of:

- project identity;
- current draft;
- validation/readiness issues;
- accepted snapshot/version;
- whether draft differs from accepted;
- status (`DRAFT`, `READY`, `APPROVED`, etc. as appropriate);
- next valid operator actions.

Do not make Dashboard infer workflow state from raw DB rows.

---

# Part E — Intake validation/readiness

Validation is deterministic. It should distinguish:

- schema/format errors;
- required source inputs missing;
- allowed-to-proceed warnings vs hard blockers.

Do not overrequire fields that later research can derive. For example, missing exact keyword clusters should not block Project Intake.

A project can be accepted when the operator has supplied enough truth for research/content/design work to begin, even if later conversion assets or CTA destinations remain explicitly unverified. Preserve explicit unknown/missing state rather than fabricate values.

Typed diagnostics should be stable enough for Dashboard to render without parsing English error strings.

---

# Part F — Trusted Operator API

Implement the narrowest API needed for this slice.

Security/topology for MVP:

- bind trusted operator service to `127.0.0.1` by default;
- same-origin Dashboard/API in the normal operator path;
- no permissive CORS;
- no provider/database credentials exposed to browser code;
- semantic mutation endpoints only;
- anti-CSRF/session/origin protection appropriate to the chosen local same-origin topology;
- bounded request bodies and strict runtime validation;
- errors are typed/sanitized;
- no filesystem/Git/provider plumbing exposed as browser parameters.

Likely semantic endpoints/use cases include project creation, workspace read, draft save and accept. Do not build generic REST CRUD for every table.

If a minimal Node HTTP implementation is sufficient, prefer it over adding a server framework. If a dependency materially reduces risk/complexity, justify it in the PR.

---

# Part G — Dashboard shell + Project Intake

Create the first actual operator UI.

Choose the smallest maintainable TypeScript frontend implementation that fits the repository. React/Vite is acceptable if justified, but do not introduce a framework merely because an earlier chat suggested one. Inspect repository constraints and use the simplest concrete solution.

Required user journey:

1. open Factory Operator UI;
2. create a project with key/name;
3. enter Project Intake through clear grouped sections;
4. save drafts without JSON editing;
5. see validation/readiness issues;
6. open Review Inputs;
7. see a human-readable summary of what will be accepted;
8. click `ACCEPT INPUTS`;
9. see exact accepted version/digest/status;
10. reload browser / restart service and see the same accepted state;
11. edit an accepted project -> see new draft state without mutating accepted v1;
12. accept again -> produce v2 with v1 still inspectable.

Suggested sections:

- Business
- Offering
- Audience
- Markets
- Site Identity
- Conversion
- Evidence / Claims
- Search Seeds / Competitors
- Brand
- References
- Assets (metadata/availability only in this run)
- Constraints
- Content Constitution / Writer Settings

The Content Constitution view must include a large custom writer-instructions textarea plus structured voice/rule fields. It is project-level, not page-level.

No visual editor.

UX should expose provenance/status/versioning clearly but not overwhelm the operator with Git/database internals.

---

# Part H — PR #16 P2 compiler hardening

Close P2-1 and P2-2 in the same PR because they are small trusted semantic-integrity defects and directly affect future accepted-input governance.

## H1 — `headingIntent`

Today `PageProductionPacket` carries `orderedSections[].headingIntent`, but `projectPacketToSiteTask()` uses `blueprintSection.heading` for the brief heading. Define an explicit rule.

Preferred behavior if contract bounds allow it:

- the Blueprint remains factual/structural authority;
- an accepted non-empty ProductionSpec `headingIntent` is the production heading instruction for that section instance and should be projected into the execution brief;
- repeated instances must therefore be able to carry distinct heading intents;
- if the target contract cannot represent this safely, fail closed and document/deprecate rather than silently ignore the field.

Add tests that reproduce the PR #16 repeated-section heading case.

## H2 — eliminate silent semantic truncation/drop

Current compiler behavior silently truncates `layoutDirection` / `editorialDirection` and slices key points/prohibited claims.

Silent loss of accepted meaning is prohibited.

Choose one reviewed deterministic policy:

- align upstream/downstream bounds so accepted values fit and then fail closed on overflow; OR
- return a typed blocker requiring operator review of explicit truncation.

Do not silently `slice()` or ellipsize authoritative accepted semantics.

Add boundary tests for all affected fields.

---

# Part I — packet -> task -> run application use case

PR #16 proved `projectPacketToSiteTask()` but left orchestration fragmented.

Within this macro-run, at minimum design and preferably implement a shared governed application service that composes:

accepted/resolved production inputs -> readiness -> page packet -> trusted SiteTask projection -> execution request.

Do NOT trigger live model execution in tests or as part of this run. The service should support dependency injection/mocking and reuse the existing executor.

If full execution wiring would materially threaten completion of the Project Intake vertical slice, do not leave a half-designed generic workflow engine. Instead:

- implement the stable compile/projection use case;
- document the exact remaining execution call boundary;
- make it the first item of the next relevant production run.

No duplicated CLI business logic.

---

# Part J — paid-provider preflight foundation

Do not implement external provider calls yet, but make sure the application architecture has a trusted place for future preflight/status and that Dashboard never gets secrets.

Preserve/extend cost telemetry semantics where applicable. Existing `model_invocations` should remain truthful.

Do not run OpenRouter evals/smokes for this PR.

---

# Required tests

At minimum add deterministic/unit/integration/E2E coverage for:

## Domain/application

- project creation;
- valid draft save/read;
- validation diagnostics;
- deterministic snapshot digest;
- accept creates immutable v1;
- editing after acceptance does not mutate v1;
- accept creates v2;
- stale optimistic-concurrency write rejected;
- duplicate/idempotent acceptance behavior deterministic;
- direct service/API attempt to accept invalid/blocking draft fails closed;
- restart/read persistence.

## PostgreSQL

Use real PostgreSQL acceptance coverage following repository practice. Do not weaken existing persistence isolation tests.

## API/security

- bounded/validated input;
- mutation without required anti-CSRF/origin/session condition rejected according to chosen topology;
- no permissive CORS;
- secrets absent from API responses/errors;
- invalid/stale acceptance rejected server-side.

## Dashboard E2E

Automate the complete browser journey through accepted v1 -> edit -> v2. No terminal/JSON manipulation in the E2E.

## Compiler P2

- repeated section instances preserve distinct accepted heading intents;
- unknown/invalid heading intent fails correctly;
- no silent guidance truncation;
- no silent keyPoint/prohibitedClaim dropping;
- existing packet/SiteTask bounds remain authoritative.

Run all relevant repository checks including full `pnpm qa` and PostgreSQL acceptance. If Dashboard introduces its own build/test commands, integrate them into the authoritative repository QA path rather than creating an undocumented side test suite.

---

# Explicit non-goals

Do NOT implement in this run:

- live SERP provider/DataForSEO/SerpApi;
- competitor crawling;
- Content Gap model execution;
- Anthropic Opus writer calls;
- Google Stitch;
- Nano Banana / image generation;
- binary asset upload/object storage unless absolutely required by the intake slice (metadata placeholders are enough);
- audio/TTS/AI summaries;
- Stitch-vs-Astro bake-off;
- static normalizer;
- multi-page generation;
- production publishing changes;
- Puck or rich visual page builder;
- enterprise auth/RBAC/multi-tenancy;
- background queues/schedulers.

---

# Migration/backward compatibility

Existing CLI, SiteTask executor, Sutherland accepted site and PR #16 behavior must remain green.

Do not rewrite the existing site foundation or Sutherland homepage as part of Operator Kernel work.

Do not change accepted ModelRolePolicy unless a concrete implementation requirement forces it; this run should not need such a change.

Do not reinterpret PR #16 as proof that Factory should remain the designer. It proved page generation on a prepared trusted foundation; the external DesignProvider program comes later.

---

# Documentation required in the PR

Update implemented architecture documentation so it distinguishes:

- what now exists;
- what remains roadmap only;
- durable data authority;
- API/browser trust boundary;
- approval/version/staleness semantics;
- current Astro production path vs future renderer decision.

If implementation requires changing the vNext Constitution, stop and make the policy change explicit rather than silently diverging.

---

# Final report required from build agent

Return a concise but exact report containing:

1. base SHA and final candidate SHA;
2. branch / PR URL;
3. changed files and architecture introduced;
4. DB migrations/tables/constraints;
5. application services added/reused;
6. API routes/security topology;
7. Dashboard user journey implemented;
8. approval/version/digest/staleness behavior;
9. PR #16 P2-1/P2-2 resolution details;
10. packet->task->run orchestration status;
11. exact QA commands and counts/results;
12. any P0/P1/P2 self-findings;
13. explicit list of deferred roadmap items;
14. confirmation: no paid model/provider calls were used for this run;
15. terminal line exactly:

`IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`

Do not merge the PR.
