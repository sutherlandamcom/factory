# Factory architecture

Repository policy: [`AGENTS.md`](../AGENTS.md) and
[`docs/seo-policy.md`](./seo-policy.md) — Google Search / SEO governance is a
first-class acceptance constraint for all Factory work.

## Reading this implementation record

Current product policy and sequencing live in the [Constitution](./architecture/factory-constitution-vnext.md)
and [roadmap](./roadmap-vnext.md). The roadmap includes a dated Git/PR status
index. Historical scope notes describe earlier slices; they do not defer
capabilities that subsequently landed or authorize new work.

At the 2026-09-06 inspection, main was
`d6eeaaa593e45be3be259feb9cda61fa8b6567c4`. Operator Kernel / Dashboard
[PR #18](https://github.com/sutherlandamcom/factory/pull/18) and instruction
alignment [PR #19](https://github.com/sutherlandamcom/factory/pull/19) are merged.
The Operator section below describes code present on that base. Search
Intelligence [PR #21](https://github.com/sutherlandamcom/factory/pull/21) is an
open candidate, not functionality on this main. Merge and CI are not independent
GO evidence; see the roadmap status index and recheck Git before starting work.

## What exists today (execution trust hardening)

Factory has four application/library workspaces (plus the private root orchestrator):

```
apps/factory        @factory/factory      — control-plane CLI, Operator API + site-task executor (tsx, TypeScript)
apps/dashboard      @factory/dashboard    — React + Vite operator console
packages/contracts  @factory/contracts    — shared machine-readable contracts (Zod schemas + types)
sites/starter       @factory/site-starter — Astro 7 + Tailwind 4 website template
```

### Contracts (`packages/contracts`)

The `SiteTask` type is the single unit of work flowing through the system.
v0 supports `create_page`, which carries a `siteId` and a
page description (`type`, `slug`, `title`, `description`, `sections`). Zod
schemas are the source of truth and TypeScript types are derived from them,
so SiteTasks arriving as JSON at runtime are validated before any work
begins; slugs are restricted to rooted lowercase paths like
`/services/roof-repair` (no traversal, backslashes, query/fragment, double
slashes). `create_page` supports `homepage` (`/`), `general` (ordinary
non-root institutional/trust/methodology/conversion routes), `service`
(`/services/**`), and `article` (`/blog/**`). General pages cannot occupy the
root, service/blog namespaces, or the Foundation-owned `/404` route.

`TaskResult` is the structured run outcome:
- `status`: `"succeeded" | "failed" | "needs_review"`
- `finalStage`: `"validation" | "preflight" | "isolation" | "worktree" | "dependencies" | "codex" | "scope" | "integrity" | "qa" | "verify" | "complete"`
- `baseCommit`: Git commit SHA of the base
- `totalAttempts`: number of coding-worker execution attempts executed (max 3)
- `successfulAttempt`: attempt number that succeeded (nullable)
- `attempts`: list of structured `AttemptResult` items
- `changes`: changed files list + relative path to cumulative `diff.patch`
- `artifacts`: run directory location
- `error`: structured error code and message

The canonical create_page fixture is `packages/contracts/fixtures/create-roof-repair.json`.

### Control plane + executor (`apps/factory`)

#### Protected modules and task write policy

**Accepted Factory modules are protected by default. AI tasks receive explicit
write authority over only the modules/paths required for that task. Cross-module
changes must be declared explicitly rather than performed incidentally.** The
execution principle is **READ MANY / WRITE FEW**: understanding or importing a
module does not grant write authority to it.

The small TypeScript registry contains only modules that exist today:
`contracts`, `control-plane`, `site-source`, `site-configuration`,
`quality-oracle`, and `repository-policy`. Contracts, executor/security code,
tests/Playwright policy, site configuration, and repository policy are protected
from ordinary tasks. `create_page` derives one immutable `TaskWritePolicy` whose
only writable path is the exact page mapped from its validated slug. The same
policy supplies the prompt boundary and post-execution Git validator; a task has
no input field capable of widening it. Future modules register only when they
actually exist, and explicit cross-module migration workflows are deferred.

`pnpm factory site-task <task.json>` runs one SiteTask end to end with a bounded automatic repair loop:

```
validate → clean-repo preflight → strong-execution-isolation gate →
detached git worktree at HEAD → pnpm install --offline --frozen-lockfile →
[Bounded Loop: Attempt 1..3]
  routed coding worker (deterministic router; Attempt 1: initial /
  Attempt > 1: repair-or-escalation) →
  exact-target Git mode/scope enforcement → ignored-input integrity →
  Foundation QA → dynamic requested-route QA → semantic verification →
  [If defect: structured FailureReport & continue when routing-eligible]
→ final diff.patch + TaskResult → cleanup
```

### Code Worker Routing v0 (factory-model-policy-v0.1 — ACTIVE)

The coding execution boundary is a MODEL + CODING RUNTIME pair selected by a
deterministic, trusted Factory router (`executor/router.ts`) — never by an
LLM, a percentage quota, or any SiteTask field:

- **Primary routine code worker**: Kimi K3 (`moonshotai/kimi-k3` on
  OpenRouter), reasoning effort `max`, through the **Kimi Code CLI** runtime (pinned 0.39.1).
- **Senior worker** (critical work, escalation, read-only review): Claude
  Opus 5 (`anthropic/claude-opus-5` on OpenRouter) through **Claude Code** (pinned 2.1.150).
- **Legacy Codex worker** (`codex-cli`): retained rollback/reference path
  only; after activation it is NOT a normal routing fallback.
- MODEL, RUNTIME, and GATEWAY are distinct provenance fields; "Kimi K3 Max"
  means model id + reasoning effort, never a model string. Exact slugs are
  pinned; aliases, `:batch` variants, and `openrouter/auto` are rejected by
  policy tests.
- Status: **`migrationActivated: true`** (active product path).

Routing semantics:

- `create_page` (the only current SiteTask type) classifies `routine` →
  primary worker attempts 1–2, senior escalation on attempt 3 when the
  attempt-2 failure is escalation-eligible. `senior_required` (future task
  types) starts on the senior worker at attempt 1.
- **Escalation-eligible failures**: repairable QA/verification/replay
  defects, `no_progress`, and routed-runtime failures/timeouts
  (`kimi_execution_failed`, `kimi_timeout`, `claude_*` equivalents).
- **Terminal — never escalate**: `scope_violation`, `integrity_violation`,
  isolation unavailability, invalid task/configuration, preflight and
  dependency failures, `qa_timeout`, credential-configuration errors, and
  all legacy Codex codes. A security violation is reported, never laundered
  through the senior runtime.
- `MAX_TOTAL_ATTEMPTS = 3` is unchanged (contract constant + SQL CHECK).
- The expected operational distribution (~70–85% primary / ~15–30% senior)
  is economic guidance only; risk routing always overrides percentages.
- Acceptance-only runtime selection: requires BOTH `FACTORY_ACCEPTANCE_MODE=1`
  and `FACTORY_ACCEPTANCE_RUNTIME` (trusted Factory process env, same trust
  class as `FACTORY_MAX_ATTEMPTS`) to force the senior or primary runtime for
  REAL isolated acceptance runs. Without `FACTORY_ACCEPTANCE_MODE=1`, leftover
  acceptance variables are ignored in normal production. SiteTask content can
  never select a runtime, model, or reasoning effort.

Runtime hardening (outer boundary is authoritative — the routed CLIs have
no inner sandbox equivalent to Codex's bubblewrap, so the container is
hardened further instead):

- Two pinned worker images (`factory-kimi-worker:0.39.1`,
  `factory-claude-worker:2.1.150`) run under the default seccomp profile
  (no unconfined exceptions), read-only rootfs, capability-free,
  no-new-privileges, resource-bounded, non-root.
- Ephemeral per-run runtime homes (`.factory/kimi-runtime/<id>`,
  `.factory/claude-runtime/<id>`, inside the Colima mount policy; deleted
  during cleanup) hold only Factory-supplied trusted configuration.
- **Factory Model Relay & Credential Isolation**: worker containers possess
  NO real `OPENROUTER_API_KEY` and NO direct public internet/OpenRouter access.
  Worker model calls route through an ephemeral local Factory model relay
  (`executor/relay.ts`) that owns the real provider credential and strictly
  enforces exact model bindings (`moonshotai/kimi-k3` for Kimi,
  `anthropic/claude-opus-5` for Claude), immediately rejecting unauthorized
  model requests (0 upstream calls).
- **Model alias pinning**: Claude Code model-alias env vars are ALL pinned
  to `anthropic/claude-opus-5` (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) so main and auxiliary calls
  cannot silently select another model.
- Runtime provenance records worker tier, requested/responded model,
  reasoning effort, escalation (+reason), exit code, and runtime version;
  unknown values stay `null` — provenance is never invented.
  `model_invocations` persists these as nullable columns (migration 0003).

Senior read-only review (additive evidence, never the QA oracle): Claude
reviews a FROZEN candidate patch with all inputs mounted read-only, write
tools denied, and outputs structured P0/P1/P2 findings; the deterministic
Factory gates remain authoritative.

- **Isolation**: a detached worktree is source-state isolation, not host-read isolation. The production boundary is a dedicated `factory-sandbox` Colima QEMU VM with exactly four host mounts (`.factory/worktrees`, `.factory/codex-runtime`, `.factory/kimi-runtime`, `.factory/claude-runtime`), an ephemeral hardened Docker worker, and — for the routed runtimes — the outer egress allowlist (the CLIs have no inner sandbox equivalent; see Code Worker Routing v0). Factory verifies the saved mount policy and Linux Docker server before execution and never falls back to the former host-shared runner.
- **Legacy Codex worker container**: the version-controlled Node 22 image pins `@openai/codex@0.150.1`. Runs are non-root, read-only, capability-free, `no-new-privileges`, resource-bounded, and temporary. Ubuntu's AppArmor user-namespace restriction is disabled only inside this dedicated VM and the worker's AppArmor/seccomp profiles are unconfined so Codex's inner bubblewrap sandbox can create its own user/mount namespaces; this does not change the VM mount boundary, grant Linux capabilities, or expose host paths. The current worktree is read-only except for the target page's parent directory; the immutable task policy still permits only the exact page and post-execution Git/integrity checks remain authoritative. No Docker/SSH-agent socket, host HOME, browser profile, primary checkout, or host `/tmp` is mounted.
- **Dependency prep**: Factory (never the coding worker) installs dependencies offline from the pnpm store against the committed lockfile once per run.
- **Legacy Codex layered sandbox policy**: Factory copies only the host Codex `auth.json` into a per-run directory, mounts it read-only, ignores user configuration, and deletes the copy during cleanup. The outer container permits Codex model-service connectivity; the inner `workspace-write` policy keeps approval disabled, shell/tool network disabled, and web search disabled. Necessary Codex authentication remains a residual readable secret inside that isolated runtime.
- **Scope enforcement**: the validated slug maps to exactly one writable `.astro` page. NUL-delimited `git diff --raw -z --no-renames` makes every rename source/destination visible as delete/add; only regular non-executable `100644` files pass. Symlinks, gitlinks, special modes, and unrelated source paths are terminal violations.
- **Ignored-input integrity**: Factory snapshots ignored state after dependency preparation and before each attempt, hashes contents/types/modes (including `.env*`, `.astro`, and `node_modules`), and compares immediately after the selected coding worker. Output exclusions are strictly anchored to explicit known repository roots (`.factory/**`, `sites/starter/dist/**`, `sites/starter/.astro/**`, `sites/starter/test-results/**`, `sites/starter/playwright-report/**`, `sites/starter/qa-artifacts/**`); nested unanchored names (such as `.../dist/helper.ts`) are never ignored or excluded.
- **Independent QA Oracle**: unchanged Foundation `pnpm qa` runs first. Factory then creates a validated task QA spec outside the worktree and runs immutable Playwright assertions for the requested route on desktop and mobile: response/errors, exact metadata/H1/canonical/OG, page-type JSON-LD, requested CTA/FAQ, bounded internal links, image semantics, meaningful body content, and mobile overflow.
- **Task verification**: a dependency-free semantic extractor checks fresh built HTML for exact title, one exact H1, description, canonical origin/path, and route existence. Comments, scripts, JSON blobs, footer text, and unrelated body text cannot satisfy title checks.
- **Patch self-containment verification (Replay)**: before returning `succeeded`, Factory creates a separate disposable worktree at `baseCommit`, applies the binary-safe `diff.patch`, and proves that `check` and `build` succeed from pristine base state without relying on untracked or ignored artifacts from the execution worktree.
- **Bounded Repair Loop**:
  - `MAX_TOTAL_ATTEMPTS = 3`; attempt 1 is initial implementation, later attempts follow the runtime-specific repair/escalation rules above. Attempt 4 is mechanically and contractually impossible. Configuration may lower the ceiling (1..3); invalid values fail before worker execution.
  - **Repairable defects**: Foundation/dynamic `qa_failed`, semantic `verification_failed`, and replay `replay_failed`.
  - **Terminal failures (stop immediately)**: input/configuration/preflight/dependency failures, `strong_execution_isolation_unavailable`, `scope_violation`, `integrity_violation`, unsafe file modes/types, QA timeouts and legacy Codex failures/timeouts. Routed worker failures/timeouts follow `executor/router.ts`; they are not universally terminal.
  - **FailureReport**: structured, bounded diagnostic report (max 8 KB excerpt, secrets scrubbed, ANSI stripped) embedded in the repair prompt.
  - **No-progress detection**: if a repair attempt produces an identical patch or makes no source changes, the loop stops early with `needs_review` and `no_progress`.
- **Artifacts**: existing task/result/patch/Codex artifacts remain. Each attempted change additionally records escaped changed-path evidence, raw NUL-delimited Git evidence, pre/post integrity manifests, the Factory-owned task QA spec, separate Foundation/dynamic QA logs, screenshots/traces, bounded failure reports, and replay verification records.

### Starter site (`sites/starter`)

Astro 7 + Tailwind CSS 4, fully static. Reusable components (`Header`,
`Footer`, `Hero`, `ContentSection`, `FeatureCards`, `FAQ`, `CTA`) and two
layouts (`Layout`, `ArticleLayout`). Routes: `/`, `/services/example`,
`/blog/example`, and `404`. Zero client-side JavaScript.

### SiteProfile v0 (`packages/contracts/src/site-profile.ts`, `sites/starter/site-profile.json`)

SiteProfile is the **trusted, repository-owned, site-level identity and shell
configuration** for one generated site — not SiteTask input, not page content,
not model-generated runtime authority. It is a strict Zod contract
(`siteProfileSchema`, unknown fields fail closed) over `v0` fields:
`siteId`, `siteName`, `canonicalOrigin`, `language`, bounded internal
`navigation` (≤ 12 entries with plain-text labels and Factory-slug
`targetSlug`s), and optional plain-text `addressLines`.

- **One data source**: `sites/starter/site-profile.json`. **One contract
  source**: `siteProfileSchema`. No duplicated schemas; Factory QA and the
  Astro site parse the same file with the same contract.
- **Loading**: `sites/starter/src/lib/site-profile.ts` parses the JSON at
  module initialization; an invalid profile fails `astro check`/build/dev
  startup clearly (fail closed). `Layout`, `Header`, and `Footer` derive
  site name, language, navigation, and address lines from it — no hard-coded
  demo identity remains in generic shell or QA logic.
- **Canonical origin precedence** (`resolveCanonicalOrigin`):
  `PUBLIC_SITE_URL` when explicitly configured and valid (same
  credential-free-origin validation as the profile value; invalid overrides
  fail the build), otherwise `SiteProfile.canonicalOrigin`. SiteTask content
  and model output have no path to this decision.
- **Factory QA**: `apps/factory/src/executor/site-profile.ts` loads the
  worktree's profile (fail-closed) and `createTaskQaSpec` derives the expected
  document title (`<page title> | <siteName>`) and canonical URL from it. The
  trusted `FACTORY_QA_ORIGIN` override is pinned both as the build's
  `PUBLIC_SITE_URL` and the expectation origin so they provably agree.
- **Write authority**: `sites/starter/site-profile.json` belongs to the
  protected `site-configuration` module. `create_page` retains READ MANY /
  WRITE ONE EXACT PAGE TARGET; a profile mutation is a terminal
  `scope_violation`. No `configure_site` task type exists yet — how Factory
  will autonomously update the profile is deferred until after the first
  end-to-end site.

### QA pipeline

`pnpm qa` = `check` → `build` → `test`:

1. **check** — `tsc --noEmit` for contracts, Factory and Dashboard;
   `astro check` for the site.
2. **build** — workspace build scripts: Astro static site and Vite Dashboard.
3. **test** — Factory unit tests, Dashboard unit tests, then site-starter
   Playwright against built Astro served by `astro preview` in the foreground
   across desktop (1280×800) and mobile (390×844) viewports.

Repository CI additionally runs, sequentially, `@factory/factory`
`test:persistence`, `test:operator`, and `@factory/dashboard` `test:e2e`.
These use explicit `FACTORY_TEST_DATABASE_URL` targeting `factory_test`;
missing/invalid selection fails before connection. Operator E2E exercises the
built Dashboard with the real service and PostgreSQL, including service restart.
It is not replaced by Dashboard unit tests. See the [README commands](../README.md#commands)
and `.github/workflows/pr-ci.yml` for the complete sequence.

## Persistent control plane (`apps/factory/src/persistence`)

### Architectural decision record (ADR): minimal operational-state layer

- **Context**: Factory execution must be durable, inspectable, idempotent, and restart-safe. While execution artifacts (patches, QA reports, transcripts, traces) belong on the local filesystem, operational lifecycle state must survive host/process restarts and provide concurrency safety.
- **Decision**: Integrate a minimal, strongly typed PostgreSQL persistence layer into `apps/factory` using **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) and `node-postgres` (`pg`).
- **ORM Selection Rationales**:
  - Drizzle provides TypeScript-first schema definitions with zero code generation requirement at runtime.
  - SQL check constraints (`attempts_attempt_number_bounds`, non-negative durations/tokens), composite unique indexes, and cascade foreign keys are fully expressible in schema.
  - Generates transparent, reviewable standard SQL migrations in `apps/factory/drizzle/`.
  - Zero heavy runtime engine/binary bloat compared to Prisma; minimal dependency footprint.

### Data model & relational structure

The current schema has ten tables: the eight execution/delivery tables listed
here plus `project_input_drafts` and `project_input_snapshots` from merged
PR #18, detailed in the Operator Kernel section below:

```
[projects]
   └── [sites] (unique project_id + key)
          └── [runs] (idempotency_key unique, base_commit, status, duration)
                 ├── [tasks] (run_id FK, site_id FK, type, payload, status)
                 │      └── [attempts] (1..3 bounds, kind, stage, status, classification)
                 │             ├── [quality_results] (gate, passed, failure_gate, details)
                 │             └── [model_invocations] (provider, runtime, tokens, cost, duration)
```

- `projects`: Business/domain grouping (e.g. `summit-roofing`). Unique `key`.
- `sites`: Individual websites registered within a project (e.g. `starter`). Unique `(project_id, key)` composite index.
- `runs`: Top-level durable execution instance. Unique `idempotency_key = sha256(siteKey + taskJson + baseCommit)`. Status: `running | succeeded | failed | interrupted | needs_review`.
- `tasks`: Individual unit of work within a run (e.g. `create_page` with full JSON payload).
- `attempts`: Bounded coding-worker attempt record (enforced `attempt_number BETWEEN 1 AND 3` via SQL CHECK constraint). Stores start/finish timestamps, duration, exit classification, and error excerpts.
- `quality_results`: Structured evaluation from each quality gate (`scope`, `integrity`, `foundation_qa`, `dynamic_qa`, `semantic_verification`, `patch_replay`).
- `model_invocations`: Audit trail of model executions (tokens, durations, runtime provider).
- `deployments`: Durable Cloudflare version/artifact lineage, promotion and verification state, and rollback/recovery metadata.

### Single-writer concurrency control

- Active execution is guarded by PostgreSQL session-level advisory locks using `pg_try_advisory_lock(1428570001)`.
- The lock is acquired on a dedicated `pg.Client` session before crash recovery or run initialization and held until execution cleanup finishes.
- If another process attempts to run concurrently, it immediately receives `control_plane_busy` and fails closed without mutating state.

### Crash & restart recovery

- On startup (under the advisory lock), the control plane automatically scans for orphaned executions left in `running` state by a previous process crash or SIGKILL.
- Atomic recovery transaction updates stale `runs`, `tasks`, and `attempts` to status `interrupted` with `errorMessage = "control_plane_restart"`.
- Recovery does **not** automatically retry or invoke Attempt 2; historical execution records are preserved accurately for post-mortem inspection.

### Security & secret isolation boundary

- Hard isolation rule: Database credentials (`FACTORY_DATABASE_URL`, `DATABASE_URL`, `PGPASSWORD`, etc.) are stripped and blocked at all execution boundaries:
  1. Never exposed to child environments (scrubbed by strict allowlist in `apps/factory/src/executor/env.ts`).
  2. Never mounted into the Colima QEMU VM or Docker worker container.
  3. Never leaked into prompt texts, `FailureReport`, `TaskResult`, or `.factory/runs/` artifacts.
  4. Redacted from all CLI logs and error messages using regex URI sanitization.
- Fail closed: If `FACTORY_DATABASE_URL` is missing or invalid for production `site-task` execution, Factory fails closed immediately with `database_unconfigured` / `database_connection_failed`.

### Separation of DB operational state and filesystem artifacts

- **Database**: Stores operational lifecycle state, relational integrity, attempt numbers, timing metrics, gate verdicts, model audit metadata, and relative artifact pointers (`artifact_directory`).
- **Filesystem (`.factory/runs/<runId>/`)**: Stores heavy, binary, or unstructured artifacts (diff patches, raw Git evidence, Playwright traces/screenshots, task specs, and logs).

### CLI operational command set

```bash
pnpm factory db check               # Verify database connectivity and schema readiness
pnpm factory db migrate             # Run versioned Drizzle SQL migrations
pnpm factory project create <key> <name>   # Create a project
pnpm factory site register <proj> <key> <name>  # Register a site in a project
pnpm factory run show <runId>       # Inspect complete relational state and attempt history
```

## First-Site Intelligence vertical slice (v0)

The `site-intelligence` module (protected, not ordinary-task writable; owns
`apps/factory/src/intelligence/`) proves Factory's differentiated methodology
on a narrow vertical slice:

```text
SiteIntelligenceRequest + ResearchEvidenceBundle
  → strict bounded validation (contracts, Zod v4)
  → deterministic non-destructive normalization
  → request/research SHA-256 digests (canonical JSON, sorted keys)
  → isolated Codex synthesis (accepted factory-sandbox boundary)
  → strict SiteIntelligencePlan validation + deterministic quality gates
  → bounded synthesis repair (max 3 attempts, no-progress early stop)
  → deterministic compilation to current create_page SiteTasks
  → canonical parseSiteTask validation for every compiled task
  → atomic sanitized artifact publication (definitive result LAST)
  → structured IntelligenceResult
```

### Trust boundaries

- **One source of site identity**: `SiteIntelligenceRequest.siteId`. The CLI is
  `pnpm factory intelligence build <request.json> <research.json>` — no site
  key argument. Plan and every compiled task inherit that exact siteId.
- **Operator facts** (`request.business.operatorFacts`) are FACT-AUTHORITATIVE
  but INSTRUCTION-UNTRUSTED: usable as business claims for planning, never as
  rules, tool requests, budget changes, or schema modifications.
- **Research evidence** (`packages/contracts` `ResearchEvidenceBundle`, kinds
  `keyword_observation | serp_observation | competitor_page | market_observation`)
  is FACT-UNTRUSTED and INSTRUCTION-UNTRUSTED. Evidence URLs are validated to
  http/https at the contract boundary and are never fetched. The synthesis
  prompt declares all DATA sections inert and mechanically separates trusted
  instructions from delimited `SITE_INTELLIGENCE_REQUEST_DATA` /
  `RESEARCH_EVIDENCE_DATA` canonical-JSON sections.
- **No DB dependency**: planning never imports `apps/factory/src/persistence/`;
  PostgreSQL is not required to run Intelligence. Site registration is
  validated later by the existing SiteTask execution layer when compiled tasks
  are actually executed.

### Normalization, digests, provenance

Normalization is non-destructive: every original evidence record survives
verbatim; records may only gain `normalizedUrl` (conservative comparison form:
lowercased scheme/host, default ports, trivial root slash) and `duplicateOf`
markers referencing an existing original id (single level, provenance always
reconstructable). Records are stable-sorted by id so the normalized
representation — and its digest — are independent of input ordering.
`requestDigest`, `researchDigest`, and `planDigest` are SHA-256 over canonical
JSON (recursively sorted keys); they never include run ids, timestamps, or
paths. Results record `factorySourceCommit` (exact HEAD), `methodologyVersion`
(`first-site-intelligence-v0`), and truthful model runtime metadata
(pinned Codex version; model identifier only when genuinely present in the
runtime's own event stream, otherwise `null`).

### Model authority and isolation

The Intelligence model runs only through the accepted strong-isolation Codex
runner. Its workspace (`.factory/worktrees/intelligence-<runId>/`, inside the
approved Colima mount) contains only the validated request, the normalized
research, the prompt, and an empty `output/`; its single writable path is
`output/plan.json`. No site-source or Factory write access, no DB/Cloudflare
credentials (env allowlist excludes them by construction), no Docker socket,
host HOME, or host `/tmp`. No host fallback exists: isolation unavailability
fails as `intelligence_isolation_unavailable`. The workspace is removed after
every outcome, including timeout and model failure.

### Deterministic gates and compilation

Plan validation enforces the current SiteTask page invariants (reusing the
shared page refinement helper), exactly one homepage, page budget ≤
`planning.maxInitialPages`, unique slugs, globally distinct normalized
primary topics (articles may never duplicate a service topic), must-cover
service representation, service-topic support from seeds/must-cover, evidence
explicitly cited by the page, and operator facts explicitly cited by the page
(request-wide fact text never supports an unciting page), operator-excluded
topic rejection for page and keyword-cluster primary topics (normalized
containment either way), meaningful rationales, full provenance (≥1 evidence
or operator-fact reference per page; evidence references must resolve), and a
fabricated-metrics gate: any cluster metric value must appear verbatim in the
metrics of a cited evidence record. Evidence records must carry at least one
substantive payload (query, sourceUrl, title, text, or an observed metric
value) — metadata-only shells are invalid. The trusted compiler (never the
model) emits `create_page` tasks in deterministic order — homepage, then
general pages, services, then articles, each non-home group by priority
(`high→medium→low`) with slug tie-break — and every task passes canonical
`parseSiteTask`.

### Source provenance fails closed

A successful Intelligence run must attribute itself to an exact, clean,
committed Factory source state. Before any model invocation, HEAD must
resolve to an exact 40-char SHA, working-tree cleanliness must be verifiable
via git, and the tree must be free of nonignored uncommitted changes
(gitignored runtime artifacts such as `.factory/**` do not invalidate a clean
source). Any unresolvable or unverifiable provenance state — including git
failures and timeouts — is a terminal `intelligence_source_unverified`
failure with zero model invocations and no successful result.

### Atomic artifacts

Artifacts live under `.factory/intelligence/<runId>/` with pattern-validated
runIds, symlink-refusing publication, and traversal-rejecting path resolution.
Intermediates appear as the run progresses; `manifest.json` (run-relative
digests over all artifacts) and `intelligence-result.json` are published via
temp-file → rename, the result LAST, only after plan gates, per-task SiteTask
validation, and manifest integrity (byte-level re-verification plus plan
canonical-digest binding) all pass. Fresh runIds refuse to reuse existing run
directories, so stale artifacts from previous runs can never satisfy a current
run. Non-success runs leave honest partial/failed evidence and no
`succeeded` result file.

### Historical deferrals at the original First-Site Intelligence v0 slice

The following paragraph preserves that slice's original boundary, not current
program sequencing. Operator Dashboard subsequently landed in PR #18; live
Search Intelligence is the open Macro Run 2 candidate in PR #21. The
[roadmap](./roadmap-vnext.md), not the original first-site prerequisite below,
governs new work.

Live research acquisition (DataForSEO, Firecrawl, crawler, SERP pipeline),
research/keyword/competitor warehouses, vector DB, embeddings, RAG, generic
provider abstractions, scheduling, dashboards, workflow engines, generic CMS,
new page types, and internal-link graph planning. Live provider acquisition
becomes a task only after the first real site proves which data is worth
automating.

## Production Delivery MVP

Production Delivery is a trusted Factory control-plane operation, not a
`SiteTask` and not a Codex operation. Its module owns
`apps/factory/src/delivery/` and `sites/starter/wrangler.jsonc`; both are
protected from ordinary task writes.

```text
fetch origin
  → exact origin/main SHA in disposable worktree
  → frozen dependency install
  → ONE Astro build with PUBLIC_SITE_URL=production origin
  → deterministic SHA-256 over sorted dist paths + contents
  → wrangler versions upload
  → existing Playwright QA at immutable version preview
  → persist promoting crash boundary
  → verify actual Cloudflare production state / drift
  → wrangler versions deploy exact-candidate@100% -y
  → existing Playwright QA at production hostname
  → verified OR exact known-good rollback + rollback QA
```

Wrangler `4.127.1` is pinned. The static-only JSONC configuration contains no
runtime `main` and no route/domain provisioning. The Worker and production
hostname are prerequisites stored once on nullable `sites` columns. The single
new `deployments` table snapshots source SHA, artifact digest, immutable
version IDs, target identity, status, error summary, and timestamps.

Mutation commands use a fresh `WRANGLER_OUTPUT_FILE_PATH` and structurally
validate NDJSON. Production state reads use Wrangler's native JSON output;
`deployments list --json` is used because it represents an empty first
deployment without parsing human error text. Wrangler 4.127.1 orders that list
oldest-to-newest, so Factory checks the final record and requires exactly one
version at 100% traffic.

The generic executor environment remains unchanged and excludes
`CLOUDFLARE_*`. A separate narrow environment exists only around the trusted
Wrangler subprocess. Site build and remote Playwright environments receive the
production URL but no provider credentials.

The existing PostgreSQL session advisory lock serializes task execution,
delivery, rollback, and reconciliation. `promoting` is persisted before the
production mutation. A later invocation reconciles only `promoting` or
`promoted` rows against real provider state, resuming verification when the
candidate is active, recognizing an already-restored previous version, and
otherwise failing closed as `deployment_drift` / `needs_review`.

Historical scope note for the original Delivery MVP (current sequencing is in
`docs/roadmap-vnext.md`): account/DNS/domain provisioning, automatic deployment on
merge, Cloudflare Access, multi-provider abstractions, environments/releases
platforms, dashboards, queues, schedules, and gradual/canary rollout.

## Autonomy v0 — Model Gateway, ModelRolePolicy, and SiteBlueprint

Autonomy v0 adds the planning layer between accepted Intelligence plans and
future content/coding work. Three new protected modules exist:
`apps/factory/src/models/`, `apps/factory/src/blueprint/`,
`apps/factory/src/evals/`, plus the `site-blueprint` contracts in
`packages/contracts`.

### Model Gateway v0 (`apps/factory/src/models/`)

A thin OpenRouter adapter (`gateway.ts`) used for planning-role model calls.
Policy enforced in code: the exact model id is always explicit per call;
model-identity auto selection — OpenRouter Auto Router, `models` fallback
arrays, `route: "fallback"` — is rejected for Factory calls (OpenRouter may
still route the pinned model among upstream providers; the actual provider is
recorded as provenance); missing `OPENROUTER_API_KEY` fails closed; the key
is scrubbed from every error message and never enters prompts or artifacts.
Each call captures responded model, provider attribution, token usage, gateway
cost, and duration. Runtime model discovery (`GET /models`) exists for
evaluations only — authoritative calls never auto-select.

`policy.ts` owns the version-controlled `ModelRolePolicy` per role: the
operator-fixed champion model, explicit challenger fallbacks, capability
requirements, sensitive-data policy, implementation status, timeout, and
bounded attempts. Fallback is only ever champion → explicit configured
challenger, and the actually used model is recorded in every artifact
together with the policy version. Autonomy v0 originally changed planning only;
subsequent code-worker routing activated Kimi/Claude as described above. The
separate current First-Site Intelligence driver still uses isolated Codex.

### Factory Model Policy v0.1

`FACTORY_MODEL_POLICY_VERSION = "factory-model-policy-v0.1"` (recorded in
invocation provenance). The model-to-role mapping is **fixed by explicit
operator architecture decision for the MVP** — version-controlled, not
dynamically benchmark-selected, not judge-selected, not "newest in family",
not cost/latency-selected, and never OpenRouter-auto-selected. Model
optimization is deferred to a later phase and does not gate production use;
evaluation tooling is non-authoritative and cannot modify the policy.

| Role | Model | Runtime/Gateway | Status |
|---|---|---|---|
| `bulk_research_extraction` | `google/gemini-3.7-flash` | openrouter | future |
| `competitor_site_analysis` | `openai/gpt-5.6-sol` | openrouter | future |
| `site_intelligence` | `anthropic/claude-opus-5` | openrouter | active (evaluation-only runner in v0) |
| `blueprint_architect` | `anthropic/claude-opus-5` | openrouter | active |
| `content_writer` | `anthropic/claude-opus-5` | openrouter | active (evaluation-only runner in v0) |
| `content_critic` | `openai/gpt-5.6-sol` | openrouter | active (judging) |
| `design_director` | `anthropic/claude-opus-5` | openrouter | active (evaluation-only runner in v0) |
| `visual_critic` | `openai/gpt-5.6-sol` | openrouter | future |
| `cheap_repair` | `z-ai/glm-5.3-flash` | openrouter | future |
| `image_generator` | `openai/gpt-image-2` | dedicated provider path when implemented | future |
| `code_worker` | Kimi K3 primary / Claude Opus 5 senior | `kimi-code-cli` / `claude-code` via Factory relay | Active (`migrationActivated: true`); Codex retained as legacy reference |

The executable assignments above include v0 evaluation roles and future
placeholders. They do not establish a production writer/design/image workflow:
vNext requires approved WriterPromptSnapshot and AcceptedPageContent, external
DesignProvider and governed VisualAssetProvider respectively. Exact executable
model/runtime assignments remain in `apps/factory/src/models/policy.ts`.

Intentional separations: writer ≠ factuality critic; design director ≠
visual critic; bulk extraction ≠ competitor analysis; `cheap_repair` is
never an authority for strategy, IA, high-value content, claim approval, or
design direction. The proprietary-data gate applies to every role that may
touch operator facts, private research, plans, or blueprints.

### SiteBlueprint v0 (`apps/factory/src/blueprint/`, `packages/contracts`)

`SiteBlueprint` bridges the information loss between a validated
`SiteIntelligencePlan` and `SiteTask` execution: it mirrors the accepted IA
exactly (same page set, types, slugs, primary topics — enforced
deterministically), and refines each page into machine-readable intent:
page role, audience, seoTitle vs visible H1, purpose, user questions,
objections, section-level content jobs with section-level evidence/operator-fact
provenance, prohibited claims, internal-link plan, structured-data intent,
bounded site-level design direction, and mandatory page readiness
(`ready | missing_operator_input | insufficient_evidence | blocked`) with
honest missing inputs. A page without sufficient support becomes NOT READY
instead of fabricated.

A Factory-owned component capability registry describes the real starter
capabilities (hero, feature_cards, content_section, faq, cta — `benefits` has
no component and is realized through the documented mapping). Blueprint output
may only reference registered capabilities; repeated semantic section instances
are allowed. Current SiteTask contracts also support bounded repeated section
instances; inspect their current limits instead of treating the original
Blueprint phase scope as a permanent restriction.

Synthesis runs through the gateway under the role policy with bounded repair
(≤3 attempts, no-progress detection, explicit fallback recording). Incoming
plans must pass the accepted Intelligence quality gates before any model work;
deterministic blueprint validation enforces IA preservation, reference
integrity (evidence/operator facts), the no-invented-chart-data rule, internal
link and navigation integrity, readiness/missing-input consistency, and payload
bounds. Artifacts publish atomically under `.factory/blueprint/<runId>/` with
the definitive result written last; no database writes, no credentials in
artifacts. CLI: `pnpm factory blueprint build <plan.json> <request.json>
<research.json>`.

### Model evaluation harness (`apps/factory/src/evals/`)

**Non-authoritative diagnostic/optimization tooling.** It may compare models
and report candidate quality, cost, and latency; it can never modify
`MODEL_ROLE_POLICY`, promote a challenger, change production behavior, or
gate MVP acceptance. Policy changes happen only through explicit reviewed
changes to `apps/factory/src/models/policy.ts`.

`pnpm factory eval run --role ...` discovers current gateway candidates per
family at runtime (no stale ids), feeds identical inputs/prompts/schemas to
every candidate, applies the SAME deterministic Factory gates, then runs two
blind rubric judges and records a winner among gate-passing candidates.
Artifacts land under `.factory/evals/autonomy-v0/<runId>/` with
per-candidate cost/latency from gateway usage accounting, bounded by
`FACTORY_EVAL_BUDGET_USD` (default 25).

Historical scope at the original Autonomy v0 phase: the deferred list below is
preserved as chronology, not current sequencing. SiteProfile/shell and
ProductionSpec packet-to-task projection subsequently landed on main; PR #18
extends projection hardening and execution preparation. Production writer,
external design/assets and full operator delivery remain governed by the roadmap.

Explicitly deferred: content synthesis, image generation, visual QA,
`SiteTask` broadening, blueprint→task compilation, migrating Intelligence
execution off Codex, generic workflow engines, multi-site scale
infrastructure, and Site Shell implementation (see
`docs/handoffs/site-shell-gap.md`).

## Operator Kernel v0 — Project Intake vertical slice (Macro Run 1)

**Implemented and merged state** (PR #18; independent GO is not asserted here). This section
describes what exists today; vNext roadmap sequencing lives in
`docs/roadmap-vnext.md` and is not reinterpreted here.

### Domain and application services

- `packages/contracts/src/project-intake.ts` — strict, bounded Project Intake
  payload contract (`.strict()` schemas, `schemaVersion: "v1"`), typed
  provenance vocabulary, credential-shaped-value rejection, and the canonical
  blank template `emptyProjectIntakePayload()` (no business facts, fails
  readiness, never accidentally acceptable).
- `apps/factory/src/operator/intake-store.ts` — `ProjectIntakeStore`: draft
  revisioning with optimistic concurrency (stale `baseRevision` saves are
  rejected with `intake_stale_revision`) and transactional immutable snapshot
  acceptance (deterministic SHA-256 digest recomputed from the stored payload,
  deep-frozen snapshot payloads, idempotent duplicate acceptance, `intake_blocked`
  fail-closed readiness gate inside the accept transaction).
- `apps/factory/src/operator/readiness.ts` — deterministic intake readiness
  (no AI, no I/O): blockers prevent acceptance, warnings do not; missing
  FUTURE-stage outputs (SERPs, designs, assets) never block intake.
- `apps/factory/src/operator/workspace.ts` — the single canonical operator
  read-model `getProjectOperatorWorkspace()`: project identity, current draft,
  readiness diagnostics, accepted snapshot/history (ascending; last entry is
  current), `draftDiffersFromAccepted`, and one status resolver with the full
  matrix `DRAFT / BLOCKED / READY / APPROVED / CHANGED`. The API and the
  Dashboard consume this projection; no duplicate status logic exists.
- `apps/factory/src/operator/prepare.ts` — governed preparation seam:
  readiness → page packet → digest → `projectPacketToSiteTask()` → task
  digest → execution eligibility. `executePreparedPageProduction()` reuses the
  EXISTING persisted-run driver (`runPersistedSiteTask`) via the production
  default; tests inject an executor spy. Blocked input fails closed before any
  execution boundary. PR #16 P2-1/P2-2 closed in `packet-projection.ts`:
  per-instance `headingIntent` projection with Blueprint fallback, and
  fail-closed (never sliced/ellipsized) keyPoints/prohibitedClaims/guidance/
  purpose bounds.

### Durable data authority (v0 split)

- **PostgreSQL** (`FACTORY_DATABASE_URL`; tests: dedicated `factory_test` via
  `FACTORY_TEST_DATABASE_URL`) — projects, `project_input_drafts` (revision,
  payload, digest), `project_input_snapshots` (immutable accepted versions
  with unique per-project version, acceptance state, digest). Migration
  `apps/factory/drizzle/0004_operator_intake_v0.sql` with check constraints.
- **Git** — source/architecture/production lineage. **`.factory/**`** —
  runtime evidence only, never authoritative acceptance state.

### Trusted Operator API and browser trust boundary

- `apps/factory/src/operator/server.ts` — Node `http` server (no framework),
  default bind `127.0.0.1`, Host allowlist (`localhost`/`127.0.0.1`),
  cross-origin mutation rejection (Origin must match Host or be absent for
  non-browser clients; deliberate, documented policy), JSON-only mutations,
  256 KiB body ceiling, sanitized error responses. Serves the BUILT dashboard
  (`apps/dashboard/dist`, `FACTORY_OPERATOR_DIST` override) with SPA fallback;
  the normal operator path is same-origin, so no CORS is emitted — ever.
- `apps/factory/src/operator/api.ts` — narrow semantic endpoints only:
  `POST /api/projects`, `GET /api/projects`, `GET /api/projects/:id/workspace`,
  `PUT /api/projects/:id/intake-draft`, `POST /api/projects/:id/intake/accept`,
  `GET /api/projects/:id/intake/versions[/:version]`. All errors serialize as
  the stable typed contract `{ error: { code, message } }` from
  `packages/contracts/src/operator-errors.ts` (closed `OperatorErrorCode`
  union + fixed HTTP status map); unexpected 500s return the fixed sanitized
  string `Internal server error.` — raw internal messages, stacks, DB URLs,
  and provider secrets never reach the client. No filesystem/Git/provider
  plumbing is exposed as browser parameters.

### Dashboard (operator console, no business logic)

- `apps/dashboard` — React + Vite console rendering the canonical workspace
  projection only. Journey: create project → grouped intake sections (incl.
  Content Constitution with custom writer instructions) → Save Draft →
  Review → ACCEPT INPUTS → version history (CURRENT ACCEPTED badge on exactly
  the latest accepted version; older versions remain inspectable). Typed
  `OperatorApiError` handling for stale revision (auto-reload), blocked
  acceptance, validation, digest/revision mismatch, and generic server
  faults. Real-browser Playwright journey (`apps/dashboard/e2e/`,
  `pnpm --filter @factory/dashboard run test:e2e`) runs against the built
  dashboard + the actual Operator service + the dedicated real PostgreSQL
  test database, including a real service restart WITHOUT DB reset.

## Live Search Intelligence v0 (Macro Run 2) and Competitors + Content Gap v0 (Macro Run 3)

**Implemented state on the current branch** (Run 2 merged via PR #21; Run 3 is the
open candidate — independent GO is not asserted here). Detailed Run 2 design:
`docs/search-intelligence-v0.md`.

### Search Intelligence (Run 2, summary)

`SerpProvider` boundary with Bright Data as production default
(`BRIGHTDATA_API_KEY`, configured `BRIGHTDATA_ZONE`, DataForSEO fallback),
fixture provider for CI; immutable `SerpSnapshot`/`GroundedSearchSnapshot`/
`SearchIntelligenceSnapshot` rows (migration `0005`); governed
`SearchIntelligenceService` (preflight → accepted inputs → budget gate →
freshness cache → acquisition → analyst); `search_analyst` model role through
the OpenRouter gateway; Dashboard Search workspace. Raw SERP payload ceiling is
2 MiB (`MAX_SERP_RAW_BYTES`, raised from 256 KB on Run 3 live evidence).

### Competitors + Content Gap (Run 3, `apps/factory/src/competitors/`, `packages/contracts/src/competitor-content-gap.ts`)

Pipeline: accepted inputs + `SerpSnapshot` + `SearchIntelligenceSnapshot` →
deterministic candidate classification (INCLUDE/EXCLUDE/REFERENCE_ONLY with
reasons, `classification-v1`) → SSRF-guarded bounded direct-HTTP acquisition
(`direct-http-v1`: per-hop DNS revalidation of all A/AAAA against
loopback/private/link-local/metadata ranges, manual redirects ≤5, 15s timeout,
2 MiB streamed cap, HTML-only, `SUCCESS|BLOCKED|NON_HTML|UNSUPPORTED|FAILED`,
no captcha/anti-bot circumvention) → deterministic structural extraction
(`node-html-parser`; title/meta/canonical/H1-H3, stable `seg-NNN` segments,
questions, tables/lists, JSON-LD/FAQ/dates, citations, CTA, word count;
script/style/nav/footer/cookie noise stripped) → bounded evidence packet
(`selection-policy-v1`, ~25k chars, explicit `sourceChars`/`selectedChars`/
`selectionTruncated`) → per-page analyst (`competitor-analyst-v1`, Gemini Flash
via the existing `search_analyst` gateway path; untrusted page text delimited
as inert DATA; categorical levels only; fabricated evidence refs normalized
away, zero resolvable refs fail closed) → PASS 2 gap analyst (compact analyses
+ search intelligence + accepted first-party evidence only; no page HTML) →
`ContentGapReport` with Factory-computed coverage matrix (`coverage-matrix-v1`)
and provenance digests → operator per-gap decisions (disposition/priority/bounded
note; every gap decided required) → immutable `accepted_content_gap_snapshots`
(unique per project+version and unique per reportId; report+decisions digest bound;
human decisions `disposition`, `priority`, `note` are materialized directly into
accepted gaps while preserving `recommendedDisposition` and `recommendedPriority`;
double acceptance is idempotent and returns the existing snapshot without minting
new versions; decision modification is locked post-acceptance).

Centralized staleness evaluation checks all upstream dependencies: latest accepted
ProjectInput version/digest, authoritative SERP snapshot (verifying digest and
ensuring no newer SERP was observed for the query), authoritative Search
Intelligence snapshot (verifying digest and ensuring no newer intelligence was
created for the query), and bound competitor page snapshots and analyses.

Trust boundaries: candidate URLs come only from persisted SERP evidence (no
browser-supplied fetch URLs, providers, or prompts); first-party evidence
separation is enforced (`ourEvidenceAvailable` must resolve to accepted intake
evidence items with excerpt checks — competitor claims can never become our
claims; `validateContentGapGrounding` fails closed on empty or forged search
evidence, non-INCLUDE competitor coverage, ungrounded segment anchors, or
smuggled claims); provider mode is trusted backend config
(`FACTORY_COMPETITOR_MODE=fixture|production`, fixture page provider for CI/E2E
zero-spend journeys; missing credentials fail closed with typed 409 errors rather
than silently falling back to fixture mode); budget gate on recorded analysis cost
(`FACTORY_COMPETITOR_DAILY_LIMIT_USD`, default 5 USD; UNKNOWN costs uncounted).
Direct HTTP acquisition uses a single global timeout covering all redirects, DNS,
and chunked body streaming, canceling response body streams immediately on
403/429/non-HTML without buffering unneeded content.

Persistence (migration `0006_competitor_content_gap_v0`): `competitor_runs`,
`competitor_page_snapshots` (content-digest dedupe, acquisition lineage),
`competitor_classification_overrides`, `competitor_page_analyses`,
`content_gap_reports`, `content_gap_decisions` (unique per report+gap),
`accepted_content_gap_snapshots` (unique per project+version). JSONB payloads
re-parsed through contracts on read; project isolation on every read.

Operator API additions under `/api/projects/:id/`:
`competitors/workspace`, `competitors/runs` (POST/GET), `competitors/candidates/:pageSnapshotId/classification`
(PATCH), `content-gaps/workspace`, `content-gaps/proposals` (POST),
`content-gaps/reports/:id` (GET), `content-gaps/reports/:id/decisions` (PUT),
`content-gaps/reports/:id/accept` (POST), `content-gaps/accepted/:version/detail`
(GET). New closed error codes: `competitor_*` / `content_gap_*`.

Dashboard: `Competitors Research` and `Content Gaps` tabs (intake seed tab
renamed `Competitor Seeds`) — evidence picker, acquisition/analysis summaries,
gap review with per-gap disposition/priority/note, digest-bound acceptance,
immutable version inspector with staleness banners; no raw JSON editing, no
competitor page text dumps. UI↔contract shape tests pin every consumed field.

### Explicitly still roadmap-only

Search/Opus/Stitch/Nano-Banana integrations, renderer ADR, queues/CMS/auth/
RBAC, full operator-controlled delivery and additional deployment targets
beyond the existing Cloudflare delivery path remain roadmap-only — see
`docs/roadmap-vnext.md`.
