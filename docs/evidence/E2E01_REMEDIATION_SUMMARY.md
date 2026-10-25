# E2E-01 integrated remediation

Status: **LOCAL REMEDIATION PASS — READY FOR INDEPENDENT REVIEW**
(See QA report limitations: independent executed acceptance and external gates
remain open; this verdict covers exactly-Sha'd local mandatory checks only.)

Branch: `fix/e2e01-integrated-remediation`. Post-remediation state retains the
original baseline semantics: no deployment, no paid provider call, no
production database access, no merge.

Baseline: clean local and remote `main` at
`82741c600aae5af1dd79f867374789b101a5b5cf`. Final functional candidate:
**`789b645b17760f91c3e3ce1fedada3b806da1318`** (clean tree, exact local
battery, superseding `49a223c2e1df56c2f18e7b6a9c3a951560454f85` — the older
candidate kept the EN-only attribution matrix and an overstated
wrong-project claim; parent `85259f8…` CI run 40134277879 was green).

## Changes

Original remediation (73 files, unchanged through `85259f8`): trusted
project-site binding, Search context enforcement, Unicode intent
normalization, exact CTA binding, profile navigation, numeric claim coverage,
Stark/Russian fixture journey.

Final updates (at `789b645`):

- **P1-04 Russian attribution coverage (Checkpoint D):** the deterministic
  action recognizer in `packages/contracts/src/trust-governance.ts` now
  covers Russian inflected actional verbs for the same six family IDs, the
  composed predicate «выполнило инженерное проектирование» (⇒ engineer),
  negation guard, passive-style actor candidates, intent/tense classes,
  legal-entity prefix gluing, bounded object binding via the post-verbal
  quoted facility name, and per-excerpt evidence isolation. English
  behavior preserved (full legacy matrix + 408-test legacy persistence green).
  RED→GREEN: 13/13 RU negative probes failed first with `got: []` under the
  EN-only matcher.
- **Genuine cross-project ownership tests (Checkpoint E):** new
  `apps/factory/tests/persistence/e2e01-cross-project-authority.test.ts`
  (XP-01/02/03/05/06/07/08) on a real migrated PostgreSQL 18 `factory_test`
  database. Verdict: protection is real and boundary-located — per-project
  lineage rows (empty under the other project), no review inheritance,
  digest-bound staleness, per-project audit-event guard
  (`cross_project_audit_event_rejected`). Honest limitation documented:
  intake-class SourceRefs are convention strings; Factory does not keep a
  generic persisted source registry for them.
- **Misleading test corrected:** the former unit probe "wrong-project
  source … still FAILS" asserted `claimLineageProblems(...)===[]` (a PASS)
  and never exercised project ownership; it is renamed to a documented
  boundary assertion with a truthful title, plus a new quoted-object
  wrong-facility reject case (object binding).
- **Dependency security (Checkpoint A, unchanged)**: all six OSV advisories
  resolved without suppression at the parent commits; re-verified exit 0 at
  the candidate with `osv-scanner.toml` byte-identical.
- **Test-harness isolation (accurate current state):** E2E this time ran on
  one real isolated Postgres.app 18.6 cluster (port 5433, fresh datadir,
  DB `factory_test` only), serially; the earlier container notes below are
  historical.

Final updates:

- **Dependency security (Checkpoint A):** resolved all six OSV advisories
  without suppression:
  - `fast-uri` 3.1.8 → 3.1.9 (bumped existing pin; 4 advisories),
  - `body-parser` add override `^1.20.9` (express 4.22.2 `~1.20.5`),
  - `zod` unified at 4.6.6 (`^4.4.3` specifiers, MCP client 2.3.1, astro),
  - scoped `@google/design.md>zod: 4.6.6` (its bundle embeds zod v3 at
    runtime; the single `lint()` import surface was typed explicitly),
  - `puppeteer-core: ^25.16.0` override → chromium-bidi 157 (`zod ^4.6.5`)
    without touching `lighthouse@12`/`@lhci/cli@0.15.1`; `lhci autorun`
    verified.
  - `minimumReleaseAgeExclude` updated for the three newly floating pins.
  - `osv-scanner scan --lockfile=pnpm-lock.yaml`: exit 0, "No issues found".
- **Test-harness isolation:** `scripts/truncate-test-db.ts` now reuses the
  persistence `resetTestDatabase` table list — budget ledger tables have no
  FK to `projects`, so prior E2E runs exhausted the daily fixture visual
  budget on shared long-lived test DBs. Fixture binding default
  `delivery.productionUrl` now agrees with the worktree site-profile
  canonical origin, matching the candidate-preview preflight rule.
- **P1-04 industrial attribution (Checkpoint B):**
  `claimLineageProblems` now requires the cited excerpt to pair the claim's
  actor with its actional verb family (invest/construct/engineer/operate/own/
  contract); a shared number or facility name no longer substantiates a
  misattributed actor. Deterministic, close to the existing M26 pattern, no
  AI, no new provenance tables.

## Verification summary (exact SHA `789b645b17760f91c3e3ce1fedada3b806da1318`)

| Suite | Result |
|---|---|
| `pnpm check` | exit 0, workspace clean |
| `pnpm qa` (check→build→test) | Factory 1167/1167, Dashboard 51/51, site 35 PASS (+35 conditional skips); exit 0 |
| `test:persistence` (real PG 18.6 :5433, `factory_test`) | 467/467 (includes EN matrix, RU-01..15+RUX-01 unit, 2 PG-RU, XP-01..08 cross-project layer) |
| `test:operator` | 149/149 |
| `test:production` | 60/60 |
| Dashboard browser E2E (real built UI + PG) | 17/17; Run 11 golden reaches READY_FOR_DEPLOYMENT, staleness cascade recovers, Run 13 completes candidate→preview→approve→publish→rollback (test-only boundary), Stark fixture journey `design_approval_failed` intact |
| `test:axe` / `test:keyboard` | 8 pass + 8 skips / 8 pass |
| `lhci autorun` | PASS (12 runs) |
| `gitleaks detect` | no leaks (328 commits) |
| `osv-scanner` | exit 0; `osv-scanner.toml` byte-identical |
| Attribution matrix | EN+RU 24/24 exec + XP 6-scenario PG suite |

CI: parent `85259f8…` green (run 40134277879). The candidate's own CI run is
cited in the PR description at acceptance time.

## Migration and compatibility

`0042_search_context.sql` remains backward-compatible (nullable
`search_runs.request_context`, no destructive backfill). Production contracts
retain historical manifest readers; binding format stays
`project-site-binding-v1` (`sites/starter/project-site-binding.json`).
Renderer policy identity `production-policy-v4`; Search context policy
`search-context-v1`. History recovery still uses persisted target authority.

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
