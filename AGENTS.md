# AGENTS.md — Factory engineering rules

These rules apply to every change in this repository, whether written by a
human or an agent executing a `SiteTask`.

## Technology constraints

- **Websites: Astro only.** No Next.js, no React/Vue/Svelte or any other UI framework.
- **Language: TypeScript** everywhere (site components, tooling, contracts).
- **CSS: Tailwind CSS 4 only.** No Bootstrap or any other CSS framework, no
  hand-rolled design systems.
- **No packages without a concrete reason.** Every new dependency must solve a
  requirement of the task at hand. Plain TS types beat runtime schema
  libraries unless runtime validation is genuinely needed.
- **No infrastructure without a PR that requires it**: no servers, databases,
  queues, auth, dashboards, or deployment targets beyond static output.

## Websites

- Prefer **static generation**. Client-side JavaScript only where strictly
  necessary; zero is the default.
- **Reuse existing components** (`sites/starter/src/components/`) before
  creating new ones.
- Every public page requires:
  - a unique `title` and meta `description`,
  - a canonical URL,
  - exactly one `<h1>` and a sensible heading hierarchy,
  - a responsive layout,
  - internal links,
  - JSON-LD structured data where applicable (e.g. `Article` on blog posts).
- Images are local assets processed through Astro's built-in image handling
  (`astro:assets`). No external hotlinks.

## Workflow

- After meaningful website changes, run `pnpm qa` (typecheck → build →
  Playwright). **A task is never complete while required QA is failing.**
- When implementing a `SiteTask`, change only the files the task implies.
  Do not touch unrelated files, reformat, or refactor opportunistically.
- Playwright QA runs against the **built** site (`astro preview`), never the
  dev server. Screenshot artifacts land in `sites/starter/qa-artifacts/`
  (gitignored, regenerated every run).

## Repository layout

- `apps/factory` — the Factory control plane (CLI).
- `packages/contracts` — machine-readable contracts (`SiteTask`) shared
  between the control plane and executors.
- `sites/starter` — the Astro starter template that generated sites are
  based on.
- `docs/architecture.md` — what exists and what comes next.
