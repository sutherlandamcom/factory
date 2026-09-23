# Production Component Registry — Component API Review

Status: reviewed Component API Review for the Pre-Run-12 governed production
implementation layer. This document records the semantic API of every
registered production component family BEFORE its governed implementation.
The machine-readable counterpart lives in
`apps/factory/src/production/design-implementation.ts` (`REGISTRY_FAMILIES`,
version `production-component-registry-v1`) and is validated by
`packages/contracts/src/design-implementation.ts`.

Authority rules:

- The registry is implementation-policy data, NOT design authority. The
  `AcceptedDesignArtifact` remains the sole design authority; the DIC is
  derived, non-authoritative evidence.
- Registered variant == implemented variant, bidirectionally enforced by
  design-drift QA (`apps/factory/src/production/qa/design-drift.ts`).
- Ordinary production pages must compose ONLY registered components in the
  bounded archetype grammar; unknown IDs/variants fail closed.
- Reuse priority honored: existing reviewed components were reviewed and
  mapped to governed semantic IDs; no hardcoded Sutherland styling was
  copied into the governed layer — styling comes only from projected
  semantic tokens.

## Families

### `page-hero` → `sites/starter/src/components/production/PageHero.astro`

- Purpose: page-opening band carrying the page's single H1, introduction and
  the probable-LCP hero visual.
- Reuse decision: reviewed existing `Hero.astro`; a new governed production
  component was justified because the legacy Hero hardcodes Sutherland
  palette/typography and has no variant or token contract. The governed
  component consumes semantic tokens only.
- Variants: `split` (two-column text+visual), `stacked` (full-width stack).
- Semantic props: `title` (accepted, verbatim), `introduction` (accepted,
  verbatim), `asset` (exact page asset authority or none), `tokens`
  (semantic token values), `headingFont`/`bodyFont` (resolved font delivery).
- Allowed archetypes: all five. Allowed patterns: `hero`, `page-header`,
  `article-header`.
- Visual roles: `hero-primary` (binds the page's exact LCP asset).
- Responsive profile: single column on mobile; two-column split at `md` for
  the split variant; visual never overlaps text.
- Accessibility contract: renders exactly one `h1` (the page title); the
  hero image carries accepted alt authority (`alt=""` only for decorative);
  no text over image without contrast review.

### `content-section` → `sites/starter/src/components/production/ContentSection.astro`

- Purpose: headed prose section rendering accepted section content verbatim.
- Reuse decision: reviewed existing `ContentSection.astro`; governed variant
  set added (`plain`/`evidence`/`structured`) replacing the renderer's
  hardcoded `primitiveClass` map.
- Semantic props: `heading`, `paragraphs` (verbatim), `variant`, `tokens`.
- Allowed archetypes: all five. Allowed patterns: all body patterns
  (`value-statement`, `service-overview`, `location-intro`, `article-body`,
  `approach`, `evidence`, `local-evidence`, `trust-signals`, `methodology`,
  `sources`, `assumptions`, `disclaimer`, `services-overview`, `process`,
  `faq`, `coverage`, `byline`, `related`, `scenarios`, `contact`).
- Responsive profile: single column on mobile; `structured` becomes
  two-column at `md`.
- Accessibility contract: `h2` heading per section; readable body measure;
  no interactive elements.

### `page-conclusion` → `sites/starter/src/components/production/PageConclusion.astro`

- Purpose: closing prose band rendering the accepted conclusion verbatim.
- Variants: `surface`.
- Semantic props: `paragraphs`, `tokens`.
- Allowed patterns: `conclusion`. Responsive: centered measure everywhere.
- Accessibility contract: no heading; body copy only; inside `main`.

### `page-cta` → `sites/starter/src/components/production/PageCta.astro`

- Purpose: full-width conversion band rendering the accepted CTA text
  verbatim.
- Variants: `text`.
- Semantic props: `ctaText`, `tokens`.
- Allowed patterns: `cta`. Responsive: centered everywhere.
- Accessibility contract: CTA text is plain content; link semantics come
  from accepted content links, never invented.

### `related-links` → `sites/starter/src/components/production/RelatedLinks.astro`

- Purpose: related-pages navigation list rendering accepted internal links
  verbatim.
- Variants: `list`.
- Semantic props: `links` (verbatim accepted), `tokens`.
- Allowed patterns: `related`. Responsive: single-column list.
- Accessibility contract: `nav` with `aria-label="Related pages"`;
  keyboard-reachable links with visible focus.

## Token scope rule

Semantic tokens are projected once at the document root
(`ProductionLayout.astro` `<html>` scope) from the manifest's
`semanticTokens`; layout (header/footer/body) and page content consume the
same projection. Components never define fallback values — a missing token
is a build error, not a default.

## Font delivery rule

Font families resolve through the DIC `fontDelivery` records
(`approved_system_stack` only in this policy version). An accepted family
without an approved delivery fails derivation; the browser never silently
substitutes an unrelated font.

## Drift severity (summary; full model in design policy)

- BLOCKING: unknown token/component/variant, unauthorized color/font literal
  in governed production source, modulo cycling, silent fallback syntax,
  authority mismatch, unbound asset.
- REVIEW: explicitly allowlisted justified one-off.
- INFO: component reuse counts, archetype coverage.
