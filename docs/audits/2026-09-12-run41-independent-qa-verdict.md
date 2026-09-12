# Run 4.1 Independent QA Verdict — PR #27 and PR #28 (Hardening Window)

- Date: 2026-09-12
- Verifier: Independent QA (no involvement in building the code under review;
  reproduced every claim from a fresh clone at pinned SHAs)
- Candidates (pinned via GitHub API at QA start):
  - PR #27 `fix/run41-closed-runs-hardening` head **`605b4feb85abee88af7fd70c76f59de5bb0ae71f`**
  - PR #28 `feat/run41-editorial-hardening` head **`e829ce56b0476fe451997216c1b8d57b883b5378`**,
    re-pinned after remediation to **`f9f903345c884aa6ab6366bca4208e207085d92f`**
- Policy basis: AGENTS.md (verification/merge governance), instruction-authority,
  roadmap-vnext §Macro Run 4.1. Builder report treated as CLAIMS.

## 1. CI on exact heads (independent signal)

| Head | "Factory QA & Persistence Acceptance" | Lanes confirmed from job logs |
| --- | --- | --- |
| PR-A `605b4fe` | **success** | unit 868/0, dashboard 17/0, persistence 92/0, operator 48/0, real-browser E2E green, Vale install + vendored-config validation green |
| PR-B `e829ce5` (original) | **failure** | unit 877/0, dashboard 17/0, Vale steps green; **persistence 91/1** — `not ok 83` `writer-qa.test.ts:466` |
| PR-B `f9f9033` (remediated) | **success** (run 34714610874) | unit 877/0, dashboard 17/0, persistence 92/0, operator 48/0, E2E green, Vale config validation produced real `write-good.*` JSON findings |

## 2. Root cause of the PR-B CI failure (reproduced, not assumed)

`not ok 83` is a **pre-existing latent bug on `main`** (byte-identical at
`writer-store.ts:1129`), not something the PRs introduced. The catch block
around the version-allocation insert checked `error.code === "23505"`, but
drizzle-orm 0.45.2 wraps driver errors in `DrizzleQueryError` where `code` is
`undefined` and the PostgreSQL code lives on `error.cause.code`. QA reproduced
the shape deterministically against a local PostgreSQL 18:
`{name: "DrizzleQueryError", code: undefined, causeCode: "23505"}` — so the
typed `content_accept_failed` mapping was dead code and a concurrent-acceptance
race surfaced as a raw 500. The failure is load-timing dependent (main's CI
passed the same test 4 hours earlier; 13/13 local runs were green before the
fix), which is why it surfaced only on the PR run.

## 3. Remediation (operator-ordered; the only GitHub write performed by QA)

- Commit `f9f9033` on `feat/run41-editorial-hardening`, 1 file +7/−1:
  `writer-store.ts` now resolves `error.code ?? error.cause.code` before the
  `23505` check, guaranteeing the typed `content_accept_failed` conflict.
- Verified: typecheck green; unit lane 877/0; persistence suite 5/5 local runs
  green on real PostgreSQL 18; CI fully green on the new head (all lanes).

## 4. PR-A verification summary (evidence produced independently)

- File scope: exactly the 6 expected files; `digest.ts` NOT in the diff; no
  pre-existing test modified (only 2 new test files).
