# Factory

Factory is an autonomous system for creating, publishing, and operating
SEO/content websites. This repository currently contains:

**structured SiteTask → isolated Codex execution → Astro website change → static/type checks → build → Playwright QA → task verification → structured TaskResult**

See `docs/architecture.md` for the design.

## Prerequisites

- Node.js >=22.12.0
- pnpm 11 (`corepack enable` if needed)
- Codex CLI (`@openai/codex`, pinned as a root devDependency) plus valid Codex
  auth in `~/.codex/` (`codex login`) — required only for real site-task runs,
  not for tests or QA.

## Install

```bash
pnpm install
```

## Playwright browser

The QA suite needs a Chromium build:

```bash
pnpm --filter @factory/site-starter exec playwright install chromium
```

(On Linux CI you would add `--with-deps`; on macOS that flag does not exist
and is not needed.)

> Note: `@playwright/test` is pinned to `~1.61.1` as a verified stable baseline
> across development and CI hosts. Any future upgrade should be verified against
> the test suite across supported platforms.

## Commands

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the starter site's dev server (http://localhost:4321) |
| `pnpm check` | Typecheck all workspaces (`tsc` + `astro check`) |
| `pnpm build` | Build all workspaces (static site output in `sites/starter/dist/`) |
| `pnpm test` | Factory unit tests (deterministic, no Codex calls) + Playwright QA against the **built** site |
| `pnpm qa` | `check` → `build` → `test` in one command |
| `pnpm factory` | Run the Factory control-plane CLI |
| `pnpm factory site-task <task.json>` | Execute one SiteTask end to end (requires Codex auth) |

## Running a site-task

```bash
pnpm factory site-task packages/contracts/fixtures/create-roof-repair.json
```

The executor validates the task (Zod schema in `@factory/contracts`),
verifies the working tree is clean, creates a detached git worktree at the
current HEAD, installs dependencies **offline** from the pnpm store, runs the
Codex CLI (`codex exec`) constrained to a workspace-write sandbox with
network and web search disabled, mechanically rejects any change outside
`sites/starter/src/`, runs the full `pnpm qa` pipeline itself in the
worktree, verifies the built page exists and contains the task title, and
writes a structured `TaskResult`. Exit code is 0 only on complete success.

Run artifacts land in `.factory/runs/<runId>/` (gitignored): the task, base
commit, raw Codex JSONL/stderr, the staged change list, `diff.patch`, QA
stdout/stderr and screenshots, the verification result, and
`task-result.json`. Temporary worktrees under `.factory/worktrees/` are
always removed, on success and failure alike.

Timeouts are bounded and env-configurable: `FACTORY_DEPS_TIMEOUT_MS` (5 min),
`FACTORY_CODEX_TIMEOUT_MS` (20 min), `FACTORY_QA_TIMEOUT_MS` (15 min).

## QA artifacts

Each `pnpm test` run captures full-page screenshots to
`sites/starter/qa-artifacts/` (gitignored, regenerated every run):

- `homepage-desktop.png`, `homepage-mobile.png`
- `service-desktop.png`, `service-mobile.png`
- `article-desktop.png`, `article-mobile.png`
- `404-desktop.png`, `404-mobile.png`

Traces and error contexts for failed tests land in
`sites/starter/test-results/`.

## Configuration

Copy `.env.example` to `.env` in the repository root (or create `sites/starter/.env`)
to configure environment variables.

- **`PUBLIC_SITE_URL`**: Canonical origin of the site. Used for canonical `<link>`,
  Open Graph URLs, and JSON-LD `@id` / `url` properties.
  - **Local default**: `http://localhost:4321` when unset.
  - **Releasable builds**: Set `PUBLIC_SITE_URL=https://yourdomain.com` in `.env` or
    in the shell environment (e.g. `PUBLIC_SITE_URL=https://summitroofing.example.com pnpm build`).
    Shell-provided values always take precedence over `.env` files.
  - **QA acceptance suite**: Automatically builds and tests with a reserved non-production
    origin (`https://test.example.com`) by default to assert correct canonical generation.
- **`FACTORY_QA_PORT`**: Optional TCP port for Playwright preview server (default: `4321`).
  Allows isolated concurrent QA runs across separate worktrees.
