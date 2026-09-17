# FACTORY MACRO RUN 10 — CLOSURE VERIFICATION REPORT

**Target System:** Factory Control Plane & Production Compiler — Macro Run 10 (Page Derivatives: AI Summary + Narration/Audio)

**Run 10 Implementation PR:** #40

**Run 10 Implementation Head:** `1061fcf1b41cd7a435f89d8bf142b713551f0e4c`

**Run 10 Merge Commit:** `93d8d33cb26476b6d9b245ed2b312d83ca5e872e`

**QA Remediation PR:** #41

**QA Remediation Candidate:** `372fadaa67c48950049ccf34c73cc09fd662f999`

**Final Merged Main SHA:** `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`

**Post-Merge Main CI:** `35080141954 — SUCCESS`

**Date:** 2026-09-17

---

## Executive Summary

Run 10 introduced governed page derivatives (AI summary and narration/audio) as version-bound, digest-bound authorities of exact accepted page content.

PR #40 established the Run 10 implementation.

Subsequent QA identified a P1 multi-page relational uniqueness defect: project-scoped unique constraints on accepted summary and audio artifacts collided with the page-scoped domain versioning semantics used by the application service.

PR #41 corrected that defect through migration `0032_accepted_derivatives_page_scoped_uniques.sql`.

Final merged main is `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`.

Post-merge CI run `35080141954` succeeded (`push` event on `main`, head SHA `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`, conclusion `success`).

No known P0/P1 implementation blocker remains in the verified Run 10 infrastructure scope.

Live external Summary and TTS execution were NOT part of final provider acceptance and remain separately gated.

---

## Historical Identity and SHA Distinction

The following identities are distinct and must not be conflated:

