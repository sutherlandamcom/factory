# Execution Trust Hardening build report

Date: 2026-08-30

Branch: `fix/execution-trust-hardening`

Status: **implementation complete; pending independent QA**

## Lineage and commits

- Sprint starting SHA: `a703bf250c2bf6b9adc2d41847c5de19a913e880`.
- Continuation checkpoint: `70dd972bd94a01142e22ef716a76facf8393534c`.
- Audit provenance commit: `690dd371f42b51097beca01de419511d3436d334`; it contains only the previously untracked cross-stage audit.
- Ending implementation SHA: `f650fb3b14ae57e59c6503d066d2b26d10e92270`.
- Final documentation commit: the commit containing this report, discoverable without history rewriting with `git log -1 -- docs/handoffs/execution-trust-hardening-build-report.md`.
- `foundation-v0` remains annotated tag object `7b6271434a270f9e20226309cb9716cf79b061a4`, peeling to accepted commit `e25f0520f7e3393a746e100665e9da633ea96d86`.
- The binary-safe, full-index, no-renames cumulative implementation diff from the sprint start through `f650fb3` has SHA-256 `30261130be18470b7e3d6d59fc29dbf7420076de2d0c4bbcc9f099faa6314c7f`.

Implementation commits after the audit baseline:

1. `a4fcf54c21b0dc72285d3573e0eaa5d304414b74` — exact scope/type evidence, ignored-state integrity, dynamic QA, semantic verification, result contracts, and regressions.
2. `9c66971c2bdfa636fbf1a7353a1e609a251d753b` — current-module registry and immutable task write policy.
3. `fd090941dadbb8baff029ad3b1f827336ce37a2f` — self-identifying dynamic gate evidence and the 12-defect matrix.
4. `6be73369c269cc86c6dbc2de2f7b9d6eea861be0` — explicit preview-daemon teardown for the intentionally failing matrix.
5. `aa6c6f399e442a289578c460c4f52907f89575c6` — dedicated Colima/Docker Codex execution boundary and live isolation acceptance.
6. `f650fb3b14ae57e59c6503d066d2b26d10e92270` — corrected wrong-H1 live repair fixture so the first attempt has exactly one injected defect.

## Audit remediation mapping

| Finding | Implemented control | Acceptance evidence |
| --- | --- | --- |
| `AUD-001` generated-page QA bypass | Factory-owned JSON task spec; separate desktop/mobile dynamic QA after the full Foundation gate | 12/12 defects rejected, 0 false passes |
| `AUD-002` rename parsing bypass | NUL-delimited Git plumbing, `--no-renames`, every delete/add/modify path, escaped JSON plus raw and binary-safe evidence | Rename, copy, deletion, binary, whitespace, Unicode, tab, and newline regressions pass |
| `AUD-003` symlink/type bypass | Git modes plus `lstat`; only regular non-executable `100644` at the exact target | External/denied symlink, executable, gitlink, and unsupported-mode regressions pass |
| `AUD-004` host-read exposure | Dedicated QEMU VM with only two exact host mounts and a hardened non-root Docker worker; preflight fails closed on drift | Live canary passed at `.factory/acceptance/isolation-4d0b4462ea52/result.json` |
| `AUD-005` title substring verifier | Dependency-free semantic extraction over newly built HTML | Exact title/H1/meta/canonical regressions reject comments, scripts, JSON, footer, and body-only appearances |
| `AUD-006` ignored-state mutation | Pre/post hashes of modes, symlink targets, and contents for ignored/build-affecting state | `.env`, ignored config, `.astro`, and `node_modules` tampering fail terminally |
| `AUD-007` broad semantic write scope | Validated slug derives one immutable target page; prompt and verifier share the same policy | Homepage, service, article, nested slug, unrelated path, and protected-module regressions pass |

## Runtime and isolation boundary

The dedicated `factory-sandbox` profile runs Colima 0.10.3 with QEMU, Docker client 29.7.2, Docker Linux server 29.5.2, 4 CPUs, 8 GiB memory, a 30 GiB data disk, and a 20 GiB root disk. Kubernetes, automatic context activation, SSH-agent forwarding, SSH configuration changes, and port forwarding are disabled. Its only host mounts are `.factory/worktrees` and `.factory/codex-runtime`; effective `findmnt` inspection confirmed that the repository root, home directory, `/Users`, and host temporary directory are not shared.

The pinned worker installs `@openai/codex@0.150.1` and runs non-root with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, process/CPU/memory limits, container-local temporary filesystems, no host sockets, read-only worktree access, and a writable overlay for the validated target page's parent directory. Factory's exact Git path/mode and ignored-state checks remain authoritative because atomic editor writes require parent-directory write access. The dedicated VM enables unprivileged user namespaces and the worker uses unconfined seccomp/AppArmor profiles solely so the inner Codex sandbox can establish its own user/mount namespace; this is an explicit residual, bounded by the VM filesystem boundary and the remaining container restrictions. Only minimal Codex auth is mounted read-only and copied into an ephemeral worker home.

