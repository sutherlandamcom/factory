# ADR: Run 4.1 editorial hardening — readability check, advisory Vale lint, calibration baselines

Date: 2026-09-12
Scope: Run 4.1 hardening window (editorial items W3 + W4 + W5)
Status: Proposed (merge gate: operator after independent QA)

## Decision 1 — `editorial.readability` via retext-readability (deterministic formulas, not model-graded prose)

### Context

The editorial QA family (E1–E5) checks terminology, clichés, structure, CTA
and headings, but nothing evaluates whether the prose is readable. A
model-graded "readability score" was rejected: it is non-deterministic,
non-reproducible, costs paid model calls per page, and cannot be versioned as
a stable acceptance signal.

### Decision

E6 `editorial.readability` uses `retext-readability@8.0.0` (with
`retext@9.0.0`, `retext-english@5.0.0`, both pinned exact) over body text
only (introduction + section bodies + conclusion; not title, meta, headings
or CTA). The plugin applies seven deterministic formulas (Dale–Chall,
Automated Readability, Coleman–Liau, Flesch, Gunning Fog, SMOG, Spache) and
flags sentences that score hard to read according to at least 4 of 7 (its
default threshold, which the design forbids re-tuning). The check is
advisory: PASS or REVIEW, never FAIL, so the worst-of overall verdict of
existing fixtures cannot regress to FAIL from this signal.

### English-only gating

All seven formulas are calibrated on English prose (Dale–Chall and Spache use
English word lists; grade levels map to US school ages). Scoring non-English
text would produce meaningless numbers presented as evidence. The check
therefore gates on `policyRules.localePreferences`: a value matching
`/\b(en|english|en-us|en-gb|us english)\b/i` is evaluated; anything else
(including empty or missing) emits ONE explicit waiver REVIEW — "check not
applicable, human review required" — so the gap is surfaced, never silently
skipped.

### Sentence floor (25 words)

Per-sentence grade formulas are statistically unreliable below ~25 words; the
plugin's own default `minWords: 5` only excludes degenerate input. Flagged
sentences shorter than 25 words are therefore not reported. This floor is the
one tuned parameter of the new check (the plugin configuration itself is
untouched) and is recorded in the calibration baselines document. It keeps
the accepted short-sentence v0 writer style out of the advisory signal while
still flagging genuinely convoluted long sentences.

### Anti-flip guardrail outcome

Adding E6 unconditionally would have flipped the existing English fixture
(`GOOD_PROPOSAL` in `tests/persistence/writer-qa.test.ts`) from PASS to
REVIEW (its sentences are 8–20 words; the formulas flag 6 of them below the
floor). The 25-word floor keeps every existing fixture verdict byte-identical
while the new test suite demonstrates E6 firing REVIEW on 40+-word
nested-clause prose. No existing test was modified.

## Decision 2 — `editorial.vale_style`: advisory, opt-in, vendored write-good pack

### Why advisory + opt-in

Vale findings are style suggestions ("may be weasel wording", "may be passive
voice") — human-judgment signals, not acceptance criteria. Making the check
unconditional would make fixture verdicts differ between environments with
and without a Vale binary (overall = worst-of; one extra REVIEW breaks PASS
assertions). The check therefore runs ONLY when `FACTORY_VALE_BIN` is
explicitly set (no PATH fallback). When set but broken (missing binary, spawn
failure, 10 s timeout, unparseable JSON), it degrades loudly to ONE REVIEW —
never FAIL, never a QA crash. When unset it emits nothing, which is
documented behavior: Vale is an optional advisory instrument, not a
governance control, and the report version field remains the authoritative
record of what was evaluated.

### Why the write-good pack is vendored

The maintained `errata-ai/write-good` pack already contains the
weasel/passive/wordiness rules; hand-writing prose rules would recreate
exactly the unmaintained-hand-rolled pattern this run removes. Vendoring the
pack's YAML into `apps/factory/vale/styles/write-good/` (pinned commit
`c9ceca7f574248a201d5524b001099c5626c7519`, LICENSE included, provenance in
`VENDORED.md`) makes rule text part of code review and keeps CI
network-free: CI installs only the pinned, checksum-verified Vale v3.21.0
binary and validates the vendored config compiles; it never downloads styles.

