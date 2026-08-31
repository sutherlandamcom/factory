# First-Site Intelligence Vertical Slice — Build Report

## A. Starting state

- Authoritative main: `sutherlandamcom/factory` `origin/main`
- Accepted base SHA: `2864b6f877b6949c71983033273aaa2b2d877283` (verified via `git fetch` + `git rev-parse origin/main` before implementation; unchanged through the build)
- Working branch: `feat/first-site-intelligence-vertical-slice`
- Repository clean: YES (only gitignored runtime/journal paths)
- Production Delivery modified: **NO** (`git diff base..HEAD -- apps/factory/src/delivery sites/starter/wrangler.jsonc` is empty)

## B. Architecture

- **SiteIntelligenceRequest**: strict Zod v4 contract (`packages/contracts/src/site-intelligence.ts`), `.strict()` throughout; bounds per spec §11 (request ≤ 64 KB, serviceSeeds 1..20, operatorFacts ≤ 30 × 1000 chars, maxInitialPages 3..20, …); documented deterministic duplicate rejection (`normalizeScalarText`: trim → lowercase → collapse whitespace).
- **ResearchEvidenceBundle**: strict, kinds `keyword_observation|serp_observation|competitor_page|market_observation` only (`operator_fact` deliberately excluded); items 1..200 × ≤ 4000 chars; bundle ≤ 512 KB; observed-only optional metrics (finite, non-negative, `position ≥ 1`); http/https-only `sourceUrl` ≤ 2048; duplicate ids rejected.
- **Operator fact trust model**: FACT-AUTHORITATIVE / INSTRUCTION-UNTRUSTED (usable as business claims; never rules, tools, budgets, or schema changes).
- **Research trust model**: FACT-UNTRUSTED / INSTRUCTION-UNTRUSTED; evidence is inert data; evidence URLs are never fetched.
- **Normalization**: non-destructive (`apps/factory/src/intelligence/normalize.ts`) — originals preserved verbatim; additive `normalizedUrl` (lowercase scheme/host, default ports, trivial root slash only) and `duplicateOf` (single level, must resolve); stable sort by evidence id.
- **Methodology version**: `first-site-intelligence-v0` (single constant).
- **Model synthesis**: reused accepted `createCodexRunner` (Colima `factory-sandbox` → hardened worker → inner Codex sandbox) with a new `workspaceWritable` mode mounting the throwaway Intelligence workspace as one writable root (validated inputs + prompt + output only). No second auth flow, no second sandbox, no host fallback.
- **Plan contract**: `SiteIntelligencePlan` (strict) — marketSummary / audiences ≤ 8 / competitorInsights ≤ 20 / keywordClusters ≤ 30 / pages / warnings; planned pages reuse the shared SiteTask page invariant helper.
- **Quality gates** (`plan-validation.ts`): exactly one homepage, budget ≤ maxInitialPages, unique slugs, globally distinct normalized primary topics, article/service topic separation, must-cover representation, service-topic support (seeds/must-cover/operator facts/referenced evidence), rationale ≥ 20 chars, provenance required + all references resolvable, fabricated-metrics rejection (metric values must appear verbatim in cited evidence metrics).
- **Repair loop**: Intelligence-specific max 3 attempts; repair prompt = rules + previous raw output (bounded) + deterministic issues; identical raw OR identical canonical content over an invalid attempt → `intelligence_no_progress` early stop; 3 failures → `intelligence_attempts_exhausted` + `needs_review`. Global `MAX_TOTAL_ATTEMPTS = 3` untouched.
- **SiteTask compiler**: deterministic order (homepage → services → articles; priority `high→medium→low`, slug tie-break); emits only current `create_page` fields; every task through canonical `parseSiteTask`; Intelligence-only fields never leak.
- **IntelligenceResult**: strict dedicated contract (`succeeded|failed|needs_review`, runId, siteId, factorySourceCommit, methodologyVersion, digests, attemptCount, modelRuntime, run-relative artifacts, taskCount, warnings, sanitized error).
- **Artifacts**: `.factory/intelligence/<runId>/` — pattern-validated runIds, fresh-dir refusal, symlink-refusing publication, traversal-rejecting paths, byte-level manifest integrity verification + plan canonical-digest binding, temp-file → rename, definitive result LAST.
- **CLI**: `pnpm factory intelligence build <request.json> <research.json>` — reads exactly the two supplied files, emits ONE `IntelligenceResult` JSON on stdout, diagnostics on stderr, exit 0 only for `succeeded`.
- **PostgreSQL dependency: NO.**

## C. Module policy

- `site-intelligence` registered: YES (`apps/factory/src/intelligence/`)
- protected: YES; ordinaryTaskWritable: NO
- create_page write authority unchanged: YES (exact page path only; regression-asserted in `module-policy.test.ts` and `isolation.test.ts`)

## D. Provenance (exact-candidate acceptance run)

