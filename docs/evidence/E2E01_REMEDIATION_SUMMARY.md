# E2E-01 integrated remediation

Status: **REMEDIATION PARTIAL — mandatory verification and independent acceptance pending.**

Baseline: clean local and remote `main` at
`82741c600aae5af1dd79f867374789b101a5b5cf`, no open PRs at baseline inspection.
Branch: `fix/e2e01-integrated-remediation`. No deployment, paid provider call,
production database access or merge is authorized or performed.

## Changes

- Added explicit repository-owned project/site/profile/accepted-identity/delivery
  binding; workspace reads no longer provision a deployment target. Shared
  backend/store validation binds new production input, candidate and QA identity.
- Preserved historical record readers and recovery against persisted target
  authority. Old evidence is not rewritten into new authority.
- Resolved Search language/geography from exact accepted Intake or explicit
  overrides; recorded provenance and policy version, extended cache identity,
  exposed readiness/defaults and reset stale Dashboard request state.
- Replaced ASCII lexical matching with deterministic Unicode normalization;
  empty intent cannot pass. Lexical alignment is not semantic or factual proof.
- Bound exact accepted CTA copy and verified destination into production
  authority; added accessible anchor semantics and destination/route QA.
  Unsupported forms fail closed until a governed form capability exists.
- Project navigation now comes from the bound profile/manifest and must resolve
  against candidate routes. No second navigation configuration was introduced.
- Fixed claim coverage that could authorize an added quantity through a matching
  substring. Existing source classification, exact content lineage and human
  review remain required; no claim or Intake array redesign was introduced.
- Added isolated Sutherland/Stark output fixtures and a Russian operator journey.
  Fixture provider evidence retains its classification throughout.

## Persistence and compatibility

Migration `0042_search_context.sql` adds nullable `search_runs.request_context`.
It has no destructive backfill. Historical Search rows read as unknown context.
Production contracts retain historical manifest readers; new bound manifests
require conversion, navigation and exact accepted-content authority. Renderer
policy identity is `production-policy-v4`; Search context policy is
`search-context-v1`. The trusted configuration format is
`project-site-binding-v1`. See [configuration instructions](../production-project-site-binding.md).

## Attribution and project data

Intake remains a local single-operator workflow (`acceptedBy: operator`). The
authenticated release/review actor boundary does not provide an authenticated
Intake identity, so no fictitious personal attribution or authentication platform
was added. Stark/RusSilica personnel percentages and industrial-responsibility
claims remain unverified project data and are not production-approved evidence.

## Evidence and remaining gates

The [issue matrix](E2E01_ISSUE_REGISTER_RESOLVED.md),
[QA ledger](E2E01_QA_EVIDENCE.md) and
[Stark trace](E2E01_STARK_GOLDEN_JOURNEY.md) distinguish implemented code,
executed verification, fixture proof, external dependency and independent QA.
Separate audit reports/register were unavailable. G01–G03 were referenced without
definitions; this remediation does not invent their meaning.

Independent review of the initial checkpoint `e841fc800c0808dbc3d8ae0eb114b6f55236fcfc`
returned CHANGES REQUIRED for form authority, numeric claim coverage, historical
rollback, mailbox encoding, country normalization and a masked negative test.
Corrections require review against the new exact functional candidate before GO.

No implementation-complete or independently-accepted claim is made while any
mandatory gate remains missing or failing. Leave the PR unmerged.
