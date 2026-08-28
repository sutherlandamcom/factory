# Factory

Factory is an autonomous system for creating, publishing, and operating
SEO/content websites. This repository currently contains the foundation slice:

**structured SiteTask → Astro website → static/type checks → build → Playwright QA → PASS/FAIL**

See `docs/architecture.md` for the design.

## Prerequisites

- Node.js 22+
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

> Note: `@playwright/test` is pinned to `~1.61.0` because 1.62 dropped
> Chromium support for macOS 13. Upgrade once all dev/CI hosts run macOS 14+.

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

Traces and error contexts for failed tests land in
`sites/starter/test-results/`.

## Configuration

Copy `.env.example` to `.env` to override defaults. Currently the only
variable is `PUBLIC_SITE_URL`, the canonical origin used by the starter site
for canonical links and JSON-LD identifiers.
