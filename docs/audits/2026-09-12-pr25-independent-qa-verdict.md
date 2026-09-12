# PR #25 Independent QA Verdict — Macro Run 4 (Content Constitution + Opus Writer v0)

- Date: 2026-09-12
- Verifier: Independent QA (no involvement in building the code under review)
- Candidate: **`6dddbf8c3afa2589f7a5cba488055c6be23cfaf0`** — verified via
  `git rev-parse HEAD` before any check; branch `feat/content-writer-v0`;
  working tree clean. Plan: `docs/audits/2026-09-12-pr25-independent-qa-plan.md`.
- Policy basis: AGENTS.md (verification/merge governance), instruction-authority,
  roadmap-vnext §Macro Run 4. `writer-pipeline-v0.md`, the builder QA record and
  the PR body were treated as CLAIMS.

## 1. Executed checks (exact commands, observed results)

| # | Check | Command | Observed |
| --- | --- | --- | --- |
| 1 | SHA verify | `git rev-parse HEAD` | `6dddbf8c3afa…cfaf0`, clean tree |
| 2 | Diff scope | `git diff --name-status origin/main..6dddbf8` | 40 files, +7150/−8, all covered by plan |
| 3 | Contracts typecheck | `npx tsc --noEmit` (packages/contracts) | PASS (exit 0) |
| 4 | Factory typecheck | `npx tsc --noEmit` (apps/factory) | PASS (exit 0) |
| 5 | Dashboard typecheck | `npx tsc --noEmit` (apps/dashboard) | PASS (exit 0) |
| 6 | Factory unit lane | `pnpm --filter @factory/factory run test` | **859 pass / 0 fail / 0 skipped** |
| 7 | Persistence lane (real PG 16, `factory_test`:54329, sequential) | `FACTORY_TEST_DATABASE_URL=… pnpm --filter @factory/factory run test:persistence` | **82 pass / 0 fail / 0 skipped** |
| 8 | Operator lane | `pnpm --filter @factory/factory run test:operator` | **47 pass / 0 fail** |
| 9 | Dashboard unit | `pnpm --filter @factory/dashboard run test` | **17 pass / 0 fail** |
| 10 | Real-browser E2E (all journeys) | `FACTORY_TEST_DATABASE_URL=… pnpm --filter @factory/dashboard run test:e2e` | **6 passed** incl. Content Writer journey (accept → reload → service restart → upstream edit) |
| 11 | PG constraint/index introspection | `psql` against factory_test | 6 CHECK constraints + 13 indexes on the 4 new tables exactly as written in migrations 0010–0013 |

## 2. Independent adversarial probes (written by QA, not the builder; uncommitted)

| Probe | Method | Observed |
| --- | --- | --- |
| A3 Budget double-spend | two independent PG pools, concurrent `reserveWriterBudget`, limit 2 USD vs 2×1.5 USD | exactly **1 fulfilled / 1 `writer_budget_blocked`**; third-pool ledger read shows exactly one ACTIVE 1.5M row (durable) |
| A1 Cross-project isolation | full pipeline on project A over real HTTP (fixture mode), then project B attacks using A's artifact ids | policy-approve / brief-approve / generate / accept → all **404 `writer_artifact_not_found`**; B's workspace contains **no** A lineage; B direct generate w/o approvals → 404 |
| A2 Forged digests | well-formed wrong 64-hex digest on policy/brief/snapshot approval and content acceptance | all **409**: `writer_approval_failed` ×3, `content_accept_failed`; no state transition |
| A4 Override guard | spawned real `startOperatorServer` processes | override+`FACTORY_ACCEPTANCE_MODE=true` → exit 1, no listen, "DEV MODEL OVERRIDE FORBIDDEN"; override+`CI=true` → same; `FACTORY_LIVE_PROOF`+fixture writer mode → exit 1, "LIVE PROOF REQUIRES PRODUCTION PROVIDER MODE"; controls: dev override **starts** with "DEV MODEL OVERRIDE ACTIVE" banner; acceptance without override starts |
| A5 Fixture attribution | fixture-mode `POST /writer/generate` | `provider="fixture"`, `model="fixture-writer"`, `overrideApplied=false`, `overriddenChampion=null` — never the champion; **zero** `writer_budget_reservations` rows in fixture mode |
| DET1 Digest determinism | key-order-permuted canonical JSON | identical digests; different content → different digest |
| DET2 Prompt-packet determinism | `compileWriterPromptPacket` twice + mutated input | byte-equal outputs; input-sensitive |
| DET3 QA reproducibility | `POST /writer/qa` twice | identical report digest |
| G6 Unpriced model | override to `totally/unpriced-model`, conservative-cost preflight | throws before reservation; ledger unchanged (error code reuses pre-existing `competitor_analyst_not_configured`) |

