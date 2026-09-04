# FACTORY — SUTHERLAND 1-PAGE HIGH-QUALITY WORKFLOW REPORT

Date: 2026-09-04 · Branch: `feat/sutherland-one-page-workflow-v0` · Candidate: `97e204f`

## A. Foundation

- base SHA: `c790f76` (main == origin/main at start)
- branch: `feat/sutherland-one-page-workflow-v0`
- PR: opened from this branch (not self-merged; independent QA required)
- Site Production Spec version: v0
- Blueprint: run `20260901T114820Z-8976f5e5`, digest `4422c932…`, homepage readiness `ready`
- SiteProfile: `sutherland-private-office` (recreated on this branch from accepted operator facts)

## B. One-page scope

- selected: `/` (Sutherland Private Office homepage)
- all other routes deferred: **YES** (Chamonix, Megève, articles, service pages, contact — none generated; sitemap contains exactly one URL, asserted in QA)

## C. Previous failure model (PR #13, closed unmerged)

- design failures: generic starter Hero+FeatureCards+ContentSection+FAQ composition; stock slate/sky Tailwind aesthetic; uniform card grid; no art direction; no rendered-output review ever performed
- content failures: copy restating Blueprint keyPoints as filler; internal uncertainty ("remains unverified", "intended as") leaking into public copy; no differentiation
- SEO failures: homepage treated as generic template with metadata as afterthought
- workflow failures: no accepted references; insufficient production specification (operator-cited root cause); senior visual review blocked by provider funding; green tests mistaken for quality
- anti-reference constraints derived: no hero+3cards+faq shape; no stock starter palette; no uniform grids; no keyPoint restatement; no internal-hedging language in public copy; no visual certification without screenshots; no invented assets/claims

## D. Real references

All CANDIDATE_ONLY → approved by operator 2026-09-04 (approval recorded in `.factory/references/sutherland/REFERENCE_CANDIDATES.md`). Screenshots captured and stored beside that file.

| ID | role | source | learn | avoid | homepage usage |
|---|---|---|---|---|---|
| ref-monument | reference | monument-privateoffice.com | asymmetric first viewport, oversized display type, one argument per band, low density | black-luxury palette, stock UHNW imagery, embedded form, credential claims | first-viewport composition, band rhythm, closing-band treatment |
| ref-arboris | reference | maison-arboris.com | eyebrow narrative sections, independence as structural decision, definition-list argumentation | unsourced stats, fees, founder bios | band grammar, boundary section, pathways definition list, FAQ voice |
| ref-knightfrank | reference | knightfrank.co.uk alpine research | evidence-first institutional voice, serif display + sans body, one accent | report gating, chart data not in evidence bundle | evidence-band treatment, typographic hierarchy |
| anti-bluepeek | anti_reference | bluepeekproperty.com | the CLASS of regulatory-boundary disclaimer (wording must be accepted facts only) | stat widgets, card grids, scarcity, booking CTAs, emoji, gradients | failure-test anchor; all avoid-items verified absent in rendered output |

## E. Creative direction

