# Factory architecture

Repository policy: [`AGENTS.md`](../AGENTS.md) and
[`docs/seo-policy.md`](./seo-policy.md) — Google Search / SEO governance is a
first-class acceptance constraint for all Factory work.

## What exists today (execution trust hardening)

Factory is a pnpm monorepo with three packages:

```
apps/factory        @factory/factory      — control-plane CLI + site-task executor (tsx, TypeScript)
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
slashes).

`TaskResult` is the structured run outcome:
- `status`: `"succeeded" | "failed" | "needs_review"`
- `finalStage`: `"validation" | "preflight" | "isolation" | "worktree" | "dependencies" | "codex" | "scope" | "integrity" | "qa" | "verify" | "complete"`
- `baseCommit`: Git commit SHA of the base
- `totalAttempts`: number of Codex execution attempts executed (max 3)
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
  isolated Codex exec (Attempt 1: initial / Attempt > 1: repair) →
  exact-target Git mode/scope enforcement → ignored-input integrity →
  Foundation QA → dynamic requested-route QA → semantic verification →
  [If QA/verify defect: create structured FailureReport & continue attempt]
→ final diff.patch + TaskResult → cleanup
```

- **Isolation**: a detached worktree is source-state isolation, not host-read isolation. The production boundary is a dedicated `factory-sandbox` Colima QEMU VM with exactly two host mounts (`.factory/worktrees` and `.factory/codex-runtime`), an ephemeral hardened Docker worker, and the inner Codex sandbox. Factory verifies the saved mount policy and Linux Docker server before execution and never falls back to the former host-shared runner.
- **Worker container**: the version-controlled Node 22 image pins `@openai/codex@0.150.1`. Runs are non-root, read-only, capability-free, `no-new-privileges`, resource-bounded, and temporary. Ubuntu's AppArmor user-namespace restriction is disabled only inside this dedicated VM and the worker's AppArmor/seccomp profiles are unconfined so Codex's inner bubblewrap sandbox can create its own user/mount namespaces; this does not change the VM mount boundary, grant Linux capabilities, or expose host paths. The current worktree is read-only except for the target page's parent directory; the immutable task policy still permits only the exact page and post-execution Git/integrity checks remain authoritative. No Docker/SSH-agent socket, host HOME, browser profile, primary checkout, or host `/tmp` is mounted.
- **Dependency prep**: Factory (never Codex) installs dependencies offline from the pnpm store against the committed lockfile once per run.
- **Layered sandbox policy**: Factory copies only the host Codex `auth.json` into a per-run directory, mounts it read-only, ignores user configuration, and deletes the copy during cleanup. The outer container permits Codex model-service connectivity; the inner `workspace-write` policy keeps approval disabled, shell/tool network disabled, and web search disabled. Necessary Codex authentication remains a residual readable secret inside that isolated runtime.
- **Scope enforcement**: the validated slug maps to exactly one writable `.astro` page. NUL-delimited `git diff --raw -z --no-renames` makes every rename source/destination visible as delete/add; only regular non-executable `100644` files pass. Symlinks, gitlinks, special modes, and unrelated source paths are terminal violations.
- **Ignored-input integrity**: Factory snapshots ignored state after dependency preparation and before each attempt, hashes contents/types/modes (including `.env*`, `.astro`, and `node_modules`), and compares immediately after Codex. Output exclusions are strictly anchored to explicit known repository roots (`.factory/**`, `sites/starter/dist/**`, `sites/starter/.astro/**`, `sites/starter/test-results/**`, `sites/starter/playwright-report/**`, `sites/starter/qa-artifacts/**`); nested unanchored names (such as `.../dist/helper.ts`) are never ignored or excluded.
- **Independent QA Oracle**: unchanged Foundation `pnpm qa` runs first. Factory then creates a validated task QA spec outside the worktree and runs immutable Playwright assertions for the requested route on desktop and mobile: response/errors, exact metadata/H1/canonical/OG, page-type JSON-LD, requested CTA/FAQ, bounded internal links, image semantics, meaningful body content, and mobile overflow.
- **Task verification**: a dependency-free semantic extractor checks fresh built HTML for exact title, one exact H1, description, canonical origin/path, and route existence. Comments, scripts, JSON blobs, footer text, and unrelated body text cannot satisfy title checks.
- **Patch self-containment verification (Replay)**: before returning `succeeded`, Factory creates a separate disposable worktree at `baseCommit`, applies the binary-safe `diff.patch`, and proves that `check` and `build` succeed from pristine base state without relying on untracked or ignored artifacts from the execution worktree.
- **Bounded Repair Loop**:
  - `MAX_TOTAL_ATTEMPTS = 3` (Attempt 1 = initial, Attempt 2 = repair 1, Attempt 3 = repair 2; Attempt 4 is mechanically and contractually impossible). Configuration (env or programmatic) may lower attempts (1..3) but any value > 3 or invalid fails closed before Codex.
  - **Repairable defects**: Foundation/dynamic `qa_failed`, semantic `verification_failed`, and replay `replay_failed`.
  - **Terminal failures (stop immediately)**: input/configuration/preflight/dependency failures, `strong_execution_isolation_unavailable`, `scope_violation`, `integrity_violation`, unsafe file modes/types, Codex failures, and timeouts.
  - **FailureReport**: structured, bounded diagnostic report (max 8 KB excerpt, secrets scrubbed, ANSI stripped) embedded in the repair prompt.
  - **No-progress detection**: if a repair attempt produces an identical patch or makes no source changes, the loop stops early with `needs_review` and `no_progress`.
- **Artifacts**: existing task/result/patch/Codex artifacts remain. Each attempted change additionally records escaped changed-path evidence, raw NUL-delimited Git evidence, pre/post integrity manifests, the Factory-owned task QA spec, separate Foundation/dynamic QA logs, screenshots/traces, bounded failure reports, and replay verification records.

### Starter site (`sites/starter`)

Astro 7 + Tailwind CSS 4, fully static. Reusable components (`Header`,
`Footer`, `Hero`, `ContentSection`, `FeatureCards`, `FAQ`, `CTA`) and two
layouts (`Layout`, `ArticleLayout`). Routes: `/`, `/services/example`,
`/blog/example`, and `404`. Zero client-side JavaScript.

### QA pipeline

`pnpm qa` = `check` → `build` → `test`:

1. **check** — `tsc --noEmit` for contracts and factory, `astro check` for
   the site.
2. **build** — `astro build`; fails on type or build errors.
3. **test** — Factory executor unit tests (deterministic, Codex mocked),
   then Playwright runs against the built site served by `astro preview` in
   the foreground across desktop (1280×800) and mobile (390×844) viewports.

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

The control plane persists exactly 7 tables:

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
- `attempts`: Bounded Codex attempt record (enforced `attempt_number BETWEEN 1 AND 3` via SQL CHECK constraint). Stores start/finish timestamps, duration, exit classification, and error excerpts.
- `quality_results`: Structured evaluation from each quality gate (`scope`, `integrity`, `foundation_qa`, `dynamic_qa`, `semantic_verification`, `patch_replay`).
- `model_invocations`: Audit trail of model executions (tokens, durations, runtime provider).

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
services, then articles, each by priority (`high→medium→low`) with slug
tie-break — and every task passes canonical `parseSiteTask`.

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

### Explicitly deferred (out of scope by design)

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

Explicitly deferred: account/DNS/domain provisioning, automatic deployment on
merge, Cloudflare Access, multi-provider abstractions, environments/releases
platforms, dashboards, queues, schedules, and gradual/canary rollout.
