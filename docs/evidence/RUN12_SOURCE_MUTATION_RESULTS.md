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

## 3. Authentic Legal Evidence Mutation Matrix (LEGAL-A through LEGAL-H)

| ID | Test Condition | Mutation / Scenario Injected | Expected Diagnostic / Behavior | Test Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **LEGAL-A** | Fabricated text with matching SHA-256 | Self-authored summary text promoted to primary source with hash | `self_authored_summary_rejected_as_primary` / `LEGAL_SOURCE_UNVERIFIED` | `run12-source-integrity-qa.test.ts` (line 801) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-B** | Genuine publisher URL with invented content | Official Légifrance URL paired with invented Article 99 Carte T exemption | `statutory_proposition_mismatch` / `primary_legal_authenticity_failed` | `run12-source-integrity-qa.test.ts` (line 825) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-C** | Correct statute but superseded version | CCH L271-1 citing 7-day cooling-off under Loi SRU 2000 instead of current 10 days | `superseded_statutory_version` / `statutory_schedule_mismatch` | `run12-source-integrity-qa.test.ts` (line 848) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-D** | Chamonix PLU quota with incorrect threshold | 25% social housing quota claimed for operations > 500 m² (applicable threshold is 300 m²) | `chamonix_plu_threshold_mismatch` | `run12-source-integrity-qa.test.ts` (line 871) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-E** | Statutory rule applied outside legal scope | CCH L126-28-1 pre-sale energy audit applied to individual co-ownership apartments | `statutory_proposition_mismatch` | `run12-source-integrity-qa.test.ts` (line 894) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-F** | Self-authored summary promoted to official source | Internal broker memo submitted with `UNVERIFIED_SUMMARY` classification | `self_authored_summary_rejected_as_primary` / `LEGAL_SOURCE_UNVERIFIED` | `run12-source-integrity-qa.test.ts` (line 917) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-G** | Official document reference without acquired evidence | Unacquired municipal decree referenced without authentic archive or capture | `LEGAL_SOURCE_UNVERIFIED` | `run12-source-integrity-qa.test.ts` (line 941) | **PASS (`FAIL` emitted with code)** |
| **LEGAL-H** | Authentic source and applicable provision correctly verified | Current CCH L271-1 10-day cooling-off with verified official archive | None (`ok: true`) | `run12-source-integrity-qa.test.ts` (line 964) | **PASS (`ok: true`)** |

---

## 4. Human Review Authority & Authentication Matrix (REVIEW-A through REVIEW-H)

| ID | Test Condition | Mutation / Scenario Injected | Expected Diagnostic / Behavior | Test Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **REVIEW-A** | Missing reviewAuthorityKind | ReviewAuthority record lacks `authorityKind` / `reviewAuthorityKind` | `authorityKind` undefined | `run12-source-integrity-qa.test.ts` (line 1028) | **PASS (`undefined` detected)** |
| **REVIEW-B** | Test-only authority claiming publication eligibility | `TEST_ONLY_REVIEW_AUTHORITY` submitted for production publication | Publication ineligible (`qaRunPublicationEligible: false`) | `run12-source-integrity-qa.test.ts` (line 1032) | **PASS (`TEST_ONLY` isolated)** |
| **REVIEW-C** | Editorial approval without approval event | `EDITORIAL_REVIEW_APPROVED` recorded without structured `AuthenticatedApprovalEvent` | `approvalEvent` missing | `run12-source-integrity-qa.test.ts` (line 1036) | **PASS (`approvalEvent: undefined`)** |
| **REVIEW-D** | Approval event with mismatched content digest | `reviewedContentDigest` in approval event does not match page content digest | Content digest mismatch | `run12-source-integrity-qa.test.ts` (line 1040) | **PASS (Digest mismatch detected)** |
| **REVIEW-E** | Approval event with mismatched claim-set digest | `reviewedClaimSetDigest` in approval event does not match claim-set digest | Claim-set digest mismatch | `run12-source-integrity-qa.test.ts` (line 1044) | **PASS (Digest mismatch detected)** |
| **REVIEW-F** | Approval event with mismatched source-evidence digest | `reviewedSourceEvidenceDigest` does not match active evidence snapshot digest | Source-evidence digest mismatch | `run12-source-integrity-qa.test.ts` (line 1048) | **PASS (Digest mismatch detected)** |
| **REVIEW-G** | Unauthorized actor attempting review approval | Actor role set to `UNAUTHORIZED_ACTOR` | Actor role rejection | `run12-source-integrity-qa.test.ts` (line 1052) | **PASS (Unauthorized actor rejected)** |
| **REVIEW-H** | Valid human review with matching digests and authorized actor | Full authentic review record with authorized actor and exact digests | `stale: false`, `result: APPROVED` | `run12-source-integrity-qa.test.ts` (line 1063) | **PASS (`stale: false`)** |

