# PR #25 Independent QA Plan — Macro Run 4 (Content Constitution + Opus Writer v0)

- Date: 2026-09-12
- Verifier: Independent QA (no involvement in building the code under review)
- Repository: `/Users/startupery/Documents/factory-girl`, branch `feat/content-writer-v0`
- Candidate under review: exact SHA `6dddbf8c3afa2589f7a5cba488055c6be23cfaf0`
  (verified via `git rev-parse HEAD` before plan writing; working tree clean)
- Governing policy read, in order: `AGENTS.md`, `docs/instruction-authority.md`,
  `docs/roadmap-vnext.md` §Macro Run 4, `docs/writer-pipeline-v0.md` (CLAIMS),
  `docs/audits/2026-09-12-macro-run-4-writer-qa-record.md` (CLAIMS).
- Rule: fail-closed. Absence of evidence is NOT evidence of quality. Any P0/P1
  or any unverified AGENTS.md acceptance criterion ⇒ NO-GO.

## 1. Scope — full diff `origin/main..6dddbf8`

`git diff --stat origin/main..6dddbf8`: **40 files, +7150 / −8**. The plan
covers ALL of them, not only the writer module.

**Contracts (packages/contracts)**
1. `src/writer-content.ts` (A) — writer artifact schemas + parsers
2. `src/operator-errors.ts` (M) — 13 new operator error codes + HTTP statuses
3. `src/index.ts` (M) — re-exports

**Factory backend (apps/factory)**
4. `src/writer/writer-store.ts` (A, 991 L) — policy/brief/snapshot/proposal/QA/accept persistence
5. `src/writer/service.ts` (A) — application service + prompt packet compiler
6. `src/writer/budget.ts` (A) — writer budget reservation ledger
7. `src/writer/provider.ts` (A) — writer provider boundary (OpenRouter champion)
8. `src/writer/fixture-writer.ts` (A) — deterministic fixture provider
9. `src/writer/qa.ts` (A) — deterministic QA triad
10. `src/models/policy.ts` (M) — `resolveRoleModel` override seam
11. `src/models/override-guard.ts` (A) — startup hard-fail guard
12. `src/models/pricing.ts` (M) — model-pricing-v0.3 (Opus 5, GLM 5.3-flash)
13. `src/operator/api.ts` (M) — 10 new writer endpoints
14. `src/operator/server.ts` (M) — writer wiring + startup override guard
15. `src/persistence/schema.ts` (M) — 6 new drizzle tables + override columns

**Migrations (drizzle)**
16. `drizzle/0010_writer_budget_and_override.sql` (A)
17. `drizzle/0011_writer_policy.sql` (A)
18. `drizzle/0012_content_brief.sql` (A)
19. `drizzle/0013_writer_snapshot_proposal_qa.sql` (A)
20. `drizzle/meta/_journal.json` (M)

**Factory tests**
21. `tests/writer-contract.test.ts` (A) 22. `tests/writer-budget.test.ts` (A)
23. `tests/models-override.test.ts` (A) 24. `tests/operator/writer-api.test.ts` (A)
25. `tests/persistence/writer-persistence.test.ts` (A) 26. `tests/persistence/writer-budget-persistence.test.ts` (A)
27. `tests/persistence/writer-qa.test.ts` (A) 28. `tests/persistence/writer-snapshot-proposal.test.ts` (A)
29. `tests/fixtures/writer-seeds.ts` (A) 30. `tests/persistence/helpers.ts` (M)
31. `tests/competitor-remediation.test.ts` (M — pricing version v0.2→v0.3)

**Dashboard (apps/dashboard)**
32. `src/api/client.ts` (M) 33. `src/pages/ContentPage.tsx` (A, 550 L)
34. `src/pages/ProjectDetailPage.tsx` (M — new "Content" tab)
35. `e2e/content-writer-journey.spec.ts` (A) 36. `scripts/operator-e2e-server.mjs` (M — fixture writer mode)

**Docs / misc**
37. `docs/writer-pipeline-v0.md` (A — claims doc) 38. `docs/roadmap-vnext.md` (M — status row)
39. `docs/audits/2026-09-12-macro-run-4-writer-qa-record.md` (A — builder QA record)
40. `.gitignore` (M — `/test-results/`)

## 2. Verification dimensions (each: concrete commands + PASS criteria)

### 2.1 Contract-level (item 1–3)
- C1 Schema strictness: every writer schema is `.strict()`, bounded
  (`max` on strings/arrays), `schemaVersion` literal-pinned. PASS: no
  `.passthrough()`, no unbounded string, version literal present.
  Command: manual read + `npx tsx --test tests/writer-contract.test.ts`.