### Test strategy

`tests/writer-vale.test.ts` is fully hermetic: a stub executable stands in
for Vale and covers alerts→REVIEW with mapped evidence, `{}`→PASS, missing
binary→degradation REVIEW, garbage output→degradation REVIEW, crash→degradation
REVIEW, and unset→check absent. Unit tests never require a real Vale.

## Decision 3 — calibration baselines (W5)

Thresholds without recorded baselines drift arbitrarily. The corpus
(`tests/calibration/good-page.json`, `bad-page.json`,
`non-english-locale.json`) plus the frozen full verdict vectors in
`tests/writer-calibration.test.ts` and
`docs/audits/2026-09-12-run41-calibration-baselines.md` pin current behavior:
good-page is all-PASS, bad-page demonstrates the FAIL (cliché) and REVIEW
(evidence trace, user needs, readability) paths, non-english-locale
demonstrates the waiver path. Any threshold change must update corpus, test
and baseline document together.

## Appendix — dependency weight (`pnpm --filter @factory/factory why retext-readability`)

```text
retext-readability@8.0.0
└── @factory/factory@0.1.0 (dependencies)

Found 1 version of retext-readability
```

Direct runtime dependencies added under `apps/factory` (pinned exact):
`retext@9.0.0`, `retext-english@5.0.0`, `retext-readability@8.0.0`.
retext-readability's own transitive runtime dependencies (per its package
manifest): `automated-readability`, `coleman-liau`, `dale-chall`,
`dale-chall-formula`, `flesch`, `gunning-fog`, `smog-formula`, `spache`,
`spache-formula`, `syllable`, `nlcst-to-string`, `unist-util-visit`,
`vfile` (+ `@types/nlcst`). All are resolved into the committed
`pnpm-lock.yaml`; no `remark-*` or `unified` direct dependency was added.

## Verification summary

- Factory unit lane: 877 tests / 0 fail (859 baseline + 8 W3 + 7 W4 + 3 W5),
  existing tests unchanged and green.
- Typecheck (`pnpm -r run check`): green.
- New pinned deps: `retext@9.0.0`, `retext-english@5.0.0`,
  `retext-readability@8.0.0` (lockfile committed).

## Remediation addendum — 2026-09-12 (P2/P3 findings from independent QA)

The independent QA verdict for PR #28 raised three non-blocking findings on
this workstream. All three are remediated in the same change set:

- **F2 (P2) — below-floor suppression is now disclosed, not silent.** The
  25-word sentence floor itself is unchanged (it is a calibrated threshold:
  the formulas false-positive on short sentences, and removing it re-flips
  existing fixtures). What changed is honesty: the check detail now always
  quantifies suppressed below-floor flags — in PASS
  ("No sentence ≥ 25 words flagged hard to read by readability formulas; N
  flagged sentence(s) below the 25-word reporting floor were suppressed (see
  calibration baselines doc).") and in REVIEW (same suffix appended). The
  human gate now sees the formulas' full signal and the floor's filtering
  effect side by side. The original QA probe (a hard 19-word nominalized
  sentence) is now a regression test asserting the disclosure.
  `QA_VERSION` stays `content-qa-v1`: verdict semantics (the PASS/REVIEW/FAIL
  distribution over the calibration corpus) are unchanged — only human-facing
  detail prose gained the disclosure, so historical stored reports are not
  invalidated.
- **F3 (P3) — `.vale.ini` path is module-relative.** `runValeStyleLint`
  resolves the vendored config from the module's own location
  (`src/writer/qa.ts` → `apps/factory/vale/.vale.ini`) via
  `fileURLToPath(import.meta.url)` (the established pattern in this codebase,
  cf. `src/persistence/migrate.ts`), not from `process.cwd()`. A test now
  runs the check from an unrelated cwd with a config-existence-probing stub
  and asserts the check behaves as properly configured.
- **F4 (P3) — upstream `README.md` vendored.** The pack's upstream README is
  copied verbatim into `apps/factory/vale/styles/write-good/`; the vendored
  directory is now byte-identical to upstream `c9ceca7f` except for the
  intentionally-added `VENDORED.md` and `LICENSE`. `VENDORED.md` file list
  updated.
