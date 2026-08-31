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

## SEO & Google Search governance

- **SEO is a first-class acceptance constraint**, not a post-launch pass. Any
  change affecting public routes, indexing, crawling, canonicals, redirects,
  internal links, metadata, structured data, public content, or performance
  MUST be evaluated for Google Search impact before implementation.
- Current official Google Search documentation is the normative external
  authority for Google-specific requirements. Do not encode SEO folklore.
- Public content MUST be helpful, reliable, people-first, purpose-specific,
  original in substance, evidence-supported where factual claims are made,
  and free of fabricated facts, metrics, credentials, experience, or sources.
- Factory MUST NOT create search-engine-first spam patterns: doorway pages,
  keyword stuffing, cloaking, hidden search-targeted text/links, link spam,
  mass thin pages, substantially duplicated location/query pages made
  primarily to rank, or scaled content whose primary purpose is manipulating
  rankings. Automation never justifies lower quality.
- Every intended indexable page MUST have a coherent route/search identity.
  Canonical, internal links, structured-data URL, sitemap URL, and the
  intended public route MUST NOT knowingly conflict.
- Search-related QA gates MUST NOT be weakened merely to make generated
  content pass.
- No ranking guarantees. If official Google guidance changes materially,
  update repository policy instead of preserving stale assumptions.
- Detailed rules: `docs/seo-policy.md`.

## Workflow

- After meaningful website changes, run `pnpm qa` (typecheck → build →
  Playwright). **A task is never complete while required QA is failing.**
- When implementing a `SiteTask`:
  - **Authorized write scope**: The coding agent may modify only files within
    the explicitly authorized site source scope, initially `sites/starter/src/**`.
  - **Deny-listed paths**: Tests (`sites/starter/tests/**`), Playwright
    configuration (`sites/starter/playwright.config.ts`), root scripts,
    package manifests (`package.json`), lockfiles (`pnpm-lock.yaml`),
    `AGENTS.md`, Git metadata (`.git/**`), and unrelated files are deny-listed.
  - **Oracle protection**: QA and changed-file validation run outside the
    coding agent's write scope.
  - **Fail closed**: Any out-of-scope changed file makes the task fail immediately.
- Playwright QA runs against the **built** site (`astro preview`), never the
  dev server. Screenshot artifacts land in `sites/starter/qa-artifacts/`
  (gitignored, regenerated every run).

## Agent and merge governance

- **Build agents**:
  - May: inspect, implement, test, commit, push feature/fix branches, create/update pull requests.
  - Must NOT: merge their own PRs, push implementation directly to `main`, or declare their own work independently accepted.
  - Terminal state: `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`.
- **Independent QA**:
  - Runs separately and independently against an exact candidate commit SHA.
  - Only after an explicit, independent GO verdict may the PR merge into `main`.

## Repository layout

- `apps/factory` — the Factory control plane (CLI).
- `packages/contracts` — machine-readable contracts (`SiteTask`) shared
  between the control plane and executors.
- `sites/starter` — the Astro starter template that generated sites are
  based on.
- `docs/architecture.md` — what exists and what comes next.