## 3. Test-suite integrity

`git diff origin/main..6dddbf8 -- apps/factory/tests apps/dashboard/e2e packages/contracts`: **zero deleted files; zero `.skip/.only/xit` additions**. The only modifications to existing tests are (a) `competitor-remediation.test.ts:2990` pricing-policy version assertion v0.2→v0.3 — REQUIRED by the new `model-pricing-v0.3` policy and coverage-strengthening, not weakening; (b) `tests/persistence/helpers.ts:81` additive `writer_budget_reservations` in the truncate list. All writer suites ADD regression coverage. Required-suite structure unchanged.

## 4. Claims verified vs unverified

| Claim (source) | Verdict |
| --- | --- |
| All typechecks + suite counts (PR body, builder record) | **VERIFIED** (lane-level reproduction, §1) |
| Exact-head CI SUCCESS at candidate SHA | **VERIFIED** (`gh run view 34692051443` → headSha = candidate, conclusion success) |
| E2E journey incl. restart + staleness markers | **VERIFIED** (E2E #3 passed; markers shown via policy/brief staleness) |
| Zero paid provider calls | **VERIFIED** (no `OPENROUTER_API_KEY` in env — 0 bytes; fixture modes everywhere; zero budget rows) |
| Policy derived projection, no second SOT | VERIFIED (code + suites) |
| Approve binds exact version+digest; immutable; idempotent same-digest | VERIFIED (suites + probe A2) |
| Gap lineage REQUIRED by default | VERIFIED |
| `noGapLineageAcknowledged` approval-time escape hatch, "persisted, digest-bound, shown in Dashboard" | **PARTIALLY FALSE** — path unreachable (P2-2) |
| Malformed proposal fails closed; no silent repair; provider cannot spoof binding | VERIFIED |
| Deterministic QA triad, no numeric scores; FAIL blocks, REVIEW permits human gate | VERIFIED |
| Budget = exact 0009 mechanism (shared advisory lock `1428570002`, lifecycle, conservative accounting, invariant) | VERIFIED (code + probes) |
| Credential preflight fail-closed; model id never browser input; provider secrets server-side | VERIFIED |
| Override seam: default byte-identical; provenance columns; dev-time only; hard-fail in governed envs; banner | VERIFIED (probe A4 + suites) |
| Pricing v0.3: Opus $5/$25 "verified OpenRouter catalog rates" | internal consistency VERIFIED; **external catalog rates UNVERIFIED** (independent verification requires live catalog access — out of allowed scope) |
| GLM ceilings conservative ($0.10/$0.30 > stated catalog $0.075/$0.25) | VERIFIED (self-consistent) |
| Unpriced models fail closed everywhere | VERIFIED |
| Live-vs-CI policy (CI runs fixture modes; live acceptance requires explicit authorization) | VERIFIED at harness level (e2e server script defaults fixture; guard hard-fails); live acceptance **NOT PERFORMED** (correctly disclosed) |
| Roadmap update does not overstate (Run 3 merged, Run 4 candidate awaiting QA) | VERIFIED (diff reviewed) |

## 5. Findings

**No P0. No P1.** Six P2 findings (none breaches a governance invariant; all fail in the safe direction or are latent):

- **P2-1** `apps/factory/src/writer/service.ts:187-189` — `compileSnapshot` accepts `briefId` but silently ignores it (both branches resolve the LATEST brief); if `briefId` is truthy and no brief exists, `latestBrief()!.version` is an unguarded non-null assertion → TypeError → sanitized 500. Latent: the HTTP layer never sends `briefId` (`api.ts` snapshot-compile passes only `projectId`). Remediation: honor the parameter or delete it and the `!`.
- **P2-2** `apps/factory/src/writer/writer-store.ts:219-225,474-476` + migration `0012` CHECK constraints — the documented `noGapLineageAcknowledged` approval-time escape hatch is **unreachable**: drafting a brief already hard-requires a current accepted gap snapshot, and the constraints forbid a no-lineage brief even as a draft. `approveBrief`'s acknowledgment branch (`writer-store.ts:321-326`) is dead code; the Dashboard displays a flag that can never be true; PR/docs claim a capability that cannot occur. Fail-closed direction; no governance hole. Remediation: implement the acknowledged path at draft time or correct `docs/writer-pipeline-v0.md` §3 and the PR claim.
- **P2-3** `packages/contracts/src/operator-errors.ts` (OPERATOR_ERROR_STATUS) — `budget_invariant_violation` is unmapped, so an invariant trip inside `POST /writer/generate` surfaces as sanitized `internal_error`/500 (api.ts:208,557) instead of the typed code. Fail-closed but opaque; matches the pre-existing competitor pattern. Remediation: map the code (409).
- **P2-4** `apps/factory/src/writer/writer-store.ts:876-879` — `saveQaReport` upserts on `proposalId`: a post-acceptance re-QA under changed policy replaces the stored report/digest, orphaning the accepted row's `qa_report_digest` reference (accepted content itself remains immutable and correctly bound). Remediation: make QA report rows insert-only or version them.
- **P2-5** `apps/factory/src/writer/service.ts:505-509,523-527` — accepted-content views return `""` for proposalId/proposalDigest/qaReportDigest although the DB stores them; the Dashboard shows accepted content without its binding digests. Remediation: populate from the record.
- **P2-6** `apps/factory/src/writer/writer-store.ts:952-956` + `apps/factory/src/writer/service.ts:459-461` — (a) concurrent acceptance of two different slugs can race the max-version allocation into a UNIQUE(project_id,version) violation → untyped 500 (fail-closed, narrow); (b) QA/acceptance re-verify only the snapshot binding, not the transitive upstream chain (intake/policy/gap), so a proposal generated from a superseded intake generation can still be accepted while its upstream artifacts display STALE — consistent with documented v0 semantics ("stale snapshot binding") and visible to the human gate via workspace STALE markers, but the E2E test name "upstream edit stales snapshot" overstates what is asserted. Remediation: typed conflict handling on version collision; expose chain-level staleness at the acceptance gate; correct the test name.

## 6. Verdict

**GO** for merging PR #25 at exact SHA `6dddbf8c3afa2589f7a5cba488055c6be23cfaf0`.

Rationale: every mandatory acceptance criterion I could execute was executed and passed at this SHA (typechecks, 4 test lanes, real-browser E2E, real-PostgreSQL persistence, independent adversarial probes, test-suite integrity, exact-head CI). No P0/P1 finding exists. No existing suite was weakened. No paid provider call was made (no credential present; fixture modes; zero ledger movement). External-catalog pricing verification and live writer acceptance (Phase 9) remain explicitly open and are correctly disclosed as such by the builder; they gate live production writer usage, not this merge. The six P2 findings should be carried into the next appropriate workstream (P2-2 doc correction is the most user-visible) and must not be opportunistically bundled into this PR per AGENTS.md merge governance.

---

# Remediation re-verification at SHA `23919ed9bae6e7e5bda27bf786c0b1d8ff42a885`

- Date: 2026-09-12
- Verifier: the SAME independent QA engineer who produced this verdict (self-remediation of my own P2 findings only; no scope expansion).
- Remediation candidate: `23919ed9bae6e7e5bda27bf786c0b1d8ff42a885`
  (one coherent commit on `feat/content-writer-v0` on top of the audit commit
  `98fbf89`; the QA lanes and probes below were executed against exactly this
  content; working tree clean; NOT pushed, NOT merged).
- Remediation diff vs candidate `6dddbf8`: 13 files, +616/−85. No P2 finding
  was fixed by weakening anything; see integrity note below.

## R1. P2 → fix → proving test → re-verified evidence

| Finding | Fix (exact change) | Proving test | Re-verified evidence |
| --- | --- | --- | --- |
| **P2-1** `compileSnapshot` ignored `briefId` + unguarded `!` | `service.ts` resolves the param via new `WriterStore.briefById(projectId, briefId)`; requires it to be the CURRENT brief (`writer_artifact_stale` if superseded, `writer_artifact_not_found` if unknown); `!` removed; default no-param path byte-identical | `writer-snapshot-proposal.test.ts` "compileSnapshot honors an explicit briefId: must resolve to the CURRENT approved brief" (current-brief success binds that brief; older-brief id → stale; unknown id → not-found; no-param draft → `writer_policy_not_approved`) | Persistence lane PASS (86/86) |
| **P2-2** `noGapLineageAcknowledged` escape hatch unreachable | Draft-time implementation: `saveBriefDraft` accepts the flag; without a gap snapshot the default path still fails `content_gap_lineage_missing`; with the flag it drafts with NO gap lineage — flag persisted on the brief row, digest-bound (inside `contentBriefDataSchema` payload), carried through approval; flag while a gap exists fails `writer_approval_failed`; approval-time validation kept unchanged; API schema + Dashboard draft form wired (checkbox moved into the draft form, also sent at approval); docs §3 updated | Rewritten `writer-persistence.test.ts` "noGapLineageAcknowledged — default REQUIRED fails closed; explicit acknowledgement drafts+approves, persisted and digest-bound": proves BOTH paths — default-required fails closed (assertion preserved from the original test), explicit flag drafts → column=true, payload flag=true, `deterministicDigest(data)===digest`, approval WITHOUT flag fails, approval WITH flag approves, view shows flag, snapshot compiles from the no-lineage brief, and flag-with-gap-exists fails | Persistence lane PASS; operator lane PASS (draft-time flag passes strict validation and reaches the service); docs §3 updated in the same commit |
| **P2-3** `budget_invariant_violation` unmapped → sanitized 500 | `operator-errors.ts`: code added to `OPERATOR_ERROR_CODES` + mapped `budget_invariant_violation: 409` (and `writer_qa_conflict: 409` added for P2-4); `WRITER_ERROR_CODES` kept coherent | `writer-api.test.ts` "budget invariant violation maps to 409; QA conflict maps to 409; brief-draft acknowledgement passes through" | Operator lane PASS (48/48): invariant trip → HTTP 409 with the typed code, no longer `internal_error` |
| **P2-4** `saveQaReport` upsert orphaned accepted `qa_report_digest` | Insert-only: same proposal digest → idempotent-identical (FIRST stored report returned, `reused`), never replaced; different digest on an existing proposalId → typed `writer_qa_conflict` (409); `service.runQa` now always surfaces the PERSISTED report's verdicts; docs stage 6 updated | `writer-qa.test.ts` "report is insert-only — same-digest re-run idempotent; accepted view digests populated and never orphaned": double-run returns same reportId/digest with exactly 1 row; after changing the writer policy (fresh recompute would FAIL on forbidden "roof") the stored PASS report/digest/verdicts are unchanged and the accepted row's `qa_report_digest` still resolves | Persistence lane PASS |
| **P2-5** accepted-content views returned `""` digests | `acceptContent` returns the stored `proposalId`/`proposalDigest`/`qaReportDigest` (insert + idempotent paths); `latestAcceptedContent` selects them; service views + Dashboard client type + Accepted section now show proposal and QA binding digests | Same `writer-qa.test.ts` test as P2-4: accept response and `acceptedContentWorkspace` both carry the three digests matching the stored proposal and report | Persistence lane PASS; E2E journey re-ran green with the new Dashboard display |
| **P2-6a** concurrent acceptance could 500 on version-collision | `acceptedPageContent` insert wrapped: PG `23505` → typed `content_accept_failed` (409) "Concurrent acceptance conflict… retry" | `writer-qa.test.ts` "concurrent acceptance of two slugs never 500s — typed content_accept_failed, contiguous versions": two slugs' proposals QA'd then accepted concurrently; every rejection (if any) is the typed code; accepted rows contiguous from v1, no duplicates, one per slug | Persistence lane PASS |
| **P2-6b** acceptance verified only the snapshot binding | `acceptContent` (in-tx) now verifies the TRANSITIVE chain: bound brief still approved at the exact digest; latest accepted ProjectInputSnapshot id+digest unchanged; approved Writer Policy digest unchanged; accepted gap snapshot digest unchanged (when present) → else `writer_artifact_stale`; docs stage 7 updated | `writer-qa.test.ts` "acceptance verifies the TRANSITIVE upstream chain (policy, gap, intake) and rejects stale with writer_artifact_stale": policy digest mutated → stale; gap digest mutated → stale; chain restored → acceptance succeeds (default path unchanged); new accepted intake v2 → even idempotent same-digest re-acceptance rejected stale | Persistence lane PASS |
| **P2-6c** E2E test name overstated the assertion | Renamed to "…upstream edit marks artifacts STALE, v1 unchanged" (+ header comment) | — | E2E suite re-ran green with the corrected name |

## R2. Full QA re-execution at `23919ed` (exact counts)

| # | Check | Command | Observed |
| --- | --- | --- | --- |
| 1 | Contracts typecheck | `npx tsc --noEmit` (packages/contracts) | PASS (exit 0) |
| 2 | Factory typecheck | `npx tsc --noEmit` (apps/factory) | PASS (exit 0) |
| 3 | Dashboard typecheck | `npx tsc --noEmit` (apps/dashboard) | PASS (exit 0) |
| 4 | Factory unit lane | `pnpm --filter @factory/factory run test` | **859 pass / 0 fail / 0 skipped** |
| 5 | Persistence lane (real PG 16, `factory_test`:54329, sequential) | `FACTORY_TEST_DATABASE_URL=… pnpm --filter @factory/factory run test:persistence` | **86 pass / 0 fail / 0 skipped** (was 82; +4 new proving tests) |
| 6 | Operator lane | `pnpm --filter @factory/factory run test:operator` | **48 pass / 0 fail** (was 47; +1) |
| 7 | Dashboard unit | `pnpm --filter @factory/dashboard run test` | **17 pass / 0 fail** |
| 8 | Real-browser E2E (all journeys) | `FACTORY_TEST_DATABASE_URL=… pnpm --filter @factory/dashboard run test:e2e` | **6 passed**, incl. the renamed Content Writer journey |

## R3. Adversarial probes re-run at `23919ed` (independent QA scripts, uncommitted)

| Probe | Observed at the new SHA |
| --- | --- |
| **A3** Budget double-spend (two independent PG pools, 2 USD limit vs 2×1.5 USD) | exactly **1 fulfilled / 1 `writer_budget_blocked`**; third-pool ledger read shows exactly one ACTIVE 1.5 USD row — **PASS** |
| **A1** Cross-project isolation (full project-A pipeline over real HTTP in fixture modes; project B attacks with A's policy/brief/snapshot/proposal ids) | policy-approve / brief-approve / snapshot-approve / generate / accept → all **404 `writer_artifact_not_found`**; B's workspace JSON contains **no** A artifact id/digest; legitimate A acceptance still succeeds afterwards — **PASS** |
| **A2** Forged well-formed 64-hex digests (wrong-digest re-approval of approved policy/brief/snapshot + wrong-digest acceptance) | all **409**: `writer_approval_failed` ×3, `content_accept_failed`; legitimate exact-digest acceptance succeeds — **PASS** |
| **A4** Override guard (real spawned `startOperatorServer` processes) | override+`FACTORY_ACCEPTANCE_MODE=true` → exit 1, no listen, "DEV MODEL OVERRIDE FORBIDDEN"; override+`CI=true` → same; `FACTORY_LIVE_PROOF`+fixture writer mode → exit 1, "LIVE PROOF REQUIRES PRODUCTION PROVIDER MODE"; controls: dev override **starts** with "DEV MODEL OVERRIDE ACTIVE" banner; acceptance without override starts — **PASS** |
| **A5** Fixture attribution (fixture-mode `POST /writer/generate` over real HTTP) | `provider="fixture"`, `model="fixture-writer"`, `overrideApplied=false`, `overriddenChampion=null`; never the champion; `writer_budget_reservations` delta during the whole fixture pipeline = **0** rows (and zero `openrouter` rows; no credential in env) — **PASS** |

## R4. Test-suite integrity of the remediation diff

`git diff 6dddbf8..23919ed -- apps/factory/tests apps/dashboard/e2e packages/contracts`: zero deleted files, zero `.skip/.only/xit`. The single replaced test is the P2-2 persistence test whose title asserted the OLD ("approval-time only") semantics that my own finding P2-2 prescribed correcting; its default-REQUIRED fail-closed assertion is preserved verbatim inside the rewritten test, which now ADDS the explicit-acknowledgement path (strictly stronger coverage). All other test changes are additive new proving tests. The two new error codes are additive contract entries (no exhaustive-union test existed that they could break; the existing `competitor-contract.test.ts` subset direction still holds).

## R5. Updated final verdict

**GO** at remediation SHA `23919ed9bae6e7e5bda27bf786c0b1d8ff42a885` (and therefore for the PR containing it).

All six P2 findings from my review at `6dddbf8` are implemented, each with a proving test, and all remain verified at the new SHA. No P0/P1 finding exists. No required suite was weakened. No paid provider call was made (no credential present; fixture modes everywhere; zero writer-ledger movement). The GO at `6dddbf8` is superseded by this GO at `23919ed`, which carries the P2 remediations. External-catalog pricing verification and live writer acceptance (Phase 9) remain open items gating live production writer usage, unchanged from the original verdict.
