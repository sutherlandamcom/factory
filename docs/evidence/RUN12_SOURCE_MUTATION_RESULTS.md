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
| **LEGAL-D** | Chamonix PLU quota with incorrect threshold | 25% social housing quota claimed for operations > 500 m² (applicable thresholds under operative 2026 PLU matrix are individual housing $\ge 200\text{ m}^2$ SP or collective programs $> 8$ units in constructible zones UA, UAS, UC, UBD, UBP) | `chamonix_plu_threshold_mismatch` | `run12-source-integrity-qa.test.ts` (line 871) | **PASS (`FAIL` emitted with code)** |
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
| **R03** | Fabricated statutory thresholds | Chamonix PLU threshold set to 500 m² floor area instead of operative 2026 PLU conditions (individual housing $\ge 200\text{ m}^2$ SP or collective programs $> 8$ units in constructible zones) | `chamonix_plu_threshold_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1291) | **PASS (`FAIL` emitted with code)** |
| **R04** | Altered DPE applicability dates | DDT energy audit for class E claimed in 2026 instead of 2025 | `statutory_schedule_mismatch` (`trust.source_authority`) | `run12-source-integrity-qa.test.ts` (line 1315) | **PASS (`FAIL` emitted with code)** |
| **R05** | Swapped DVF transfer prices | Fabricated average transfer price (2,500 EUR/m²) ungrounded in DVF data | `statutory_schedule_mismatch` / `LEGAL_SOURCE_UNVERIFIED` / `claim_value_mismatch` | `run12-source-integrity-qa.test.ts` (line 1340) | **PASS (`FAIL` emitted with code)** |
| **R06** | Fabricated short-term rental rules | Primary residence rental cap claimed as 120 days instead of 90 days | `statutory_schedule_mismatch` / `statutory_proposition_mismatch` | `run12-source-integrity-qa.test.ts` (line 1368) | **PASS (`FAIL` emitted with code)** |

---

## 8. Key Findings & Assurance (P1 Remediation Verification)

1. **R12-QA-01: Chamonix PLU Operative Regulation Grounding**:
   - The code and tests no longer enforce an ungrounded, hardcoded 300 m² or 200 m² universal threshold.
   - Primary regulation PDF `74056_reglement_20260226.pdf` (approved 2026-02-26, enforceable 2026-05-09, Géoportail de l'Urbanisme `beaa82a7b5594b3913d5156928287d07`) is archived and verified with exact SHA-256 (`25425f385c72a88d3607a0314db9166efe9add139ca45314e124d3eb9bac707f`).
   - The structured `CHAMONIX_PLU_APPLICABILITY_MATRIX` in `legal-evidence.ts` validates distinct thresholds and scopes: individual housing $\ge 200\text{ m}^2$ SP, collective programs $> 8$ dwellings, tourist worker accommodation extensions up to $20\%$ under Loi Montagne, principal-residence servitudes, and zone exclusions (UT, A, N).
   - Negative tests correctly fail on misapplied quotas, wrong zones, swapped categories, or superseded regulations.

2. **R12-QA-02: Real Legal-Source Authenticity & Provenance**:
   - `loadLegalEvidenceRegistry` implements a strict two-pass acquisition boundary: raw publisher captures (`PRIMARY_SOURCE_CAPTURE`, `VERIFIED_OFFICIAL_ARCHIVE`) are authenticated first; extracted provisions (`EXTRACTED_LEGAL_PROVISION`) must bind to an authenticated raw capture with verified bytes and digest in `TRUSTED_ACQUISITION_REGISTRY`.
   - `UNVERIFIED_SUMMARY` and self-authored editorial interpretations are rejected closed. Fake publisher signatures (e.g. `SIG-...-OFFICIAL`) are prohibited and rejected.

3. **R12-QA-03: Real Editorial Review Boundary**:
   - The review authority layer rejects self-approved or author-supplied human review objects.
   - `EditorialReviewService` (`editorial-review-boundary.ts`) requires authenticated principals, active reviewer permissions, and matching content, claim-set, and evidence digests.
   - `TEST_ONLY_REVIEW_AUTHORITY` exercises technical build QA (validating HTML review attribute projection) but strictly enforces `publicationEligible: false`.
   - Production publication remains blocked until an authentic human review event is recorded.

4. **R12-QA-04: Trusted Research Acquisition Provenance**:
   - In `runTrustQa()`, external sources must bind to authenticated acquisition records in `TRUSTED_ACQUISITION_REGISTRY`.
   - Acquisition event records require canonical and retrieval URLs, system timestamps, HTTP/archive metadata, raw byte digests, document version identifiers, and authorized provider registration. Missing or forged provenance fails closed.

5. **R12-QA-05: Elimination of Arbitrary Shell Execution**:
   - All dynamic shell execution (`execSync`) has been eliminated from `production/qa/trust.ts`.
   - Deterministic model reproductions are executed via registered TypeScript transformation functions (`transformation-registry.ts`) that compute outputs in memory and verify exact file digests and anchor text against disk artifacts.

6. **Elimination of False Passes & Denominator Checks**:
   - Under the Run 12 independent verifier (`insee-evidence.ts` + `verifyInseeClaim`), authentic raw HTML snapshot tables are parsed directly. Negative mutations fail closed with exact diagnostic codes. All test suites pass green.

---

## 9. Final Trust Boundary Remediation Acceptance Matrix (AUTH, ACQ, LEGAL, WORK, PUB)

The final remediation established strict fail-closed trust boundaries verified across 33 automated tests in `apps/factory/tests/persistence/run12-source-integrity-qa.test.ts`:

### 9.1 Editorial Review Boundary (`AUTH-01` through `AUTH-06`)

| ID | Test Scenario | Threat / Failure Mode | Enforcement Mechanism | Result |
| :--- | :--- | :--- | :--- | :--- |
| **AUTH-01** | Unauthenticated principal | Caller submits valid-looking `AuthenticatedPrincipal` directly in request | `TrustedSessionRegistry.validateSessionToken` fails closed (`unauthenticated_principal_rejected`) | **PASSED (REJECTED)** |
| **AUTH-02** | Direct store insertion | Caller writes directly to `TrustGovernanceStore.recordReviewLocked` with `VERIFIED_HUMAN_REVIEW_AUTHORITY` | Verifies append-only `EditorialAuditStore` event exists; direct insert rejected (`unauthenticated_human_review_rejected`) | **PASSED (REJECTED)** |
| **AUTH-03** | Unauthorized actor | Valid authenticated session but actor lacks project-specific review permission | `ProjectMembershipAuthority.assertCanApproveReview` fails closed (`unauthorized_reviewer_actor`) | **PASSED (REJECTED)** |
| **AUTH-04** | Cross-project replay | Authentic audit event recorded for Project A used in Project B | `recordReviewLocked` checks `auditEvent.projectId === input.projectId` (`cross_project_audit_event_rejected`) | **PASSED (REJECTED)** |
| **AUTH-05** | Stale evidence digest | Source evidence mutated while HTML content remains identical | `reviewStaleness` detects `sourceEvidenceSetDigest` mismatch (`stale: true`, `review_authority_stale`) | **PASSED (DETECTED)** |
| **AUTH-06** | Authentic human approval | Valid session token, project permission, matching digests, and persisted audit event | Full verification succeeds (`VERIFIED_HUMAN_REVIEW_AUTHORITY`, `stale: false`) | **PASSED (ACCEPTED)** |

### 9.2 Research Acquisition Boundary (`ACQ-01` through `ACQ-08`)

| ID | Test Scenario | Threat / Failure Mode | Enforcement Mechanism | Result |
| :--- | :--- | :--- | :--- | :--- |
| **ACQ-01** | In-memory only fixture | Acquisition event not backed by actual disk capture file | Disk byte verification fails (`capture_file_missing_from_disk`) | **PASSED (REJECTED)** |
| **ACQ-02** | Disk byte tampering | Capture file on disk altered after acquisition | SHA-256 byte digest recomputed and compared against recorded hash (`disk_capture_digest_mismatch`) | **PASSED (REJECTED)** |
| **ACQ-03** | Mismatched URL / Provider | Genuine URL paired with unverified or scraped provider | Provider-URL binding check fails (`acquisition_provider_url_mismatch`) | **PASSED (REJECTED)** |
| **ACQ-04** | Unregistered event ID | Source references unrecorded acquisition event ID | Registry lookup fails (`acquisition_event_not_found`) | **PASSED (REJECTED)** |
| **ACQ-05** | Synthetic fixture | Source with `origin: SYNTHETIC_FIXTURE` submitted for Tier A claim | Synthetic source rejected (`synthetic_fixture_research_rejected`) | **PASSED (REJECTED)** |
| **ACQ-06** | Document identity mismatch | Valid raw bytes paired with differing document identity | Document title/ref mismatch detected (`acquisition_document_mismatch`) | **PASSED (REJECTED)** |
| **ACQ-07** | Simulated signature | Simulated publisher signature without acquisition receipt | Provenance missing check fails (`research_acquisition_event_missing`) | **PASSED (REJECTED)** |
| **ACQ-08** | Authentic capture | Authentic bytes, matching SHA-256, genuine provider URL, registered event | Verification passes (`valid: true`) | **PASSED (ACCEPTED)** |

### 9.3 Legal Extract Derivation (`LEGAL-01` through `LEGAL-06`)

| ID | Test Scenario | Threat / Failure Mode | Enforcement Mechanism | Result |
| :--- | :--- | :--- | :--- | :--- |
| **LEGAL-01** | Missing raw capture ID | Extract cites nonexistent raw capture ID | `loadLegalEvidenceRegistry` Pass 2 rejects extract (`raw_capture_not_found`) | **PASSED (REJECTED)** |
| **LEGAL-02** | Content digest mismatch | Extract rawCaptureDigest does not match actual raw capture file bytes | Strict SHA-256 comparison fails (`raw_capture_digest_mismatch`) | **PASSED (REJECTED)** |
| **LEGAL-03** | Invented statutory rule | Extract quotes clause not present in raw document | `verifyLegalExtract` parses raw PDF/text streams and verifies quote anchors (`extracted_text_not_found_in_raw_capture`) | **PASSED (REJECTED)** |
| **LEGAL-04** | Mutated threshold | Extract alters threshold (e.g. 200 m² to 300 m²) | `verifyLegalExtract` scans numeric threshold units in raw capture text (`threshold_not_in_raw_document`) | **PASSED (REJECTED)** |
| **LEGAL-05** | Superseded regulation | Extract references superseded/obsolete document version | `effectiveTo` and version validity checked (`obsolete_regulation_version`) | **PASSED (REJECTED)** |
| **LEGAL-06** | Authentic extract | Operative Chamonix PLU PDF (223 pages) verbatim provisions matching exact rules | Full verification passes (`ok: true`) | **PASSED (ACCEPTED)** |

### 9.4 Original Work Product Integrity (`WORK-01` through `WORK-07`)

| ID | Test Scenario | Threat / Failure Mode | Enforcement Mechanism | Result |
| :--- | :--- | :--- | :--- | :--- |
| **WORK-01** | Missing disk dataset | Input dataset file does not exist on disk | Disk file check fails (`input_dataset_file_missing`) | **PASSED (REJECTED)** |
| **WORK-02** | Altered dataset bytes | Dataset bytes on disk tampered | SHA-256 computed from disk bytes does not match declared digest (`input_dataset_digest_mismatch`) | **PASSED (REJECTED)** |
| **WORK-03** | Incompatible product type | `productType` changed to `EMPIRICAL_DATASET` without dataset fields | Schema validation fails (`inputDatasetDigests must be empty`) | **PASSED (REJECTED)** |
| **WORK-04** | Execution hash divergence | Transformation output recomputed dynamically from inputs diverges | Transformation execution re-run; hash mismatch detected (`execution_hash_mismatch`) | **PASSED (REJECTED)** |
| **WORK-05** | Anchor text not in HTML | Output anchors missing from rendered page HTML | Verifiable anchor presence assertion fails (`verifiable_anchor_missing_from_page`) | **PASSED (REJECTED)** |
| **WORK-06** | Unregistered transformation | Unknown transformation ID without registered function | Registry lookup fails (`unregistered_transformation_id`) | **PASSED (REJECTED)** |
| **WORK-07** | Fully authentic work product | Real transformation re-evaluated on verified dataset bytes | Full verification passes (`valid: true`) | **PASSED (ACCEPTED)** |

### 9.5 Publication Exclusion & Structured Mode (`PUB-01` through `PUB-06`)

| ID | Test Scenario | Threat / Failure Mode | Enforcement Mechanism | Result |
| :--- | :--- | :--- | :--- | :--- |
| **PUB-01** | Non-human authority kind | `TEST_ONLY_REVIEW_AUTHORITY` used | `deriveReviewAuthorityMode` returns `TEST_ONLY` (`publicationEligible: false`) | **PASSED (BLOCKED)** |
| **PUB-02** | Pending review | No review authority recorded | Mode evaluates to `PENDING` (`publicationEligible: false`) | **PASSED (BLOCKED)** |
| **PUB-03** | Stale human review | Reviewed content digest mismatch | Stale review detected (`publicationEligible: false`) | **PASSED (BLOCKED)** |
| **PUB-04** | Missing audit event | Review has `VERIFIED_HUMAN` kind but server audit event is missing | Audit event check fails (`publicationEligible: false`) | **PASSED (BLOCKED)** |
| **PUB-05** | Production QA provenance | QA provenance reflects structured `reviewAuthorityMode` | Provenance mode verified; detail-string regex eliminated | **PASSED (STRUCTURED)** |
| **PUB-06** | Valid human review | Valid actor session, active project permission, persisted audit event | Mode evaluates to `VERIFIED_HUMAN` (`publicationEligible: true`) | **PASSED (ELIGIBLE)** |