- C2 Digest determinism: `deterministicDigest` = SHA-256 over canonical JSON
  (sorted keys, arrays preserved). PASS: same logical object → same digest
  regardless of key order; reproduced by an independent probe.
- C3 Fail-closed parsers: `parse*` reject unknown/extra fields, wrong digest
  shape, wrong version. PASS: probe with mutated payloads throws.
- C4 Typed error surface: every writer `FactoryError` code ∈
  `OPERATOR_ERROR_STATUS`; unexpected errors → sanitized `internal_error`
  (no stack/DB/provider text). Command: code read + API probe.

### 2.2 Security (OWASP-style scan of the diff)
- S1 Secrets: `OPENROUTER_API_KEY` read only server-side in provider preflight;
  never persisted, logged, or returned in any API response/browser artifact.
- S2 Browser-controlled plumbing: model id from `resolveRoleModel` (env/policy)
  only; provider mode from trusted server env only; no endpoint accepts
  model/env/provider from the request body (verify all 10 new endpoint schemas).
- S3 Operator-input injection: brief pageTarget/keyPoints flow only into
  digested artifacts + compiled prompt (server-side template); no SQL string
  concatenation (drizzle parameterized; check raw `sql\`\`` usages interpolate
  only constants/numbers).
- S4 Error leakage: non-`FactoryError` → fixed `internal_error` message.
- S5 SSRF: no new fetch of operator-supplied URLs (writer provider URL is
  gateway-owned; fixture provider performs no I/O).
- S6 Authorization/isolation: every new endpoint resolves the project first and
  every store query filters by `projectId` (verify each query in
  writer-store/budget/qa). Probe A: cross-project artifact access via direct
  HTTP.
- S7 Startup guard: override env in governed env → server refuses to start.
  Probe D.

### 2.3 Governance invariants (AGENTS.md)
- G1 No second SOT: writer policy is derived from the accepted intake snapshot;
  brief composes accepted material verbatim; no operator-editable copy.
- G2 Approval binds exact version+digest; approved artifacts immutable
  (draft→approved one-way; digest mismatch → `writer_approval_failed`).
- G3 Accepted state immutable: `accepted_page_content` insert-only; same-slug
  different-digest re-acceptance fails closed.
- G4 UI cannot bypass backend: every Dashboard action maps to a service command
  that re-validates; direct API without required approvals fails closed
  identically (probe B + API tests).
- G5 No silent semantic loss: no truncation of accepted material (grep
  `.slice/substring` — display-only digest previews and bounded QA windows
  allowed); strict schemas reject drift.
- G6 No paid AI call without trusted preflight: credential check + conservative
  authorization + durable reservation BEFORE provider call; unpriced model
  throws before reservation.
- G7 Provider secrets server-side (S1); lineage to exact accepted inputs/
  digests on every artifact (policy→intake, brief→intake+policy+gap,
  snapshot→brief, proposal→snapshot, QA→proposal, accepted→proposal+QA).
- G8 Models propose / Factory governs: writer output only enters as a
  validated `PageContentProposal` bound to the approved snapshot digest;
  provider cannot spoof binding (spread order + `.strict()`).

### 2.4 Data integrity
- D1 Migrations 0010–0013: constraints (state lifecycle, approved⇔approved_at,
  gap-lineage validity, uniqueness (project,version)/(project,slug)),
  indexes present, forward-only, drizzle journal updated.
- D2 Budget ledger lifecycle equivalence with 0009: ACTIVE→ACCOUNTED|RELEASED;
  ceiling-check + INSERT in one tx under `pg_advisory_xact_lock` (same lock
  key as competitor ledger — verify `FACTORY_BUDGET_RESERVATION_LOCK_KEY`);
  stale-reservation reconciliation; unknown cost → authorized amount; overrun
  → full accounting + `budget_invariant_violation`.
- D3 Staleness propagation across ALL lineage dimensions: intake→policy,
  intake/policy/gap→brief, brief(+newer approved brief)→snapshot,
  snapshot→proposal; verified at approve time AND in workspaces.
- D4 Concurrency: row locks (`.for("update")`) on approve/accept; advisory xact
  lock on reserve/account; idempotent same-digest re-approval; idempotent
  same-digest re-acceptance. Probe C: double-spend race via two PG pools.

### 2.5 Determinism
- DET1 Canonical-JSON digest stability (C2 probe).
- DET2 Prompt-packet compilation determinism: same brief+policy → byte-equal
  prompts → same snapshot digest.
- DET3 QA verdict reproducibility: same proposal+brief+policy → identical
  report digest across runs.

### 2.6 Adversarial probes (builder did NOT write these)
- A1 **Cross-project isolation (S6):** two projects; project B's token-space
  attempts to approve/generate/accept using project A's artifact ids via
  direct HTTP. PASS: 404/409 typed failures, no A data returned or mutated.
