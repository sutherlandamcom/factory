# Factory architecture

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

- **Isolation**: a detached worktree is source-state isolation, not host-read isolation. Real Codex execution requires a separately verified OCI/container boundary. No supported runtime is installed on the current host, so the CLI fails before worktree creation with `STRONG_EXECUTION_ISOLATION_UNAVAILABLE`; it does not invoke the former host-shared runner.
- **Dependency prep**: Factory (never Codex) installs dependencies offline from the pnpm store against the committed lockfile once per run.
- **Layered sandbox policy**: any future outer backend must expose only the worktree, an isolated temporary directory/HOME, and minimal read-only Codex auth/config. The inner Codex policy must keep approvals disabled, shell network disabled, and web search disabled. Necessary Codex authentication remains a residual readable secret inside that isolated runtime.
- **Scope enforcement**: the validated slug maps to exactly one writable `.astro` page. NUL-delimited `git diff --raw -z --no-renames` makes every rename source/destination visible as delete/add; only regular non-executable `100644` files pass. Symlinks, gitlinks, special modes, and unrelated source paths are terminal violations.
- **Ignored-input integrity**: Factory snapshots ignored state after dependency preparation and before each attempt, hashes contents/types/modes (including `.env*`, `.astro`, and `node_modules`), and compares immediately after Codex. Only explicit generated QA/build artifact directories are excluded.
- **Independent QA Oracle**: unchanged Foundation `pnpm qa` runs first. Factory then creates a validated task QA spec outside the worktree and runs immutable Playwright assertions for the requested route on desktop and mobile: response/errors, exact metadata/H1/canonical/OG, page-type JSON-LD, requested CTA/FAQ, bounded internal links, image semantics, meaningful body content, and mobile overflow.
- **Task verification**: a dependency-free semantic extractor checks fresh built HTML for exact title, one exact H1, description, canonical origin/path, and route existence. Comments, scripts, JSON blobs, footer text, and unrelated body text cannot satisfy title checks.
- **Bounded Repair Loop**:
  - `MAX_ATTEMPTS = 3` (Attempt 1 = initial, Attempt 2 = repair 1, Attempt 3 = repair 2; Attempt 4 is impossible).
  - **Repairable defects**: Foundation/dynamic `qa_failed` and semantic `verification_failed`.
  - **Terminal failures (stop immediately)**: input/preflight/dependency failures, `strong_execution_isolation_unavailable`, `scope_violation`, `integrity_violation`, unsafe file modes/types, Codex failures, and timeouts.
  - **FailureReport**: structured, bounded diagnostic report (max 8 KB excerpt, secrets scrubbed, ANSI stripped) embedded in the repair prompt.
  - **No-progress detection**: if a repair attempt produces an identical patch or makes no source changes, the loop stops early with `needs_review` and `no_repair_progress`.
- **Artifacts**: existing task/result/patch/Codex artifacts remain. Each attempted change additionally records escaped changed-path evidence, raw NUL-delimited Git evidence, pre/post integrity manifests, the Factory-owned task QA spec, separate Foundation/dynamic QA logs, screenshots/traces, and bounded failure reports.

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

## Next vertical slice (PR #4 — future, not implemented)

Future vertical slices (publishing, deployment, multi-site management, automated task generation, patch promotion) will build on the validated PR #3 bounded execution and repair loop.