- factorySourceCommit: `72ab42d8898f39d5132434a751a0b2aa50764b4b` (verified equal to frozen candidate)
- methodologyVersion: `first-site-intelligence-v0`
- requestDigest: `20306fbbec4133fe…` (full 64-hex in artifacts)
- researchDigest: `3b0c17827da65926…`
- planDigest: recorded per run (e.g. `460660a804b2…` in the exact-candidate run)
- Codex version: `codex-cli 0.150.1`
- Actual model identifier: `null` — codex-cli 0.150.1 `exec --json` events (`thread.started`) do not expose a model identifier; recorded truthfully as null and documented here rather than invented.
- Provenance limitations: model identifier unavailable from the accepted runtime's event stream; dirty working tree is surfaced as a warning; factorySourceCommit is mandatory (run fails without it).

## E. Security

- Prompt-injection defense: inert-DATA rule + mechanical separation; hostile-string tests (§15 list) prove data stays data; authority fields are mechanically derived.
- Model repository write access: NONE (throwaway workspace only; no repo mounts).
- Model host HOME access: NONE (HOME=/tmp/home tmpfs).
- Model Docker socket access: NONE (no socket mounts; args asserted).
- Model network access: inner tool/shell network disabled (`sandbox_workspace_write.network_access=false`); no network primitives in module source (static test).
- Cloudflare secrets exposed: NO (env allowlist + container-arg tests).
- DB secrets exposed: NO (`FACTORY_DATABASE_URL`, `DATABASE_URL`, `PGPASSWORD` excluded; module imports no persistence code).
- Research credentials exposed: NO (research is data; provider credentials are not request fields).
- Artifact traversal protection: `resolveWithinRunDirectory` + runId pattern + absolute-path rejection (tested).
- Symlink protection: intelligence root and run dir must be real non-symlink dirs; artifact writes refuse symlinks; atomic publish replaces symlinks rather than writing through (tested).
- Workspace cleanup: `finally` on every outcome including timeout and model failure (tested).

## F. Files changed (33 files, +4762/−49)

- `packages/contracts/src/site-intelligence.ts` — all Intelligence contracts + parse helpers + error codes.
- `packages/contracts/src/site-task.ts` — extracted shared `addSitePageInvariantIssues` (behavior-identical refactor, reused by planned pages).
- `packages/contracts/src/index.ts` — exports.
- `apps/factory/src/intelligence/{digest,normalize,prompt,plan-validation,compile,artifacts,synthesis,driver,index}.ts` — the module.
- `apps/factory/src/executor/codex.ts` — `--skip-git-repo-check` + optional `workspaceWritable` mount mode (SiteTask default layout unchanged, regression-asserted).
- `apps/factory/src/executor/module-policy.ts` — `site-intelligence` module registration.
- `apps/factory/src/index.ts` — `intelligence build` command.
- `apps/factory/tests/intelligence-*.test.ts` (10 files) + `intelligence-fixtures.ts` + fixtures — 121 new tests.
- `apps/factory/tests/{isolation,module-policy}.test.ts` — regression assertions for the executor layout change and the new module.
- `README.md`, `docs/architecture.md` — documentation.
- `.gitignore` — ignore local agent tooling `/.kilo/`.

## G. Deterministic tests (new: 121; total factory: 267 pass / 0 fail)

request contract (19) · research contract (23) · normalization (8) · plan validation + product quality (23) · prompt/injection (5) · compilation (5) · atomic artifacts (8) · model output + repair matrix (16) · security (6) · provenance (7) · module policy (+2). URL provenance covered in normalization tests; stale artifact handling in artifacts + model-output suites.

## H. Full QA

- `pnpm install --frozen-lockfile`: clean.
- `pnpm qa` (tsc + astro check + build + factory tests + Playwright): **PASS** (exit 0; Playwright 8 passed / 2 pre-existing skips).
- Persistence not touched → persistence suite not invalidated (CI still runs it against PostgreSQL 18).
- Result: GREEN.

## I. Exact candidate

- Candidate SHA: `72ab42d8898f39d5132434a751a0b2aa50764b4b` (2 commits on top of base)
- Candidate clean checkout: verified (working tree clean at run time; `git rev-parse HEAD` == candidate)
- factorySourceCommit recorded by runtime: `72ab42d8898f39d5132434a751a0b2aa50764b4b` (exact match — acceptance passed)

## J. Real isolated Intelligence acceptance

