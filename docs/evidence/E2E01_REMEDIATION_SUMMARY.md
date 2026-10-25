# E2E-01 integrated remediation

Status: **FINAL REMEDIATION PASS — READY FOR INDEPENDENT REVIEW**
(See QA report limitations: independent executed acceptance and external gates
remain open; this verdict covers exactly-Sha'd local mandatory checks only.)

Branch: `fix/e2e01-final-remediation` (continuation of
`fix/e2e01-integrated-remediation`, merged to `main` via PR #48 as merge commit
`16b0b952c16b3a9b68f303c92035615891cf22c1`; the user authorized the agent-merge
in the working session, recorded here as a governance exception — AGENTS.md
normally reserves merging to a human authority). Post-remediation state retains
the delivery safety baseline: no deployment, no paid provider call, no
production database access (merges expressly authorized by the user only).

Baseline for this final stage: merged `main` at `16b0b95…` (post-merge CI run
`40188839863` green). Final candidate: **`d479512…`
(d479512 + docs updates; clean tree battery, superseding `f45058f…` and
`49a223c…`/`b44ec64…` history — the exact final SHA is re-stated at the bottom
after the doc commits).**

## Changes

Original remediation (73 files, unchanged through `85259f8`): trusted
project-site binding, Search context enforcement, Unicode intent
normalization, exact CTA binding, profile navigation, numeric claim coverage,
Stark/Russian fixture journey.

FINAL-STAGE updates (E2E-01 adversarial review round, exact SHA `d479512`):

- **P1-A SourceRef isolation (`packages/contracts/src/trust-governance.ts`):**
  `claimLineageProblems` now evaluates numeric-figure substantiation and
  actor-action alignment PER SourceRef unit. A figure that appears only in an
  unrelated second excerpt no longer launders support for the first excerpt;
  an actor fragment in one ref plus a verb fragment in another never fuses
  into a supported pairing. RED→GREEN: F-01 (EN fusion), F-02 (RU fusion),
  F-03 (figure laundering), F-06 (cross-ref pairing) failed with `[]` first;
  positive controls F-04/F-04b/F-05 preserved both single-ref and
  multi-source-with-independent-support shapes. Lock file:
  `apps/factory/tests/e2e01-sourceref-isolation.test.ts` (7 cases).
- **P1-B Unicode negation (same file):** the negation guard was DEAD for
  Cyrillic — JavaScript `/\b(?:не|нет)\b/` uses ASCII-only `\b` and never
  matched («не построило», «не инвестировало» were, at best, rejected
  accidentally via stopword windows). Replaced with
  `negatedCyrillic` (lookaround `(?:^|[^а-яёА-ЯЁ])(?:не|нет)(?![а-яёА-ЯЁ])`,
  comma/parenthetical insertion tolerance ≤24 chars for «не, впрочем,
  построило» / «не-смо́г инвестировал», 40-char distance window) and
  `negatedEnglish` (do-support "did/does/was/were/have/has/had not <verb>",
  bare "not <participle>", fronted "Not <X> but <Y> <verb>" anti-attribution).
  Negated occurrences become `tense: "intent"` (support nothing); empty-actor
  pair windows are dropped. New locks:
  `apps/factory/tests/e2e01-negation.test.ts` (16 cases incl. RU-NEG-01..05,
  EN-NEG-06/07, CLAIM-NEG-08, POS-09..15, CALC-16).
- **Adversarial probe battery A1..A8 (author-executed adversarial tier):**
  probes A1 (split-figure), A2 (punctuated fragment), A5 (stopword window),
  A6 (intent-vs-past), A7 (composite-subject one-sided support) all FAIL
  closed; A3a (hyphenated negation), A3c (comma negation) and A8 (figure via
  calculationRef on a FIRST_PARTY_FACT claim) were confirmed BYPASSES and are
  now fixed/closed: A8 imposes `calculation_ref_claim_type_mismatch` — a
  calculationRef substantiates figures only for CALCULATION-type claims.
  A3b/A4b locks document NOT-over-suppression boundaries. Raw output:
  `.factory/e2e01/phase3/logs/probe-battery-a-output.txt` (runtime evidence,
  gitignored).
- **P1-C source ownership (probe-first, NO new provenance system):** three
  adversarial transplant cases
  (`apps/factory/tests/persistence/e2e01-source-transplant.test.ts`, TP-01..03
  on the dedicated Phase 3 PostgreSQL container `factory-e2e01-ph3-pg`, port
  54351): B cannot read A's lineage rows even with A's exact digest and page
  identity strings; a verbatim-excerpt transplant leaves B without ANY review
  (A's approval never crosses projects); B's stored claim stands only on B's
  own evaluation. Verdict: the existing boundary holds — no bypass proven, so
  per the prompt's anti-over-engineering rule NO refactor was made; the
  probes are additive regression coverage on top of XP-01..08.
- **Phase 3 groundwork (read-only):** separate acceptance probe environment
  provisioned (phase3/, isolated PG 54351); Cloudflare mutations remain
  NOT AUTHORIZED.

## Verification summary (exact SHA at final candidate)

| Suite | Result |
|---|---|
| `pnpm check` | exit 0 |
| `pnpm run build` | exit 0 (all packages + Astro site build) |
| Unit battery (`pnpm test`, Factory+Dashboard+site) | Factory 1192/1192, Dashboard 51/51, site 35 PASS; exit 0 |
| `test:persistence` (real PG 18 container :54351 `factory_test`) | 474/474 (includes P1-A per-ref matrix, P1-B 16-case negation, XP-01..08, TP-01..03, EN+RU attribution, 23-case RU unit matrix) |
| Playwright against built site (`pnpm --filter @factory/site-starter test`) | 35 passed |
| `gitleaks detect` | no leaks (exit 0) |
| `osv-scanner scan --lockfile=pnpm-lock.yaml` | exit 0 — **all six historical advisories RESOLVED** (upgraded in lock: `body-parser@1.20.9`, `fast-uri@3.1.9`, `zod@4.6.6`; nothing beyond scoped Vite dev-server exemptions in `osv-scanner.toml`) — supersedes the stale 2026-10-24 checkpoint note listing them as open |
| `pnpm qa` | exit 0 (check→build→test) |

CI: merged `main` `16b0b95…` green (run `40188839863`); the final
remediation-branch CI run is cited in the PR update at push time.

## Migration and compatibility

No schema changes in this final stage (`0042_search_context.sql` unchanged;
binding format stays `project-site-binding-v1`). Behavior changes are
fail-closed `claimLineageProblems` refinements only — existing FIXTURE-only
Sutherland claims and accepted multi-source claims were re-verified green
(1192 unit + 474 persistence).

## Attribution and project data

Intake remains a local single-operator workflow (`acceptedBy: operator`).
Stark/RusSilica personnel percentages and industrial-responsibility claims
remain unverified project data (P1-06: NOT A CODE DEFECT — PRIMARY SOURCE AND
HUMAN APPROVAL REQUIRED) and are excluded from production-approved evidence.
The attribution matrix uses fictional entities only.

## Onboarding condition (accurate classification)

Configuring a NEW Stark site remains a MANUAL, operator-performed step: a
test-isolated worktree with a reserved `.example.test` origin, a
`site-profile.json`, a registered PostgreSQL project/site row, and the exact
`project-site-binding-v1` file (`sites/starter/project-site-binding.json`).
Workspace inspection does NOT provision a deployment target; wrong-project,
missing, stale or changed bindings fail closed. One-click automatic site
provisioning does not exist and is not claimed. Deployment itself stays
behind E2E-G02 (authorized Cloudflare operations only).

## Evidence and remaining gates

- Issue matrix: [E2E01_ISSUE_REGISTER_RESOLVED.md](E2E01_ISSUE_REGISTER_RESOLVED.md)
  (now includes the restored E2E-G01/G02/G03 definitions).
- QA ledger: [E2E01_QA_EVIDENCE.md](E2E01_QA_EVIDENCE.md).
- Stark trace: [E2E01_STARK_GOLDEN_JOURNEY.md](E2E01_STARK_GOLDEN_JOURNEY.md).
- Binding/configuration details: [../production-project-site-binding.md](../production-project-site-binding.md).

Open external objectives remain unchanged: E2E-G01 (live provider pilot),
E2E-G02 (authorized Cloudflare deployment), E2E-G03 (Stark legal/source
approval, includes P1-06 verification). Independent executed acceptance of
the final SHA remains the next review step; adversarial self-review is
labeled explicitly in the QA report and must not substitute for it.