- quality bar: concrete must/avoid lists in the spec (no bare adjectives); must feel like a dated, sourced research paper / private-bank orientation letter / institutional decision framework
- must not feel like: Tailwind starter, SaaS landing, listing portal, PR #13, AI brochure
- layout: asymmetric first viewport (headline left majority, counterweight definition block right, hairline accent rule, no image, no button); alternating full-width bands with deliberate variable rhythm (airy statement → dense two-column → narrow definition list → wide FAQ); tone-shift transitions (paper/mist), no dividers
- typography: editorial serif display (Iowan/Palatino stack) + disciplined system sans body; scale contrast as primary hierarchy device
- color: warm paper, deep ink, single deep teal accent (#2f5d62) on eyebrows/rules/link states only
- imagery: none — typographic identity only (operator-recorded "no approved assets"); evidence as sourced prose, never widgets
- density: low statement bands, moderate evidence bands, deliberate variation
- motion: none beyond link/focus transitions
- reference provenance: 4 approved references with screenshots; research candidates never silently promoted — explicit operator approval recorded before any generation

## F. SEO strategy

- homepage role: entity establishment + commercial-investigation orientation (advisory positioning), NOT locality market queries (deferred to future intelligence pages per accepted cannibalisation controls), NOT transactional clusters
- search intent: international buyer evaluating who should support a consequential French Alps property decision (independent advisory vs listing intermediary)
- primary keyword: independent property advisory French Alps
- secondary: Sutherland Private Office (brand); property decision support Chamonix / Megève; buyer-side property advisory France; evidence-led property analysis
- title strategy: accepted Blueprint seoTitle pattern — value argument + brand suffix
- meta strategy: accepted Blueprint metaDescription verbatim
- heading strategy: single H1 stating the value argument naturally; 5 unique H2s mapping band arguments; H3s only inside evidence band columns
- schema intent: LocalBusiness (name, description, url only — no fabricated fields)
- future internal-link relationships: deferred pages (market intelligence, service detail) will hang off this entity page; current internal links limited to brand self-reference; no invented routes (readiness evaluator enforced)

## G. Assets

- required: **NO** (operator-recorded: typographic identity only)
- assets used: none; `approvedAssetRequired=false`, zero fabricated imagery; reference screenshots remain QA artifacts, never production assets

## H. Conversion

- mode: **QUALITY_PROOF (Mode B)** — operator-approved explicit no-CTA (matches `CONVERSION_DESTINATION_DEFERRED`)
- CTA label/destination: none, by deliberate operator decision recorded in spec (`primaryCtaRequired=false`)
- closing band states how an engagement begins in prose without a conversion element; page is NOT production-commercial launch

## I. Production Spec

- path: `.factory/production-spec/sutherland-homepage-v0.json`
- validated: `ok: true` (contract + Blueprint consistency + SiteProfile consistency + evidence cross-refs + reference path safety)
- readiness: **READY, 0 blockers** (`site-production readiness` with `--input-root .factory/references`)
- references: 4 (with digests + byte sizes) · assets: 0 · evidence: 14 (5 discovery + 9 operator facts, all IDs verified present in accepted bundle)

## J. Operator approval

- references approved: YES · creative direction approved: YES · homepage composition approved: YES · CTA mode approved: YES (Mode B)
- **CREATIVE_SPEC_APPROVED: YES** (explicit operator answers recorded 2026-09-04)

## K. Page Production Packet

- compiled: yes · bytes: 29,403 · references: 4 (materialized) · assets: 0 · evidence: 14
- deterministic: **YES — two compilations byte-identical**
- bounded: yes (single page, only cited evidence/references, no other Blueprint pages)
- major ambiguity remaining: none found at §23 review; one compiler gap surfaced at projection (zero-keyPoint conversion section) — fixed by promoting accepted purpose, committed

## L. Executor integration

- files changed: `packages/contracts/src/site-task.ts` (+ index export), `packages/contracts/src/site-intelligence.ts` (doc), `apps/factory/src/site-production/packet-projection.ts` (new), `apps/factory/src/site-production/index.ts` (export), `apps/factory/src/executor/prompt.ts` (2 lines)
- contentBrief impact: positional per-instance matching; new bounded `productionGuidance`/`purpose` fields (≤600/≤300 chars, no HTML)
- SiteTask impact: repeated section instances allowed up to `MAX_SECTION_TYPE_INSTANCES=4` (proven gap: old uniqueness rule forced the rejected uniform shape)
- write-authority impact: none — page workers still write exactly one file; scope/integrity verified in run
- routing impact: none — Kimi K3 product path, senior escalation available, MAX 3 attempts preserved
- security impact: none — projection re-parses through `parseSiteTask` (all bounds apply); guidance fields HTML-forbidden; no packet embedding

## M. Generation

- runId: `run-2026-09-04T12-28-09-557Z-79729c`
- model: moonshotai/kimi-k3 via kimi-code-cli (attempt 1 initial, attempt 2 bounded repair)
- attempts: 2 of max 3 · result: succeeded, finalStage complete
- scope: passed (exactly `sites/starter/src/pages/index.astro`) · integrity: passed · replay: passed
- verification: semantic title/H1/description/canonical checks passed

## N. Technical QA

- Astro: check 0 errors · build clean (2 pages: /, 404)
- build+Playwright via `pnpm qa`: **556 unit + 8 Playwright green** (desktop 1280×800 + mobile 390×844)
- PostgreSQL 18: persistence suites **19/19** (per-file; concurrent same-process runs have a pre-existing suite-isolation race, noted as workflow friction)
- canonical `https://sutherlandam.com/` · exactly one H1 · title/desc/OG from accepted truth · LocalBusiness JSON-LD validated · sitemap exactly one URL · no console errors
- determinism: packet compile byte-identical ×2; worker replay verified in run

## O. SEO QA (rendered HTML reviewed)

- SEO-P0: 0 · SEO-P1: 0 (1 found → remediated) · SEO-P2: 1 (hero brand self-link is decoration-only; harmless)
- search-intent fit: homepage answers "who advises a consequential alpine property decision" with differentiation, not listings — satisfies commercial-investigation intent
- keyword use: natural density (independent×4, advisory×7, Chamonix/Megève×2 each, evidence×7 across 693 words) — no stuffing
- metadata: accepted Blueprint values verbatim; canonical/OG correct
- semantic structure: H1 unique; H2s unique after remediation; hierarchy coherent
- crawlability: static HTML, internal links resolve, sitemap/robots coherent
- schema: LocalBusiness minimal and truthful
- content quality: claims traceable to accepted evidence; no locality cannibalisation

## P. UI/UX QA (rendered screenshots reviewed, desktop + mobile)

- UI-P0: 0 · UI-P1: 0 (duplicate-H2 visual/template issue → remediated) · UI-P2: 2 (FAQ band padding slightly tighter than EditorialBand rhythm; mobile hero counterweight cards stack cleanly but could breathe more)
- desktop: asymmetric first viewport confirmed (H1 49% width + right counterweight; measured), band tone alternation paper/mist confirmed
- mobile: stacked single-column rhythm, no horizontal overflow (0px), definition lists stack term-over-description
- first viewport: eyebrow + display serif H1 + positioning paragraph + 3-fact orientation block — positioning established without imagery
- hierarchy: serif/sans contrast carries bands; accent restricted to eyebrows/rules (4 uses measured)
- imagery: zero, per approved typographic identity
- navigation: single-entry nav renders from profile; footer identity correct
- conversion: no CTA elements (0 filled buttons) — deliberate Mode B
- reference fidelity: ref-monument composition IMPLEMENTED; ref-arboris editorial grammar IMPLEMENTED; ref-knightfrank evidence treatment IMPLEMENTED; dimension table in spec → all IMPLEMENTED (0 MISSED)
- anti-reference compliance: 0 card grids, 0 stat widgets, 0 emoji, 0 gradients verified programmatically in rendered DOM
- failure test (§33): page does not read as generic Tailwind starter / SaaS / listing portal / hero+3cards template — materially NO on all

## Q. Editorial QA

- EDITORIAL-P0: 0 · EDITORIAL-P1: 0 (1 found → remediated) · EDITORIAL-P2: 1 (positioning phrase repeats in hero and FAQ answer — consistency, not filler)
- specificity: decisions, markets, and source classes named; no superlative stacking
- credibility: every market/process statement qualitative or traceable; evidence band states limits symmetrically with strengths
- AI clichés: zero instances of banned phrase list (checked rendered text)
- unsupported claims: zero (claims matrix + prohibitedClaims enforced; "Investment Memorandum" expressed as concept in development)
- narrative: complete one-page argument — positioning → boundary → pathways → evidence method → objections → engagement; not a menu of future pages
- repetition: minimal; accepted as deliberate consistency (P2)

## R. Remediation

- frozen findings before fixes: SEO-P1 duplicate H2; EDITORIAL-P1 "remains unverified" leakage (both frozen, then fixed in one bounded commit)
- fixes: evidence-band heading → approved headingIntent; honest boundary phrasing without internal language
- new SHA: `97e204f`
- rerun results: 556 unit + 8 Playwright + 19 persistence green; rendered H2 uniqueness and zero "unverified" verified

## S. Final homepage assessment

- technically acceptable: **YES**
- SEO acceptable: **YES**
- UI/UX acceptable: **YES**
- editorially acceptable: **YES**
- operator-quality acceptable: **YES** (Mode B quality proof; not a commercial launch — no verified CTA exists)

## T. Workflow proof

1. inputs representable without schema hacks: **YES** (references incl. anti-reference with screenshots; SEO intent; no-CTA decision — all expressed in spec v0 as-is; two small schema evolutions were contract-gap fixes, not hacks)
2. references materially influenced output: **YES** (composition, band grammar, evidence treatment traceable to approved references; anti-reference constraints verified in rendered DOM)
3. approved assets controlled: YES/NA (zero assets; `approvedAssetRequired=false` enforced by readiness)
4. SEO intent reached final page correctly: **YES** (title/H1/meta/canonical/keyword coverage verified in rendered HTML)
5. business truth protected: **YES** (all copy from Blueprint keyPoints/prohibitedClaims via packet→brief; claims matrix respected)
6. packet bounded and useful: **YES** (29.4KB single-page, deterministic, §23 review passed)
7. page worker preserved write boundary: **YES** (scope/integrity passed; exactly one file changed)
8. deterministic QA caught objective defects: **YES** (foundation QA caught real failure in run 1; contract bounds caught zero-keyPoint gap)
9. visual/editorial QA caught subjective defects: **YES** (duplicate H2 + internal-hedging leak found only via rendered review)
10. remediation bounded: **YES** (one frozen set, one page-local commit, one rerun)
11. result genuinely acceptable to operator: **YES** (approval gates explicit; final quality bar met)
12. no dashboard required: **YES** (whole workflow ran through CLI + files + operator chat)

Manual intervention audit: no hidden page edits — the only page-touching changes are the worker patch (applied verbatim from run artifacts) and the recorded P1 remediation commit. **WORKFLOW PROVEN** (with the provider-funding and idempotency frictions recorded in U).

## U. Dashboard evidence (actual friction from this run)

- repeated manual actions: sourcing .env before CLI (3×); per-file persistence test invocation (port mismatch 5432/5433 in .env); idempotency-key flag on generation retry; killing orphaned preview servers on 4321
- fields needing UI: reference submission (URL + LEARN/AVOID + screenshot upload), asset rights/approval status, SEO intent/keywords form, CTA mode + destination entry, spec quality-bar editor
- reference UX needs: paste URL → auto-screenshot → annotate LEARN/AVOID per dimension → approve; approval record persistence
- asset UX needs: upload + rights status + assign to page/section (not exercised here — zero-asset path worked)
- approval UX needs: side-by-side candidate packet view with explicit CREATIVE_SPEC_APPROVED action; approval must be recorded as data, not chat
- preview/review UX needs: built-site screenshot viewer (desktop+mobile) with finding pinning (P0/P1/P2 classification at the finding site)
- version UX needs: run list (runId, attempts, model, QA verdicts) with candidate SHA + diff view
- provider-funding friction: OpenRouter key-level monthly limit exhausted mid-run (402) while account balance remained — a funding-status check belongs in the run UX before model spend
- idempotency friction: a failed terminal run cannot be re-executed without a new explicit idempotency key (data model is correct; the retry UX decision is operator-visible and should be a Dashboard affordance)

## V. Open-source reuse map (analysis only; nothing integrated)

| Capability needed | Puck | ChaiBuilder | GrapesJS | Onlook | Dyad | TinaCMS | Webstudio | Payload | Open Lovable concept |
|---|---|---|---|---|---|---|---|---|---|
| reference URL→screenshot capture | REJECT | REJECT | REJECT | ADAPT (visual canvas capture ideas) | REJECT | REJECT | REJECT | REJECT | REUSE (reference-ingestion concept) |
| LEARN/AVOID annotation + approval records | PATTERN | PATTERN | REJECT | REJECT | REJECT | ADAPT (editorial workflow) | REJECT | PATTERN (admin collections) | REJECT |
| Production-spec form fields (SEO, CTA mode, quality bar) | REJECT | REJECT | REJECT | REJECT | REJECT | ADAPT (structured content forms) | REJECT | REUSE_AS_PATTERN (field schema admin) | REJECT |
| packet/spec preview + approve action | REJECT | REJECT | REJECT | REJECT | REJECT | PATTERN (review workflow) | REJECT | PATTERN | REJECT |
| built-site screenshot review with findings | REJECT | REJECT | REJECT | ADAPT (screenshot-to-code inspection) | REJECT | REJECT | REJECT | REJECT | REJECT |
| page visual editing by operator | PATTERN (block editing fits Astro components) | PATTERN | REJECT (too low-level, wrong abstraction) | REJECT | REJECT | REJECT | ADAPT (visual tree concepts) | REJECT | REJECT |
| run/version list with QA verdicts | REJECT | REJECT | REJECT | REJECT | REJECT | REJECT | REJECT | PATTERN (admin list views) | REJECT |

Net: no full-editor dependency is justified for v0. The operator-facing surface is forms, approvals, and review views — Tina/Payload-style structured-content patterns cover most; Puck is the candidate if/when in-browser page editing is truly required. Editing is the LAST need; evidence capture and approvals are the FIRST.

## W. Dashboard decision

**DASHBOARD V0 — GO — WORKFLOW PROVEN ON ACCEPTED HIGH-QUALITY HOMEPAGE**

Conditions met: (A) homepage quality accepted on all four gates; (B) workflow proven end-to-end without undocumented intervention; (C) no unresolved core Production-Spec capability gap (the two gaps found were fixed within the accepted contract); (D) repeated operator actions identified in U; (E) Dashboard reduces friction (input capture, approvals, review) without becoming a truth source — spec/packet/readiness remain the authority. Build order should follow U's friction ranking: provider-funding precheck → reference capture/annotation/approval → spec form → packet preview/approve → run/finding review views. Visual page editing (Puck-class) is explicitly not v0.

## X. Final status

**1. SUTHERLAND 1-PAGE WORKFLOW — HIGH-QUALITY HOMEPAGE ACCEPTED — TECHNICAL / SEO / UIUX / EDITORIAL GATES PASSED — WORKFLOW PROVEN — READY TO DESIGN DASHBOARD V0**

Governing notes: candidate SHA `97e204f` requires independent QA before merge (not self-merged). Mode B: this homepage is a quality proof, not a production commercial launch; Mode A requires a verified CTA destination from the operator. No dashboard code, tables, auth, or builder integrations were created in this run.