No project dependency, manifest, or lockfile changed. Colima, Docker CLI, Lima, and QEMU were installed on the host under the sprint's explicit runtime authorization; a temporary Homebrew build prerequisite and tap were removed afterward.

## Dynamic and semantic acceptance

The task-page oracle checks HTTP success, page/console errors, exact title/H1/meta/canonical/Open Graph/JSON-LD identity, requested CTA/FAQ, bounded same-site links and fragments, local image accessibility/dimensions/responsiveness/alt semantics, mobile overflow, and meaningful body text. Failures identify gate, route, project, requirement, expected value, and actual value. Foundation and dynamic outcomes and artifacts remain separate while aggregate QA compatibility is preserved.

The 12-defect matrix at `.factory/acceptance/quality-matrix.json` rejected all defects with no false passes: missing and duplicate H1, missing description, missing Open Graph data, malformed JSON-LD, missing CTA, broken internal link, runtime error, missing image alt, missing dimensions, mobile overflow, and empty body. Catching gates were respectively `h1-count`, `description`, `og:title`, `json-ld-parse`, `cta`, `internal-link`, `page-errors`, `image-alt`, `image-width`, `horizontal-overflow`, `h1-count`, and `meaningful-body`.

## Live acceptance runs

| Acceptance | Result | Artifact |
| --- | --- | --- |
| Host read/write and environment canary | Pass: outside read/write blocked, worktree read allowed, zero synthetic leaks, zero orphan containers | `.factory/acceptance/isolation-4d0b4462ea52/result.json` |
| Real isolated create-page with repair | Pass on attempt 2 after dynamic JSON-LD identity failure on attempt 1 | `.factory/runs/run-2026-08-30T08-37-24-820Z-ddc278/` |
| Wrong-H1 dynamic failure and real Codex repair | Pass on attempt 2; attempt 1 passed Foundation and failed only dynamic H1 validation | `.factory/runs/run-2026-08-30T09-12-00-492Z-c2a058/` |
| Three-attempt ceiling | `needs_review` after exactly three failing attempts; no fourth attempt | `.factory/runs/run-2026-08-30T09-20-33-032Z-ffff6a/` |
| 12-defect matrix | 12 rejected, 0 false passes | `.factory/acceptance/quality-matrix.json` |

Each task attempt retains the Factory task spec, separate Foundation/dynamic logs, bounded scrubbed failure report, integrity manifests, escaped changed paths, raw NUL Git evidence, binary patch, semantic result, and attempt result. Cleanup ran on success, repair, exhaustion, and terminal failures.

## Verification evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Contracts check | Exit 0 | `pnpm --filter @factory/contracts run check` |
| Factory tests | Exit 0 | 80/80 tests passed |
| Repository check | Exit 0 | Astro checked 18 files with 0 errors, warnings, or hints |
| Repository build | Exit 0 | Four static pages built |
| Foundation Playwright | Exit 0 | 8 tests passed; 2 task-aware tests skipped without a Factory spec |
| Aggregate repository test | Exit 0 on clean rerun | Factory 80/80 and Foundation 8/8; 2 expected skips |
| Composite QA | Exit 0 | Check, build, Factory 80/80, Foundation 8/8; 2 expected skips |
| Stale-server negative | Expected exit 1 | A deliberate listener on port 4321 was rejected instead of reused; the preview was then terminated |
| Synthetic-secret scan | No matches | Randomized synthetic formats were absent from repository source, outputs, and `.factory` artifacts |
| Cleanup | Pass | No disposable worktree, container, preview, Playwright, or Factory-Codex process remained; primary checkout was clean |

The first aggregate `pnpm test` attempt had two desktop `page.goto` timeouts after all 80 Factory tests passed and therefore exited 1. The immediately following independent site run passed all 8 Foundation tests, and a clean aggregate rerun passed Factory 80/80 plus Foundation 8/8. This transient failed attempt is retained rather than hidden.

## Disposition and residual risk

The earlier 2026-08-29 handoff correctly recorded `STRONG_EXECUTION_ISOLATION_UNAVAILABLE` before runtime authorization. That historical state is superseded by the installed, validated, fail-closed Colima boundary and the three now-completed live gates: isolated create-page success, real Codex repair after dynamic failure, and host read/write canary isolation.

The implementation does not claim that Docker alone is an absolute security boundary. Acceptance rests on the dedicated QEMU VM's narrow host mounts, hardened worker settings, inner Codex policy, and Factory's post-execution mechanical checks as independent layers. Runtime/profile drift still produces `STRONG_EXECUTION_ISOLATION_UNAVAILABLE`; there is no host-shared fallback. Independent QA remains intentionally separate from this implementation handoff.
