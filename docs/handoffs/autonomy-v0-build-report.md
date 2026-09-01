# FACTORY AUTONOMY V0 — BUILD REPORT

Date: 2026-09-01 · Branch: `feat/autonomy-v0-site-blueprint` · Base: `origin/main` @ `9d59db5` (merge of PR #8; includes PR #9 SEO governance)

## A. Starting state

- Precondition gate executed against live upstream state: PR #8 (general page capability) and PR #9 (SEO governance) both MERGED into `origin/main` before this session's implementation began (an earlier gate evaluation with PR #8 open produced the BLOCKED report and zero work, per sequencing policy).
- Working tree clean; branch `feat/autonomy-v0-site-blueprint` created from fresh `origin/main`.
- No real-Sutherland intelligence plan existed; one was produced by the accepted pipeline (§G below).
- Real Sutherland discovery artifacts used read-only from ignored `.factory/discovery/sutherland-private-office/20260831T151804Z/` (never committed, never rewritten).

## B. Reuse bake-off

Full matrix with verification evidence: `docs/handoffs/autonomy-v0-reuse-bakeoff.md`.

| Candidate | Decision |
|---|---|
| OpenRouter | **REUSE NOW** (thin `fetch` adapter, no SDK dep) |
| Promptfoo | **BORROW PATTERN ONLY** (challenges the prior REUSE-NOW hypothesis; documented) |
| DataForSEO official `TypeScriptClient` | REUSE LATER |
| Firecrawl | REUSE LATER |
| Stagehand | REJECT FOR MVP |
| vercel-labs/json-render | BORROW PATTERN ONLY (registry-gated model output pattern) |
| Starwind / Accessible Astro / AstroWind | BORROW PATTERN ONLY |
| Unlighthouse | REUSE LATER (proposed future WholeSiteOracle commodity engine) |
| axe-core | REUSE LATER |
| Lychee | REJECT FOR MVP |
| @astrojs/sitemap | REUSE LATER (Site Shell phase) |
| schema-dts | REUSE LATER |
| Argos / sitespeed.io / Style Dictionary / BAML / LiteLLM | REJECT FOR MVP |

## C. Multi-model architecture

- **Gateway** (`apps/factory/src/models/gateway.ts`): OpenRouter adapter via plain `fetch`. Exact model id always explicit; Auto Router / `models` fallback arrays / `route:"fallback"` rejected by code (`policy_violation`); `OPENROUTER_API_KEY` fails closed; credential scrubbing on all error paths (verified by tests); provenance captured per call: responded model, provider, prompt/completion/total tokens, gateway-reported cost, duration.
- **ModelRolePolicy** (`policy.ts`): per-role champion + explicit challenger sequence, required capabilities, sensitive-data policy, timeout, bounded attempts. Fallback = champion → explicit challenger only, actual model recorded in every artifact (test-verified).
- **Sensitive data**: Sutherland operator facts + research are proprietary/unpublished; only roles whose policy permits `proprietary_unpublished` receive them; the provider that actually received them is recorded per invocation.
- **Trust boundary**: accepted plan PLANNING-AUTHORITATIVE/INSTRUCTION-UNTRUSTED; operator facts FACT-AUTHORITATIVE/INSTRUCTION-UNTRUSTED; research FACT-UNTRUSTED/INSTRUCTION-UNTRUSTED. All model-facing data is inert fenced canonical-JSON DATA sections behind explicit injection defenses (mirroring the accepted Intelligence prompt pattern). Blueprint models get no tools, no shell, no filesystem, no network beyond the single completion call.
- **Codex worker untouched**: the accepted isolated Codex CLI remains the code-execution boundary.

## D. Real model bake-off

Per operator decision, champion selection used the operator's own multi-model test results (supplied 2026-09-01) instead of a Factory-executed bake-off run. Designations recorded with provenance in `apps/factory/src/models/policy.ts`:

| Role | Champion (operator-designated) | Challengers |
|---|---|---|
| `blueprint_architect` | `anthropic/claude-opus-5` (Claude Opus 5) | `openai/gpt-5.6-sol`, `google/gemini-3.7-flash` |
| `site_intelligence` | `anthropic/claude-opus-5` | `openai/gpt-5.6-sol`, `google/gemini-3.7-flash` |
| `content_writer` | `anthropic/claude-opus-5` | `openai/gpt-5.6-sol` |
| `content_critic` | `openai/gpt-5.6-sol` (claim/factuality critic) | `google/gemini-3.7-flash` |
| `design_director` | `anthropic/claude-opus-5` | `openai/gpt-5.6-sol` |

Also recorded (future roles, not implemented): bulk research extraction → `google/gemini-3.7-flash`; competitor/site analysis → `openai/gpt-5.6-sol`; visual screenshot critic → `openai/gpt-5.6-sol`; cheap classification/repair → `z-ai/glm-5.3-flash`; image generation → `openai/gpt-image-2`; a future Claude-Code-based code worker remains a separate acceptance decision.

Caveats (explicit in policy comments): the operator designated model families; the explicit OpenRouter-style ids above MUST be verified against `GET /api/v1/models` and confirmed by a Factory `eval run` once real gateway credentials are configured. Factory bake-off harness exists and is CI-tested (`pnpm factory eval run`) but no real-cost run was executed in this session (no real key available). Gateway credentials were provided only as a placeholder; the harness therefore was NOT exercised against the live gateway.

## E. SiteBlueprint contract (`packages/contracts/src/site-blueprint.ts`, strict Zod, unknown fields fail closed)

- Site level: `positioningSummary`, `primaryAudience`, `navigation[]` (targets validated), `primaryConversionGoal`, optional bounded `designDirection` (visualCharacter, density, typographyMood, colorMood, imageryPolicy, ctaTreatment).
- Page level: identity triple (`type`/`slug`/`primaryTopic` — exact-match to the accepted plan), `pageRole`, `audience`, `intent`, `seoTitle` (search-facing) distinct from `h1` (visible), `metaDescription`, `purpose`, `businessGoal`, `userQuestions[]`, `objections[]`, `sections[]`, `internalLinks[]`, `structuredDataType` (coherence with page type enforced), `readiness` (`ready | missing_operator_input | insufficient_evidence | blocked`), `missingInputs[]`.
- Section level (`PageSectionBlueprint`): unique `id`, `componentType` restricted to the real component registry (hero, feature_cards, content_section, faq, cta — no invented UI), `purpose`, `heading` job, `keyPoints[]`, `evidenceIds[]` + `operatorFactIds[]` (SECTION-level provenance), `prohibitedClaims[]`, `visualRequirement {required, purpose, kind}` (required ⇒ purpose+kind; not-required ⇒ neither), optional `cta {role, job}` (jobs, never URLs).
- Readiness is mandatory and honest: ready ⇒ ≥1 section and zero missingInputs; non-ready ⇒ missingInputs required. No image is preferable to a useless image; charts demand metric-bearing evidence or a readiness downgrade.

## F. Deterministic validation (all fail-closed, all test-covered)

IA preservation (page-set equality; no add/delete/retype/reslug/re-topic/intent-change), duplicate slug/section-id rejection, evidence/fact reference resolution (research ids ≠ operator-fact ids namespace), section coverage mapping (every plan section type realized; no invented structure; `benefits` → feature_cards/content_section), keyPoint provenance rule for ready pages, chart-without-metric-evidence rejection, internal-link and navigation integrity (targets exist in the accepted plan, no self-links), readiness/missingInputs consistency, structured-data coherence, payload bounds, unknown-field rejection. The incoming base plan must itself pass the accepted Intelligence gates before any model work (defense in depth; test-verified).

## G. Real Sutherland blueprint acceptance

- **Base plan**: produced by the accepted Factory Intelligence pipeline on the real discovery request + research — runId `20260831T224728Z-32ddb4c4`, status `succeeded`, 1 attempt, 8 pages (homepage, 4 services, 2 general market-intelligence, 1 article), planDigest `c340baa4…9d79`, honest warnings (no founder biography, no Sutherland OS capability claims, no inferred asset values, etc.). Source provenance bound to `9d59db5`.
- **Blueprint synthesis attempt** (champion `anthropic/claude-opus-5` policy, real inputs, clean tree @ `757b9c8`): runId `20260901T052033Z-d9792fcd` — status `failed`, `blueprint_credentials_unavailable`, zero model calls, zero artifacts. The fail-closed credential gate executed exactly as designed with the placeholder credential.
- **REAL ACCEPTANCE IS PENDING**: a single step remains — configure a real `OPENROUTER_API_KEY` (root `.env`, gitignored), then re-run
  `pnpm factory blueprint build .factory/intelligence/20260831T224728Z-32ddb4c4/site-intelligence.json <request.json> <research.json>`
  from the repo root on a clean committed tree. Per mission §65, any functional code change after a successful acceptance will require a new SHA + fresh QA + fresh acceptance.

## H. Site shell gap

`docs/handoffs/site-shell-gap.md` — verified: hard-coded `Summit Roofing Co.` identity (Layout + duplicated `SITE_TITLE_SUFFIX` in the control plane), demo nav/footer, no nav registration, `benefits` without a component, no sitemap/robots/og:image, QA coupled to demo strings. Conclusion: a `SiteProfile`/`SiteShell` configuration primitive is the proven prerequisite before a real Sutherland build. Not fixed in this PR.

## I. Full QA

- `pnpm qa` (typecheck → build → Playwright): **PASS** — 3 packages typecheck clean; Astro build clean; factory unit tests **372/372** (65 new: contract, validation, driver, gateway, eval-harness, prompt, module-policy); starter Playwright **8/8** (2 task-page skips by design).
- PostgreSQL 18 persistence acceptance: **19/19 PASS** (test DB credentials re-synced from the running container; no schema migrations required — Blueprint v0 makes no DB writes).
- No new runtime dependencies introduced (plain `fetch`; zod remains contracts-only).

## J. Self-QA

- **P0 = 0** (no credential leakage — scrubbing test-verified; no trust-boundary bypass — inert DATA + no-tools execution + deterministic backstops, test-verified; untrusted input cannot alter model policy, budgets, schema, or filesystem).
- **P1 = 0** (IA mutation rejected — test-verified; invalid provenance rejected; missing/extra plan pages rejected; readiness bypass impossible; model identity + fallback always recorded; no silent fallback; Auto Router forbidden by code; no existing-behavior regression — full suite green).
- **P2 (accepted, documented)**: operator-designated champions pending Factory bake-off confirmation; exact OpenRouter model ids pending live verification; design bake-off not executed; real acceptance pending credentials.

## K. PR / CI

- Base: `main` · Candidate: `feat/autonomy-v0-site-blueprint` @ commit recorded in the PR head.
- PR: opened frozen (no merge by this agent). CI: `pnpm qa` on the exact PR head SHA — status recorded on the PR (required: exact checked-out SHA == candidate SHA).

## L. Next proven bottleneck

**SiteProfile / SiteShell configuration primitive** — evidenced by `site-shell-gap.md`: the accepted blueprint (and any real Sutherland build) cannot become a coherent site while brand identity, navigation, title suffix, and QA identity are hard-coded to the Summit Roofing demo. It is the smallest capability that unblocks Grounded ContentBundle and blueprint→task compilation.

## M. Deferrals

Sutherland page build; production deploy; International Realty scope; full content pipeline; image generation; generic workflow engine; multi-site scale infrastructure; Site Shell implementation; SiteTask broadening; migrating Intelligence execution off Codex; Unlighthouse/@astrojs/sitemap/schema-dts integration; real-cost bake-off runs.

## N. Final verdict

```
BLOCKED — REAL SUTHERLAND BLUEPRINT ACCEPTANCE PENDING REAL OPENROUTER CREDENTIALS
(all other Autonomy v0 phases complete: gateway, policy, blueprint contract/module,
eval harness, base plan, deterministic tests, full QA, PostgreSQL acceptance;
PR frozen for independent QA)
```
