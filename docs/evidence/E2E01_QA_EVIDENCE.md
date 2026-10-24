# E2E-01 QA evidence

Verdict: **REMEDIATION PARTIAL — VERIFIED FIXES, OPEN BLOCKERS**
Baseline `82741c600aae5af1dd79f867374789b101a5b5cf`; first implementation
checkpoint `e841fc800c0808dbc3d8ae0eb114b6f55236fcfc`. Subsequent working-tree
checks below must not be represented as exact-final-SHA acceptance. Final report
updates record the committed functional candidate separately.

## Environment and evidence discipline

Node 22.22.3; existing pnpm and repository dependencies. Dedicated PostgreSQL 18
containers `factory-e2e01-pg` (127.0.0.1:54349) and
`factory-e2e01-browser-pg` (127.0.0.1:54350), database **factory_test** only.
Real repository migrations, including 0042, were used. No production database,
live deployment or paid provider was used. Browser providers are fixtures.

New logs are retained locally under `.factory/e2e01/logs/` (gitignored). Earlier
`/tmp/e2e01-*.log` logs became unavailable after session restoration on October 24;
their observed results below are development evidence, not final-candidate proof.
Screenshot/test artifacts are local evidence rather than durable approval data.

## Observed development checks

| Command / test path | Observed result | Scope / limitation |
|---|---|---|
| `node --import ./apps/factory/node_modules/tsx/dist/loader.mjs --test apps/factory/tests/e2e01-site-binding.test.ts` | 3 PASS | Isolated configuration, not live delivery |
| Same runner, `e2e01-unicode.test.ts` plus Search tests | 25 PASS | Relevant/unrelated Russian and English, empty/mixed input; earlier RED reproduced |
| Same runner, provider/context tests | 13 PASS | Russia gl/hl normalization; no provider request |
| Same runner, conversion and production QA tests | 33 PASS | Paragraph CTA RED before anchor/destination enforcement |
| Same runner, `delivery-rollback-authority`, `e2e01-review-regressions`, `e2e01-conversion` | 29 PASS, 0 skipped | Historical rollback, added quantity and recipient encoding |
| Same runner, `e2e01-writer-fixture` and `e2e01-search-context` | 4 PASS | Russian fixture, exact CTA, targeting normalization; later conflict test also passed |
| Migrated PG, `production-persistence.test.ts` | 23 PASS | Existing regressions retained and explicitly bound fixtures |
| Migrated PG, Search and trust focused suites | 12 PASS | Existing authority boundaries |
| Migrated PG, four authority/reliability files | 81 tests: 79 PASS, 2 FAIL, 0 skipped | Remaining manifest field placement fixed later; not a passing gate |
| `node --import ./apps/factory/node_modules/tsx/dist/loader.mjs --test apps/factory/tests/e2e01-renderer.test.ts` | 2 PASS, 0 skipped | Real isolated Astro builds; Sutherland/Stark identity, sitemap, nav, keyboard CTA; later explicit CTA contract extension requires rerun |
| `FACTORY_TEST_DATABASE_URL=<isolated-test-url> node apps/dashboard/scripts/operator-e2e-run.mjs e2e01-stark-golden-journey.spec.ts` | 1 PASS | Continuous accepted fixture journey, initially stopped at missing binding; stronger configured-target boundary rerun required |
| `pnpm qa` development attempt | Factory 1127 PASS, 6 FAIL | Rollback fixture failures subsequently corrected; full pipeline did not pass |
| `pnpm --filter @factory/factory run test:persistence` development attempt | 370 tests: 350 PASS, 20 FAIL, 0 skipped | Primarily missing explicit fixture binding; subsequent focused migrations do not replace full rerun |
| `osv-scanner scan --lockfile=pnpm-lock.yaml` | FAIL: 2 affected package versions | GHSA-mrhx-c7xc-m3w5, zod 3.25.76 and 4.4.3; scanner reports fixed version 4.6.6. Dependency remediation not claimed |

## Committed functional checkpoint

Candidate: `794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`. The source tree was clean when the sequential run began.
Reports are a documentation-only descendant and do not change this functional SHA.
Logs: `.factory/e2e01/logs/794c3f4/` (local, gitignored). Local commands below
ran sequentially; no concurrent builds shared the ordinary source output directory.
Local dedicated `factory_test` databases on 54349/54350 used real migrations; CI uses its own PostgreSQL 18 factory_test service on 5432.