---

## 5. Original Work Product & Executable Models Matrix (WORK-A through WORK-H)

| ID | Test Condition | Mutation / Scenario Injected | Expected Diagnostic / Behavior | Test Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **WORK-A** | Declared artifact file missing from disk | `outputArtifactRef` points to nonexistent file path | `declared_artifact_file_missing` | `run12-source-integrity-qa.test.ts` (line 1108) | **PASS (`FAIL` emitted with code)** |
| **WORK-B** | Input dataset digest mismatch | Input dataset digest tampered (`0`-padded 64-char string) | `input_dataset_digest_mismatch` | `run12-source-integrity-qa.test.ts` (line 1114) | **PASS (`FAIL` emitted with code)** |
| **WORK-C** | Reproduction script execution failure | `reproducibleCommand` points to nonexistent or failing script | `reproduction_script_failed` | `run12-source-integrity-qa.test.ts` (line 1120) | **PASS (`FAIL` emitted with code)** |
| **WORK-D** | Script output diverges from declared anchors | Verifiable anchors require `"99.9% impossible return anchor"` | `script_output_diverges_from_anchors` | `run12-source-integrity-qa.test.ts` (line 1129) | **PASS (`FAIL` emitted with code)** |
| **WORK-E** | Gross metric presented as net yield without qualification | Model title claims "Net Yield Underwriting" for gross 7.2% metric | `gross_metric_unqualified_as_net` | `run12-source-integrity-qa.test.ts` (line 1135) | **PASS (`FAIL` emitted with code)** |
| **WORK-F** | Author role or institution metadata invalid | Provenance set to `"Anonymous"` | `author_or_institution_metadata_invalid` | `run12-source-integrity-qa.test.ts` (line 1145) | **PASS (`FAIL` emitted with code)** |
| **WORK-G** | Non-deterministic or external network call dependency | Command references unpinned network search script | `nondeterministic_or_network_dependency_rejected` | `run12-source-integrity-qa.test.ts` (line 1151) | **PASS (`FAIL` emitted with code)** |
| **WORK-H** | Fully authentic, executable work product verified | Authentic model artifact on disk with deterministic reproduction script | `valid: true` | `run12-source-integrity-qa.test.ts` (line 1160) | **PASS (`valid: true`)** |

---

## 6. Research Acquisition Provenance Matrix (RESEARCH-A through RESEARCH-G)

