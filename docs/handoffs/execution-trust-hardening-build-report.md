# Execution Trust Hardening build report

Date: 2026-08-29  
Branch: `fix/execution-trust-hardening`  
Status: **blocked**  
Exact blocker: `STRONG_EXECUTION_ISOLATION_UNAVAILABLE`

## Lineage and commits

- Starting SHA: `a703bf250c2bf6b9adc2d41847c5de19a913e880`.
- Audit provenance commit: `690dd371f42b51097beca01de419511d3436d334` (`docs: record pre-repair cross-stage audit`). This commit contains only the previously untracked cross-stage audit.
- Ending implementation SHA: `6be73369c269cc86c6dbc2de2f7b9d6eea861be0`.
- Final documentation commit: the commit containing this report; record its SHA from Git after the commit is created.
- `foundation-v0` remains an annotated tag object at `7b6271434a270f9e20226309cb9716cf79b061a4`, peeling to accepted commit `e25f0520f7e3393a746e100665e9da633ea96d86`. No tag or existing history was rewritten.
- The binary-safe, full-index, no-renames cumulative implementation diff from the starting SHA through `6be7336` hashes to `a2e50e4179d130ae8305ceda85c7da992949e7fa2cb3512ec110117790a08924` (SHA-256).

Implementation commits after the audit baseline:

1. `a4fcf54c21b0dc72285d3573e0eaa5d304414b74` — execution isolation, exact scope/type evidence, ignored-state integrity, dynamic QA, semantic verification, result contracts, and regression tests.
2. `9c66971c2bdfa636fbf1a7353a1e609a251d753b` — minimal current-module registry and immutable task write policy.
3. `fd090941dadbb8baff029ad3b1f827336ce37a2f` — self-identifying dynamic QA gate evidence and 12-defect matrix.
4. `6be73369c269cc86c6dbc2de2f7b9d6eea861be0` — explicit preview-daemon teardown for the intentionally failing matrix.

## Audit remediation mapping

| Audit finding | Implemented control | Deterministic evidence |
| --- | --- | --- |
| `AUD-001` generated-page QA bypass | Factory-owned task spec plus desktop/mobile route QA after the full Foundation gate | 12/12 injected defects rejected; 0 false passes |
| `AUD-002` rename parsing bypass | NUL-delimited raw Git plumbing, `--no-renames`, and evaluation of every delete/add/modify path | Rename, copy, deletion, binary, whitespace, Unicode, tab, and newline tests pass |
| `AUD-003` symlink/type bypass | Git-mode plus `lstat` checks; only regular non-executable `100644` at the exact target is accepted | External/denied symlink, executable, gitlink, and special-path tests pass |
| `AUD-004` host-read exposure | Production runner fails closed before worktree creation when strong isolation is unavailable | CLI run ends at `isolation` with zero attempts and the exact blocker |
| `AUD-005` title substring verifier | Dependency-free semantic extraction over fresh built HTML | Exact title/H1/meta/canonical tests reject comment, script, JSON, footer, and body-only appearances |
| `AUD-006` ignored-state mutation | Pre/post hashed manifests for ignored and build-affecting state | `.env`, ignored configuration, `.astro`, and `node_modules` tampering tests pass terminally |
| `AUD-007` broad semantic write scope | Task policy derives exactly one page source path from the validated slug | Homepage, service, article, nested slug, unrelated page, component, executor, contracts, QA, and repository-policy tests pass |

## Module and write policy

The registry contains only modules present in this repository: `contracts`, `control-plane`, `site-source`, `site-configuration`, `quality-oracle`, and `repository-policy`. Accepted contracts, executor/security code, site configuration, QA, and repository policy are protected by default. A validated `create_page` task can read registered modules but can write only its exact derived page:

- `/` → `sites/starter/src/pages/index.astro`
- another valid slug → `sites/starter/src/pages/<slug-without-leading-slash>.astro`

Task content cannot declare, replace, or widen this policy. Prompt authorization and post-execution enforcement consume the same immutable policy object: **READ MANY / WRITE FEW**.

Execution-time filesystem mounts remain unavailable with the missing isolation backend; the production path therefore stops before Codex rather than relying on post-execution checks. Deterministic injected runners exercise the same policy through NUL-safe Git/type validation. Database-backed freezes, module-version services, dependency graphs, approval workflows, future-module placeholders, and cross-module migration workflows are intentionally deferred; future modules register only when implemented.

## Verification evidence

All exit evidence below was collected independently from the primary checkout unless the row says it used a disposable worktree.

| Gate | Exit/result | Evidence |
| --- | --- | --- |
| Contracts check | 0 | `pnpm --filter @factory/contracts run check` |
| Repository check | 0 | `pnpm check`; Astro reported 18 files, 0 errors, 0 warnings, 0 hints |
| Repository build | 0 | `pnpm build`; four static pages built |
| Repository test | 0 | `pnpm test`; 76 Factory tests and 8 Foundation Playwright tests passed; 2 task-aware tests skipped as designed without a Factory spec |
| Full composite QA | 0 | `pnpm qa`; check, build, 76 Factory tests, and 8 Foundation Playwright tests passed; 2 expected no-spec skips |
| 12-defect matrix | 0 | Disposable detached worktree; 12/12 rejected, 0 false passes; artifact `.factory/acceptance/quality-matrix.json` |
| Bounded repair regression | pass inside Factory suite | Attempts 1–3, exhaustion, terminal scope/integrity/isolation behavior, 8 KB reports, secret scrubbing, no-progress, cumulative patch, and cleanup are covered by the 76-test suite |
| Legacy real-repair acceptance | 1, blocked as required | Run `run-2026-08-29T13-56-41-126Z-1992f0`; Attempt 1 produced a repairable Foundation failure, then the real runner returned the isolation blocker without host execution |
| Production CLI isolation probe | 1, blocked as required | Run `run-2026-08-29T13-42-23-794Z-558f8f`; `finalStage=isolation`, `totalAttempts=0` |
| Stale-server behavior | 1, expected fail-closed | A deliberate preview on port 4321 caused Playwright to stop with `http://localhost:4321 is already used`; `reuseExistingServer=false` |
| Secret artifact scan | no matches | Synthetic secret values and names were absent from `.factory/runs` and `.factory/acceptance`; `rg` returned 1 for both searches |
| Cleanup | clean | The matrix rerun left no detached worktree and no port-4490 preview process; the primary Git worktree was clean before this report |

Dynamic gate identity is preserved in failure output as `FACTORY_QA_GATE=<gate> route=<route> project=<project>`. Separate Foundation and dynamic QA logs, task specs, integrity manifests, raw NUL Git evidence, binary patches, task verification, failure reports, and attempt results are retained beneath `.factory/runs/<runId>/attempts/`.

## Acceptance disposition

Implemented remediations that do not require unavailable host infrastructure are complete and deterministic gates pass. No software or dependency was installed, no dependency or package manifest changed, no deployment/persistence/research/SEO/product scope was added, and nothing was pushed.

The following live gates are **NOT VERIFIED** and must not be claimed as passed:

1. Real isolated `create_page` success.
2. Real Codex repair after a dynamic QA failure.
3. Real host read/write canary isolation inside the approved runtime.

No supported Docker, Podman, nerdctl, Colima, Lima/limactl, or Finch runtime was available during acceptance. The correct final status is therefore **blocked**, with exact blocker `STRONG_EXECUTION_ISOLATION_UNAVAILABLE`; this sprint does not claim 7/7 completion.
