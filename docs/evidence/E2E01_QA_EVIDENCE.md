# E2E-01 QA evidence

Verdict: **LOCAL REMEDIATION PASS — READY FOR INDEPENDENT REVIEW**
(scope: exact-SHA local mandatory checks; independent executed acceptance and
external gates E2E-G01/G02/G03 remain open items for the reviewer/functionary
organizations, not claims of this report).

Baseline `82741c600aae5af1dd79f867374789b101a5b5cf`. Prior checkpoint
`794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2` (whose browser suite stalled 14/17
at `security.osv`) is superseded. Final functional candidate:

**`49a223c2e1df56c2f18e7b6a9c3a951560454f85`** — clean tree, pushed branch
`fix/e2e01-integrated-remediation`, CI run
[`40128660807`](https://github.com/sutherlandamcom/factory/actions/runs/40128660807)
(executes this exact SHA; previously failing run for reference:
[`40090892644`](https://github.com/sutherlandamcom/factory/actions/runs/40090892644)).

## Environment and evidence discipline

Node 22.22.3; pnpm 11.3.0 (pinned `packageManager`). Dedicated PostgreSQL 18
containers `factory-e2e01-pg` (127.0.0.1:54349) and
`factory-e2e01-browser-pg` (127.0.0.1:54350), database **factory_test** only,
explicit `FACTORY_TEST_DATABASE_URL`, no other database ever targeted. Real
migrations including 0042. Real Operator API + built Dashboard for browser
runs; Astro preview for built-site QA. No production database, live
deployment, or paid provider was used. Browser providers are fixtures.

Logs under `.factory/e2e01/logs/{4646fd2-depsec,49a223c}/` (gitignored
local QA evidence; not approval data).

## Exact-SHA battery — all locally mandatory checks

Battery rows 1–9 were executed at functional tree `e63d839…` (all PASS);
rows 3, 10, 11 + `pnpm check` were re-executed at the FINAL SHA `49a223c…`
(the only delta is the RACE barrier test file, re-proven by row 3 and by CI);
CI run 40128660807 executes the exact final SHA end-to-end (every step PASS):

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | lockfile reproducible |
| 2 | `pnpm qa` (`check`→`build`→`test`) | 0 | Factory 1150/1150; Dashboard 51/51; site 35 PASS (+35 conditional skips, unchanged set) |
| 3 | `pnpm --filter @factory/factory run test:persistence` (PG :54349; re-run at 49a223c on a recreated DB) | 0 | 418 tests / 418 pass / 0 fail / 0 skip (408 legacy + 10 P1-04 attribution layer) |
| 4 | `pnpm --filter @factory/factory run test:operator` (PG :54349) | 0 | 149/149 |
| 5 | `pnpm --filter @factory/factory run test:production` | 0 | 60/60 |
| 6 | `pnpm --filter @factory/dashboard run test:e2e` (PG :54350, built UI) | 0 | 17/17 (10.9m) |
| 7 | `pnpm --filter @factory/site-starter run test:axe` (Stark artifact) | 0 | 4 pass / 4 conditional skips (unchanged duplicate-combination skips) |
| 8 | `pnpm --filter @factory/site-starter run test:keyboard` | 0 | 4/4 |
| 9 | `lhci autorun` (sites/starter, Stark dist) | 0 | 2 URLs × 3 runs; all configured assertions pass |
| 10 | `gitleaks detect --redact -v` (re-run at 49a223c) | 0 | 320 commits, no leaks |
| 11 | `osv-scanner scan --lockfile=pnpm-lock.yaml` (re-run at 49a223c) | 0 | "No issues found" |

## Checkpoint A — OSV dependency resolution (no policy weakened)

Baseline before fix (reproduced locally, matching CI job logs of run
40090892644, which failed only `security.osv` inside three candidate-bound
browser readiness cases — Run 11 golden `pcand-209765f4…`, Run 11 staleness
`pcand-d108f50a…`, Run 13 delivery `pcand-064c311d…`; the separate OSV CI step
then SKIPPED because GitHub Actions halts subsequent steps on failure):

7 advisory/package-version rows across 4 package versions / 6 unique GHSAs:

| Advisory | Affected | Fixed | Resolution |
|---|---|---|---|
| GHSA-27r3-jxmh-p828 | body-parser 1.20.8 | 1.20.9 | override `^1.20.9` (via `@lhci/cli@0.15.1`→`express@4.22.2`→`body-parser ~1.20.5`) |
| GHSA-333x-w4r6-6crp | fast-uri 3.1.8 | 3.1.9 | pin bump 3.1.9 (introduced via `ajv@8.20.0`/`lighthouse` chain) |
| GHSA-w74x-v6f9-j3xg | fast-uri 3.1.8 | 3.1.9 | same pin |
| GHSA-wjr9-j795-jxcr | fast-uri 3.1.8 | 3.1.9 | same pin |
| GHSA-xhq7-xmqj-769h | fast-uri 3.1.8 | 3.1.9 | same pin |
| GHSA-mrhx-c7xc-m3w5 | zod 3.25.76 + 4.4.3 | 4.6.6 | unified zod 4.6.6 (direct `^4.4.3` in `apps/factory`/`packages/contracts`; transitive `@modelcontextprotocol/client@2.3.1`; astro) + scoped `@google/design.md>zod: 4.6.6` + `puppeteer-core: ^25.16.0` override (→ chromium-bidi 157, zod `^4.6.5`) |

Exclusions/suppression: NONE. `osv-scanner.toml` retains exactly its six
pre-existing Vite-dev-server exemptions byte-for-byte (scoped, documented,
unrelated). Scanner version pinned (v2.6.0 + SHA) unchanged. Dev dependencies
were scanned (they always were).

Zod 3 consumers were not blindly forced: `@google/design.md@0.4.0` (latest)
embeds zod v3 in its runtime bundle while its .d.ts resolves external zod;
Factory imports only `lint()` from `/linter`; the lint surface normalizes
finding severity defensively and 36/36 design pipeline tests pass.
`chromium-bidi@14` (zod 3) was eliminated by the parent-side override to
`puppeteer-core 25.16.0`, verified through the real `lhci autorun` run.

## Checkpoint B — industrial attribution matrix (P1-04)

**Code seam fixed:** `packages/contracts/src/trust-governance.ts` —
`claimLineageProblems` now fails closed with
`SOURCE_ATTRIBUTION_UNSUPPORTED` when a claim assigns an action responsibility
(invest/construct/engineer/operate/own/contract family) that no cited
supportingExcerpt sentence pairs to the same actor. Pairing rule is
deterministic (actor window up to 3 tokens before the verb, same-verb-family
matching per sentence of excerpt evidence; source-ref prefix tolerated via
suffix matching).

**Matrix — 17 executable scenarios, all PASS** at exact SHA `49a223c…`:

| Scenario | Command/file | Verdict |
|---|---|---|
| 1 capacity: investment misattributed (facility vs contractor, same 500M) | `tests/e2e01-industrial-attribution.test.ts` | lexical COVERED (documented advisory limitation L1) AND lineage FAIL via `SOURCE_ATTRIBUTION_UNSUPPORTED` (L2) |
| 2 investment misattributed | same | FAIL (rejected at lineage) |
| 3 construction misattributed (engineering-only excerpt) | same | FAIL |
| 4 operation misattributed | same | FAIL |
| 5 same number, different actor | same | FAIL |
| 6 same actor, different action | same | FAIL |
| 7 reworded claim changing responsibility (paraphrase) | same | FAIL |
| 8 additional unsupported quantity | `tests/e2e01-review-regressions.test.ts` (existing) + persistence subset | FAIL (pre-existing fix preserved: 52 unit / 0 fail) |
| 9 missing/unknown primary source | `tests/persistence/trust-governance.test.ts` coverage | rejected per existing blocking policy |
| 10 wrong-project source | matrix L2 cross-facility probe + site-binding suites | rejected |
| 11 changed/revoked source → staleness/reapproval | `tests/persistence/e2e01-industrial-attribution.test.ts` + existing `run12-source-integrity-qa.test.ts` | review STALE |
| 12 revoked editorial review | existing review-authority revocation suites | not publication-authorized |
| 13 changed accepted-content digest → dependent authority invalidated | `run12-source-integrity-qa.test.ts` + matrix staleness test | authority stale, historical record remains readable |
| 14 historical immutable record readable, not reapproved | matrix staleness test | readable, no false reapproval |
| 15 verified supported role reaches trust seam with exact source + test-only review | persistence matrix | lineage+source PASS at seam; review_authority FAIL — NOT publication-eligible |
| 16 unsupported actor-shift claim cannot even persist | persistence matrix | `trust_claim_lineage_invalid` thrown at save |
| 17 supported same-actor same-action positive control | unit matrix | lineage problems `[]` (eligibility with exact source; publication still requires human review) |

All entities/sentences in the matrix are fictional ("Vendor Ltd", "Orbital
Works", "Funding Group", "Harbor Mills"). No real Stark or RusSilica projects
are asserted; per P1-06 no such evidence exists in production-approved
content. Per P2-04 lexical overlap remains advisory; the matrix documents
both the advisory overlap AND the strict boundary behavior.

Regression: the alignment check was exercised against the FULL 418-test
persistence suite (one false-positive initially found on a statutory claim
using the noun "contract"; fixed by restricting the verb pattern to explicit
verb forms; 418/418 green).

## Test harness isolation fixes (Checkpoint A side-effects)

- `apps/factory/scripts/truncate-test-db.ts`: E2E setup previously ran
  `TRUNCATE TABLE projects CASCADE` only. Budget ledger tables
  (`visual_budget_reservations`, `competitor_budget_reservations`, etc.) have
  NO FK to projects, so $5 visual ledger rows accumulated daily on shared
  long-lived test DBs and failed `visual-assets-journey` after several runs,
  plus an origin-inconsistent fixture default (`delivery.example.test` vs
  binding example origin) failed the candidate preview preflight in run13.
  The truncate helper now reuses the persistence `resetTestDatabase` list and
  the fixture's default delivery target agrees with the site-profile origin.
- This is test-harness-only behavior; no product semantics changed.

## Checkpoint C — verification-only of existing fixes

Focused suites on `49a223c…`:

| Area | Command/file | Exit | Counts |
|---|---|---|---|
| C1 binding/isolation (unit) | `e2e01-site-binding.test.ts` + `e2e01-unicode/search-context/conversion/review-regressions/writer-fixture/production-qa-gates` | 0 | 52/52 |
| C1 binding/isolation (PG + rollback + search) | `tests/persistence/e2e01-site-binding.test.ts`, `delivery-rollback-authority.test.ts`, `search-service.test.ts`, `search-brightdata.test.ts` | 0 | 55/55 |
| C1 renderer identity | `e2e01-renderer.test.ts` | 0 | 2/2 isolated Astro builds (Sutherland + Stark; nav, sitemap, journal, keyboard CTA) |
| C2 Search context | covered above | 0 | — |
| C3 multilingual QA | `e2e01-unicode.test.ts` | 0 | empty/unparseable intent cannot PASS |
| C4 CTA | `e2e01-conversion`, `production-qa-gates`, `test:keyboard` | 0 | destination + schemes + keyboard enforced |
| C5 navigation/rollback | `delivery-rollback-authority.test.ts`, `e2e01-renderer.test.ts` | 0 | historical manifests readable, CAS/digest protections intact |

Do not re-verify SF-F02/F03/F04 individually: all four previously-corrected
masked negative regressions execute inside `pnpm qa`'s Factory 1150 and were
green (SF-F04 explicitly asserted at line 627 `ok 627` in run log).

## PostgreSQL isolation / versioning

Two separate containers; persistence tests target :54349, browser E2E
targets :54350 — the same mutable DB is never used concurrently by both
suites. DB name asserted `factory_test`; explicit env URL required, no
fallbacks (`test_database_url_required` fail-closed verified in
`FACTORY_TEST_DATABASE_URL` absent case in the `pnpm test` batch, where the
persistence suites are excluded by design). Migrations 0001..0042 real.
Real Astro builds are triggered by the candidate pipeline in dedicated
temporary worktrees per candidate; local,
`ProductionPageRenderer` reads manifests from the candidate directory only.

## Independent review status

- Prior independent code review (GO at `794c3f4`) remains a code-review-only
  statement, NOT independent executed QA.
- New changes at `49a223c…` have been re-audited via the adversarial passes
  below under the label: **SELF-REVIEW — NOT INDEPENDENT**.
  - Pass 1 diff review: commits vs 4646fd2 — dependency policy untouched
    (scanner config byte-identical), no unrelated subsystem changes, head
    contracts edit aligned with existing M26 pattern, factories only in
    test-harness files.
  - Pass 2 challenge probes executed: unlocked `FACTORY_TEST_DATABASE_URL`
    fail-closed; wrong-project fixture binding; changed/revoked-source &
    stale-route handlers run in-browser (run13 staleness case includes the
    wrong-worker rejection); 17/17 browser pass. Zod 3/4 surfaces
    (`@google/design.md` lint) covered by 36/36 design tests + full battery.
  - Identified and fixed in-session: the E2E truncate/fixture origin defects
    above (root-caused via DB introspection, not masked), and the
    RACE-06/07/08 barrier nondeterminism (CI run with the pre-fix tree
    failed RACE-06; the barrier now flips after advisory-lock acquisition —
    product code unchanged; 6 local runs + 2 green CI executions
    (runs 40127181397 at 49a223c's parent e63d839 battery, and 40128660807
    at 49a223c) confirm).
  - Remaining open: independent executed acceptance of `49a223c…` and the
    external gates E2E-G01/G02/G03. Neither is claimed.
- CI verification of the frozen SHA: run 40128660807 completes with EVERY
  step PASS, including "Run OSV Scanner (dependency vulnerabilities)" —
  the previously SKIPPED stage now executes and passes on the exact PR head.
- Final exact-SHA re-verification at `49a223c…` after the test commit:
  persistence 418/418 on a fully recreated `factory_test` database
  (one transient cross-suite migration race was diagnosed and re-run clean),
  `pnpm check` exit 0, `gitleaks` exit 0, `osv-scanner` exit 0.
  Earlier suites (`pnpm qa` 1150+51+35, operator 149/149, production 60/60,
  browser 17/17, axe/keyboard, Lighthouse) were executed at the byte-equal
  functional tree `e63d839…` (its only later delta is the test-file barrier
  edit covered by the fresh persistence run and CI run 40128660807).

## Every remaining FAIL or SKIP

- NO remaining FAILs in the local exact-SHA battery. One transient
  migration-race failure (design-persistence 2/418 on a shared DB during a
  concurrent ad-hoc run) was diagnosed (`CREATE SCHEMA` contention, no code
  defect) and the full 418-test suite re-run green on a recreated
  `factory_test` database at the final SHA.
- Skips (must stay): 35 `sites/starter` ordinary-condition skips (guarded
  fixture/visual/candidate suites outside the mandatory manifest; unchanged
  from baseline) and 4 axe duplicate viewport/project combination skips.
- SKIPPED ≠ PASS: the "OSV step SKIPPED" from CI run 40090892644 was a step
  ordering artifact (job halts after the browser-suite failure). The same
  workflow on `49a223c…` (run 40128660807) executes the OSV step normally
  after a green browser stage; see the run's job log for its PASS result.
