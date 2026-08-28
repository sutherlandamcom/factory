# Factory architecture

## What exists today (PR #1)

Factory is a pnpm monorepo with three packages:

```
apps/factory        @factory/factory      — control-plane CLI (tsx, TypeScript)
packages/contracts  @factory/contracts    — shared machine-readable contracts
sites/starter       @factory/site-starter — Astro 7 + Tailwind 4 website template
```

### Contracts (`packages/contracts`)

The `SiteTask` type is the single unit of work flowing through the system.
v0 supports exactly one task: `create_page`, which carries a `siteId` and a
page description (`type`, `slug`, `title`, `description`, `sections`). The
package exports the types plus one example fixture (`exampleSiteTask`).
These are plain TypeScript types — no runtime schema system yet.

### Control plane (`apps/factory`)

A minimal CLI (`pnpm factory`) that proves the workspace wiring: it imports
`@factory/contracts` and prints its identity plus the example task's slug.
No server, database, queue, or auth — those arrive only when a later PR
requires them.

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
3. **test** — Playwright runs against the built site served by
   `astro preview` (never the dev server), at desktop (1280×800) and mobile
   (390×844) viewports. It asserts 2xx/404 statuses, exactly one `<h1>` per
   page, correct titles, CTA visibility, working navigation and internal
   links, Article JSON-LD, and zero page/console errors. Full-page
   screenshots are written to `sites/starter/qa-artifacts/`.

## Next vertical slice (PR #2)

Close the loop from contract to verified change:

```
SiteTask → isolated Codex execution → repository modification → QA → structured result
```

- The control plane accepts a `SiteTask` (e.g. the `create_page` fixture)
  and dispatches it to an isolated Codex execution environment.
- The executor modifies a site repository (initially a copy/instance of
  `sites/starter`) to satisfy the task, constrained by `AGENTS.md`.
- The existing QA pipeline (`pnpm qa`) runs against the modified site.
- The executor reports a structured PASS/FAIL result back to the control
  plane, keyed to the original `SiteTask`.

Everything beyond this slice (publishing, scheduling, multiple sites,
content generation, SEO automation) is intentionally out of scope until a
later PR introduces it.