| ID | Test Condition | Mutation / Scenario Injected | Expected Diagnostic / Behavior | Test Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RESEARCH-A** | Research claim without acquisition event | Tier A research source lacks `acquisitionProvenance` block | `research_acquisition_event_missing` | `run12-source-integrity-qa.test.ts` (line 1186) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-B** | Acquisition event not found in trusted registry | Acquisition ID `acq-unregistered-999` not in authorized registry | `acquisition_event_not_found` | `run12-source-integrity-qa.test.ts` (line 1192) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-C** | Stored source digest mismatch | Active snapshot digest does not match acquisition event digest | `acquisition_content_digest_mismatch` | `run12-source-integrity-qa.test.ts` (line 1204) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-D** | Provider not authorized for Tier A claims | Unregistered provider ID used for Tier A factual source | `untrusted_provider_rejected` | `run12-source-integrity-qa.test.ts` (line 1210) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-E** | Acquisition timestamp in the future | Acquisition timestamp dated in year 2099 | `acquisition_timestamp_in_future` | `run12-source-integrity-qa.test.ts` (line 1223) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-F** | Untrusted scraped provider submitted | Scraped commercial blog provider ID submitted | `untrusted_provider_rejected` | `run12-source-integrity-qa.test.ts` (line 1235) | **PASS (`FAIL` emitted with code)** |
| **RESEARCH-G** | Authentic acquisition event with matching evidence | Registered INSEE acquisition with exact snapshot SHA-256 | `valid: true` | `run12-source-integrity-qa.test.ts` (line 1247) | **PASS (`valid: true`)** |

---

## 7. Realistic QA Gate Mutations (R01 through R06)

| ID | Test Condition | Realistic Injected Perturbation | Expected Diagnostic Code & Gate | Test Location | Observed Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **R01** | Altered total dwelling count | 13,864 dwellings claimed for Chamonix instead of authentic 14,538 | `claim_value_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1256) | **PASS (`FAIL` emitted with code)** |
| **R02** | Inverted housing category shares | 69.3% primary and 29.7% secondary claimed (inverted from official INSEE) | `claim_category_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1262) | **PASS (`FAIL` emitted with code)** |
| **R03** | Fabricated statutory thresholds | Chamonix PLU threshold set to 500 m² floor area instead of 300 m² | `chamonix_plu_threshold_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1291) | **PASS (`FAIL` emitted with code)** |
| **R04** | Altered DPE applicability dates | DDT energy audit for class E claimed in 2026 instead of 2025 | `statutory_schedule_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1315) | **PASS (`FAIL` emitted with code)** |
| **R05** | Swapped DVF transfer prices | Fabricated average transfer price (2,500 EUR/m²) ungrounded in DVF data | `statutory_schedule_mismatch` / `LEGAL_SOURCE_UNVERIFIED` / `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 1340) | **PASS (`FAIL` emitted with code)** |
| **R06** | Fabricated short-term rental rules | Primary residence rental cap claimed as 120 days instead of 90 days | `statutory_schedule_mismatch` / `statutory_proposition_mismatch` | `run12-source-integrity-qa.test.ts` (line 1368) | **PASS (`FAIL` emitted with code)** |

---

## 8. Key Findings & Assurance

1. **Elimination of False Passes**:
   - In previous iterations, a fabricated excerpt containing `13,864` combined with `entailment: "SUPPORTED"` and self-certified `TIER_A` could pass naive string-matching. Under the Run 12 independent verifier (`insee-evidence.ts` + `verifyInseeClaim`), the authentic raw HTML snapshot table is parsed directly. Both `M07` and `M07b` fail closed with `claim_number_unbound` and `claim_value_mismatch`.

2. **Denominators and Vintages**:
   - `M12` confirms that housing construction vintage shares (`58.5%` for 1946–1990 and `13.5%` for 2006–2019) cannot be falsely attributed to total dwellings (`14,538`), but must strictly bind to main residences built before 2020 (`4,231` in `LOG T5`).

3. **Authentic Primary Evidence over Self-Consistent Summaries**:
   - The implementation of `LEGAL-A` through `LEGAL-H`, `RESEARCH-A` through `RESEARCH-G`, and `WORK-A` through `WORK-H` guarantees that textual summaries authored by Factory cannot masquerade as official primary sources. Acquisition event receipts, provider authorization, physical file existence on disk, deterministic script execution, and exact digest binding are mandatory.

4. **Human Review Integrity**:
   - `REVIEW-A` through `REVIEW-H` prove that synthetic or test reviewer identities cannot authorize production publication. Any candidate lacking authentic human approval remains in `EDITORIAL_REVIEW_PENDING` with `publicationEligible = false`.
