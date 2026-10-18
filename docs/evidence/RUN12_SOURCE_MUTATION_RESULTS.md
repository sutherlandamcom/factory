# Factory Run 12 — Adversarial Source Mutation Results (`RUN12_SOURCE_MUTATION_RESULTS.md`)

## 1. Adversarial Mutation Protocol Overview

To prove that Factory's YMYL and research integrity validation is robust, deterministic, and fail-closed—and cannot be deceived by decorative citations, fabricated excerpts, matching but incorrect strings, or synthetic approvals—26 distinct adversarial mutations (`M01` through `M26`) were implemented and executed against the trust governance and production QA subsystems.

Every mutation:
1. Targets a specific vulnerability or failure mode.
2. Injects an adversarial perturbation into claim text, evidence bindings, source provenance, calculation models, reviewer authority, or page copy.
3. Asserts that the system returns `verdict: "FAIL"` (never `PASS`).
4. Verifies the exact machine-readable diagnostic code in `detail`.

All 26 mutations are executed deterministically in `apps/factory/tests/persistence/run12-source-integrity-qa.test.ts` and `apps/factory/tests/run12-source-integrity.test.ts`.

---

## 2. Adversarial Mutation Test Matrix (M01–M26)

| ID | Vulnerability / Failure Mode Tested | Adversarial Perturbation | Expected Diagnostic Code | Test File & Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **M01** | Fabricated commune dwelling total (Chamonix) | Chamonix 2022 total dwellings claimed as `13,864` instead of authentic `14 538` | `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 150) | **PASS (`FAIL` emitted with code)** |
| **M02** | Fabricated commune dwelling total (Megève) | Megève 2022 total dwellings claimed as `11,291` instead of authentic `9 354` | `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 159) | **PASS (`FAIL` emitted with code)** |
| **M03** | Mutated secondary residence percentage | Chamonix secondary share claimed as `82.9%` (Megève's number) instead of authentic `69,3%` | `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 166) | **PASS (`FAIL` emitted with code)** |
| **M04** | Temporal attribution mismatch | Authentic 2022 value (`14,538`) labelled as `2023` in claim text or evidence binding | `claim_year_mismatch` | `run12-source-integrity-qa.test.ts` (line 114) | **PASS (`FAIL` emitted with code)** |
| **M05** | Geography transposition | Chamonix commune ID (`74056`) replaced by Megève ID (`74173`) in evidence binding | `claim_value_mismatch` / `claim_geography_mismatch` | `run12-source-integrity-qa.test.ts` (line 140) | **PASS (`FAIL` emitted with code)** |
| **M06** | Category swapping | Primary and secondary residence shares swapped (`69.3%` primary, `29.7%` secondary) | `claim_category_mismatch` | `run12-source-integrity-qa.test.ts` (line 183) | **PASS (`FAIL` emitted with code)** |
| **M07** | Matching fabricated excerpt deception | Fabricated supporting excerpt matches wrong number (`13,864`) but no evidence binding exists | `claim_number_unbound` | `run12-source-integrity-qa.test.ts` (line 72) | **PASS (`FAIL` emitted with code)** |
| **M07b** | Colluding excerpt + fake binding | Excerpt and binding both assert `13,864`; rejected by independent verifier against snapshot `14 538` | `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 89) | **PASS (`FAIL` emitted with code)** |
| **M08** | Self-certified source without evidence | `SUPPORTED` + `TIER_A` + matching excerpt, but `evidenceBindings: []` on INSEE claim | `source_evidence_unbound` | `run12-source-integrity-qa.test.ts` (line 103) | **PASS (`FAIL` emitted with code)** |
| **M09** | Tampered source snapshot bytes | Raw source snapshot HTML altered; sha256 no longer matches manifest digest | `source_snapshot_unverified` | `run12-source-integrity-qa.test.ts` (line 197) | **PASS (`FAIL` emitted with code)** |
| **M10** | Official publisher name with deceptive URL | Trusted publisher label (`INSEE`) paired with unrelated Dossier URL | `source_url_mismatch` | `run12-source-integrity-qa.test.ts` (line 123) | **PASS (`FAIL` emitted with code)** |
| **M11** | Unregistered source reference | INSEE claim references unregistered document or unpinned snapshot | `source_snapshot_unverified` | `run12-source-integrity-qa.test.ts` (line 131) | **PASS (`FAIL` emitted with code)** |
| **M12** | Denominator distortion | Construction share (`58.5%`) attributed to total dwellings instead of main residences built before 2020 | `claim_denominator_mismatch` | `run12-source-integrity-qa.test.ts` (line 211) | **PASS (`FAIL` emitted with code)** |
| **M13** | Statutory proposition fabrication | Loi Hoguet claimed as permitting real-estate brokerage without a Carte T | `statutory_proposition_mismatch` | `run12-source-integrity-qa.test.ts` (line 228) | **PASS (`FAIL` emitted with code)** |
| **M14** | Regulatory timetable distortion | DPE rental prohibition for Class E cited as `2026` instead of statutory `2034` (or audit as `2026`) | `statutory_schedule_mismatch` | `run12-source-integrity-qa.test.ts` (line 238) | **PASS (`FAIL` emitted with code)** |
| **M15** | Non-prose material assertion leakage | False numeric claim hidden in `<h2>` heading, table cell (`<td>`), callout, or meta description | `claim_missing_for_material_sentence` | `run12-source-integrity-qa.test.ts` (line 247) | **PASS (`FAIL` emitted with code)** |
| **M16** | Mathematical calculation output error | Net equity yield formula outputs `8.4%` instead of independently calculated `7.2%` | `calculation_output_mismatch` | `run12-source-integrity-qa.test.ts` (line 274) | **PASS (`FAIL` emitted with code)** |
| **M17** | Rounding or unit distortion | Calculation rounded to `7.3%` or given unit `EUR` instead of `percent` (`7.2%`) | `calculation_rounding_or_unit_mismatch` | `run12-source-integrity-qa.test.ts` (line 289) | **PASS (`FAIL` emitted with code)** |
| **M18** | Cross-geography evidence contamination | Megève secondary residence claim justified using Chamonix HTML snapshot | `claim_geography_mismatch` | `run12-source-integrity-qa.test.ts` (line 135) | **PASS (`FAIL` emitted with code)** |
| **M19** | Synthetic fixture claimed as external research | `origin: "SYNTHETIC_FIXTURE"` source submitted as primary external research on YMYL route | `synthetic_fixture_research_rejected` | `run12-source-integrity-qa.test.ts` (line 309) | **PASS (`FAIL` emitted with code)** |
| **M20** | Empty or non-anchored original work product | Original value record lacks concrete quantitative/statutory anchors in page HTML | `original_value_work_product_missing` | `run12-source-integrity-qa.test.ts` (line 321) | **PASS (`FAIL` emitted with code)** |
| **M21** | Fabricated human editorial sign-off | Review authority marked approved by synthetic reviewer or set to `EDITORIAL_REVIEW_PENDING` | `editorial_review_pending_or_synthetic` | `run12-source-integrity-qa.test.ts` (line 330) | **PASS (`FAIL` emitted with code)** |
| **M22** | Stale review authority on claim mutation | Page content and claims mutated while keeping previous review authority digest | `review_authority_stale` | `run12-source-integrity-qa.test.ts` (line 342) | **PASS (`FAIL` emitted with code)** |
| **M23** | Cross-page cannibalization & duplicate content | Two pages share identical query cluster, intent, and duplicated section headings/body | `cannibalization_or_duplicate_page_rejected` | `run12-source-integrity-qa.test.ts` (line 353) | **PASS (`FAIL` emitted with code)** |
| **M24** | Unverified factual claim in copy | Quantitative or statutory sentence present in page prose without bound verified claim | `unverified_claim_in_production_copy` | `run12-source-integrity-qa.test.ts` (line 368) | **PASS (`FAIL` emitted with code)** |
| **M25** | Unlabelled speculative forecast | Appreciation model assertion (`"Asset will appreciate 12%"`) presented as `FACT` | `forecast_as_fact_rejected` | `run12-source-integrity-qa.test.ts` (line 379) | **PASS (`FAIL` emitted with code)** |
| **M26** | Non-entailing source excerpt | Excerpt lacks lexical overlap or contradicts the asserted factual proposition | `claim_lineage_invalid` | `run12-source-integrity-qa.test.ts` (line 391) | **PASS (`FAIL` emitted with code)** |

---

## 3. Key Findings & Assurance

1. **Elimination of False Passes**:
   - In previous iterations, a fabricated excerpt containing `13,864` combined with `entailment: "SUPPORTED"` and self-certified `TIER_A` could pass naive string-matching. Under the Run 12 independent verifier (`insee-evidence.ts` + `verifyInseeClaim`), the authentic raw HTML snapshot table is parsed directly. Both `M07` and `M07b` fail closed with `claim_number_unbound` and `claim_value_mismatch`.

2. **Denominators and Vintages**:
   - `M12` confirms that housing construction vintage shares (`58.5%` for 1946–1990 and `13.5%` for 2006–2019) cannot be falsely attributed to total dwellings (`14,538`), but must strictly bind to main residences built before 2020 (`4,231` in `LOG T5`).

3. **Full Production Coverage**:
   - `M15` confirms that material numbers are intercepted regardless of where they appear in the rendered document—headings (`<h1>`–`<h6>`), meta descriptions, table cells (`<td>`), callouts, or JSON-LD.