- Dependency: exactly one added line `"ipaddr.js": "2.5.0"`; frozen install green.
- Independent equivalence reproduction (QA's own 45-vector list, expectations
  derived from `main`'s implementation checked out locally): 41/45 identical;
  delta-1 = `198.51.100.1` (intended test-net-2 fix, disclosed in ADR);
  delta-2 = `3fff::1`, `5f00::1`, `2001:30::1` (fail-closed superset, matches
  the ADR's conservative-superset note); **delta-3 (blocked→allowed) = ZERO**.
- Hex-bug claim CONFIRMED by arithmetic: `0xc6120000` = 198.18.0.0,
  `0xc613ffff` = 198.19.255.255 (198.18.0.0/15), while true
  198.51.100.0/24 = `0xc6336400`; the legacy label "test-net-2 198.51.100/24"
  did not match its own constant (`main`:ssrf-guard.ts:43).
- Negative control: `main`'s ssrf-guard under the NEW vector test → FAIL
  ("198.51.100.0 must be blocked") — the test has teeth.
- RFC 8785 proof: all claimed vector sets present (24 Appendix B IEEE-754
  vectors, §3.2.x samples, Appendix E, 6 official Appendix-I corpus files);
  test imports the production `canonicalJsonStringify`; 6/6 green; negative
  control (corrupted one IEEE-754 expectation) → FAIL. "Appendix A is sample
  code, not vectors" verified against rfc-editor.org text.
- ADR records the port rationale, equivalence method, hex bug and both deltas.

## 5. PR-B verification summary

- File scope: only allowed paths; no dashboard/sites/contracts/migrations; no
  pre-existing test modified (3 new test files only).
- Dependencies: exactly `retext@9.0.0`, `retext-english@5.0.0`,
  `retext-readability@8.0.0` (the 4th `+` line is the trailing comma added to
  the pre-existing `pg` entry, not a new dependency); frozen install green;
  `pnpm why retext-readability` output recorded in the editorial ADR.
- E6 `editorial.readability`: locale gate regex per spec; empty/missing locale
  → explicit waiver REVIEW; all emissions PASS/REVIEW (never FAIL);
  `processSync`; evidence refs `kind: "section"` ≤ 280 chars.
  - **P2 finding (accepted):** the check applies a 25-word sentence floor
    (post-filter on plugin messages). QA probe: a genuinely-hard 19-word
    nominalized sentence (raw plugin flags it) is invisible to E6. Verdict P2,
    not P1: the floor only suppresses the short-sentence zone where per-sentence
    grade formulas are statistically unreliable (QA probes confirmed 8–14-word
    ordinary sentences are formula false-positives), genuinely-hard sentences
    ≥ 25 words are still flagged, and the floor + justification are frozen in
    `docs/audits/2026-09-12-run41-calibration-baselines.md`. Operator acceptance
    of this documented floor is part of the merge decision.
- E6 negative control: neutering the filter → 3 readability tests FAIL.
- E7 `editorial.vale_style`: `FACTORY_VALE_BIN` is the only resolution (no
  PATH fallback); unset → check absent (probe confirmed); bogus path → exactly
  one loud degradation REVIEW; `.txt` temp file, `finally` unlink, 10 s
  spawnSync timeout. **P3:** the config path is `process.cwd()`-relative —
  correct for the service's `apps/factory` run directory, degrades loudly
  (never silently) otherwise.
- Vendored pack byte-identical to upstream `c9ceca7f` (fresh tarball diff;
  only VENDORED.md/LICENSE differ by design; upstream README.md not copied —
  P3, documentation-only).
- CI workflow diff additive-only (+9); pinned v3.21.0 URL; sha256
  `96997d19…336` independently verified against errata-ai checksums file;
  `FACTORY_VALE_BIN` appears nowhere in the workflow.
- Anti-flip proof: full unit lane 877/0 with zero modifications to existing
  tests.
- Calibration: 3 fixtures with per-fixture justifications; frozen verdict
  vectors pass; baselines doc contains the English-calibration caveat verbatim;
  no invented PR links in new doc text.

## 6. Merge sequencing (executed)

1. Merge PR-A (`605b4fe`) first.
2. Merge PR-B. QA simulated the sequential merge locally before merging:
   auto-merge clean on `package.json`/`pnpm-lock.yaml`; the combined tree
   passes the unit lane at 886/0.
3. Post-merge: verify CI green on the merge commit; the `main` baseline
   becomes 886 unit / 17 dashboard / 92 persistence / 0 fail.

## 7. Findings table

| ID | Severity | Where | Evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | P1 | `writer-store.ts:1129` (pre-existing on main) | CI PR-B red; deterministic drizzle error-shape reproduction | **FIXED** in `f9f9033`; CI green on new head |
| F2 | P2 | `qa.ts` E6 25-word floor | 19-word hard sentence invisible (QA probe) | **FIXED** (post-merge remediation): floor retained as calibrated threshold, but suppression is now disclosed in the check detail (PASS and REVIEW); probe converted to regression test |
| F3 | P3 | `qa.ts:546` cwd-relative Vale config path | Works from `apps/factory`; loud degradation otherwise | **FIXED** (post-merge remediation): config resolved module-relative via `import.meta.url`; cwd-independence regression test added |
| F4 | P3 | vendored pack | upstream README.md not copied | **FIXED** (post-merge remediation): README.md vendored byte-verbatim; vendored dir now byte-identical to upstream `c9ceca7f` except VENDORED.md/LICENSE |

## 8. Verdict

- **PR-A #27: GO** at `605b4fe` — no changes required.
- **PR-B #28: GO** at `f9f9033` (post-remediation) — all CI lanes green.
- Merge order: PR-A → PR-B (see §6). This document records the independent
  QA verdict; the merges are performed by the operator flow.