| Required command | Observed result | Measured evidence |
|---|---|---|
| `node --import ./apps/factory/node_modules/tsx/dist/loader.mjs --test apps/factory/tests/e2e01-renderer.test.ts` | PASS; exit 0; timeout=False | tests=2; pass=2; fail=0; skipped=0 |
| `pnpm --filter @factory/dashboard run test:e2e` | FAIL; exit 1; timeout=False | 3 failed; 14 passed (10.5m) |
| `pnpm --filter @factory/factory run test:production` | PASS; exit 0; timeout=False | tests=60; pass=60; fail=0; skipped=0 |
| `pnpm --filter @factory/site-starter run test:axe` | PASS; exit 0; timeout=False | 4 skipped; 4 passed (18.2s) |
| `pnpm --filter @factory/site-starter run test:keyboard` | PASS; exit 0; timeout=False | 4 passed (8.9s) |
| `pnpm exec lhci autorun --collect.staticDistDir=/Users/startupery/Documents/factory-girl/.factory/e2e01/renderer/stark/dist` | PASS; exit 0; timeout=False | 2 URLs × 3 runs = 6 reports; all configured assertions passed |
| `gitleaks detect --redact -v --config .gitleaks.toml` | PASS; exit 0; timeout=False | 319 commits; ~9,947,448 bytes; no leaks |
| `osv-scanner scan --lockfile=pnpm-lock.yaml` | FAIL; exit 1; timeout=False | 7 advisory/package-version rows; 4 package versions; 6 unique advisories |
| `lychee --offline --no-progress --root-dir /Users/startupery/Documents/factory-girl/.factory/e2e01/renderer/stark/dist '/Users/startupery/Documents/factory-girl/.factory/e2e01/renderer/stark/dist/**/*.html'` | PASS; exit 0; timeout=False | 26 total, 10 unique, 23 OK, 0 errors, 3 excluded |

Artifact environment for axe/keyboard: `FACTORY_QA_ARTIFACT_DIR` and
`FACTORY_PRODUCTION_OUT_DIR` both resolve to `.factory/e2e01/renderer/stark/dist`;
`FACTORY_QA_PORT=4389`. Lighthouse runs in `sites/starter`; Lychee uses this
same explicit artifact as root. These are synthetic renderer checks, not a
production-approved artifact from the accepted Stark operator chain.

Independent adversarial code review: **GO** for exact SHA
`794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`; initial scoped review found no new actionable findings.
The final reviewer inspected the two-file test delta; the earlier ac9ff07 review also ran mailbox probes. The reviewer performed no builds or DB operations. This is not independent executed QA acceptance or merge authorization.
The earlier 872a9cc review found authority-form mailto parsing and merged-copy
artifact evidence issues; both were corrected and reviewed again.

OSV remains blocking: seven advisory/package-version rows across four package
versions (six unique advisories): body-parser 1.20.8 (fixed 1.20.9), fast-uri
3.1.8 (fixed 3.1.9), zod 3.25.76 and 4.4.3 (fixed 4.6.6). The remediation does
not change dependencies, the lockfile or existing scanner exclusions. A blind
major-version override of transitive Zod consumers is not accepted remediation.
No new suppression or fabricated security PASS was introduced.

A preceding run spanning earlier checkpoints passed QA (Factory 1141, Dashboard
51, site 35 PASS/35 conditional skips), persistence 408/408, Operator 149/149,
production 60/60, axe 4 PASS/4 conditional skips, Lighthouse, Gitleaks and offline
links. Dashboard had 11 PASS/6 FAIL and keyboard 0 PASS/4 FAIL. Its historical
runner header names 9b1d85f but later source changes occurred during execution;
that run is supplementary evidence, never exact-SHA proof. The explicit Search
fixture changes subsequently passed all four focused browser cases; duplicate
link identity was reproduced then corrected with DOM-element/order checks
(4/4 focused keyboard PASS).

## Exact-head CI execution evidence

[PR CI run 40089521063](https://github.com/sutherlandamcom/factory/actions/runs/40089521063), exact candidate `794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`, job 120859164411. Checkout verification passed.

| Mandatory command | Observed CI conclusion | Totals |
|---|---|---|
| `pnpm qa` | completed / success | NOT MEASURED: complete job log unavailable while job runs |
| `pnpm --filter @factory/factory run test:persistence` | completed / success | NOT MEASURED: complete job log unavailable while job runs |
| `pnpm --filter @factory/factory run test:operator` | completed / success | NOT MEASURED: complete job log unavailable while job runs |

Snapshot observed at 2026-10-24 11:36:03 UTC. The CI job/browser stage was still in progress at this snapshot; no full green-CI claim is made. The local full browser suite independently finished with 14 PASS/3 FAIL/0 skips, all three failures reporting only security.osv.

The preceding exact checkpoint `ac9ff072d713aa50a5ad2bbf8617cccad8f42fd4` completed local QA (Factory 1142, Dashboard 51, site 35 PASS/35 skips), PostgreSQL persistence 408/408 and Operator 149/149, all zero failures. Its browser run was deliberately interrupted before source edits. Final 794c3f4 changes only the isolated QA configuration fixture and adds its RED/GREEN regression (4/4 focused tests; typecheck exit 0). These parent counts are explicitly compatibility evidence, not exact-final-SHA measured totals.

## Remaining browser/security gates

All three failing browser readiness cases reached actual candidate QA and failed
only `security.osv`; no assertion was skipped or weakened. Readiness, staleness
recovery after READY, and browser publication/rollback after READY therefore
remain NOT VERIFIED at this candidate. Failing candidate IDs:

- Run 11 golden: `pcand-209765f4-003b-4010-a66d-b4dccefcbe06`.
- Run 11 staleness: `pcand-d108f50a-702f-49db-bbff-07687771d8c0`.
- Run 13 delivery: `pcand-064c311d-b8f8-441d-b219-280194a82412`.

These are separate legacy synthetic test-harness candidates, not the continuous
Stark fixture chain. Each actual overall QA verdict is FAIL.

| Advisory | Affected lockfile version | Scanner fixed version |
|---|---|---|
| GHSA-27r3-jxmh-p828 | body-parser 1.20.8 | 1.20.9 |
| GHSA-333x-w4r6-6crp | fast-uri 3.1.8 | 3.1.9 |
| GHSA-w74x-v6f9-j3xg | fast-uri 3.1.8 | 3.1.9 |
| GHSA-wjr9-j795-jxcr | fast-uri 3.1.8 | 3.1.9 |
| GHSA-xhq7-xmqj-769h | fast-uri 3.1.8 | 3.1.9 |
| GHSA-mrhx-c7xc-m3w5 | zod 3.25.76 and 4.4.3 | 4.6.6 |

The existing Google design.md and Chromium Bidi dependencies consume Zod 3;
compatibility must be established rather than assuming a major override is safe.
Lychee 0.24.2 uses the official macOS x86 release with archive SHA-256
`887503a9cff667d322b8d0892b40bf49976eb9507af8483220a3706cdad55978`.
Existing workflow scanner configuration and exclusions were preserved byte-for-byte.

## Targeted industrial-attribution review — open verification

At ac9ff072d713aa50a5ad2bbf8617cccad8f42fd4 (production code unchanged in final 794c3f4), the separate reviewer subsequently reproduced a P2
semantic false-positive: a synthetic RusSilica 500-million probe claim lexically covers
Stark investing, building or operating the plant with the same number. These invented probe sentences are test inputs, not assertions about either company. Both
`isSentenceCoveredByClaims` and `claimLineageProblems` permit this. A transparent
in-memory strict `runTrustQa` seam returned claim-lineage/source-authority PASS
but overall FAIL without real editorial/original-work authority. This seam is
not persisted acceptance. Actual content integrity rejected a changed subject
under the accepted manifest, and review staleness rejected a changed digest.

No complete authority-preserving publication bypass was demonstrated. The
mandated durable supported/unsupported industrial-attribution, wrong-project,
source-change, rewording and revocation matrix remains **NOT VERIFIED**. This is
a separate acceptance blocker, not evidence that generic trust-suite PASS proves
industrial attribution. Under repository P2 scope governance, the semantic
weakness is carried explicitly rather than replaced by an unreviewed semantic
engine. Scoped code-review GO remains; independent executed acceptance does not.

## Execution timestamps and log fingerprints

| Gate | Started (UTC) | Finished (UTC) | Log SHA-256 |
|---|---|---|---|
| renderer | 2026-10-24T11:21:01.396Z | 2026-10-24T11:21:17.885Z | `9297034771020ec83c470019282e5dae190e7f0806c6a900c3ecfc8fb16de97e` |
| browser | 2026-10-24T11:21:17.887Z | 2026-10-24T11:31:54.111Z | `ac116d421c8205a26cbab808aaa567ea0ab8190ad940ae9fd1da923cfae7e8e8` |
| production | 2026-10-24T11:31:54.113Z | 2026-10-24T11:32:33.147Z | `f5725f5ca37cd4b9ee16529175788ee71a65f28cd8baed373e98cbc1bfdf6326` |
| axe | 2026-10-24T11:32:33.148Z | 2026-10-24T11:32:53.152Z | `3e2868aec49a37e68b5bee64676995c3209c3d825fbe3f2d288859892c4265b3` |
| keyboard | 2026-10-24T11:32:53.153Z | 2026-10-24T11:33:03.639Z | `bcbed4e256b6fe94c8125eba77400a49f2cd74d8dfe497a5808d4078b6bbf995` |
| lighthouse | 2026-10-24T11:33:03.640Z | 2026-10-24T11:34:52.388Z | `b9963f82209791bce526c5470036365b3de3b8fec2c6cc90457de8c77bd2a9ee` |
| gitleaks | 2026-10-24T11:34:52.388Z | 2026-10-24T11:35:20.674Z | `d40adf5222ddfb974759f80680d1ed8afb6cc15e40b3c7a188438f2baa6f0686` |
| osv | 2026-10-24T11:35:20.675Z | 2026-10-24T11:35:22.879Z | `8007dda1918edea027e3e6a84e3909926e57a2b382740e0f70431551b7257c2e` |
| links | 2026-10-24T11:35:22.880Z | 2026-10-24T11:35:22.983Z | `f9a8233fe0b5c5b68fbde0e0bcb6d721039cd93d42e0b65287fccee7c9d0088b` |

Conditional axe skips are duplicate project/viewport combinations; the four actual page/viewport combinations execute. Ordinary site skips include guarded task, visual and candidate-specific suites; no skip was introduced to obtain green results.

## Acceptance mapping and limitations

Project isolation and configuration mutations: `e2e01-site-binding.test.ts` and
its persistence counterpart. Direct store derivation is tested before missing
content can mask the binding check. Existing production/reliability/delivery
tests retain content, design, visual, source, review, stale-QA, route and rollback
mutations; no existing suite/assertion was removed or weakened.

CTA: `e2e01-conversion`, `e2e01-review-regressions`, `production-qa-gates` and
`e2e01-renderer`. Unicode: `e2e01-unicode`, Search context/provider and writer QA.
Concurrency: separate temporary configuration/output roots; existing advisory
lock, CAS and authority mutation tests remain mandatory in full persistence QA.

The initial independent review found three P1 issues (form authority, appended
quantity coverage and stale-Intake rollback) and three P2 issues (recipient
encoding, country alias normalization and masked direct-store negative test).
All have code/test corrections; exact-SHA code review returned GO for 794c3f4. Executed independent acceptance remains outstanding.

## Search and SEO authority review

Reviewed current official guidance before canonical/navigation changes:
[Google canonical consolidation](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
and [crawlable links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable).
The implementation keeps canonical, JSON-LD, sitemap and internal destinations
consistent with one project-bound origin, and uses actual anchors with `href`.
It invents no routes or indexing claims. Broken configured routes fail closed.

Provider parameter review used
[Bright Data Google query parameters](https://docs.brightdata.com/products/serp-api/query-parameters/google)
and [DataForSEO live advanced parameters](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/).
Normalized effective parameters and policy version bind the cache identity;
accepted-snapshot lineage and override/derived provenance are persisted. Fixture
execution does not establish provider reachability or live result quality.
