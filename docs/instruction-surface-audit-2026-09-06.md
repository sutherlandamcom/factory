# Instruction alignment follow-up — 2026-09-06

This is a builder's source-alignment record, not independent QA or a new policy.
The [2026-09-04 audit](./instruction-surface-audit-2026-09-04.md) and
[2026-09-05 audit](./instruction-surface-audit-2026-09-05.md) remain unchanged.

## Verified baseline and boundaries

- Main: `d6eeaaa593e45be3be259feb9cda61fa8b6567c4`.
- PR #18 and PR #19 are merged. PR #21 is open at
  `433844a716b484e3b32f55c699d268ee253d7c60`; it is not part of this base.
- This follow-up changes documentation only: no application code, test suite,
  workflow, dependency, runtime prompt, provider policy or renderer change.
- Vercel / Macro Run 1.5 is not adopted.
- PR #19's GitHub reviews/comments contain no independent GO. None was found
  in the inspected repository records; an external review may exist.
  Correcting its CI report cannot retroactively create independent acceptance.

## Finding-to-correction matrix

| Finding | Correction / source evidence |
| --- | --- |
| README still describes test-DB fallback and open PR #18 | Describe `resolveTestDatabaseUrl()` in `apps/factory/tests/persistence/helpers.ts`: explicit URL, exact `factory_test` name, fail before connection |
| Incomplete local QA/browser instructions | Mirror root, Factory, Dashboard and site manifests and `.github/workflows/pr-ci.yml`; install both browser workspaces and enumerate all four QA commands |
| Architecture omits Dashboard workspace/check/build/tests | Four workspaces, actual QA split, ten tables including intake; verified against manifests and persistence schema |
| Coding runtime/attempt wording remains misleading | Integrity follows the selected worker; three total attempts including initial implementation, consistent with `executor/router.ts` |
| First-Site Intelligence deferred paragraph appears current | Preserve paragraph under explicit historical heading with current roadmap/PR navigation |
| Roadmap/handoff still direct readers to pre-merge state | Add new dated status; preserve old snapshot and original prompt; do not claim open Search candidate exists on main |
| PR #19 still says CI pending | Correct GitHub report with exact original candidate CI and distinguish its narrower pre-Operator suites from current main |

## Verification and handoff

Local source checks cover relative Markdown file targets, balanced code fences,
exact mount set, documented script names, preserved original handoff/history,
and documentation-only diff/whitespace. The follow-up PR records their observed
results, candidate SHA and exact-candidate CI URL; this file does not claim a
future CI result.

Baseline [CI](https://github.com/sutherlandamcom/factory/actions/runs/33998967648)
ran at the exact main SHA above: Factory 582, Dashboard 6, persistence 34,
Operator 31, Operator browser E2E 2 passed; site-starter 8 passed / 2 skipped.
Baseline success is not verification of a later candidate. Full application
suites are run by repository CI, not by the local documentation-only snapshot.

Independent review remains a separate gate on the final follow-up SHA.
Builder completion does not authorize self-merge.
