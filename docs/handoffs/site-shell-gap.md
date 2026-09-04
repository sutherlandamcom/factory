# Autonomy v0 — Site Shell gap report

> **Historical status (2026-09-04):** This is a dated gap report from the
> Autonomy v0 workstream on 2026-09-01. Preserve it as empirical history; do
> not use its "next phase" sequencing as current instructions. Several gaps
> described below were subsequently addressed (including SiteProfile/shell
> identity work), and current/future sequencing is governed by `AGENTS.md`,
> `docs/architecture/factory-constitution-vnext.md`, and
> `docs/roadmap-vnext.md`. In particular, vNext does not adopt "coding worker
> invents page copy/design" as the target architecture: marketing copy moves
> to the approved writer pipeline and professional design to an external
> DesignProvider.

Date: 2026-09-01 · Branch: `feat/autonomy-v0-site-blueprint` · Scope: report only (no shell changes in this PR)

Question answered at that date: what was required before Sutherland could become a real, coherent site?

Every finding below was verified against the repository state at that time (post PR #8/#9 merge), not
assumed from earlier summaries.

## Verified gaps at the time of the report

### 1. Brand identity is hard-coded to the demo business

| Where | What was hard-coded at the time |
|---|---|
| `sites/starter/src/layouts/Layout.astro:16-17` | `const siteName = "Summit Roofing Co.";` → every page title got the ` \| Summit Roofing Co.` suffix; Header/Footer received it |
| `apps/factory/src/executor/task-qa.ts:3-4` | `SITE_TITLE_SUFFIX = " \| Summit Roofing Co."` — the control plane duplicated the demo suffix for task QA |
| `sites/starter/src/components/Header.astro:8-12` | nav items hard-coded to `/`, `/services/example`, `/blog/example` |
| `sites/starter/src/components/Footer.astro:14,17-19` | copyright line + the same three demo links |
| `sites/starter/src/pages/index.astro:10-18` | LocalBusiness JSON-LD with demo name/areaServed |
| `sites/starter/src/pages/services/example.astro:9-16` | Service JSON-LD with demo provider/areaServed |
| `sites/starter/tests/qa.spec.ts` | exact demo titles, H1s, alt texts asserted |
| `.env.example` | `PUBLIC_SITE_URL=https://summitroofing.example.com` |

Only the canonical origin (`PUBLIC_SITE_URL`) was environment-configurable at that time.

### 2. No navigation registration mechanism

Generated pages were not reachable from the shell nav: new pages hard-coded their own
contextual links, and Header/Footer stayed frozen on demo routes. The SiteBlueprint then
specified `site.navigation` and per-page internal links, but nothing consumed them yet.

### 3. Section-model gaps between blueprint and runtime

- `benefits` existed in the SiteTask section enum but had **no component** — executors improvised
  with FeatureCards. The blueprint registry documented the mapping; the starter needed either
  a real benefits/sections mechanism or later enum cleanup.
- SiteTask carried no per-section final content fields; the then-current coding worker
  materialized prose from section intent. **This is historical behavior, not the vNext
  target.** vNext introduces a separate human-approved content-production path ending in
  `AcceptedPageContent`; implementation workers should then reproduce accepted copy rather
  than author it.
- `ContentSection` took its body from a raw slot, not data — content bundles needed a
  data-driven section surface.

### 4. Technical SEO gaps (per `docs/seo-policy.md`)

- No `@astrojs/sitemap` integration (seo-policy §Sitemaps expected one once the site was real).
- No `robots.txt`.
- No default `og:image` anywhere in the shell.
- `og:title`/`og:url` existed; `og:type` was fixed to `website` even for articles
  (ArticleLayout generated `Article` JSON-LD but the OG type stayed `website`).

### 5. QA coupling to the demo identity

`qa.spec.ts` asserted exact demo strings; `task-page.qa.spec.ts` was generic but the
control plane fed it the demo suffix. Any shell identity work needed to move these together.

## Recommendation made at the time

The original report recommended the following sequence. It is retained for
provenance only and is **superseded for current sequencing by
`docs/roadmap-vnext.md`**:

1. **SiteProfile / SiteShell configuration primitive**: one Factory-owned
   configuration for identity/shell data.
2. **Sitemap + robots** with the shell work.
3. **Blueprint → SiteTask compilation** so content jobs survive toward execution.
4. **QA identity decoupling** behind the SiteProfile fixture.

Do not infer from this historical recommendation that Astro is a permanent
renderer, that SiteTask is the final content authority, or that the code worker
should own final marketing copy/design. Those questions are governed by the
vNext Constitution and roadmap.

## Explicitly out of scope of the historical PR

Per that PR's mission, the Site Shell remained a then-future implementation
phase after SiteBlueprint v0. Nothing in `sites/starter/src/**` was modified by
Autonomy v0.