- A2 **Digest-binding with forged digests (G2/G3):** approve policy/brief/
  snapshot/accept content with a wrong-but-well-formed 64-hex digest. PASS:
  `writer_approval_failed`/`content_accept_failed`; nothing transitions.
- A3 **Budget double-spend race (D4):** two independent PG pools issue
  concurrent `reserveWriterBudget` with limit ~2×one reservation; PASS: exactly
  one reservation succeeds, the other gets `writer_budget_blocked`.
- A4 **Override guard (S7):** start operator server with
  `FACTORY_MODEL_OVERRIDE__CONTENT_WRITER` set and `FACTORY_ACCEPTANCE_MODE=true`
  → startup must hard-fail (non-zero exit / no listen).
- A5 **Fixture attribution (G8):** fixture-mode proposal must record
  `provider="fixture"`, `model="fixture-writer"`, `overrideApplied=false` and
  never the champion `anthropic/claude-opus-5` or `override_applied=true`.

### 2.7 Test-suite integrity (AGENTS.md "never weaken to obtain green")
- T1 `git diff origin/main..6dddbf8 -- apps/factory/tests apps/dashboard/e2e packages/contracts`
  — judge every deletion/modification. PASS: modifications are (a) pricing
  version bump v0.2→v0.3 in `competitor-remediation.test.ts` (required by the
  new pricing policy — the assertion is STRENGTHENED in coverage, not weakened)
  and (b) additive reset-table entry in persistence helpers. NO removals,
  skips, or assertion deletions. New suites ADD coverage.
- T2 No `.skip`/`.only`/`--test-name-pattern` filtering introduced.
- T3 Builder-claimed counts reproduced (claims-vs-evidence table).

### 2.8 Claims-vs-evidence audit
Every claim in PR body / `docs/writer-pipeline-v0.md` / builder QA record is
either independently reproduced below or marked **UNVERIFIED** (esp.: zero
paid calls; exact mechanism equivalence with migration 0009; live-vs-CI policy;
"deterministic QA green"; E2E journey including restart + staleness).

## 3. Severity definitions

- **P0** — Governance/security breach: accepted-material bypass, cross-project
  data leakage, secret exposure, UI/backend divergence in fail-closed behavior,
  budget double-spend possible, silent semantic loss of accepted content.
- **P1** — Invariant broken but with a compensating gate that still fails
  closed, or a claimed acceptance criterion that cannot be verified /
  reproduced at this SHA; any weakening of a required test suite.
- **P2** — Dead/misleading code or doc-vs-behavior mismatch in the fail-closed
  direction, cosmetic leaks of internal detail, minor robustness gaps
  (e.g. unhandled 500 on malformed-but-typed input) that do not breach
  governance.

## 4. Execution checklist

| # | Plan item | Command / method | Evidence line |
| --- | --- | --- | --- |
| E1 | SHA verify | `git rev-parse HEAD` | Phase B log |
| E2 | Diff enumeration | `git diff --name-status origin/main..6dddbf8` | §1 above |
| E3 | Typechecks | `npx tsc --noEmit` in packages/contracts, apps/factory, apps/dashboard | B-log |
| E4 | Factory unit lane | `pnpm --filter @factory/factory run test` | B-log |
| E5 | Persistence lane (real PG) | `FACTORY_TEST_DATABASE_URL=postgresql://postgres:factory@localhost:54329/factory_test pnpm --filter @factory/factory run test:persistence` | B-log |
| E6 | Operator lane | `pnpm --filter @factory/factory run test:operator` | B-log |
| E7 | Dashboard unit | `pnpm --filter @factory/dashboard run test` | B-log |
| E8 | Real-browser E2E | `FACTORY_TEST_DATABASE_URL=… pnpm --filter @factory/dashboard run test:e2e` | B-log |
| E9 | Probes A1–A5 | independent TS scripts (not committed unless required) | B-log |
| E10 | Test-suite integrity | T1 diff review + skip scan | B-log |
| E11 | Determinism DET1–DET3 | probe script | B-log |
| E12 | Contract probes C1–C4 | probe script + suite reads | B-log |
| E13 | Security scan S1–S7 | code read + greps + probes | B-log |
| E14 | Governance G1–G8 | code read + probes | B-log |
| E15 | Data integrity D1–D4 | migration read + PG introspection + probe A3 | B-log |
| E16 | Claims audit | reproduce each claim or mark UNVERIFIED | verdict table |

Constraint: no paid provider call; no code fixes; probes live under
`/var/folders/.../kilo` temp dir and are committed only if classified as
required regression coverage.
