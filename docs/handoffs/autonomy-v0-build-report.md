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

## D. Real model bake-off (COMPLETED — Factory-executed, real cost)

Factory executed real GPT/Claude/Gemini bake-offs on the real Sutherland inputs with pinned candidates (`openai/gpt-5.6-sol`, `anthropic/claude-opus-5`, `google/gemini-3.7-flash` — all verified AVAILABLE via authenticated gateway discovery), identical prompts, schemas, and accepted deterministic gates, and a blind two-judge rubric:

| Role | Eval runs | Deterministic results | Judge rubric (blind) | Winner |
|---|---|---|---|---|
| `site_intelligence` | `eval-20260901T104549Z-12c450c6` (pre-fix), final `eval-20260901T110515Z-b8d52c71` | gpt-5.6-sol PASS both; claude-opus-5 PASS then FAIL (markdown-fenced output — zero-salvage production contract); gemini-3.7-flash PASS both | 5.00 gpt / 4.80–4.40 claude / 2.40–3.20 gemini; final run 2/2 judge votes → gpt | **`openai/gpt-5.6-sol`** |
| `blueprint_architect` | `eval-20260901T105050Z-f4e79061` (pre-fix), final `eval-20260901T111010Z-c12b0864` | gpt-5.6-sol PASS both (only candidate valid in both); claude-opus-5 FAIL both (run 1: 300s harness artifact — since fixed; run 2: 32k-token completion truncation — the real production envelope); gemini-3.7-flash FAIL then PASS | run-2 judges unavailable (gateway HTTP 402 credit exhausted mid-run); run-1 judge preferred gpt (4.6) | **`openai/gpt-5.6-sol`** (deterministic-first decision; judges secondary) |

Harness corrections made from run-1 evidence (commit `aa01831`): candidates now run under the evaluated role's policy timeout (blueprint/intelligence 600s, not 300s), and the judge parser strips a single markdown fence before the STRICT verdict parse (eval-only; production synthesis keeps zero salvage).

Champion decision: `site_intelligence` and `blueprint_architect` champions are **FACTORY-EVAL-CONFIRMED** as `openai/gpt-5.6-sol` (challenger order: `anthropic/claude-opus-5`, then `google/gemini-3.7-flash`). This CHALLENGED and replaced the operator's provisional claude-opus-5 designations for both planning roles (functional policy change, commit `24889b3`). `content_writer`/`content_critic`/`design_director` remain OPERATOR-DESIGNATED (no Factory bake-off run yet). Future-role designations (research extraction → gemini-3.7-flash; competitor analysis & visual critic → gpt-5.6-sol; cheap repair → z-ai/glm-5.3-flash; image generation → gpt-image-2; Claude-Code code worker = separate future decision) are recorded in policy comments.

## E. SiteBlueprint contract (`packages/contracts/src/site-blueprint.ts`, strict Zod, unknown fields fail closed)

- Site level: `positioningSummary`, `primaryAudience`, `navigation[]` (targets validated), `primaryConversionGoal`, optional bounded `designDirection` (visualCharacter, density, typographyMood, colorMood, imageryPolicy, ctaTreatment).
- Page level: identity triple (`type`/`slug`/`primaryTopic` — exact-match to the accepted plan), `pageRole`, `audience`, `intent`, `seoTitle` (search-facing) distinct from `h1` (visible), `metaDescription`, `purpose`, `businessGoal`, `userQuestions[]`, `objections[]`, `sections[]`, `internalLinks[]`, `structuredDataType` (coherence with page type enforced), `readiness` (`ready | missing_operator_input | insufficient_evidence | blocked`), `missingInputs[]`.
- Section level (`PageSectionBlueprint`): unique `id`, `componentType` restricted to the real component registry (hero, feature_cards, content_section, faq, cta — no invented UI), `purpose`, `heading` job, `keyPoints[]`, `evidenceIds[]` + `operatorFactIds[]` (SECTION-level provenance), `prohibitedClaims[]`, `visualRequirement {required, purpose, kind}` (required ⇒ purpose+kind; not-required ⇒ neither), optional `cta {role, job}` (jobs, never URLs).
- Readiness is mandatory and honest: ready ⇒ ≥1 section and zero missingInputs; non-ready ⇒ missingInputs required. No image is preferable to a useless image; charts demand metric-bearing evidence or a readiness downgrade.

## F. Deterministic validation (all fail-closed, all test-covered)

