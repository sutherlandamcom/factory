# Autonomy v0 — Reuse / Buy / Build bake-off

Date: 2026-09-01 · Branch: `feat/autonomy-v0-site-blueprint` (from `origin/main` @ `9d59db5`)

Method: every candidate was checked against current upstream truth (npm registry metadata
and/or GitHub repo API) on 2026-09-01 unless marked otherwise. No decision is based on
README marketing alone; API shapes for the REUSE NOW candidate were verified against
current documentation.

Rule applied: REUSE only where a mature project closes ~80% of the problem while
preserving Factory contracts, security boundaries, the Astro runtime and differentiated
methodology. Otherwise build only the Factory-specific core.

## Decision matrix

| Candidate | Decision | Problem solved | Factory overlap | Integration cost | Security impact | MVP value |
|---|---|---|---|---|---|---|
| OpenRouter | **REUSE NOW** | Unified multi-model gateway | Transport only; Factory owns roles, policy, contracts, provenance | Low: thin `fetch` adapter; OpenAI-compatible JSON; no SDK dependency | Must fail closed on missing key; key never enters prompts/artifacts; provider attribution recorded per call | **Critical**: makes multi-model bake-off and per-role champion selection possible at all |
| Promptfoo | **BORROW PATTERN ONLY** | Multi-provider eval harness, judging, CI reports | Duplicates the gateway path Factory needs in production; cannot execute Factory's in-repo Zod validators without shelling out | Medium: YAML config + custom JS assertions + dependency weight (heavy install, Node ≥ 22.22 satisfied) | New large dependency in eval path; separate provider auth handling | Low for v0: Factory's deterministic gates and blind two-judge rubric are small on top of the Factory adapter |
| DataForSEO `TypeScriptClient` (official, `dataforseo/TypeScriptClient`) | **REUSE LATER** | Keyword/SERP/competitor data acquisition | None yet — no automated acquisition in Factory | Low at adoption time | Service account credentials; egress of query lists | Real when the Research-acquisition phase starts; not needed for Autonomy v0 |
| Firecrawl (`firecrawl` npm, MIT) | **REUSE LATER** | Web page → structured content acquisition | None yet | Low | Fetches attacker-influenceable web content; must stay outside trust boundary | Real for evidence acquisition phase |
| Stagehand (`@browserbasehq/stagehand`, MIT) | **REJECT FOR MVP** | Agentic browser automation | Overlaps nothing critical; acquisition fallback only | High: browser runtime + service assumptions | Browser agent with web content in loop = large untrusted surface | None for v0 |
| vercel-labs/json-render (Apache-2.0) | **BORROW PATTERN ONLY** | Guarded rendering of model-proposed UI from a closed component registry | Direct conceptual overlap with ComponentCapabilityRegistry ("model may only reference registered capabilities") | n/a (pattern only) | n/a | Pattern validated: registry-gated model output is the right shape |
| Starwind UI (MIT) | **BORROW PATTERN ONLY** | Tailwind 4 + Astro component recipes | Partial; Factory starter owns its components | Selective file-level adoption only, never wholesale | Copy-in components must be reviewed as Factory code | Future design-system expansion reference |
| Accessible Astro Components (MIT) | **BORROW PATTERN ONLY** | Accessible Astro component patterns | Partial | Selective adoption per component | Copy-in reviewed as Factory code | A11y reference for future shell work |
| AstroWind (`arthelokyo/astrowind`, MIT) | **BORROW PATTERN ONLY** | Astro site architecture/config patterns | Overlaps Site Shell concerns, not Blueprint | n/a | n/a | Configuration/IA patterns for future SiteProfile work |
| Unlighthouse (MIT) | **REUSE LATER** | Whole-site Lighthouse crawl (a11y, perf, meta, links) | Commodity layer of a future WholeSiteOracle | Low: npx + config; Node ≥ 22.18 satisfied | Runs a headless browser against the local build | High for whole-site QA phase — but explicitly out of this PR |
| axe-core (MPL-2.0) | **REUSE LATER** | Accessibility rule engine | Commodity a11y checks | Low | Low | Bundled inside future whole-site QA (possibly via Unlighthouse) |
| Lychee (Apache-2.0, Rust binary) | **REJECT FOR MVP** | Fast whole-site link checking | Commodity broken-link checks | Medium: external non-Node binary in CI | Low | Playwright QA already enforces same-origin link resolution; revisit later |
| @astrojs/sitemap (MIT) | **REUSE LATER** | sitemap.xml generation | None (starter has none) | Low | Low | Site Shell phase prerequisite, not Autonomy v0 |
| schema-dts (Apache-2.0) | **REUSE LATER** | Typed schema.org JSON-LD | Blueprint carries structured-data *intent* only in v0 | Low | Low | Structured-data codegen phase |
| Argos (MIT) | **REJECT FOR MVP** | Visual regression SaaS | None | Medium + external service | Sends site imagery to third party | Deferred |
| sitespeed.io (MIT) | **REJECT FOR MVP** | Performance suites | Overlaps Lighthouse/Unlighthouse | Medium | Low | Deferred |
| Style Dictionary (Apache-2.0) | **REJECT FOR MVP** | Design-token pipeline | No token framework in Factory v0 | Medium | Low | Explicitly deferred per mission §31 |
| LiteLLM (Python) | **REJECT FOR MVP** | Multi-provider LLM proxy | Duplicates the chosen OpenRouter gateway; Python not TS | High (language/runtime mismatch) | Extra proxy surface | OpenRouter covers the need |
| BAML (MIT) | **REJECT FOR MVP** | Typed LLM function calls + repair | Factory already owns strict Zod contracts and bounded repair | Medium | Prompt-injected DSL surface | Rejects on IP-ownership grounds |

