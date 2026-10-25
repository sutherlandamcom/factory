# E2E-01 QA evidence

Verdict: **LOCAL REMEDIATION PASS — READY FOR INDEPENDENT REVIEW**
(scope: exact-SHA local mandatory checks; independent executed acceptance and
external gates E2E-G01/G02/G03 remain open items for the reviewer/functionary
organizations, not claims of this report).

Baseline `82741c600aae5af1dd79f867374789b101a5b5cf`. Superseded checkpoints:
`794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2` (14/17 browser) and
`49a223c2e1df56c2f18e7b6a9c3a951560454f85` (CI run
[`40128660807`](https://github.com/sutherlandamcom/factory/actions/runs/40128660807)
— EN-only attribution matrix, overstated wrong-project claim; kept as
historical evidence). Final functional candidate:

**`789b645b17760f91c3e3ce1fedada3b806da1318`** — clean tree, on branch
`fix/e2e01-integrated-remediation` (parent `85259f8a409b4ba9aab9a91c57d13576e9116ee3`,
whose CI run [`40134277879`](https://github.com/sutherlandamcom/factory/actions/runs/40134277879)
is green; the NEW candidate's own CI run is verified and cited in the PR
description).

## Environment and evidence discipline (current candidate)

Node 22.22.3; pnpm 11.3.0 (pinned `packageManager`). Dedicated REAL isolated
PostgreSQL 18.6 cluster (Postgres.app, fresh `initdb` datadir, port 5433),
database **factory_test** only, explicit `FACTORY_TEST_DATABASE_URL`
(`postgresql://factory:...@127.0.0.1:5433/factory_test`), name-guard
fail-closed honored. Real migrations including 0042. Real Operator API +
built Dashboard for browser runs; Astro preview for built-site QA. No
production database, live deployment, or paid provider was used. Browser
providers are fixtures.

## Exact-SHA battery at `789b645…` (every row executed at this tree)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` (unchanged lockfile) | 0 | reproducible |
| 2 | `pnpm check` | 0 | workspace clean |
| 3 | `pnpm qa` | 0 | Factory 1167/1167; Dashboard 51/51; site 35 pass + 35 conditional skips (unchanged skip set) |
| 4 | `test:persistence` (real PG18 :5433) | 0 | **467/467** (408 legacy + 10 EN attribution + 2 RU-PG + 6 XP cross-project + re-imported unit matrix & helpers) |
| 5 | `test:operator` | 0 | 149/149 |
| 6 | `test:production` | 0 | 60/60 |
| 7 | dashboard `test:e2e` (built UI, PG :5433) | 0 | 17/17 (Run 11 READY_FOR_DEPLOYMENT; Run 13 preview/approve/publish/rollback incl. expected test-only `permission_denied` boundary; Stark fixture journey `design_approval_failed`) |
| 8 | site `test:axe` | 0 | 8 pass + 8 duplicate-combination skips (unchanged) |
| 9 | site `test:keyboard` | 0 | 8/8 |
| 10 | `lhci autorun` | 0 | 4 URLs × 3 runs; all configured assertions pass |
| 11 | `gitleaks detect --redact -v` | 0 | 328 commits, no leaks |
| 12 | `osv-scanner scan --lockfile=pnpm-lock.yaml` | 0 | "No issues found"; `osv-scanner.toml` byte-identical to parent (6 pre-existing Vite-dev-server exemptions only) |

## Checkpoint D — P1-04 closure update (RU attribution + cross-project ownership)

**Language-coverage fix (`packages/contracts/src/trust-governance.ts`):**
the action recognizer now covers Russian多大的 industrial vocabulary keyed to
the same six family IDs: inflected past/present verbs (инвестировал/вложил/
финансировал; построил/строил/возвёл/соорудил/модернизировал;
спроектировал/проектировал/инжиниринг/проектирование;
эксплуатирует/обслуживает; владеет/принадлежит; общесоюзный срок determined
выполнил/подряд/несёт ответственность), composed predicate reclassification
(«выполнило инженерное проектирование» ⇒ engineer family), negation guard
(«не <verb>» can never pair as support), intent/tense classes (planned/
future evidence cannot authorize completed past facts), legal-entity prefix
gluing («ООО ИнжПроект»), bounded object binding via the post-verbal quoted
facility name (wrong-facility attribution with quoted objects rejects), and
per-excerpt evidence isolation with bounded unpunctuated fragments (no
cross-source sentence fusion). English path unchanged (full legacy matrix
and 408-test legacy persistence regress clean).

**RED→GREEN evidence:** 13/13 strict negative RU probes failed first with
`got: []` (EN-only matcher blind) and turned green only after the
implementation; RU-06/RU-12 positive controls and the numeric seam RU-09
passed before implementation unchanged.

**Matrix at `789b645…`:**

| Scenario | File | Verdict |
|---|---|---|
| RU-01 investor misattribution (500M) | unit matrix | FAIL `SOURCE_ATTRIBUTION_UNSUPPORTED` (invest/ИнжПроект) |
| RU-02 construction claimed from engineering-only excerpt | unit matrix | FAIL (construct family, composed-predicate semantics) |
| RU-03 operation misattributed | unit matrix | FAIL (operate) |
| RU-04 ownership misattributed | unit matrix | FAIL (own) |
| RU-05 investment misattributed | unit matrix | FAIL (invest) |
| RU-06 faithful engineering claim | unit matrix | PASS ([]) positive control |
| RU-07 source names another builder (passive «был построен ПромСтрой») | unit matrix | FAIL (changed actor) |
| RU-08 same actor+action, PLANT B object | unit matrix | FAIL (object binding Орбита≠Спектр) |
| RU-09 unsupported 900M figure | unit matrix | FAIL (numeric seam) |
| RU-10 passive wording, wrong company claims responsibility | unit matrix | FAIL |
| RU-11 mixed RU/EN entity names | unit matrix | FAIL |
| RU-12 inflected verbs, legitimate actor/action | unit matrix | PASS ([]) positive control |
| RU-13 source negation «не строило» | unit matrix | FAIL (negation guard) |
| RU-14 future/intent source («планирует построить») | unit matrix | FAIL (intent cannot authorize past) |
| RU-15 ambiguous responsibility phrasing | unit matrix | FAIL |
| RUX-01 cross-excerpt fusion probe | unit matrix | FAIL (fragment isolation) |
| L2x wrong-facility QUOTED object claim | unit matrix | FAIL (object binding; replaces the misleading unquoted-only probe) |
| PG-RU: unsupported RU claim cannot persist | persistence matrix | `trust_claim_lineage_invalid` |
| PG-RU: supported RU engineering claim persists; TEST_ONLY review still not publication-eligible | persistence matrix | lineage/source PASS at seam; review_authority FAIL |

**Cross-project ownership (genuine two-project PostgreSQL suite,
`tests/persistence/e2e01-cross-project-authority.test.ts`):**

| Case | Boundary exercised | Verdict |
|---|---|---|
| XP-01 | A's own evidence inside A | PASS (positive control) |
| XP-02 | A lineage rows unreadable beneath B (`listClaimLineage` project-scoped) | rows empty under B — protection VERIFIED |
| XP-03 | A review not inherited by B (B `currentReview` → null; A remains APPROVED) | protection VERIFIED |
| XP-05 | copied claim text under B does not merge/inherit A rows | protection VERIFIED (per-project rows + each claim judged under its own authority; textual copying alone grants nothing) |
| XP-06 | changed A content digest ⇒ review stale | protection VERIFIED |
| XP-07 | historical A record stays readable, not re-approved | VERIFIED |
| XP-08 | independently accepted B evidence valid inside B | PASS (with its own claim-set digest) |
| XP-03/`()trust`, XP-04 | direct cross-project **audit-event** reuse of VERIFIED_HUMAN authority | covered by pre-existing `cross_project_audit_event_rejected` store check (repo suite, untouched) |

**Honest boundary (corrects the overstated old claim):** an intake-class
`SourceRef` (`ref: "intake:..."`) is a convention string, NOT a persisted
project-owned source-evidence row; Factory does not maintain a generic
persisted source registry for such refs. Cross-project protection provably
lives at: per-project ClaimLineage/Review/Intent rows, digest-bound review
staleness (incl. source-evidence/claim-set digests), and the
`cross_project_audit_event_rejected` guard for human approvals.
Acquisition-bound refs carry `acquisitionEventId` + `acquisitionDigest`
bound to the global TRUSTED_ACQUISITION_REGISTRY — provider-scoped, not
project-scoped (external-world facts). The former unit probe titled
"wrong-project source … still FAILS" asserted `claimLineageProblems(...)===[]`
and never exercised project ownership; it is renamed to the documented
boundary and supplemented by a quoted-object reject case and the XP suite.

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

## Checkpoint B — industrial attribution matrix (P1-04) — SUPERSEDED (historical, EN-only; see Checkpoint D for the current RU+XP state)

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
- **Current state (`789b645…`): `INDEPENDENT QA PENDING`.** New changes
  (RU attribution recognizer + object binding + evidence isolation +
  cross-project XP suite + corrected unit probe) have NOT yet received an
  independent executed review; an adversarial subagent review is executed
  against this exact SHA and its verdict is recorded in the PR description.
  The older `49a223c…` adversarial passes below are historical
  (**SELF-REVIEW — NOT INDEPENDENT**) and do not certify `789b645…`.
- CI verification: the parent commit `85259f8…` has green CI
  (run 40134277879); the candidate's own CI run is verified and cited in
  the PR description before any review verdict references it.

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
