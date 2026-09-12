# Macro Run 4 — Content Constitution + Opus Writer v0: independent QA verdict (durable artifact)

- Date: 2026-09-12
- Branch: `feat/content-writer-v0`
- Base: `main` at `46a556603047c4dce75ca3bbd05e1ed4b7ea817c` (PR #24 merged)
- Candidate: see PR description for the exact frozen SHA (recorded at Phase 8 freeze)
- Verifier role: this artifact records the RUN's QA execution record. Per
  repository governance it is NOT an independent GO; independent QA must run
  separately against the exact candidate SHA.

## Executed checks (exact commands, observed results)

| Check | Command | Result |
| --- | --- | --- |
| Factory typecheck | `npx tsc --noEmit` (apps/factory) | PASS (exit 0) |
| Dashboard typecheck | `npx tsc --noEmit` (apps/dashboard) | PASS (exit 0) |
| Contracts typecheck | `npx tsc --noEmit` (packages/contracts) | PASS (exit 0) |
| Override + policy suites | `npx tsx --test tests/models-override.test.ts tests/models-policy.test.ts tests/models-gateway.test.ts tests/competitor-analyst.test.ts tests/budget-price-ceiling.test.ts` | 41 pass, 0 fail |
| Writer budget unit | `npx tsx --test tests/writer-budget.test.ts` | 10 pass, 0 fail |
| Writer contract | `npx tsx --test tests/writer-contract.test.ts` | 6 pass, 0 fail |
| Writer policy/brief PG | `FACTORY_TEST_DATABASE_URL=… npx tsx --test tests/persistence/writer-persistence.test.ts` | 9 pass, 0 fail |
| Writer budget PG | `FACTORY_TEST_DATABASE_URL=… npx tsx --test tests/persistence/writer-budget-persistence.test.ts` | 2 pass, 0 fail |
| Snapshot/proposal PG | `FACTORY_TEST_DATABASE_URL=… npx tsx --test tests/writer-snapshot-proposal.test.ts` | 6 pass, 0 fail |
| QA triad + gate | `FACTORY_TEST_DATABASE_URL=… npx tsx --test tests/writer-qa.test.ts` | 7 pass, 0 fail |
| Writer API adversarial | `npx tsx --test tests/operator/writer-api.test.ts` | 4 pass, 0 fail |
| Content Writer E2E | `FACTORY_TEST_DATABASE_URL=… node scripts/operator-e2e-run.mjs e2e/content-writer-journey.spec.ts` (apps/dashboard) | 1 passed (full journey incl. restart + staleness) |

Environment: real PostgreSQL 16 (docker, `factory_test` on :54329),
`FACTORY_TEST_DATABASE_URL` explicit. Zero paid provider calls; writer ran in
fixture mode for E2E and via injected fixtures for unit suites.

## Scope covered

- Phase 0 override seam: default champion resolution unchanged (existing
  policy/gateway/competitor suites green unmodified); override resolution +
  telemetry provenance; CI/acceptance hard-fail; unpriced fail-closed.
- Budget lifecycle: adversarial two-pool PG tests with lock-wait proof,
  durable accounting/release, invariant violation persistence.
- Writer policy + brief: staleness across all lineage dimensions, idempotent
  same-digest concurrency, project isolation, restart safety.
- Snapshot: digest determinism, approval binding, staleness on newer approved
  brief, generation fail-closed on malformed/schema-violating output.
- QA triad: prohibited claims, invented numbers, unverified qualifiers,
  semantic coverage with evidence refs, forbidden terminology, AI-cliché,
  structure/CTA integrity; acceptance gate fail-closed paths.
- API: typed error propagation, malformed-body rejection before the service,
  project isolation.

## Evidence gaps (NOT verified here)

- Independent QA at the exact candidate SHA (required before any merge GO).
- Exact-head CI run on the PR branch (recorded in the PR, not here).
- Live writer acceptance (Phase 9): blocked pending explicit credential +
  spend authorization; no paid call was made in this run.