## Verification evidence (2026-09-01)

- **OpenRouter**: docs verified (chat completions response `usage` with `cost`/`cost_details`;
  `GET /api/v1/models` returning `pricing`, `supported_features` incl. `structured_outputs`;
  `response_format: json_schema`; provider-routing parameters that Factory deliberately
  does NOT use for authoritative calls — `models` fallback arrays, `route:"fallback"`,
  Auto Router). SDK `@openrouter/sdk@1.2.86` exists (Apache-2.0) but a plain `fetch`
  adapter is preferred: fewer dependencies, full control over provenance capture.
- **Promptfoo**: repo active (24.7k★, ~9.5k commits, MIT, now part of OpenAI but remains
  open source; Node ≥ 22.22).
- **Unlighthouse**: repo active (`harlan-zw/unlighthouse`, 4.8k★, MIT; Node ≥ 22.18).
- **DataForSEO**: official org client `TypeScriptClient` exists (41★, pushed 2026-08-21).
- **npm metadata observed** (version, license, last publish): `schema-dts` 2.0.0
  Apache-2.0 (2026-03); `@astrojs/sitemap` 3.7.4 MIT (2026-08-31); `axe-core` 4.13.0
  MPL-2.0 (2026-08-31); `firecrawl` 4.38.0 MIT (2026-08-31); `@boundaryml/baml` 0.226.1
  MIT (2026-08-19); `accessible-astro-components` 5.7.1 MIT (2026-08-16);
  `@browserbasehq/stagehand` 4.0.2 MIT (2026-08-31); `sitespeed.io` 42.6.0 MIT (2026-08-06);
  `style-dictionary` 5.5.2 Apache-2.0 (2026-08-19).
- **GitHub API observed** (stars, last push, license): `vercel-labs/json-render` 16.1k,
  2026-08-30, Apache-2.0; `BerriAI/litellm` 57.7k, 2026-08-31, license non-standard
  (MIT + enterprise constraints on parts); `lycheeverse/lychee` 3.9k, Apache-2.0;
  `argos-ci/argos` 619, MIT; `starwind-ui/starwind-ui` 718, MIT;
  `browserbase/stagehand` 24.1k, MIT; `arthelokyo/astrowind` 5.9k, MIT (repo moved
  from `onwidget`).

## Hypothesis challenges

Prior hypotheses from the mission brief, with outcomes:

1. "Promptfoo → likely REUSE NOW or thin evaluation inspiration" — **CHALLENGED →
   BORROW PATTERN ONLY.** Promptfoo cannot run Factory's in-repo Zod gates
   (`parseSiteIntelligencePlan` + `validateSiteIntelligencePlan`, and the new Blueprint
   validator) without shelling out to a script; its provider layer would duplicate the
   OpenRouter adapter that production needs anyway; and Factory's three-layer judging
   (deterministic gates → rubric judges → human-readable evidence) is small on top of
   the Factory adapter. Revisit if eval cadence grows beyond ad-hoc sessions.
2. "OpenRouter → likely REUSE NOW" — **CONFIRMED**, with a stricter rule set than the
   README suggests: no Auto Router, no `models` fallback arrays, no `route:"fallback"`
   for authoritative calls; exact model id always explicit; response `model`/`provider`
   recorded as provenance.
3. "Unlighthouse → strong WholeSiteOracle commodity layer" — **CONFIRMED, REUSE LATER**
   (not integrated in this PR).
4. "BAML → reject because Factory owns Zod contracts/repair" — **CONFIRMED.**
5. "LiteLLM → later, not MVP" — **REJECT FOR MVP entirely**: TypeScript-first repo,
   OpenRouter already covers multi-provider transport.

## Factory-differentiated IP — not outsourced (unchanged by this bake-off)

Site Intelligence methodology; SiteBlueprint contract; page-intent methodology;
claim/evidence mapping; operator-fact trust model; prohibited-claim policy; page
readiness decisions; conversion architecture; internal-link planning methodology;
component capability semantics; media usefulness policy; SEO governance; quality gates;
acceptance methodology; security boundaries.

## Whole-site QA proposal (for a later phase — not this PR)

Split between commodity and Factory-differentiated checks:

**COMMODITY (proposed: Unlighthouse as the engine)**
- Lighthouse performance/a11y/best-practices/SEO scores per route
- Broken same-origin links (complements existing Playwright link checks)
- Basic metadata presence/consistency at scale (title/description/canonical/og)
- robots/sitemap sanity once those exist

**FACTORY-DIFFERENTIATED (always Factory-owned TS)**
- Accepted-plan completeness: every accepted plan page exists, none extra
- Intent uniqueness / cannibalization detection across routes
- Claim provenance: published claims trace to evidence/operator facts
- Conversion architecture: each page's CTA role matches the blueprint
- Route ownership: canonical/route identity vs accepted plan
- Content duplication across pages vs blueprint purpose separation
- Brand/prohibited-claim constraints on rendered text
- Evidence compliance: no published metric without cited evidence

Rationale: Unlighthouse covers the crawl + Lighthouse commodity surface well and is
actively maintained; reimplementing it in Factory would be undifferentiated work. The
Factory-specific gates cannot come from a generic crawler because they require the
accepted plan and evidence bundle as inputs.
