# Factory

Factory is an autonomous system for creating, publishing, and operating
SEO/content websites. This repository establishes the PR #1 foundation:

1. **Contracts & Control Plane**: `@factory/contracts` defining the machine-readable `SiteTask` contract, verified by the `apps/factory` CLI.
2. **Starter Template & QA Oracle**: `sites/starter` Astro 7 + Tailwind 4 static website, verified by a strict Playwright QA acceptance suite.

The vertical task-to-site execution pipeline (`SiteTask → Codex executor → verified patch`) will be implemented in PR #2.

See `docs/architecture.md` for the full design.

## Prerequisites

- Node.js >=22.12.0
- pnpm 11 (`corepack enable` if needed)

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
| `pnpm test` | Playwright QA against the **built** site (builds + previews automatically) |
| `pnpm qa` | `check` → `build` → `test` in one command |
| `pnpm factory` | Run the Factory control-plane CLI |

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