| SHA / Run | Role |
|---|---|
| `1061fcf1b41cd7a435f89d8bf142b713551f0e4c` | Run 10 implementation head (PR #40 branch tip) |
| `93d8d33cb26476b6d9b245ed2b312d83ca5e872e` | Run 10 merge baseline before the multi-page uniqueness remediation (PR #40 merge commit) |
| `372fadaa67c48950049ccf34c73cc09fd662f999` | QA remediation candidate (PR #41 head) |
| `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8` | GitHub merge result of PR #41 into `main`; the final merged main verified by this report |

`93d8d33…` is historical. It is the merged Run 10 baseline before migration 0032. It is not the final verified main.

The QA remediation candidate `372fadaa…` and the final merged main `f11fd0f6…` are different objects: the former is the PR #41 branch head that was reviewed and tested as a candidate; the latter is the merge commit GitHub produced in `main`. Post-merge CI run `35080141954` ran against `f11fd0f6…` (head SHA verified via `gh run view`).

Correction note: an earlier draft of this report used an incorrect SHA (one character different from the correct final main) as the final main. That string does not correspond to any object in this repository's history. The correct final merged main is `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`. This report supersedes that draft.

---

## Independence and Evidence Classification

**Separate read-only final remediation audit proven: NO.**

Repository evidence does not establish that a distinct read-only audit context independently reviewed remediation candidate `372fadaa…` after it was created:

- PR #40 and PR #41 carry no recorded reviews or review comments in the repository's PR metadata.
- PR #41 was authored and merged by the same account (`sutherlandamcom`).
- No tracked Run 10 audit document existed in the repository before this report.
- The actor context that identified the defect, wrote migration 0032, committed the fix, opened PR #41, and merged PR #41 cannot simultaneously be described as an independent read-only auditor of its own remediation.

Accordingly:

- This report is titled **Closure Verification Report**, not "Independent" closure verification.
- Post-merge CI run `35080141954` is automated evidence: it proves the repository's automated QA pipeline passed on the final merged main. It does not constitute independent code review, and this report does not claim it does.
- The verification evidence below was produced by builder-context execution and source inspection, recorded here so that any reviewer can reproduce every material claim independently.

---

## Formalized Invariants and Verification Evidence

The verification methodology combines:

- explicitly stated system invariants;
- source-code inspection;
- PostgreSQL integration tests;
- negative/adversarial authority tests;
- deterministic digest verification;
- real Astro builds;
- browser E2E verification;
- exact-SHA CI evidence.

No formal-verification proof assistant (Lean, Coq, Isabelle, TLA+, Alloy, SMT solver, or model checker) was used. The invariants below were verified by tests and code inspection, not by machine-checked formal proof.

### Invariant A — Historical Immutability

For every accepted derivative set `d`, and for every time `t` after acceptance:

```
data(d, t) = data(d, t_accept)
```

and:

```
Digest(data(d, t)) = d.setDigest
```

The invariant means that acceptance creates an immutable historical record. Later accepted derivative versions may supersede it for current production authority, but must not mutate its persisted authority data.

**Verified evidence.** The exact test
`PG run10: mandatory supersession regression (D1 historical immutable, D2 current, PI1 stale, candidate blocked)`
(`apps/factory/tests/persistence/run10-production-derivatives.test.ts`) establishes the full D1→D2 scenario:

```
D1 accepted
↓
D2 accepted
↓
D1 data remains unchanged (deep equality against the pre-D2 snapshot)
D1 still parses (parseAcceptedDerivativeSetData(D1.data) succeeds)
digest(D1.data) == D1.setDigest (acceptedDerivativeSetDigest recomputation)
D1 is historical
D2 becomes current
```

The same test then verifies that production currentness follows supersession: `requireProductionDerivativeSet(D1)` fails with `production_authority_stale` (message matches `superseded`), `requireProductionDerivativeSet(D2)` passes, the production input bound to D1 becomes stale, and a candidate bound to that input is blocked and persisted as `state = "stale"`.

The complementary test
`summary regeneration does not mutate the accepted artifact`
(`apps/factory/tests/persistence/derivatives-persistence.test.ts`) verifies that regenerating a summary proposal never mutates the previously accepted summary artifact.

### Invariant B — Production Derivative Authority

`requireProductionDerivativeSet(D)` succeeds only when all required authority and integrity conditions are satisfied. The implementation (`apps/factory/src/derivatives/production-verifier.ts`) enforces the following condition groups:

- **Exact set identity** — the set row exists for the requested set id and project.
- **Set canonical digest integrity** — the stored `setDigest` matches the request, and the canonical digest recomputed from the persisted `set.data` matches the stored `setDigest` (forged or corrupted rows are rejected).
- **Current derivative-set identity** — the requested set is the current accepted set for the project/page; a superseded set fails with `production_authority_stale`.
- **Current accepted content** — both the set row columns and the parsed set data bind the exact current content id, version, and digest.
- **Current effective derivative intent** — the set's intent snapshot digest equals a freshly derived current intent digest (policy + page override + content).
- **Summary member authority when enabled** — see below.
- **Audio member authority when enabled** — see below.
- **Provider/test-double truthfulness** — member artifacts must be `providerMode == "live"` with `isTestDouble == false`; fixture/test-double output is rejected as production authority.
- **Summary QA status** — the QA report is digest-bound into the accepted artifact (`qaReportDigest`), and acceptance is blocked for `qaOverall === "FAIL"` or a missing verdict (`derivative_qa_failed`).
- **Narration currentness** — the accepted audio must bind the current narration snapshot for the page/content.
- **Audio binary/CAS integrity** — the audio binary digest is bound exactly; when a storage backend is supplied, the stored bytes are re-hashed and must match the recorded `binaryDigest`.
- **Project/page isolation** — set and member artifacts must belong to the requesting project and page identity.

Provider truthfulness fields (`providerMode`, `isTestDouble`) belong to the accepted member artifacts (summary artifact, audio artifact), not to `AcceptedDerivativeSet` itself. This report therefore never attributes `providerMode`/`isTestDouble` to the set.

**Summary production member conditions** (for an enabled summary): exact bound artifact id; same project; same page identity; exact version and artifact digest agreement between set data, set row, and artifact row; canonical artifact digest recomputation valid; source content still current; intent snapshot still current; `providerMode == "live"`; `isTestDouble == false`; QA does not fail.

**Audio production member conditions** (for enabled audio): exact bound artifact id; same project; same page identity; exact artifact digest; exact binary digest agreement across set data, set row, and artifact row; current source content; current narration snapshot; canonical artifact digest recomputation valid; `providerMode == "live"`; `isTestDouble == false`; stored audio bytes match the recorded binary digest when storage verification applies.

**Negative evidence.** The following exact tests reject fixture/test-double and forged authority (`apps/factory/tests/persistence/run10-golden-seam.test.ts`):

- `NEGATIVE SEAM: requireProductionDerivativeSet rejects fixture summary`
- `NEGATIVE SEAM: requireProductionDerivativeSet rejects fixture audio`
- `NEGATIVE SEAM: forged set digest is rejected`
- `NEGATIVE SEAM: stale policy makes deriveProductionInput fail immediately with production_authority_stale`
- `NEGATIVE SEAM: stale content makes requireProductionDerivativeSet reject`
- `NEGATIVE SEAM: audio binary byte mutation in storage fails closed`

The production authority truth matrix is additionally covered by
`production authority truth matrix: fixture/double output is rejected`
(`apps/factory/tests/persistence/derivatives-persistence.test.ts`).

### Invariant C — `recordBuild` Staleness Transaction Semantics

When `recordBuild()` detects stale upstream authority, the candidate is updated to `state = "stale"` inside the transaction.

The transaction then returns `{ staleReason }` and commits, preserving the stale state durably.

After the transaction boundary, `recordBuild()` throws `production_authority_stale` to the caller.

The error is intentionally thrown after commit; throwing it inside the transaction would roll back the persisted stale transition.

Implementation evidence: `ProductionStore.recordBuild()` in `apps/factory/src/production/store.ts` — inside the transaction, `inputStaleness()` detects stale authority, the candidate row is updated to `state = "stale"`, and the transaction callback returns `{ staleReason }`; after the transaction completes, the method throws the typed `production_authority_stale` error. The D1→D2 regression test above verifies the persisted `state = "stale"` row after the thrown error.

### Invariant D — Future `page_summarizer` Role Performs Zero Network I/O

```
implementationStatus = future
↓
guard executes before credential check
↓
before budget reservation
↓
before external provider invocation
↓
derivative_generation_blocked
↓
network requests = 0
```

Implementation evidence: `runSummaryInvocation()` in `apps/factory/src/derivatives/summary-provider.ts` executes the `implementationStatus = "future"` guard (step 0) before credential preflight (step 1), before conservative authorization/budget reservation (steps 2–4), and before any provider invocation (step 5). `page_summarizer` has `implementationStatus: "future"` in `apps/factory/src/models/policy.ts`.

Budget wording (precise): when a live model role is eligible to execute, governed budget reservation precedes external provider invocation. For `page_summarizer` in its current `future` state, execution is blocked earlier, before credential validation, budget reservation and network I/O.

Verified by the exact tests:

- `Theorem D / Section 18-21: page_summarizer future role blocks live summary execution before network with zero calls` (`apps/factory/tests/derivatives-core.test.ts`)
- `Theorem D / Section 18-21: page_summarizer implementationStatus=future blocks live summary generation with zero network calls` (`apps/factory/tests/persistence/derivatives-persistence.test.ts`)

---

## Migration 0032 — Root Cause and Scope

Defect class: P1 multi-page relational uniqueness mismatch. Domain versioning of derivative artifacts is page-scoped; migration 0030's relational uniqueness for two of the three tables was project-scoped.

**`accepted_summary_artifacts`** — migration 0030 defined `UNIQUE(project_id, version)` (constraint `accepted_summary_artifacts_project_version_unique`) although domain versions are page-scoped. Migration 0032 drops that constraint and adds `UNIQUE(project_id, page_identity, version)` (constraint `accepted_summary_artifacts_project_page_version_unique`).

**`accepted_audio_artifacts`** — identical defect and identical remediation: `UNIQUE(project_id, version)` replaced by `UNIQUE(project_id, page_identity, version)` (constraint `accepted_audio_artifacts_project_page_version_unique`).

**`accepted_derivative_sets` is different.** Migration 0030 had already defined BOTH `UNIQUE(project_id, version)` (`accepted_derivative_sets_project_version_unique`) and `UNIQUE(project_id, page_identity, version)` (`accepted_derivative_sets_project_page_version_unique`). Migration 0032 therefore only removes the redundant project-scoped constraint `accepted_derivative_sets_project_version_unique`; the correct page-scoped constraint already existed. This asymmetry is explicit in the migration file `apps/factory/drizzle/0032_accepted_derivatives_page_scoped_uniques.sql`.

**Multi-page failure example.** Under page-scoped domain versioning, the following state is valid:

```
P1 / home  / version 1
P1 / about / version 1
```

But the defective `UNIQUE(project_id, version)` made the second row collide with the first at the PostgreSQL level:

```
23505 unique_violation
```

preventing any multi-page project from accepting derivatives beyond the first page. Migration 0032 aligns relational uniqueness with domain semantics. The regression test
`multi-page project: multiple pages in the same project can each accept derivatives independently with page-scoped versioning`
(`apps/factory/tests/persistence/derivatives-persistence.test.ts`) verifies `home` v1 + `about` v1 coexist and that superseding `home` to v2 leaves `about` at v1.

---

## Concurrency and Isolation Terminology

**Advisory lock primitive.** The Run 10 store uses the PostgreSQL transaction-level advisory lock:

```
pg_advisory_xact_lock(hashtextextended(projectId, 104))
```

It is transaction-level and released at transaction completion (`apps/factory/src/derivatives/store.ts`, `withProjectLock`; the same discipline is used by `ProductionStore.recordBuild()` in `apps/factory/src/production/store.ts`).

**Scope of the claim.** The audited Run 10 mutation paths that require project serialization use the established project advisory-lock discipline: `DerivativesService.deriveIntentSnapshot()`, `acceptSummary()`, `acceptAudio()`, and `acceptDerivativeSet()` execute inside `withProjectLock`, with in-lock re-verification of currentness before acceptance transitions. This report does not generalize the claim beyond the audited mutation paths.

**Cross-project isolation.** Application-level cross-project authority guards validate referenced artifacts before insertion and throw the typed `derivative_authority_wrong_project` error (`DerivativesStore.insertDerivativeSet()` in `apps/factory/src/derivatives/store.ts`; the same typed code is enforced in `requireProductionDerivativeSet()`). This avoids relying on raw database foreign-key failures for the operator-visible rejection path. Verified by the exact test
`cross-project isolation: derivative artifacts from project B cannot attach to project A`
(`apps/factory/tests/persistence/derivatives-persistence.test.ts`).

---

## Evidence Matrix

All commands below are executed from repository root. Suite rows marked "local execution (this report)" were executed while preparing this report; PostgreSQL persistence suites require `FACTORY_TEST_DATABASE_URL` pointing at a dedicated test database.

| Suite | Root Command | Observed Result | Evidence |
|---|---|---|---|
| Contracts typecheck | `pnpm --filter @factory/contracts run check` | PASS (0 errors) | local execution (this report); CI 35080141954 |
| Factory typecheck | `pnpm --filter @factory/factory run check` | PASS (0 errors) | local execution (this report); CI 35080141954 |
| Derivatives core contracts/policy/staleness/QA | `pnpm --filter @factory/factory exec tsx --test tests/derivatives-core.test.ts` | 27/27 pass | local execution (this report) |
| Model role policy | `pnpm --filter @factory/factory exec tsx --test tests/models-policy.test.ts` | 15/15 pass | local execution (this report) |
| Derivative provider economics | `pnpm --filter @factory/factory exec tsx --test tests/persistence/derivatives-economics.test.ts` | 3/3 pass | local execution (this report) |
| Run 10 production derivative authority (PG) | `pnpm --filter @factory/factory exec tsx --test tests/persistence/run10-production-derivatives.test.ts` | 6/6 pass | local execution (this report); CI 35080141954 |
| Derivatives persistence lifecycle (PG) | `pnpm --filter @factory/factory exec tsx --test tests/persistence/derivatives-persistence.test.ts` | 22/22 pass | local execution (this report); CI 35080141954 |
| Run 10 golden seam: DB → set → production-v2 → manifest → Astro build → Playwright browser (PG) | `pnpm --filter @factory/factory exec tsx --test tests/persistence/run10-golden-seam.test.ts` | 8/8 pass | local execution (this report); CI 35080141954 |
| Schema & migrations idempotency (PG) | `pnpm --filter @factory/factory exec tsx --test tests/persistence/schema-migrations.test.ts` | 1/1 pass | local execution (this report); CI 35080141954 |
| Post-merge main CI (full pipeline: QA, persistence, operator, E2E, production gates, axe/keyboard, Lighthouse, gitleaks, OSV, lychee) | CI run `35080141954` | SUCCESS | GitHub Actions run on `main`, head SHA `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`, event `push` |

Notes:

- Test counts above are from the exact local executions listed; they are not inherited from any earlier report.
- The CI run executes the persistence suites with its own PostgreSQL 18 service; its SUCCESS on the exact final main SHA is the top-level automated evidence for the merged state.

---

## Browser E2E and Accessibility

Playwright configuration (`sites/starter/playwright.config.ts`) defines two projects: `desktop` (Chromium, 1280×800) and `mobile` (iPhone 13 viewport, chromium browser). QA runs against the built site served via `astro preview`, never the dev server.

Run 10 E2E tests (`sites/starter/tests/run10-derivatives.e2e.spec.ts`), executed against built production output:

- `derivative page renders summary details + audio controls from accepted artifacts`
- `100 visitor interactions trigger ZERO provider requests` — the test literally performs 100 summary reveals/toggles and 100 audio control interactions and asserts that zero provider/network requests to model or TTS endpoints occurred
- `disabled derivatives render no fake controls`
- `summary control is keyboard accessible`

Automated accessibility verification passed for the tested production surfaces, including the reported Axe and keyboard checks (`axe: ${route} [${project}] has 0 critical/serious violations` in `sites/starter/tests/axe.production.spec.ts`; `keyboard: ${route} exposes every interactive element in DOM order` in `sites/starter/tests/keyboard.production.spec.ts`). No critical/serious Axe violations were observed in the tested scope.

These automated checks provide accessibility evidence but do not constitute a complete manual WCAG 2.2 AA conformance audit.

---

## Static Production Integration

Run 10 proves:

- static Astro output of derivative-aware pages;
- static derivative materialization into the production build;
- browser consumption of built artifacts;
- zero visitor-time generation.

Accepted summary and audio derivatives are materialized into static Astro production output and can be consumed without visitor-time model or TTS execution.

Derivative generation is operator-triggered and versioned. Accepted derivative artifacts are reused statically. Visitor interactions never trigger regeneration.

Governed production delivery (deployment, preview, publish, rollback) belongs to a later run and is not claimed here. No Cloudflare delivery claim is made or implied by Run 10 evidence.

The golden seam test
`GOLDEN SEAM: real DB → AcceptedDerivativeSet → production-v2 → manifest → Astro build → QA → Playwright browser`
verifies the full chain from a real PostgreSQL database through an accepted derivative set, a production-v2 input, a render manifest, a real Astro build, and browser consumption, with a network guard asserting zero provider calls. The determinism test
`DETERMINISM: Re-compiling manifest without authority changes yields identical digests`
verifies deterministic recompilation.

---

## Provider Truthfulness

| Statement | Status |
|---|---|
| External live Summary provider executed during Run 10 acceptance | NO |
| External live TTS provider executed during Run 10 acceptance | NO |
| Paid provider calls used as final Run 10 acceptance proof | NO |
| `page_summarizer` live activation | PENDING PROVIDER-POLICY APPROVAL (`implementationStatus: "future"` in `apps/factory/src/models/policy.ts`) |
| Production TTS provider | NOT YET APPROVED / ACTIVATED (no approved live production TTS implementation was verified in repository policy) |

All tests and CI inject fixture/test-double providers; the fixture path is explicitly marked `providerMode: "fixture"` / `isTestDouble: true` and is rejected as production authority by the gates described under Invariant B.

---

## Economics

Ordinary static rendering and visitor consumption do not invoke Summary or TTS providers; this is verified by the browser E2E test and the economics tests (`provider economics: one provider op per generation; zero on re-derivation, status, and set acceptance`; `zero visitor provider calls: 100 visitor interactions trigger zero provider operations`; `cost telemetry: fixture proposals record UNKNOWN cost (never zero) and usage tokens`).

Actual live provider costs were not exercised in Run 10 acceptance:

- live Summary provider cost: UNKNOWN / NOT EXERCISED
- live TTS provider cost: UNKNOWN / NOT EXERCISED

No zero-cost claim is made for live provider execution.

---

## Verified Scope

The following capabilities are evidence-backed by the tests and implementation referenced in this report:

- derivative policy/override authority (versioned, digest-bound, immutable history)
- intent snapshots (idempotent, digest-bound to content + policy + override)
- accepted summary/audio artifact authority
- `AcceptedDerivativeSet` (explicit disabled | accepted members, canonical set digest)
- historical immutability of accepted derivative artifacts (Invariant A)
- current-set enforcement and supersession semantics (Invariant B)
- staleness propagation: content, policy, voice, and set supersession → artifacts, set, production-v2 input, candidate
- production-v2 exact binding of the derivative set into `ProductionPageInput`
- fixture/test-double production rejection (negative authority tests)
- static Astro rendering of derivative-aware pages
- multi-page page-scoped versioning (migration 0032 remediation)
- zero visitor-time provider generation (browser E2E, including the literal 100-interaction test)
- tested security/accessibility gates (axe, keyboard, gitleaks, OSV, lychee in CI)

## Not Proven by Run 10 Closure

The following are explicitly outside the verified scope:

- real external Summary provider execution
- real external TTS provider execution
- live provider quality
- live provider production pricing accuracy
- governed production deployment (Run 13 owns preview/publish/rollback delivery)
- field Core Web Vitals (no field INP/FID data; only lab evidence exists)
- complete manual WCAG 2.2 AA conformance

---

## Final Verdict

**GO — MACRO RUN 10 INFRASTRUCTURE AND AUTHORITY BASELINE ACCEPTED**

Final merged main:

`f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`

Post-merge automated CI:

`35080141954 — SUCCESS`

Closure severity for the accepted implementation scope:

- P0: 0
- P1: 0

The accepted scope includes governed derivative authority, persistence, historical immutability, production-currentness checks, staleness propagation, fixture/test-double isolation, multi-page page-scoped versioning, deterministic Astro production integration, and tested automated quality gates.

Live Summary and live TTS provider activation remain outside this acceptance and require separate provider-policy approval and live provider verification.

Macro Run 10 is closed for this infrastructure scope.

---

## Evidence Index

| Claim / Invariant | Implementation evidence | Test evidence | Final-main evidence |
|---|---|---|---|
| Historical immutability (Invariant A) | `apps/factory/src/derivatives/store.ts`, `apps/factory/src/derivatives/core.ts` | `PG run10: mandatory supersession regression (D1 historical immutable, D2 current, PI1 stale, candidate blocked)`; `summary regeneration does not mutate the accepted artifact` | main CI 35080141954 |
| Production derivative authority (Invariant B) | `apps/factory/src/derivatives/production-verifier.ts` | `NEGATIVE SEAM: requireProductionDerivativeSet rejects fixture summary` / `rejects fixture audio` / `forged set digest is rejected` / `stale content makes requireProductionDerivativeSet reject`; `production authority truth matrix: fixture/double output is rejected` | main CI 35080141954 |
| recordBuild stale commit-then-throw (Invariant C) | `ProductionStore.recordBuild()` in `apps/factory/src/production/store.ts` | stale-state assertion inside the D1→D2 regression test | main CI 35080141954 |
| Future `page_summarizer` zero network I/O (Invariant D) | `apps/factory/src/derivatives/summary-provider.ts` (`runSummaryInvocation` guard ordering); `apps/factory/src/models/policy.ts` (`implementationStatus: "future"`) | `Theorem D / Section 18-21: page_summarizer future role blocks live summary execution before network with zero calls`; `Theorem D / Section 18-21: page_summarizer implementationStatus=future blocks live summary generation with zero network calls` | main CI 35080141954 |
| Migration 0032 page-scoped uniqueness | `apps/factory/drizzle/0032_accepted_derivatives_page_scoped_uniques.sql`; `apps/factory/drizzle/0030_derivatives_v0.sql` | `multi-page project: multiple pages in the same project can each accept derivatives independently with page-scoped versioning` | main CI 35080141954 |
| Project advisory-lock serialization | `apps/factory/src/derivatives/store.ts` (`withProjectLock`) | `concurrency race B: derivative set acceptance serializes with policy mutation` | main CI 35080141954 |
| Cross-project isolation | `DerivativesStore.insertDerivativeSet()` in `apps/factory/src/derivatives/store.ts` | `cross-project isolation: derivative artifacts from project B cannot attach to project A` | main CI 35080141954 |
| Zero visitor-time provider generation | `sites/starter/tests/run10-derivatives.e2e.spec.ts` network guard | `100 visitor interactions trigger ZERO provider requests` | main CI 35080141954 |
| Deterministic Astro production integration | `apps/factory/src/derivatives/production-verifier.ts`; render manifest compiler | `GOLDEN SEAM: real DB → AcceptedDerivativeSet → production-v2 → manifest → Astro build → QA → Playwright browser`; `DETERMINISM: Re-compiling manifest without authority changes yields identical digests` | main CI 35080141954 |
| Automated accessibility gates | `sites/starter/tests/axe.production.spec.ts`; `sites/starter/tests/keyboard.production.spec.ts` | `axe: ${route} [${project}] has 0 critical/serious violations`; `keyboard: ${route} exposes every interactive element in DOM order` | main CI 35080141954 |
| Provider truthfulness (no live execution) | `apps/factory/src/derivatives/audio-provider.ts`; `apps/factory/src/models/policy.ts` | fixture/test-double rejection tests under Invariant B | main CI 35080141954 |
| Final merged main identity | PR #41 merge commit (GitHub metadata) | — | CI run 35080141954 headSha = `f11fd0f6b1b60e2f56b9aba98cc219ca092056b8`, conclusion SUCCESS |
