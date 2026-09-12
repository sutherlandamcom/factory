# Run 4.1 calibration baselines — deterministic QA triad

Date: 2026-09-12
Scope: Run 4.1 W5 — recorded baselines for the content QA triad
(`runContentQa` in `apps/factory/src/writer/qa.ts`).

Without recorded baselines, every future threshold change is arbitrary. This
document freezes the raw signal counts and the verdict vectors for the three
corpus fixtures in `apps/factory/tests/calibration/`. The regression test
`apps/factory/tests/writer-calibration.test.ts` asserts the full verdict
vector per fixture with `FACTORY_VALE_BIN` explicitly unset (deterministic in
every environment — Vale is strictly opt-in and must not influence these
vectors).

Readability formulas are English-calibrated; non-English locales receive an
explicit waiver REVIEW instead of a score. Vale lint is opt-in via
`FACTORY_VALE_BIN` and absent when unconfigured.

## Corpus

| Fixture | Description |
| --- | --- |
| `good-page.json` | Clean, concrete, short-sentence English roofing page; operator facts verbatim from the brief's evidence. |
| `bad-page.json` | Same brief; weasel words, passive voice, 2 sentences > 40 words, one AI cliché from the policy avoidance list, one unsupported superlative claim. |
| `non-english-locale.json` | Exactly the good-page proposal with `localePreferences: "Russian"`. |

## Raw signal counts

### good-page

- Body text (introduction + 3 section bodies + conclusion): **11 sentences**.
- Sentences ≥ 25 words (the E6 reporting floor): **0**.
- retext-readability flagged messages (before floor): 6 — all short sentences
  below the floor, therefore not reported.
- Vale: not applicable (opt-in; unset for calibration).

### bad-page

- Body text: **9 sentences**.
- Sentences ≥ 25 words: **2** (42 and 37 words) — both flagged by
  retext-readability (5/7 and 6/7 algorithms respectively).
- Vale: not applicable (opt-in; unset for calibration).

### non-english-locale

- Identical proposal text to good-page (11 sentences, 0 ≥ 25 words).
- Readability is not scored: locale gate emits the waiver REVIEW.

## Frozen verdict vectors

### good-page — overall PASS

| Check | Verdict |
| --- | --- |
| factual.prohibited_claims | PASS |
| factual.evidence_trace | PASS |
| factual.no_invented_numbers | PASS |
| factual.unverified_claims | PASS |
| factual.key_points_fidelity | PASS |
| search.semantic_coverage | PASS |
| search.user_needs | PASS |
| search.primary_intent | PASS |
| editorial.forbidden_terminology | PASS |
| editorial.ai_cliche | PASS |
| editorial.structure_integrity | PASS |
| editorial.cta_integrity | PASS |
| editorial.heading_integrity | PASS |
| editorial.readability | PASS |

### bad-page — overall FAIL

| Check | Verdict | Justification |
| --- | --- | --- |
| factual.prohibited_claims | PASS | The unsupported superlative ("the best") is not on the prohibited list ("#1 roofing company", "Cheapest prices in Denver"); it is an unsupported claim, not a listed prohibited claim. |
| factual.evidence_trace | REVIEW | Neither operator fact ("Serving Denver since 1998", "BBB A+ rating") appears verbatim in the proposal. |
| factual.no_invented_numbers | PASS | No numeric claims beyond the brief's 25-year warranty. |
| factual.unverified_claims | PASS | No unknown claim asserted without a qualifier. |
| factual.key_points_fidelity | PASS | No contentBriefKeyPoints to violate. |
| search.semantic_coverage | PASS | All coverage requirements reflected. |
| search.user_needs | REVIEW | The trust-signals user need is not addressed. |
| search.primary_intent | PASS | Intent terms present in title/introduction. |
| editorial.forbidden_terminology | PASS | No "cheap"/"bargain". |
| editorial.ai_cliche | FAIL | Avoidance-list hit: "we've got you covered". |
| editorial.structure_integrity | PASS | All structure guidance reflected. |
| editorial.cta_integrity | PASS | CTA present. |
| editorial.heading_integrity | PASS | Unique headings. |
| editorial.readability | REVIEW | 2 sentences ≥ 25 words flagged hard to read. |

### non-english-locale — overall REVIEW

| Check | Verdict | Justification |
| --- | --- | --- |
| (all checks) | PASS | Identical to good-page. |
| editorial.readability | REVIEW | Explicit waiver: locale "Russian" — formulas are English-calibrated; human review required. The only delta vs good-page. |

## Threshold rationale

- **E6 sentence floor (25 words):** per-sentence grade formulas (Dale–Chall,
  SMOG, Gunning Fog, etc.) are statistically unreliable below ~25 words — a
  sentence-level "grade" over 8 words is noise. The floor keeps the accepted
  short-sentence v0 writer style out of the advisory signal while still
  flagging genuinely convoluted long sentences. The plugin's own
  configuration (threshold 4/7, age 16, minWords 5) is untouched.
- **E6 English gate:** all seven formulas are calibrated on English prose;
  scoring non-English text would produce meaningless numbers, so the gate
  emits an explicit waiver REVIEW instead.
- **E7 opt-in:** Vale findings are advisory style signals. Making the check
  unconditional would change fixture verdicts between environments that have
  Vale installed and those that do not (overall = worst-of), so it runs only
  when `FACTORY_VALE_BIN` is explicitly configured.

## Changing a threshold

Any future change to a QA threshold MUST update the corpus fixtures, the
frozen vectors in `apps/factory/tests/writer-calibration.test.ts`, and this
document in the same reviewed change, with per-fixture justification for each
verdict that moved.
