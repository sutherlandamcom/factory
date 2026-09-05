# Factory instruction alignment audit — 2026-09-05

This is a dated evidence record, not a new policy layer or an independent QA
verdict. Governing precedence remains in [instruction-authority.md](./instruction-authority.md).
The [2026-09-04 audit](./instruction-surface-audit-2026-09-04.md) is preserved.

## Inspected state

- Accepted main: `c6c7e000caf9797398dc4e05642ed42a40e664d0` (PR #17).
- Open Operator Kernel [PR #18](https://github.com/sutherlandamcom/factory/pull/18):
  head `7ef24e55417038d4b53201944f83fd13d7d34c06`, not merged.
- Its [GitHub CI](https://github.com/sutherlandamcom/factory/actions/runs/33987804364)
  reports success. GitHub reviews were empty at inspection; no independent GO
  was established by this audit. An external review may exist elsewhere.
- PR #18 now restores site-starter QA and adds Operator security/preparation
  and browser E2E suites to CI. Earlier findings against `0266e9a9` are not
  automatically findings against this new candidate.
- Root `AGENTS.md` is the only AGENTS file in the inspected base tree.

## Changes and their evidence

| Surface | Correction | Evidence / boundary |
| --- | --- | --- |
| README isolation setup | Four exact mounts; prerequisites separated by operation/runtime | `apps/factory/src/executor/isolation.ts` / `expectedColimaMounts`; existing Kimi/Claude policy and worker images |
| README tests and versions | Frozen installation; manifest/lockfile authority; actual QA composition and explicit test DB selection | Root/site manifests, base CI workflow and base vs PR #18 persistence helpers |
| README delivery | Workers Static Assets identified explicitly | `sites/starter/wrangler.jsonc` and `apps/factory/src/delivery/wrangler.ts`; no hosting migration |
| Architecture record | Correct v0.1 model policy, active Kimi/Claude coding routing, legacy Codex scope and historical deferred lists | Executable policy/router, existing SiteProfile and production packet/projection code |
| Constitution / roadmap | Accepted policy status distinguished from implementation status | Authority assigned by merged PR #17; no new provider/renderer decision |
| Roadmap / Macro Run 1 handoff | Dated PR/SHA status; existing candidate must be inspected before continuing | Live PR metadata, changed paths and CI; not a replacement for independent QA |
| AGENTS | Exact criterion/command/result/SHA evidence, additive regression coverage, real browser journey requirements, scoped reading | Makes existing acceptance intent explicit; does not itself execute or enforce CI |
| Instruction authority | Precedence vs reading order clarified; old handoffs require live-state checks | Existing hierarchy retained; dated status is navigation, not operational truth |
| ProductionSpec | Transitional design/content role and historical Next Steps clarified | Current production contracts remain unchanged; future authority stays with approved providers/artifacts |

## Remaining boundaries

- Accepted base still has an implicit localhost persistence-test fallback.
  Operators must explicitly choose a dedicated test database; fail-before-
  connection enforcement exists in PR #18 and is not claimed merged here.
- New Operator architecture prose is already part of PR #18. This docs change
  preserves that separate work rather than copying its candidate into main.
- Search, writer, design, assets and full operator delivery are planned slices;
  existing model/eval role names are not production acceptance evidence.
- Vercel / "Macro Run 1.5" remains an unadopted topology proposal. Current
  generated-site rendering, providers, execution and deployment behavior are
  unchanged.
- No runtime prompts, model policy, tests, manifests, CI workflow, migrations
  or application code are changed by this documentation task. Historical
  reports and their original findings remain intact.

## Verification scope

Review this docs candidate for exact source alignment, valid relative links,
preserved historical text, consistent statuses and documentation-only scope.
Check mount instructions against the trusted implementation; do not weaken the
implementation to match an example. Run required repository CI on the exact
candidate and report its result separately from local documentation checks.
Application/DB/browser behavior is not independently re-certified by a docs
audit. Builder self-review must never be presented as independent GO.
