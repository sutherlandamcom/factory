# E2E-01 integrated remediation

Status: **LOCAL REMEDIATION PASS — READY FOR INDEPENDENT REVIEW**
(See QA report limitations: independent executed acceptance and external gates
remain open; this verdict covers exactly-Sha'd local mandatory checks only.)

Branch: `fix/e2e01-integrated-remediation`. Post-remediation state retains the
original baseline semantics: no deployment, no paid provider call, no
production database access, no merge.

Baseline: clean local and remote `main` at
`82741c600aae5af1dd79f867374789b101a5b5cf`. Final functional candidate:
`e63d83938ca9ae2cb5681feb2ad04df1984a7db2` (clean tree, exact local battery,
superseding the earlier `794c3f4` checkpoint).

## Changes

Original remediation (73 files, unchanged in this update): trusted
project-site binding, Search context enforcement, Unicode intent
normalization, exact CTA binding, profile navigation, numeric claim coverage,
Stark/Russian fixture journey.

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

## Verification summary (exact SHA `e63d839`)

| Suite | Result |
|---|---|
| `pnpm qa` (check→build→test) | Factory 1150/1150, Dashboard 51/51, site 35 PASS (+35 conditional skips); exit 0 |
| `test:persistence` (real PG 18, `factory_test`) | 418/418, includes the 10-test attribution persistence layer |
| `test:operator` | 149/149 |
| `test:production` | 60/60 |
| Dashboard browser E2E (real built UI + PG) | 17/17; Run 11 golden reaches READY_FOR_DEPLOYMENT, staleness cascade recovers, Run 13 completes candidate→preview→approve→publish→rollback |
| `test:axe` / `test:keyboard` (Stark fixture artifact) | 4+4 PASS |
| `lhci autorun` | PASS (6 reports) |
| `gitleaks detect` | no leaks |
| `osv-scanner` | exit 0 |
| Attribution matrix | 17/17 across two layers |

CI run `40127181397` executes this exact commit (windows: single `qa` job —
OSV step previously SKIPPED must now execute after the green browser suite).

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