- Run ID: `20260831T114133Z-cefa07c1` (artifacts: `.factory/intelligence/20260831T114133Z-cefa07c1/`, gitignored)
- Exact candidate SHA: `72ab42d8898f39d5132434a751a0b2aa50764b4b` — PROVENANCE MATCH
- Real Codex: YES (real auth, real model turn; codex-cli 0.150.1)
- Strong isolation: PASS (dedicated `factory-sandbox` Colima VM + hardened worker + inner sandbox; one recoverable environment issue resolved first: a leftover `factory-smoke-postgres` container in the profile was stopped — no isolation weakened)
- Request fixture: `apps/factory/tests/fixtures/intelligence/summit-roofing.request.json` (synthetic, clearly marked)
- Research fixture: `apps/factory/tests/fixtures/intelligence/summit-roofing.research.json` (24 synthetic records incl. an explicit prompt-injection trap)
- Model attempts: 2 (attempt 1 rejected by deterministic gates; attempt 2 valid — bounded repair proven in production)
- Digests: request `20306fbbec4133fe…`, research `3b0c17827da65926…`, plan `460660a804b2…`
- Pages planned: 5 (budget 5)
- Homepage: `/` — "Denver Roofing Contractor | Summit Roofing LLC" (commercial_investigation)
- Services: `/services/emergency-roof-repair`, `/services/gutter-installation`, `/services/roof-replacement` (transactional)
- Articles: `/blog/repair-or-replace-roof-after-hail` (informational)
- Compiled tasks: 5 (`tasks/001-homepage.json` … `tasks/005-article-…json`), homepage first, deterministic order
- All parseSiteTask: PASS (enforced by compiler; taskCount 5)
- Artifact result status: `succeeded` (published last, atomically; manifest integrity verified)
- Temp workspace cleaned: YES
- Repository clean: YES
- Result: **ACCEPTANCE PASS**

Earlier real runs against the first candidate (`dda7e82…`) surfaced two genuine defects — Codex's git-repo trust check rejecting the non-git workspace, and bubblewrap's non-recursive workspace re-bind shadowing the nested writable mount (model could not write `output/plan.json`). Both were repaired generally (`--skip-git-repo-check` + `workspaceWritable` mount mode), regression-tested, and the candidate was re-frozen; the acceptance above ran against the NEW exact SHA. The first candidate's real run (5-task success, 1 attempt) additionally demonstrated the single-attempt path end to end.

## K. Product-quality review (exact-candidate run)

- Distinct page intents: homepage commercial_investigation; services transactional; article informational — no cannibalization.
- Service coverage: all three serviceSeeds covered (emergency roof repair, gutter installation, roof replacement); mustCover satisfied.
- Article differentiation: "Choosing roof repair or replace after hail" is a decision-stage informational page distinct from every service topic.
- Evidence quality: every page/cluster/insight references semantically sensible fixture evidence; competitor insights are pattern summaries, not copied prose.
- Fabricated metrics: NONE — all cluster metrics match cited evidence verbatim (8100/11.2/42, 5400/9.8/38, 2900/7.4/31, 1600/8.9/27, 720/5.1/19).
- Unsupported facts: none elevated; warnings explicitly refuse unsupported 24/7 and outcome claims.
- Warnings/uncertainty: 5 actionable warnings; uncertainty notes flag synthetic data and unverified competitor claims — honest confidence.
- Overall usefulness: the plan is directly usable to build the first real site (topics, slugs, titles, descriptions, sections, rationales, provenance all actionable).
- Verdict: product-quality PASS (no P1 methodology defect).

## L. Self-adversarial QA

- P0: 0
- P1: 0
- P2:
  1. Model identifier not exposed by codex-cli 0.150.1 events → recorded as `null` (documented limitation, truthful).
  2. `needs_review`/`failed` runs publish no `intelligence-result.json` file (result is on stdout; artifacts remain honest partial evidence) — by design per §42.
  3. Attempt evidence caps codex stdout/stderr at 64 KB (raw plan itself is always fully persisted separately).

Defects found and remediated during the build (both invalidating the first candidate):
- Finding: real Codex run failed with `intelligence_isolation_unavailable` (leftover smoke container) → root cause: profile busy → fix: stopped the disposable container; no code change.
- Finding: Codex refused non-git workspace → root cause: interactive trusted-directory check → fix: `--skip-git-repo-check` + regression assertions → new candidate SHA.
- Finding: model could not write output file → root cause: bubblewrap non-recursive re-bind shadowing nested rw mounts → fix: `workspaceWritable` single-rw-root mount for the throwaway Intelligence workspace + SiteTask layout regression assertions → new candidate SHA `72ab42d…` + full re-acceptance.

## M. PR / CI

- PR: #7 (`feat(intelligence): add first-site intelligence vertical slice`)
- Final candidate SHA: `72ab42d8898f39d5132434a751a0b2aa50764b4b` (PR head verified equal)
- Exact candidate CI run: GitHub Actions run on PR #7 head `72ab42d…` (SHA verified via `gh run list`, not branch name)
- CI head SHA: `72ab42d8898f39d5132434a751a0b2aa50764b4b`
- CI conclusion: recorded in the final session report (PASS required before handoff)

## N. Independent QA

- Available: NO (single-agent session; no genuinely separate QA process exists in this environment)
- Status: **PENDING INDEPENDENT QA** — the candidate is frozen; the builder will not modify it during independent review.

## O. Deferrals (confirmed)

DataForSEO: deferred · Firecrawl: deferred · live crawler: deferred · SERP acquisition: deferred · research DB: deferred · keyword warehouse: deferred · vector DB: deferred · RAG: deferred · dashboard: deferred · workflow engine: deferred · provider framework: deferred · Production Delivery changes: NONE.

## P. Final verdict

IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA
