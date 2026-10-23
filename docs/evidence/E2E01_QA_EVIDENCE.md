# E2E-01 QA evidence

Verdict: **PARTIAL — final-candidate mandatory gates are not yet all verified.**
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

## Required final checkpoint

Each row requires exit status, measured totals/skips where applicable and exact
candidate SHA before a PASS can be recorded. An initiated command is not proof.

| Required command | Final-candidate result |
|---|---|
| `pnpm qa` | NOT VERIFIED |
| `pnpm --filter @factory/factory run test:persistence` | NOT VERIFIED |
| `pnpm --filter @factory/factory run test:operator` | NOT VERIFIED |
| `pnpm --filter @factory/dashboard run test:e2e` | NOT VERIFIED |
| `pnpm --filter @factory/factory run test:production` | NOT VERIFIED |
| `FACTORY_QA_ARTIFACT_DIR=<built-candidate> FACTORY_PRODUCTION_OUT_DIR=<built-candidate> FACTORY_QA_PORT=4389 pnpm --filter @factory/site-starter run test:axe` | NOT VERIFIED |
| Same artifact environment, `pnpm --filter @factory/site-starter run test:keyboard` | NOT VERIFIED |
| In `sites/starter`: `pnpm exec lhci autorun --collect.staticDistDir=<built-candidate>` | NOT VERIFIED |
| `gitleaks detect --redact -v --config .gitleaks.toml` | NOT VERIFIED |
| `osv-scanner scan --lockfile=pnpm-lock.yaml` | NOT VERIFIED for final SHA; development scan failed |
| `lychee --offline --no-progress --root-dir <built-candidate> '<built-candidate>/**/*.html'` | NOT VERIFIED; local Lychee binary unavailable at initial inspection |
| Independent adversarial review of final functional SHA | NOT VERIFIED; initial checkpoint required changes |
| GitHub Actions exact-head CI | NOT VERIFIED |

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
All have code/test corrections; exact-new-SHA review remains required.

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