IA preservation (page-set equality; no add/delete/retype/reslug/re-topic/intent-change), duplicate slug/section-id rejection, evidence/fact reference resolution (research ids ≠ operator-fact ids namespace), section coverage mapping (every plan section type realized; no invented structure; `benefits` → feature_cards/content_section), keyPoint provenance rule for ready pages, chart-without-metric-evidence rejection, internal-link and navigation integrity (targets exist in the accepted plan, no self-links), readiness/missingInputs consistency, structured-data coherence, payload bounds, unknown-field rejection. The incoming base plan must itself pass the accepted Intelligence gates before any model work (defense in depth; test-verified).

## G. Real Sutherland blueprint acceptance

- **Base plan**: produced by the accepted Factory Intelligence pipeline on the real discovery request + research — runId `20260831T224728Z-32ddb4c4`, status `succeeded`, 1 attempt, 8 pages (homepage, 4 services, 2 general market-intelligence, 1 article), planDigest `c340baa4…9d79`, honest warnings. Source provenance bound to `9d59db5`.
- **Real acceptance run** `20260901T101437Z-2cdf01eb` @ clean tree `f374b2b…` (pre-policy-change champion `anthropic/claude-opus-5`): status `succeeded`, 2 attempts, no fallback, provider `Anthropic`, 58,596 tokens / $0.86652 (accepted invocation), blueprintDigest `fd13d58a…e4fc`; IA preserved exactly; all 8 pages honestly `missing_operator_input` with 7 site-level operator-input demands; the model removed two planned charts because cited records carried no reusable observed metrics (P1-A semantics in action). Manifest digests verified; zero credential leakage.
- **Fresh exact-SHA acceptance at the FINAL candidate** (post-bake-off policy, champion `openai/gpt-5.6-sol`): executed on a clean committed tree at the frozen final SHA; result (runId, provenance, cost) recorded in the PR #10 thread and in gitignored `.factory/blueprint/` artifacts. Acceptance requirement: `factorySourceCommit == FINAL_CANDIDATE_SHA` and `status == succeeded`.

## H. Site shell gap

`docs/handoffs/site-shell-gap.md` — verified: hard-coded `Summit Roofing Co.` identity (Layout + duplicated `SITE_TITLE_SUFFIX` in the control plane), demo nav/footer, no nav registration, `benefits` without a component, no sitemap/robots/og:image, QA coupled to demo strings. Conclusion: a `SiteProfile`/`SiteShell` configuration primitive is the proven prerequisite before a real Sutherland build. Not fixed in this PR.

## I. Full QA

- `pnpm qa` (typecheck → build → Playwright): **PASS** — 3 packages typecheck clean; Astro build clean; factory unit tests **380/380**; starter Playwright **8 passed** (2 task-aware skips by design).
- PostgreSQL 18 persistence acceptance: **19/19 PASS** (no schema migrations — Blueprint v0 makes no DB writes).
- No new runtime dependencies (plain `fetch`; zod remains contracts-only).

## J. Self-QA

- **P0 = 0** · **P1 = 0**
- **P2 (explicit)**: gateway `.env` fallback is cwd-dependent (`pnpm factory` runs from `apps/factory`; operators export the env var — fail-closed direction); content_writer/content_critic/design_director champions remain operator-designated pending Factory bake-offs; blueprint bake-off run-2 judges were lost to gateway credit exhaustion (deterministic-first decision stood without them); the real claude-opus-5 acceptance blueprint (run `20260901T101437Z-2cdf01eb`) remains valid evidence for the superseded champion binding `f374b2b`; Colima VM stop event mid-session (test DB container recreated identically).

## K. PR / CI

- Base: `main` @ `9d59db5` · Branch head: the frozen final candidate SHA.
- CI on the exact head SHA: run `33496128917` (f374b2b) and the final-head run recorded on the PR — verified `CHECKED_OUT_SHA == head SHA`, conclusion success.
- PR frozen; no merge by the authoring agent.

## L. Next proven bottleneck

**SiteProfile / SiteShell configuration primitive** — evidenced by `site-shell-gap.md`: the accepted blueprint (and any real Sutherland build) cannot become a coherent site while brand identity, navigation, title suffix, and QA identity are hard-coded to the Summit Roofing demo. It is the smallest capability that unblocks Grounded ContentBundle and blueprint→task compilation.

## M. Deferrals

Sutherland page build; production deploy; International Realty scope; full content pipeline; image generation; generic workflow engine; multi-site scale infrastructure; Site Shell implementation; SiteTask broadening; migrating Intelligence execution off Codex; Unlighthouse/@astrojs/sitemap/schema-dts integration; real-cost bake-off runs.

## N. Final verdict

```
AUTONOMY V0 COMPLETE — FROZEN FOR FINAL INDEPENDENT QA
(factory-executed multi-model bake-off evidence recorded; champions
factory-eval-confirmed for both planning roles; fresh exact-SHA blueprint
acceptance bound to the frozen final candidate)
```
