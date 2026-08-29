# Factory architecture

## What exists today (PR #3)

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
- `finalStage`: `"validation" | "preflight" | "worktree" | "dependencies" | "codex" | "scope" | "qa" | "verify" | "complete"`
- `baseCommit`: Git commit SHA of the base
- `totalAttempts`: number of Codex execution attempts executed (max 3)
- `successfulAttempt`: attempt number that succeeded (nullable)
- `attempts`: list of structured `AttemptResult` items
- `changes`: changed files list + relative path to cumulative `diff.patch`
- `artifacts`: run directory location
- `error`: structured error code and message

The canonical create_page fixture is `packages/contracts/fixtures/create-roof-repair.json`.

### Control plane + executor (`apps/factory`)

`pnpm factory site-task <task.json>` runs one SiteTask end to end with a bounded automatic repair loop:

```
validate → clean-repo preflight → detached git worktree at HEAD →
pnpm install --offline --frozen-lockfile →
[Bounded Loop: Attempt 1..3]
  Codex exec (Attempt 1: initial prompt / Attempt > 1: repair prompt) →
  mechanical scope enforcement →
  Factory QA in the worktree →
  task-specific verification →
  [If QA/verify defect: create structured FailureReport & continue attempt]
→ final diff.patch + TaskResult → cleanup
```

- **Isolation**: a single detached worktree under `.factory/worktrees/<runId>/` is created once for the entire parent run. Attempt 2 and Attempt 3 build directly upon the workspace modifications of prior attempts. Temporary worktrees are always removed in a `finally` block upon run completion.
- **Dependency prep**: Factory (never Codex) installs dependencies offline from the pnpm store against the committed lockfile once per run.
- **Codex adapter** (`src/executor/codex.ts`): direct `codex exec --ephemeral --json -s workspace-write -C <worktree>` with `approval_policy="never"`, `sandbox_workspace_write.network_access=false`, and `tools.web_search=false` config overrides. Environment is sanitized to an allowlist (no API keys, no tokens).
- **Scope enforcement**: after each Codex attempt, mechanical staging discovery inspects all modified/added paths. Only `sites/starter/src/**` is authorized. Any edit outside this scope triggers an immediate terminal failure (`scope_violation`) with no repair retries.
- **Independent QA Oracle**: Factory independently runs the full QA suite (`pnpm check` → `pnpm build` → Playwright) outside the Codex sandbox and never trusts model self-reports.
- **Task verification**: verifies the built `dist/<slug>/index.html` exists, contains the exact SiteTask title, and has a correct canonical `<link>`.
- **Bounded Repair Loop**:
  - `MAX_ATTEMPTS = 3` (Attempt 1 = initial, Attempt 2 = repair 1, Attempt 3 = repair 2; Attempt 4 is impossible).
  - **Repairable defects**: `qa_failed` (Astro typecheck/build error, Playwright test failure) and `verification_failed` (missing route, title mismatch, canonical error).
  - **Terminal failures (stop immediately)**: `invalid_task`, `dirty_working_tree`, `worktree_failed`, `dependency_prepare_failed`, `scope_violation`, `codex_failed`, timeouts (`codex_timeout`, `qa_timeout`).
  - **FailureReport**: structured, bounded diagnostic report (max 8 KB excerpt, secrets scrubbed, ANSI stripped) embedded in the repair prompt.
  - **No-progress detection**: if a repair attempt produces an identical patch or makes no source changes, the loop stops early with `needs_review` and `no_repair_progress`.
- **Artifacts**: `.factory/runs/<runId>/` holds `task.json`, `base-commit.txt`, `task-result.json`, `diff.patch`, `changed-files.txt`, and per-attempt subdirectories `attempts/<attemptNumber>/` containing `codex-output.jsonl`, `codex-stderr.txt`, `changed-files.txt`, `diff.patch`, `qa-stdout.txt`, `qa-stderr.txt`, `task-verification.json`, `failure-report.json`, and `attempt-result.json`.

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
