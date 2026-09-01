# Autonomy v0 — Site Shell gap report

Date: 2026-09-01 · Branch: `feat/autonomy-v0-site-blueprint` · Scope: report only (no shell changes in this PR)

Question answered: what is required before Sutherland can become a real, coherent site?

Every finding below was verified against the current repository (post PR #8/#9 merge), not
assumed from earlier summaries.

## Verified gaps

### 1. Brand identity is hard-coded to the demo business

| Where | What is hard-coded |
|---|---|
| `sites/starter/src/layouts/Layout.astro:16-17` | `const siteName = "Summit Roofing Co.";` → every page title gets the ` \| Summit Roofing Co.` suffix; Header/Footer receive it |
| `apps/factory/src/executor/task-qa.ts:3-4` | `SITE_TITLE_SUFFIX = " \| Summit Roofing Co."` — the control plane duplicates the demo suffix for task QA |
| `sites/starter/src/components/Header.astro:8-12` | nav items hard-coded to `/`, `/services/example`, `/blog/example` |
| `sites/starter/src/components/Footer.astro:14,17-19` | copyright line + the same three demo links |
| `sites/starter/src/pages/index.astro:10-18` | LocalBusiness JSON-LD with demo name/areaServed |
| `sites/starter/src/pages/services/example.astro:9-16` | Service JSON-LD with demo provider/areaServed |
| `sites/starter/tests/qa.spec.ts` | exact demo titles, H1s, alt texts asserted |
| `.env.example` | `PUBLIC_SITE_URL=https://summitroofing.example.com` |

Only the canonical origin (`PUBLIC_SITE_URL`) is environment-configurable today.

### 2. No navigation registration mechanism

Generated pages are not reachable from the shell nav: new pages hard-code their own
contextual links, and Header/Footer stay frozen on demo routes. The SiteBlueprint now
specifies `site.navigation` and per-page internal links, but nothing consumes them yet.

### 3. Section-model gaps between blueprint and runtime

- `benefits` exists in the SiteTask section enum but has **no component** — executors improvise
  with FeatureCards. The blueprint registry documents the mapping; the starter should either
  gain a real benefits/sections mechanism or drop the enum value later.
- SiteTask carries no per-section content fields; all section copy is invented by the coding
  worker. SiteBlueprint v0 preserves content jobs/provenance, but compilation into per-section
  data does not exist yet (deliberate deferral).
- `ContentSection` takes its body from a raw slot, not data — content bundles will need a
  data-driven section surface.

### 4. Technical SEO gaps (per `docs/seo-policy.md`)

- No `@astrojs/sitemap` integration (seo-policy §Sitemaps expects one once the site is real).
- No `robots.txt`.
- No default `og:image` anywhere in the shell.
- `og:title`/`og:url` exist; `og:type` is fixed to `website` even for articles
  (ArticleLayout generates `Article` JSON-LD but the OG type stays `website`).

### 5. QA coupling to the demo identity

`qa.spec.ts` asserts exact demo strings; `task-page.qa.spec.ts` is generic (good) but the
control plane feeds it the demo suffix. Any shell identity work must move these together.

## Required before a real Sutherland build (sequenced)

1. **SiteProfile / SiteShell configuration primitive** (next implementation phase — this is
   the proven bottleneck): one Factory-owned configuration (name, title suffix, canonical
   origin, navigation set, JSON-LD organization identity, default OG image policy, robots) that
   Layout/Header/Footer/task-qa all consume. Removes every hard-coded demo string in one move.
2. **Sitemap + robots** via `@astrojs/sitemap` + static robots (cheap, belongs with #1).
3. **Blueprint → SiteTask compilation** including per-section data so content jobs survive to
   the executor (follows the Grounded ContentBundle phase).
4. **QA identity decoupling**: qa.spec demo assertions move behind the SiteProfile fixture so
   starter QA tests the shell generically.

## Explicitly out of scope of this PR

Per the mission: the Site Shell remains the NEXT implementation phase after SiteBlueprint v0.
Nothing in `sites/starter/src/**` was modified by Autonomy v0.
