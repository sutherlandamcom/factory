# Factory architecture

## What exists today (PR #2)

Factory is a pnpm monorepo with three packages:

```
apps/factory        @factory/factory      — control-plane CLI + site-task executor (tsx, TypeScript)
packages/contracts  @factory/contracts    — shared machine-readable contracts (Zod schemas + types)
sites/starter       @factory/site-starter — Astro 7 + Tailwind 4 website template
```

### Contracts (`packages/contracts`)

The `SiteTask` type is the single unit of work flowing through the system.
v0 supports exactly one task: `create_page`, which carries a `siteId` and a
page description (`type`, `slug`, `title`, `description`, `sections`). Zod
schemas are the source of truth and TypeScript types are derived from them,
so SiteTasks arriving as JSON at runtime are validated before any work
begins; slugs are restricted to rooted lowercase paths like
`/services/roof-repair` (no traversal, backslashes, query/fragment, double
slashes). `TaskResult` is the structured run outcome (status, finalStage,
baseCommit, codex/qa/verification outcomes, change set, artifact directory,
error code). The canonical create_page fixture is
`packages/contracts/fixtures/create-roof-repair.json` (mirrored by the
`exampleSiteTask` TS export).

### Control plane + executor (`apps/factory`)

`pnpm factory site-task <task.json>` runs one SiteTask end to end:

```
validate → clean-repo preflight → detached git worktree at HEAD →
pnpm install --offline --frozen-lockfile → constrained Codex exec →
mechanical scope enforcement → Factory QA in the worktree →
task-specific verification → diff.patch + TaskResult → cleanup
```

- **Isolation**: a detached worktree under the gitignored
  `.factory/worktrees/<runId>/` — the site is never copied, the main tree is
  never touched, and cleanup (worktree remove + prune) runs in a `finally`.
- **Dependency prep**: Factory (never Codex) runs the install, offline from
  the host's content-addressable pnpm store against the committed lockfile.
- **Codex adapter** (`src/executor/codex.ts`): direct `codex exec
  --ephemeral --json -s workspace-write -C <worktree>` with
  `approval_policy="never"`, `sandbox_workspace_write.network_access=false`
  and `tools.web_search=false` config overrides. The child receives an
  allowlisted environment (PATH, HOME, TMPDIR, locale, CODEX_HOME) — no
  CLOUDFLARE_*/GITHUB_*/DATABASE_URL/DATAFORSEO_*/FIRECRAWL_*/SMTP or other
  API keys. There is no fallback to weaker sandboxing: if the CLI can't
  satisfy the policy the run fails closed with `codex_environment_failed`.
- **Scope enforcement**: after Codex exits, `git add -A` + `git diff
  --cached` (staging for evidence only, never committed) yields the
  authoritative change set, including previously untracked files. For
  create_page only `sites/starter/src/**` may change; anything else fails
  with `scope_violation` and the evidence is preserved in the run directory.
- **Independent QA**: Factory runs `pnpm qa` itself in the worktree and
  trusts only its own exit code, then a task-specific verifier checks the
  built `dist/<slug>/index.html` exists and contains the task title.
- **Artifacts**: `.factory/runs/<runId>/` holds task.json, base-commit.txt,
  codex-version.txt, codex-output.jsonl, codex-stderr.txt,
  codex-last-message.txt, changed-files.txt, diff.patch, qa-stdout/stderr,
  qa-artifacts/, task-verification.json, task-result.json. No DB, no secrets.
- **Timeouts**: hard bounds on dependency prep, Codex, and QA
  (env-configurable, defaults 5/20/15 min); a timed-out process group is
  SIGKILLed and the run fails with `*_timeout`.
- **Tests**: `pnpm --filter @factory/factory test` runs deterministic
  `node --test` (via tsx) unit/integration tests with the Codex boundary
  mocked — no real Codex calls, wired into root `pnpm test`/`pnpm qa`.

### Starter site (`sites/starter`)

Astro 7 + Tailwind CSS 4, fully static. Reusable components (`Header`,
`Footer`, `Hero`, `ContentSection`, `FeatureCards`, `FAQ`, `CTA`) and two
layouts (`Layout`, `ArticleLayout`). Routes: `/`, `/services/example`,
`/blog/example`, and `404`. Every page ships per-page metadata, a canonical
URL (rooted at `PUBLIC_SITE_URL`), exactly one `<h1>`, internal links,
locally-generated responsive images via `astro:assets`, and JSON-LD where
appropriate (`LocalBusiness` on `/`, `Service` on the service page,
`Article` on the blog post). Zero client-side JavaScript.

### QA pipeline

`pnpm qa` = `check` → `build` → `test`:

1. **check** — `tsc --noEmit` for contracts and factory, `astro check` for
   the site.
2. **build** — `astro build`; fails on type or build errors.
3. **test** — Factory executor unit tests (deterministic, Codex mocked),
   then Playwright runs against the built site served by `astro preview` in
   the foreground with Playwright-owned process lifetime
   (`ASTRO_PREVIEW_BACKGROUND=0`, `reuseExistingServer: false`, and configurable
   `FACTORY_QA_PORT`), across desktop (1280×800) and mobile (390×844) viewports.
   It independently asserts:
   - 200 OK / 404 HTTP response status across all routes;
   - zero console errors or unhandled page errors (including on 404);
   - exact per-page `<title>`, meta `description`, and Open Graph tags;
   - exactly one canonical `<link>` matching configured origin and path;
   - exactly one semantic `<h1>` per page with expected text;
   - parseable JSON-LD structured data (`LocalBusiness` on `/`, `Service` on
     `/services/example`, `Article` on `/blog/example`) with verified schema
     types and canonical identity URLs;
   - local responsive images (`astro:assets` generated WebP, non-empty `alt`,
     explicit `width`/`height`, `srcset`, `sizes`, and eager/lazy loading);
   - working internal links, CTA buttons, and navigation;
   - full-page screenshots written to `sites/starter/qa-artifacts/`.

## Next vertical slice (PR #3 — future, not implemented)

A repair loop: when Factory QA or task verification fails, feed the failure
evidence (QA output, verification details, current diff) back into a bounded
number of additional Codex turns inside the same worktree, re-running QA and
verification after each attempt, before declaring the run failed. Everything
beyond this slice (publishing, scheduling, multiple sites, content
generation, SEO automation, patch application to the main tree) is
intentionally out of scope until a later PR introduces it.
